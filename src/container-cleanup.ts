import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import execa from 'execa';
import { logger } from './logger';
import { cleanupSslKeyMaterial, unmountSslTmpfs } from './ssl-bump';
import {
  AGENT_CONTAINER_NAME,
  SQUID_CONTAINER_NAME,
  IPTABLES_INIT_CONTAINER_NAME,
  API_PROXY_CONTAINER_NAME,
} from './constants';
import { getLocalDockerEnv } from './docker-host';

/**
 * Collects diagnostic logs from AWF containers on failure.
 *
 * Writes the following artifacts to `${workDir}/diagnostics/` (created if absent):
 * - `<container>.log`          – stdout+stderr captured via `docker logs`
 * - `<container>.state`        – ExitCode + Error string from `docker inspect`
 * - `<container>.mounts.json`  – Mount metadata from `docker inspect` (no env vars)
 * - `docker-compose.yml`       – Generated compose file with TOKEN/KEY/SECRET values redacted
 *
 * Containers that were never started (e.g. awf-api-proxy when `--enable-api-proxy` is
 * not set) are silently skipped — `docker logs` returns a non-zero exit code and the
 * error is swallowed.
 *
 * Must be called BEFORE stopContainers() because `docker compose down -v` destroys
 * containers (and their log streams).
 *
 * @param workDir - AWF working directory (contains docker-compose.yml)
 */
function isSensitiveComposeEnvVar(name: string): boolean {
  return /(TOKEN|KEY|SECRET)/i.test(name);
}

function sanitizeComposeEnvironment(environment: unknown): void {
  if (Array.isArray(environment)) {
    for (let i = 0; i < environment.length; i++) {
      const entry = environment[i];
      if (typeof entry !== 'string') {
        continue;
      }

      const separatorIndex = entry.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const key = entry.slice(0, separatorIndex);
      if (isSensitiveComposeEnvVar(key)) {
        environment[i] = `${key}=[REDACTED]`;
      }
    }
    return;
  }

  if (environment && typeof environment === 'object') {
    const values = environment as Record<string, unknown>;
    for (const key of Object.keys(values)) {
      if (isSensitiveComposeEnvVar(key)) {
        values[key] = '[REDACTED]';
      }
    }
  }
}

function sanitizeDockerComposeYaml(raw: string): string {
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object') {
    return raw;
  }

  const compose = parsed as Record<string, unknown>;
  const services = compose.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    return yaml.dump(compose, { lineWidth: -1 });
  }

  for (const service of Object.values(services as Record<string, unknown>)) {
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      continue;
    }

    const serviceConfig = service as Record<string, unknown>;
    if ('environment' in serviceConfig) {
      sanitizeComposeEnvironment(serviceConfig.environment);
    }
  }

  return yaml.dump(compose, { lineWidth: -1 });
}

export async function collectDiagnosticLogs(workDir: string): Promise<void> {
  const diagnosticsDir = path.join(workDir, 'diagnostics');
  try {
    fs.mkdirSync(diagnosticsDir, { recursive: true });
  } catch (error) {
    logger.warn('Failed to create diagnostics directory:', error);
    return;
  }

  logger.info('Collecting diagnostic logs...');

  const containers = [
    SQUID_CONTAINER_NAME,
    AGENT_CONTAINER_NAME,
    API_PROXY_CONTAINER_NAME,
    IPTABLES_INIT_CONTAINER_NAME,
  ];

  for (const container of containers) {
    // Collect stdout+stderr from docker logs (last 200 lines to keep files manageable)
    try {
      const result = await execa('docker', ['logs', '--tail', '200', container], { reject: false, env: getLocalDockerEnv() });
      if (result.exitCode === 0) {
        const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        if (combined) {
          fs.writeFileSync(path.join(diagnosticsDir, `${container}.log`), combined + '\n');
        }
      }
    } catch {
      // Container may not exist — silently skip
    }

    // Collect exit code and error string (no env vars exposed)
    try {
      const result = await execa(
        'docker',
        ['inspect', '--format', '{{.State.ExitCode}} {{.State.Error}}', container],
        { reject: false, env: getLocalDockerEnv() }
      );
      const state = result.stdout.trim();
      if (state) {
        fs.writeFileSync(path.join(diagnosticsDir, `${container}.state`), state + '\n');
      }
    } catch {
      // silently skip
    }

    // Collect mount metadata (no env vars exposed)
    try {
      const result = await execa(
        'docker',
        ['inspect', '--format', '{{json .Mounts}}', container],
        { reject: false, env: getLocalDockerEnv() }
      );
      const mounts = result.stdout.trim();
      if (mounts && mounts !== 'null') {
        fs.writeFileSync(path.join(diagnosticsDir, `${container}.mounts.json`), mounts + '\n');
      }
    } catch {
      // silently skip
    }
  }

  // Write a sanitized copy of docker-compose.yml by parsing the YAML and redacting
  // sensitive environment variable values under services[*].environment in both
  // object/map and list forms.
  const composeFile = path.join(workDir, 'docker-compose.yml');
  if (fs.existsSync(composeFile)) {
    try {
      const raw = fs.readFileSync(composeFile, 'utf8');
      const sanitized = sanitizeDockerComposeYaml(raw);
      fs.writeFileSync(path.join(diagnosticsDir, 'docker-compose.yml'), sanitized);
    } catch (error) {
      logger.debug('Could not write sanitized docker-compose.yml to diagnostics:', error);
    }
  }

  logger.info(`Diagnostic logs collected at: ${diagnosticsDir}`);
}

