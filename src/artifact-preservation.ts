import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import execa from 'execa';
import { getSafeHostGid, getSafeHostUid } from './host-identity';
import { buildRuntimeImageRef, parseImageTag } from './image-tag';
import { logger } from './logger';
import { applyHostPathPrefixToVolumes } from './services/host-path-prefix';
import { getLocalDockerEnv } from './docker-host';

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
        logger.warn(permissionErrorMessage, error);
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

type PreserveCleanupArtifactsOptions = {
  proxyLogsDir?: string;
  auditDir?: string;
  sessionStateDir?: string;
  dockerHostPathPrefix?: string;
  imageRegistry?: string;
  imageTag?: string;
};

function resolvePermFixerImageRef(imageRegistry?: string, imageTag?: string): string {
  try {
    const registry = imageRegistry || 'ghcr.io/github/gh-aw-firewall';
    const parsedImageTag = parseImageTag(imageTag || 'latest');
    return buildRuntimeImageRef(registry, 'agent', parsedImageTag);
  } catch {
    return 'ghcr.io/github/gh-aw-firewall/agent:latest';
  }
}

function fixArtifactPermissionsForRootless(
  dirs: Array<string | undefined>,
  dockerHostPathPrefix: string | undefined,
  imageRegistry: string | undefined,
  imageTag: string | undefined,
): void {
  const currentUid = process.getuid?.();
  if (currentUid === undefined || currentUid === 0) {
    return;
  }

  const existingDirs = dirs.filter(
    (dir): dir is string => typeof dir === 'string' && dir.length > 0 && fs.existsSync(dir),
  );
  if (existingDirs.length === 0) {
    return;
  }

  const uid = getSafeHostUid();
  const gid = getSafeHostGid();
  const imageRef = resolvePermFixerImageRef(imageRegistry, imageTag);

  for (const dir of existingDirs) {
    const mount = applyHostPathPrefixToVolumes([`${dir}:/fix:rw`], dockerHostPathPrefix)[0];
    try {
      const result = execa.sync(
        'docker',
        [
          'run',
          '--rm',
          '--pull',
          'never',
          '--network',
          'none',
          '--cap-drop',
          'ALL',
          '--cap-add',
          'CHOWN',
          '--cap-add',
          'DAC_OVERRIDE',
          '--cap-add',
          'FOWNER',
          '-e',
          `TUID=${uid}`,
          '-e',
          `TGID=${gid}`,
          '-v',
          mount,
          imageRef,
          'sh',
          '-c',
          'chown -R "$TUID:$TGID" /fix && chmod -R a+rX /fix',
        ],
        { env: getLocalDockerEnv(), reject: false },
      );

      if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
        logger.warn(`Rootless artifact permission repair failed for ${dir} (exit ${result.exitCode})`);
      }
    } catch (error) {
      logger.warn(`Rootless artifact permission repair failed for ${dir}:`, error);
    }
  }
}

export function preserveCleanupArtifacts(
  workDir: string,
  { proxyLogsDir, auditDir, sessionStateDir, dockerHostPathPrefix, imageRegistry, imageTag }: PreserveCleanupArtifactsOptions = {},
): void {
  const timestamp = path.basename(workDir).replace('awf-', '');
  const agentLogsDestination = path.join(os.tmpdir(), `awf-agent-logs-${timestamp}`);
  const agentLogsDir = path.join(workDir, 'agent-logs');
  if (fs.existsSync(agentLogsDir) && fs.readdirSync(agentLogsDir).length > 0) {
    try {
      fs.renameSync(agentLogsDir, agentLogsDestination);
      logger.info(`Agent logs preserved at: ${agentLogsDestination}`);
    } catch (error) {
      logger.debug('Could not preserve agent logs:', error);
    }
  }

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
    chmodPreservedDir: true,
    runtimeDirMustExist: false,
  });

  if (auditDir) {
    if (fs.existsSync(auditDir)) {
      try {
        execa.sync('chmod', ['-R', 'a+rX', auditDir]);
        logger.info(`Audit artifacts available at: ${auditDir}`);
      } catch (error) {
        logger.warn('Could not fix audit dir permissions as non-root user; rootless repair will be attempted:', error);
      }
    }
  } else {
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

  const diagnosticsDir = path.join(workDir, 'diagnostics');
  if (fs.existsSync(diagnosticsDir) && fs.readdirSync(diagnosticsDir).length > 0) {
    if (auditDir) {
      const auditDiagnosticsDir = path.join(auditDir, 'diagnostics');
      try {
        fs.mkdirSync(auditDiagnosticsDir, { recursive: true });
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

  fixArtifactPermissionsForRootless(
    [proxyLogsDir, auditDir, sessionStateDir],
    dockerHostPathPrefix,
    imageRegistry,
    imageTag,
  );
}

export function removeWorkDirectories(workDir: string): void {
  fs.rmSync(workDir, { recursive: true, force: true });

  const chrootHomeDir = `${workDir}-chroot-home`;
  if (fs.existsSync(chrootHomeDir)) {
    fs.rmSync(chrootHomeDir, { recursive: true, force: true });
  }
}
