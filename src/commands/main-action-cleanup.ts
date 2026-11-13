import * as os from 'os';
import * as path from 'path';
import { logger } from '../logger';
import {
  stopContainers,
  cleanup,
  preserveIptablesAudit,
} from '../docker-manager';
import { cleanupHostIptables } from '../host-iptables';
import { resolveRouterLogsDir } from '../routing/router-log-capture';
import { publishFinalResolvedConfig } from '../resolved-config-artifact';
import type { ExternalAgentRuntimeBackend } from '../external-runtime-backend';
import { teardownEnclaves } from '../enclave/manager';
import {
  closeCloudHypervisorEnclaveAdmissions,
  stopCloudHypervisorEnclaveLifecycle,
} from '../enclave/cloud-hypervisor-lifecycle';
import {
  closeDockerEnclaveAdmissions,
  isDockerEnclaveSelected,
  stopDockerEnclaveLifecycle,
} from '../enclave/docker-lifecycle';
import { stopEnclaveDynamicDelegation } from '../enclave/dynamic-delegation';
import { shutdownEnclaveGateway } from '../enclave/gateway';
import { captureEnclaveStartupDiagnostics } from '../enclave/startup-diagnostics';
import { disconnectEnclaveGithubGateway } from '../enclave/github-gateway';
import type { WrapperConfig } from '../types';
import { getResolvedConfigSnapshot } from './main-action-audit';
import { writeIncompleteEnclaveAuditMarker } from './main-action-startup-diagnostics';

export function buildCleanupFn(
  config: WrapperConfig,
  getContainersStarted: () => boolean,
  getHostIptablesSetup: () => boolean,
  externalRuntimeBackend?: ExternalAgentRuntimeBackend,
) {
  // The workflow cleans up before verifying routing completion; the fatal
  // path and signal handlers must not tear down a removed work directory again.
  let cleanupRun: Promise<void> | undefined;
  return (signal?: string): Promise<void> => {
    cleanupRun ??= runCleanup(config, getContainersStarted, getHostIptablesSetup, externalRuntimeBackend, signal);
    return cleanupRun;
  };
}