/**
 * Stops and removes Docker Compose services
 */
export async function stopContainers(workDir: string, keepContainers: boolean): Promise<void> {
  if (keepContainers) {
    logger.info('Keeping containers running (--keep-containers enabled)');
    return;
  }

  logger.info('Stopping containers...');

  try {
    await execa('docker', ['compose', 'down', '-v', '-t', '1'], {
      cwd: workDir,
      stdout: process.stderr,
      stderr: 'inherit',
      env: getLocalDockerEnv(),
    });
    logger.success('Containers stopped successfully');
  } catch (error) {
    logger.error('Failed to stop containers:', error);
    throw error;
  }
}

/**
 * Cleans up temporary files
 * Preserves agent logs by moving them to a persistent location before cleanup
 * @param workDir - Working directory containing configs and logs
 * @param keepFiles - If true, skip cleanup and keep files
 * @param proxyLogsDir - Optional custom directory where Squid proxy logs were written directly
 */
/**
 * Copies the iptables audit dump from the init-signal volume to the audit directory.
 * Must be called BEFORE stopContainers() because `docker compose down -v` destroys
 * the init-signal volume.
 */
export function preserveIptablesAudit(workDir: string, auditDir?: string): void {
  const iptablesAuditSrc = path.join(workDir, 'init-signal', 'iptables-audit.txt');
  const targetAuditDir = auditDir || path.join(workDir, 'audit');
  if (fs.existsSync(iptablesAuditSrc) && fs.existsSync(targetAuditDir)) {
    try {
      fs.copyFileSync(iptablesAuditSrc, path.join(targetAuditDir, 'iptables-audit.txt'));
      fs.chmodSync(path.join(targetAuditDir, 'iptables-audit.txt'), 0o644);
      logger.debug('Copied iptables audit state to audit directory');
    } catch (error) {
      logger.debug('Could not copy iptables audit file:', error);
    }
  }
}

type PreserveDirectoryOptions = {
  runtimeDir?: string;
  runtimeSubdir?: string;
  workDir: string;
  workSubdir: string;
  destinationBaseName: string;
  timestamp: string;
  availableLabel: string;
  preservedLabel: string;
  permissionErrorMessage: string;
  preserveErrorMessage: string;
  chmodPreservedDir?: boolean;
  runtimeDirMustExist?: boolean;
};

