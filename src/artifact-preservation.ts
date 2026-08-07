import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import execa from 'execa';
import { logger } from './logger';
import {
  fixArtifactPermissionsForRootless,
  isBenignArtifactPermissionError,
} from './artifact-permissions';
import { getLocalDockerEnv } from './host-env';
import { resolveEnclavePaths } from './enclave/paths';
import { ENCLAVE_MCP_SERVER_CONTAINER_NAME } from './constants';

const ENCLAVE_SESSION_DIR = 'sessions';
const ENCLAVE_AUDIT_FILES = [
  { source: 'enclave.jsonl', destination: 'enclave.jsonl' },
  { source: 'runtime-telemetry.jsonl', destination: 'enclave-runtime.jsonl' },
] as const;

/**
 * Copies the iptables audit dump from the init-signal volume to the audit directory.
 * Must be called BEFORE stopContainers() because `docker compose down -v` destroys
 * the init-signal volume.
 */
export function preserveIptablesAudit(workDir: string, auditDir?: string): void {
  const iptablesAuditSrc = path.join(workDir, 'init-signal', 'iptables-audit.txt');
  const enclaveRoot = resolveEnclavePaths(workDir).root;
  const targetAuditDir = auditDir || path.join(workDir, 'audit');
  if (!fs.existsSync(targetAuditDir)) return;

  if (fs.existsSync(iptablesAuditSrc)) {
    try {
      fs.copyFileSync(iptablesAuditSrc, path.join(targetAuditDir, 'iptables-audit.txt'));
      fs.chmodSync(path.join(targetAuditDir, 'iptables-audit.txt'), 0o644);
      logger.debug('Copied iptables audit state to audit directory');
    } catch (error) {
      logger.debug('Could not copy iptables audit file:', error);
    }
  }

  if (fs.existsSync(enclaveRoot)) {
    for (const auditFile of ENCLAVE_AUDIT_FILES) {
      try {
        const source = `${ENCLAVE_MCP_SERVER_CONTAINER_NAME}:/var/log/awf-enclave/${auditFile.source}`;
        const destination = path.join(targetAuditDir, auditFile.destination);
        const result = execa.sync(
          'docker',
          ['cp', source, destination],
          { env: getLocalDockerEnv(), reject: false },
        );
        if (result.exitCode === 0) {
          logger.debug(`Copied enclave MCP server ${auditFile.source} to audit directory`);
        } else {
          logger.debug(`Could not copy enclave ${auditFile.source}:`, result.stderr);
        }
      } catch (error) {
        logger.debug(`Could not copy enclave ${auditFile.source}:`, error);
      }
    }
    try {
      const destination = path.join(targetAuditDir, 'enclave-agent-sessions');
      const result = execa.sync(
        'docker',
        [
          'cp',
          `${ENCLAVE_MCP_SERVER_CONTAINER_NAME}:/var/log/awf-enclave/${ENCLAVE_SESSION_DIR}`,
          destination,
        ],
        { env: getLocalDockerEnv(), reject: false },
      );
      if (result.exitCode === 0) {
        logger.debug('Copied enclave agent sessions to audit directory');
      } else {
        logger.debug('Could not copy enclave agent sessions:', result.stderr);
      }
    } catch (error) {
      logger.debug('Could not copy enclave agent sessions:', error);
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
}: PreserveDirectoryOptions): void {
  if (runtimeDir) {
    const targetDir = runtimeSubdir ? path.join(runtimeDir, runtimeSubdir) : runtimeDir;
    if (fs.existsSync(targetDir)) {
      try {
        execa.sync('chmod', ['-R', 'a+rX', targetDir]);
        logger.info(`${availableLabel} available at: ${targetDir}`);
      } catch (error) {
        if (isBenignArtifactPermissionError(error)) {
          logger.debug(
            `${permissionErrorMessage} Permission repair was denied for ${targetDir}; ` +
              'this is expected on restricted runners and does not affect the run.',
          );
        } else {
          logger.warn(permissionErrorMessage, error);
        }
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
  agentImage?: string;
};

export function preserveCleanupArtifacts(
  workDir: string,
  { proxyLogsDir, auditDir, sessionStateDir, dockerHostPathPrefix, imageRegistry, imageTag, agentImage }: PreserveCleanupArtifactsOptions = {},
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
  });

  if (auditDir) {
    if (fs.existsSync(auditDir)) {
      try {
        execa.sync('chmod', ['-R', 'a+rX', auditDir]);
        logger.info(`Audit artifacts available at: ${auditDir}`);
      } catch (error) {
        if (isBenignArtifactPermissionError(error)) {
          logger.debug(
            `Could not fix audit dir permissions as non-root user. Permission repair was denied for ${auditDir}; ` +
              'this is expected on restricted runners and rootless repair will be attempted.',
          );
        } else {
          logger.warn('Could not fix audit dir permissions as non-root user; rootless repair will be attempted:', error);
        }
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
    agentImage,
  );
}

type RemoveWorkDirectoriesOptions = Pick<
  PreserveCleanupArtifactsOptions,
  'dockerHostPathPrefix' | 'imageRegistry' | 'imageTag' | 'agentImage'
>;

export function removeWorkDirectories(workDir: string, options: RemoveWorkDirectoriesOptions = {}): void {
  fs.rmSync(workDir, { recursive: true, force: true });

  const chrootHomeDir = `${workDir}-chroot-home`;
  if (fs.existsSync(chrootHomeDir)) {
    try {
      fs.rmSync(chrootHomeDir, { recursive: true, force: true });
    } catch (error: unknown) {
      // In rootless Docker, files created inside the container may be owned by
      // remapped UIDs that the host process cannot delete. Fix permissions via
      // a privileged container, then retry removal.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EACCES') {
        logger.debug('Chroot home removal failed with EACCES; attempting rootless permission repair');
        fixArtifactPermissionsForRootless(
          [chrootHomeDir],
          options.dockerHostPathPrefix,
          options.imageRegistry,
          options.imageTag,
          options.agentImage,
        );
        try {
          fs.rmSync(chrootHomeDir, { recursive: true, force: true });
        } catch (retryError) {
          // Non-fatal: chroot-home will be cleaned by the post-step
          // (install_copilot_cli.sh's sudo cleanup) or runner infrastructure.
          logger.debug(`Could not remove chroot home directory after permission repair: ${chrootHomeDir}`, retryError);
        }
      } else {
        // Non-fatal: same reasoning — defer to post-step cleanup.
        logger.debug('Failed to remove chroot home directory:', error);
      }
    }
  }
}
