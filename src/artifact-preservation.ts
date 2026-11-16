import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from './logger';
import {
  fixArtifactPermissionsForRootless,
  isBenignArtifactPermissionError,
} from './artifact-permissions';
import {
  chmodPublicArtifacts,
  chmodRuntimeArtifacts,
  hasPrivateDiagnostics,
  publicArtifactPaths,
} from './artifact-public-permissions';
import { preserveEnclaveAudit } from './artifact-enclave-handoff';
import { publishTokenUsageLogPath, resolveTokenLogSubdir } from './artifact-token-usage';
import type { ImageManifestConfig } from './image-resolver';
import { resolveEnclavePaths } from './enclave/paths';
import { resolveRunnerVisibleHostPath } from './services/host-path-prefix';
import { getStartupDiagnosticPath } from './logs/startup-diagnostics';
import { openArtifactDirectory } from './resolved-config-artifact';
import { preservedArtifactDirectory } from './log-paths';

export { handoffPrivateEnclaveAudit } from './artifact-enclave-handoff';

/**
 * Copies the iptables audit dump from the init-signal volume to the audit directory.
 * Must be called BEFORE stopContainers() because `docker compose down -v` destroys
 * the init-signal volume. Returns false if a destination is unsafe or a required
 * audit copy fails; a missing optional enclave session directory is tolerated.
 */
export function preserveIptablesAudit(
  workDir: string,
  auditDir?: string,
): boolean {
  const iptablesAuditSrc = path.join(workDir, 'init-signal', 'iptables-audit.txt');
  const enclavePaths = resolveEnclavePaths(workDir);
  const enclaveRoot = enclavePaths.root;
  const targetAuditDir = path.resolve(auditDir || path.join(workDir, 'audit'));
  let auditDirectoryFd: number;
  try {
    auditDirectoryFd = openArtifactDirectory(targetAuditDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    logger.warn(`Could not validate audit directory: ${targetAuditDir}`, error);
    return false;
  }
  try {
    let complete = true;

    if (fs.existsSync(iptablesAuditSrc)) {
      try {
        const fd = fs.openSync(`/proc/self/fd/${auditDirectoryFd}/iptables-audit.txt`, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, fs.readFileSync(iptablesAuditSrc));
          fs.fchmodSync(fd, 0o644);
        } finally {
          fs.closeSync(fd);
        }
        logger.debug('Copied iptables audit state to audit directory');
      } catch (error) {
        complete = false;
        logger.warn('Could not safely preserve iptables audit file:', error);
      }
    }

    if (fs.existsSync(enclaveRoot)) {
      if (!preserveEnclaveAudit(auditDirectoryFd, targetAuditDir)) complete = false;
    }
    return complete;
  } finally {
    fs.closeSync(auditDirectoryFd);
  }
}

type PreserveDirectoryOptions = {
  runtimeDir?: string;
  runtimeSubdir?: string;
  workDir: string;
  workSubdir: string;
  destinationBaseName: string;
  availableLabel: string;
  preservedLabel: string;
  permissionErrorMessage: string;
  preserveErrorMessage: string;
  chmodPreservedDir?: boolean;
  chmodRuntimeDir?: 'recursive' | 'direct-files' | false;
};