function preserveDirectory({
  runtimeDir,
  runtimeSubdir,
  workDir,
  workSubdir,
  destinationBaseName,
  timestamp,
  availableLabel,
  preservedLabel,
  permissionErrorMessage,
  preserveErrorMessage,
  chmodPreservedDir = false,
  runtimeDirMustExist = true,
}: PreserveDirectoryOptions): void {
  if (runtimeDir) {
    const targetDir = runtimeSubdir ? path.join(runtimeDir, runtimeSubdir) : runtimeDir;
    if (!runtimeDirMustExist || fs.existsSync(targetDir)) {
      try {
        execa.sync('chmod', ['-R', 'a+rX', targetDir]);
        logger.info(`${availableLabel} available at: ${targetDir}`);
      } catch (error) {
        logger.debug(permissionErrorMessage, error);
      }
    }
    return;
  }

  const sourceDir = path.join(workDir, workSubdir);
  const destinationDir = path.join(os.tmpdir(), `${destinationBaseName}-${timestamp}`);
  if (fs.existsSync(sourceDir) && fs.readdirSync(sourceDir).length > 0) {
    try {
      fs.renameSync(sourceDir, destinationDir);
      if (chmodPreservedDir) {
        execa.sync('chmod', ['-R', 'a+rX', destinationDir]);
      }
      logger.info(`${preservedLabel} preserved at: ${destinationDir}`);
    } catch (error) {
      logger.debug(preserveErrorMessage, error);
    }
  }
}