async function runCleanup(
  config: WrapperConfig,
  getContainersStarted: () => boolean,
  getHostIptablesSetup: () => boolean,
  externalRuntimeBackend: ExternalAgentRuntimeBackend | undefined,
  signal: string | undefined,
): Promise<void> {
  let externalRuntimeCleanupError: unknown;
  const dockerEnclaves = isDockerEnclaveSelected(config);
  if (signal) {
    logger.info(`Received ${signal}, cleaning up...`);
  }
  closeCloudHypervisorEnclaveAdmissions(config);
  closeDockerEnclaveAdmissions(config);

  if (externalRuntimeBackend) {
    try {
      if (config.diagnosticLogs) {
        await externalRuntimeBackend.collectDiagnostics();
      }
      if (config.keepContainers && externalRuntimeBackend.preserve) {
        await externalRuntimeBackend.preserve();
      } else if (!config.keepContainers) {
        await externalRuntimeBackend.stop();
      }
    } catch (error) {
      externalRuntimeCleanupError = error;
      logger.warn(
        config.containerRuntime === 'cloud-hypervisor' && config.enclaves?.enabled
          ? 'Unified Cloud Hypervisor cleanup failed; infrastructure and recovery state must be preserved.'
          : 'External runtime cleanup failed; continuing with infrastructure teardown.',
        error,
      );
    }
  }

  // Let the enclave server emit final cleanup telemetry before preserving
  // container artifacts. Stopped containers remain available to docker cp
  // until the subsequent compose down removes them.
  let containersStarted = false;
  let enclaveAuditComplete = true;
  let auditRecoveryFailure: { error: unknown } | undefined;
  try {
    containersStarted = getContainersStarted();
    // Keep delegated identities and sidecars alive through host cancellation.
    // Failure retains networks, seeds and recovery state, but still saves audit.
    let dockerEnclaveShutdownFailed = false;
    let dockerEnclaveShutdownError: unknown;
    try {
      await stopDockerEnclaveLifecycle(config);
    } catch (error) {
      dockerEnclaveShutdownFailed = true;
      dockerEnclaveShutdownError = error;
    }
    if (containersStarted || dockerEnclaves) {
      try {
        // Revoke every outstanding dynamic identity before the broker and the
        // gateway go away, so no delegated bearer can outlive the run.
        await stopEnclaveDynamicDelegation(config);
      } catch (error) {
        enclaveAuditComplete = false;
        logger.warn(
          'Dynamic enclave delegation shutdown did not complete; mcpg state may be unreconciled.',
          error,
        );
        if (dockerEnclaves && !dockerEnclaveShutdownFailed) throw error;
      }
    }
    if (dockerEnclaveShutdownFailed) throw dockerEnclaveShutdownError;
    if (containersStarted) {
      try {
        await shutdownEnclaveGateway(config);
      } catch {
        enclaveAuditComplete = false;
        if (config.enclaves?.enabled) {
          await captureEnclaveStartupDiagnostics(config.workDir, config.proxyLogsDir, 'shutdown-failure');
        }
        logger.warn(
          'Enclave gateway did not complete graceful shutdown; preserved enclave audit is marked incomplete.',
        );
      }
    }
  } finally {
    // VM cancellation/cleanup must complete before disconnecting its peers or
    // tearing down sidecars/networks, even when broker draining fails.
    try {
      await stopCloudHypervisorEnclaveLifecycle(config);
    } finally {
      // Recover broker evidence even when host shutdown must retain resources.
      if (containersStarted) {
        try {
          if (preserveIptablesAudit(config.workDir, config.auditDir) === false) {
            enclaveAuditComplete = false;
            logger.warn('One or more protected enclave audit artifacts could not be preserved.');
          }
        } catch (error) {
          logger.error('Protected audit recovery failed (role=broker-audit, reason=preservation).');
          auditRecoveryFailure = { error };
        }
      }
    }
  }
  if (auditRecoveryFailure) throw auditRecoveryFailure.error;
  if (externalRuntimeCleanupError
    && config.containerRuntime === 'cloud-hypervisor' && config.enclaves?.enabled) {
    throw externalRuntimeCleanupError;
  }
  if (containersStarted) {
    try {
      await disconnectEnclaveGithubGateway(config);
    } catch (error) {
      enclaveAuditComplete = false;
      logger.warn(
        'Compiler-owned shared MCP gateway could not be disconnected cleanly.',
        error,
      );
    }
    if (!enclaveAuditComplete && config.enclaves?.enabled) {
      const targetAuditDir = config.auditDir || path.join(config.workDir, 'audit');
      try {
        writeIncompleteEnclaveAuditMarker(targetAuditDir);
      } catch (error) {
        logger.warn('Failed to write the incomplete enclave audit marker.', error);
      }
    }
    await stopContainers(config.workDir, config.keepContainers, { routerLogsDir: resolveRouterLogsDir(config) });
  }

  if (getHostIptablesSetup() && !config.keepContainers) {
    await cleanupHostIptables();
  }

  // Remove any probe container still labelled with this run and restore
  // write permissions on the immutable seeds. Must run before the generic
  // work-directory cleanup: `rm -rf` cannot unlink entries inside a
  // directory whose write bit was stripped during staging.
  await teardownEnclaves(config);

  if (!config.keepContainers) {
    await cleanup(
      config.workDir,
      false,
      config.proxyLogsDir,
      config.auditDir,
      config.sessionStateDir,
      config.dockerHostPathPrefix,
      config.imageRegistry,
      config.imageTag,
      config.agentImage,
      config.images,
      config.tokenLogDir,
    );
    const resolvedConfigSnapshot = getResolvedConfigSnapshot(config);
    if (!externalRuntimeCleanupError && resolvedConfigSnapshot !== undefined) {
      const finalAuditDir = config.auditDir ||
        path.join(os.tmpdir(), `awf-audit-${path.basename(config.workDir).replace('awf-', '')}`);
      try {
        publishFinalResolvedConfig(finalAuditDir, resolvedConfigSnapshot);
      } catch (error) {
        logger.warn('Failed to publish finalized resolved config artifact:', error);
      }
    }
    // Note: We don't remove the firewall network here since it can be reused
    // across multiple runs. Cleanup script will handle removal if needed.
  } else {
    logger.info(`Configuration files preserved at: ${config.workDir}`);
    logger.info(`Agent logs available at: ${config.workDir}/agent-logs/`);
    logger.info(`Squid logs available at: ${config.workDir}/squid-logs/`);
    logger.info(`Host iptables rules preserved (--keep-containers enabled)`);
  }
  if (externalRuntimeCleanupError) throw externalRuntimeCleanupError;
}