function preserveDirectory({
  runtimeDir,
  runtimeSubdir,
  workDir,
  workSubdir,
  destinationBaseName,
  availableLabel,
  preservedLabel,
  permissionErrorMessage,
  preserveErrorMessage,
  chmodPreservedDir = false,
  chmodRuntimeDir = 'recursive',
}: PreserveDirectoryOptions): string | undefined {
  if (runtimeDir) {
    const targetDir = runtimeSubdir ? path.join(runtimeDir, runtimeSubdir) : runtimeDir;
    if (fs.existsSync(targetDir)) {
      try {
        if (chmodRuntimeDir) chmodRuntimeArtifacts(targetDir, chmodRuntimeDir);
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
      return targetDir;
    }
    return undefined;
  }

  const sourceDir = path.join(workDir, workSubdir);
  const destinationDir = preservedArtifactDirectory(workDir, destinationBaseName);
  if (fs.existsSync(sourceDir) && fs.readdirSync(sourceDir).length > 0) {
    try {
      fs.renameSync(sourceDir, destinationDir);
      logger.info(`${preservedLabel} preserved at: ${destinationDir}`);
    } catch (error) {
      logger.debug(preserveErrorMessage, error);
      return undefined;
    }
    if (chmodPreservedDir) {
      // Best-effort: files written by a container user (e.g. squid UID 13) are
      // not owned by the runner, so a host-side chmod is denied. The directory
      // is already preserved at this point, and the in-container repair in
      // container-stop.ts is the authoritative fix, so never mask the
      // successful preservation with a chmod failure.
      try {
        chmodRuntimeArtifacts(destinationDir, 'recursive');
      } catch (error) {
        if (isBenignArtifactPermissionError(error)) {
          logger.debug(
            `${permissionErrorMessage} Permission repair was denied for ${destinationDir}; ` +
              'this is expected on restricted runners and does not affect the run.',
          );
        } else {
          logger.debug(permissionErrorMessage, error);
        }
      }
    }
    return destinationDir;
  }
  return undefined;
}

function preserveHostStartupDiagnostic(proxyLogsDir: string): void {
  const diagnosticPath = getStartupDiagnosticPath(proxyLogsDir);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      diagnosticPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    if (!fs.fstatSync(descriptor).isFile()) return;
    fs.fchmodSync(descriptor, 0o644);
    logger.info(`Startup diagnostic available at: ${diagnosticPath}`);
  } catch (error) {
    logger.debug('Could not fix startup diagnostic permissions:', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

type PreserveCleanupArtifactsOptions = {
  proxyLogsDir?: string;
  tokenLogDir?: string;
  auditDir?: string;
  sessionStateDir?: string;
  dockerHostPathPrefix?: string;
  imageRegistry?: string;
  imageTag?: string;
  agentImage?: string;
  images?: ImageManifestConfig['images'];
};

export function preserveCleanupArtifacts(
  workDir: string,
  { proxyLogsDir, tokenLogDir, auditDir, sessionStateDir, dockerHostPathPrefix, imageRegistry, imageTag, agentImage, images }: PreserveCleanupArtifactsOptions = {},
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

  // Container-written log directories reach the runner through translated bind
  // mounts; read them where the daemon actually wrote them.
  const runnerVisibleProxyLogsDir = proxyLogsDir
    ? resolveRunnerVisibleHostPath(proxyLogsDir, dockerHostPathPrefix)
    : undefined;
  if (proxyLogsDir && proxyLogsDir !== runnerVisibleProxyLogsDir) {
    preserveHostStartupDiagnostic(proxyLogsDir);
    preserveDirectory({
      runtimeDir: proxyLogsDir,
      runtimeSubdir: 'enclave-startup',
      workDir,
      workSubdir: 'squid-logs/enclave-startup',
      destinationBaseName: 'awf-enclave-startup',
      availableLabel: 'Host enclave startup diagnostics',
      preservedLabel: 'Host enclave startup diagnostics',
      permissionErrorMessage: 'Could not repair enclave startup diagnostic permissions:',
      preserveErrorMessage: 'Could not preserve enclave startup diagnostics:',
      chmodRuntimeDir: false,
    });
  }

  preserveDirectory({
    runtimeDir: sessionStateDir,
    workDir,
    workSubdir: 'agent-session-state',
    destinationBaseName: 'awf-agent-session-state',
    availableLabel: 'Agent session state',
    preservedLabel: 'Agent session state',
    permissionErrorMessage: 'Could not fix session state permissions:',
    preserveErrorMessage: 'Could not preserve agent session state:',
  });

  const preservedApiProxyLogsDir = preserveDirectory({
    runtimeDir: runnerVisibleProxyLogsDir,
    runtimeSubdir: 'api-proxy-logs',
    workDir,
    workSubdir: 'api-proxy-logs',
    destinationBaseName: 'api-proxy-logs',
    availableLabel: 'API proxy logs',
    preservedLabel: 'API proxy logs',
    permissionErrorMessage: 'Could not fix api-proxy log permissions:',
    preserveErrorMessage: 'Could not preserve api-proxy logs:',
    chmodRuntimeDir: false,
  });
  const tokenLogSubdir = resolveTokenLogSubdir(tokenLogDir);
  if (preservedApiProxyLogsDir && tokenLogSubdir !== undefined) {
    publishTokenUsageLogPath(preservedApiProxyLogsDir, tokenLogSubdir);
  }

  // AWF writes these itself at the untranslated path, readable only by the invoking user
  // (src/routing/router-log-capture.ts), so no prefix translation applies.
  preserveDirectory({
    runtimeDir: proxyLogsDir,
    runtimeSubdir: 'router-logs',
    workDir,
    workSubdir: 'router-logs',
    destinationBaseName: 'router-logs',
    availableLabel: 'Router logs',
    preservedLabel: 'Router logs',
    permissionErrorMessage: 'Could not fix router log permissions:',
    preserveErrorMessage: 'Could not preserve router logs:',
    chmodRuntimeDir: false,
  });

  preserveDirectory({
    runtimeDir: runnerVisibleProxyLogsDir,
    runtimeSubdir: 'cli-proxy-logs',
    workDir,
    workSubdir: 'cli-proxy-logs',
    destinationBaseName: 'cli-proxy-logs',
    availableLabel: 'CLI proxy logs',
    preservedLabel: 'CLI proxy logs',
    permissionErrorMessage: 'Could not fix cli-proxy log permissions:',
    preserveErrorMessage: 'Could not preserve cli-proxy logs:',
  });

  preserveDirectory({
    runtimeDir: runnerVisibleProxyLogsDir,
    workDir,
    workSubdir: 'squid-logs',
    destinationBaseName: 'squid-logs',
    availableLabel: 'Squid logs',
    preservedLabel: 'Squid logs',
    permissionErrorMessage: 'Could not fix squid log permissions:',
    preserveErrorMessage: 'Could not preserve squid logs:',
    chmodPreservedDir: true,
    chmodRuntimeDir: 'direct-files',
  });

  if (auditDir) {
    if (fs.existsSync(auditDir)) {
      try {
        chmodPublicArtifacts(auditDir);
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
        chmodPublicArtifacts(auditDestination);
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
        chmodPublicArtifacts(auditDiagnosticsDir);
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
        chmodPublicArtifacts(diagnosticsDestination);
        logger.info(`Diagnostic logs preserved at: ${diagnosticsDestination}`);
      } catch (error) {
        logger.debug('Could not preserve diagnostic logs:', error);
      }
    }
  }

  fixArtifactPermissionsForRootless(
    [
      ...(auditDir && fs.existsSync(auditDir) && hasPrivateDiagnostics(auditDir)
        ? publicArtifactPaths(auditDir)
        : [auditDir]),
      sessionStateDir,
    ],
    dockerHostPathPrefix,
    imageRegistry,
    imageTag,
    agentImage,
    undefined,
    images,
  );
}

type RemoveWorkDirectoriesOptions = Pick<
  PreserveCleanupArtifactsOptions,
  'dockerHostPathPrefix' | 'imageRegistry' | 'imageTag' | 'agentImage' | 'images'
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
          undefined,
          options.images,
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