export async function cleanup(workDir: string, keepFiles: boolean, proxyLogsDir?: string, auditDir?: string, sessionStateDir?: string): Promise<void> {
  if (keepFiles) {
    logger.debug(`Keeping temporary files in: ${workDir}`);
    return;
  }

  logger.debug('Cleaning up temporary files...');
  try {
    if (fs.existsSync(workDir)) {
      const timestamp = path.basename(workDir).replace('awf-', '');

      // Agent logs always go to timestamped /tmp directory
      // (separate from proxyLogsDir which only affects Squid logs)
      const agentLogsDestination = path.join(os.tmpdir(), `awf-agent-logs-${timestamp}`);

      // Preserve agent logs before cleanup
      const agentLogsDir = path.join(workDir, 'agent-logs');
      if (fs.existsSync(agentLogsDir) && fs.readdirSync(agentLogsDir).length > 0) {
        try {
          // Always move agent logs to timestamped directory
          fs.renameSync(agentLogsDir, agentLogsDestination);
          logger.info(`Agent logs preserved at: ${agentLogsDestination}`);
        } catch (error) {
          logger.debug('Could not preserve agent logs:', error);
        }
      }

      // Preserve agent session-state (contains events.jsonl, session data from Copilot CLI)
      // Session state was written directly to sessionStateDir during runtime (timeout-safe)
      // Just fix permissions so it's readable for artifact upload.
      preserveDirectory({
        runtimeDir: sessionStateDir,
        workDir,
        workSubdir: 'agent-session-state',
        destinationBaseName: 'awf-agent-session-state',
        timestamp,
        availableLabel: 'Agent session state',
        preservedLabel: 'Agent session state',
        permissionErrorMessage: 'Could not fix session state permissions:',
        preserveErrorMessage: 'Could not preserve agent session state:',
      });

      // Preserve api-proxy logs before cleanup
      // Logs were written inside proxyLogsDir/api-proxy-logs during runtime (timeout-safe)
      // Just fix permissions so they're readable.
      preserveDirectory({
        runtimeDir: proxyLogsDir,
        runtimeSubdir: 'api-proxy-logs',
        workDir,
        workSubdir: 'api-proxy-logs',
        destinationBaseName: 'api-proxy-logs',
        timestamp,
        availableLabel: 'API proxy logs',
        preservedLabel: 'API proxy logs',
        permissionErrorMessage: 'Could not fix api-proxy log permissions:',
        preserveErrorMessage: 'Could not preserve api-proxy logs:',
      });

      // Preserve cli-proxy (mcpg DIFC proxy audit) logs before cleanup
      preserveDirectory({
        runtimeDir: proxyLogsDir,
        runtimeSubdir: 'cli-proxy-logs',
        workDir,
        workSubdir: 'cli-proxy-logs',
        destinationBaseName: 'cli-proxy-logs',
        timestamp,
        availableLabel: 'CLI proxy logs',
        preservedLabel: 'CLI proxy logs',
        permissionErrorMessage: 'Could not fix cli-proxy log permissions:',
        preserveErrorMessage: 'Could not preserve cli-proxy logs:',
      });

      // Handle squid logs
      // Logs were written directly to proxyLogsDir during runtime (timeout-safe)
      // Just fix permissions so they're readable.
      preserveDirectory({
        runtimeDir: proxyLogsDir,
        workDir,
        workSubdir: 'squid-logs',
        destinationBaseName: 'squid-logs',
        timestamp,
        availableLabel: 'Squid logs',
        preservedLabel: 'Squid logs',
        permissionErrorMessage: 'Could not fix squid log permissions:',
        preserveErrorMessage: 'Could not preserve squid logs:',
        // Make moved logs readable for artifact upload when preserving default squid logs.
        chmodPreservedDir: true,
        // Existing behavior attempts chmod directly on proxyLogsDir and handles any resulting error.
        runtimeDirMustExist: false,
      });

      // Preserve audit artifacts
      if (auditDir) {
        // User-specified audit dir: just fix permissions
        if (fs.existsSync(auditDir)) {
          try {
            execa.sync('chmod', ['-R', 'a+rX', auditDir]);
            logger.info(`Audit artifacts available at: ${auditDir}`);
          } catch (error) {
            logger.debug('Could not fix audit dir permissions:', error);
          }
        }
      } else {
        // Default: move from workDir/audit to timestamped /tmp directory
        const defaultAuditDir = path.join(workDir, 'audit');
        const auditDestination = path.join(os.tmpdir(), `awf-audit-${timestamp}`);
        if (fs.existsSync(defaultAuditDir) && fs.readdirSync(defaultAuditDir).length > 0) {
          try {
            fs.renameSync(defaultAuditDir, auditDestination);
            execa.sync('chmod', ['-R', 'a+rX', auditDestination]);
            logger.info(`Audit artifacts preserved at: ${auditDestination}`);
          } catch (error) {
            logger.debug('Could not preserve audit artifacts:', error);
          }
        }
      }

      // Preserve diagnostic logs (collected when --diagnostic-logs is enabled and exit was non-zero)
      const diagnosticsDir = path.join(workDir, 'diagnostics');
      if (fs.existsSync(diagnosticsDir) && fs.readdirSync(diagnosticsDir).length > 0) {
        if (auditDir) {
          // Co-locate with audit artifacts for a single upload path
          const auditDiagnosticsDir = path.join(auditDir, 'diagnostics');
          try {
            fs.mkdirSync(auditDiagnosticsDir, { recursive: true });
            // Move each file individually (rename across devices may fail)
            for (const file of fs.readdirSync(diagnosticsDir)) {
              fs.renameSync(path.join(diagnosticsDir, file), path.join(auditDiagnosticsDir, file));
            }
            execa.sync('chmod', ['-R', 'a+rX', auditDiagnosticsDir]);
            logger.info(`Diagnostic logs available at: ${auditDiagnosticsDir}`);
          } catch (error) {
            logger.debug('Could not move diagnostics to audit dir:', error);
          }
        } else {
          const diagnosticsDestination = path.join(os.tmpdir(), `awf-diagnostics-${timestamp}`);
          try {
            fs.mkdirSync(diagnosticsDestination, { recursive: true });
            // Move each entry individually (rename across devices may fail)
            for (const file of fs.readdirSync(diagnosticsDir)) {
              fs.renameSync(path.join(diagnosticsDir, file), path.join(diagnosticsDestination, file));
            }
            execa.sync('chmod', ['-R', 'a+rX', diagnosticsDestination]);
            logger.info(`Diagnostic logs preserved at: ${diagnosticsDestination}`);
          } catch (error) {
            logger.debug('Could not preserve diagnostic logs:', error);
          }
        }
      }

      // Securely wipe SSL key material before deleting workDir
      cleanupSslKeyMaterial(workDir);

      // Unmount tmpfs if it was used for SSL keys (data destroyed on unmount)
      const sslDir = path.join(workDir, 'ssl');
      if (fs.existsSync(sslDir)) {
        await unmountSslTmpfs(sslDir);
      }

      // Clean up workDir
      fs.rmSync(workDir, { recursive: true, force: true });

      // Clean up chroot home directory (created outside workDir to avoid tmpfs overlay)
      const chrootHomeDir = `${workDir}-chroot-home`;
      if (fs.existsSync(chrootHomeDir)) {
        fs.rmSync(chrootHomeDir, { recursive: true, force: true });
      }

      logger.debug('Temporary files cleaned up');
    }
  } catch (error) {
    logger.warn('Failed to clean up temporary files:', error);
  }
}
