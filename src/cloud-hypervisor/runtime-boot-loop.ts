import type { MicrovmInfrastructureSnapshot } from '../microvm/infrastructure';
import type { WrapperConfig } from '../types';
import type {
  CloudHypervisorManagerAdapter,
  CloudHypervisorRuntimeBackendDependencies,
} from './runtime-backend';
import type { CloudHypervisorPreflightResult } from './preflight';
import {
  CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS,
  CloudHypervisorRetryableReadinessError,
} from './preflight';
import { buildCloudHypervisorGuestEnvironment } from './guest-environment-builder';
import { planCloudHypervisorFilesystemWriteEnforcement } from './filesystem-write-enforcement';
import { requireCloudHypervisorConfig } from './runtime-validation';
import { formatError } from './backend-utils';
import {
  captureGuestNetworkStateForDiagnostics,
  cleanupFailedBootAttempt,
  getBootDiagnosticsDirectory,
} from './runtime-cleanup';
import {
  probeGuestConnectivity,
  waitForGuestNetworkReady,
} from './runtime-readiness';

const CLOUD_HYPERVISOR_BOOT_RETRY_DELAYS_MS = [5_000, 10_000] as const;

export interface CloudHypervisorBootLoopOptions {
  config: WrapperConfig;
  workDir: string;
  allowedDomains: string[];
  proxyLogsDir?: string;
  skipPull?: boolean;
  onNetworkReady?: () => Promise<void>;
  onInfrastructureReady?: () => Promise<void>;
  dependencies: CloudHypervisorRuntimeBackendDependencies;
  ensurePreflight(): Promise<void>;
  getPreflightResult(): CloudHypervisorPreflightResult | undefined;
  cleanupArtifactSnapshot(): Promise<void>;
  agentExecutionStarted(): boolean;
  markStopped(): void;
  markDiagnosticsCollected(): void;
  failedBootDiagnostics: string[];
  cleanedManagers: Set<CloudHypervisorManagerAdapter>;
}

export interface CloudHypervisorBootLoopResult {
  manager: CloudHypervisorManagerAdapter;
  environment: Record<string, string>;
  identity: { uid: number; gid: number };
  infrastructure: MicrovmInfrastructureSnapshot;
  diagnosticsCollected: boolean;
}

export async function runCloudHypervisorBootLoop({
  config,
  workDir,
  allowedDomains,
  proxyLogsDir,
  skipPull,
  onNetworkReady,
  onInfrastructureReady,
  dependencies,
  ensurePreflight,
  getPreflightResult,
  cleanupArtifactSnapshot,
  agentExecutionStarted,
  markStopped,
  markDiagnosticsCollected,
  failedBootDiagnostics,
  cleanedManagers,
}: CloudHypervisorBootLoopOptions): Promise<CloudHypervisorBootLoopResult> {
  let stage = 'preflight';
  let manager: CloudHypervisorManagerAdapter | undefined;
  let environment: Record<string, string> | undefined;
  let identity: { uid: number; gid: number } | undefined;
  let infrastructure: MicrovmInfrastructureSnapshot | undefined;
  let diagnosticsCollected = false;
  let stopped = false;
  dependencies.logger.info(
    '[cloud-hypervisor] runtime=cloud-hypervisor maturity=preview fallback=disabled',
  );
  try {
    await ensurePreflight();
    const preflightResult = getPreflightResult();
    if (!preflightResult) {
      throw new Error('Cloud Hypervisor preflight did not produce verified artifacts');
    }
    stage = 'compose-infrastructure';
    await dependencies.startInfrastructure(
      workDir,
      allowedDomains,
      proxyLogsDir,
      skipPull,
      onNetworkReady,
      onInfrastructureReady,
    );

    stage = 'infrastructure-discovery';
    const cloudHypervisor = requireCloudHypervisorConfig(config);
    const verifiedCloudHypervisor = {
      ...cloudHypervisor,
      cloudHypervisorBinary: preflightResult.cloudHypervisorBinary,
      kernelPath: preflightResult.kernelPath,
      rootfsPath: preflightResult.rootfsPath,
      supervisorPath: preflightResult.supervisorPath,
      sha256: preflightResult.artifactDigests,
    };
    infrastructure = await dependencies.resolveInfrastructure(
      Boolean(config.enableApiProxy),
      preflightResult.tools.ip,
      config.topologyAttach,
    );
    identity = dependencies.identity();
    stage = 'filesystem-write-policy';
    // Planned before the boot loop so an invalid or unmatched
    // `filesystem.allowWrite` entry fails closed before virtiofsd, the VMM,
    // or the guest is launched, and so every boot attempt reuses one
    // decision instead of re-resolving host paths per attempt.
    const { exports, mountEnforcement, writeBoundary } = planCloudHypervisorFilesystemWriteEnforcement(
      await dependencies.resolveExports(cloudHypervisor.mountPolicy),
      config.filesystemAllowWrite,
    );
    if (writeBoundary.length > 0) {
      // Without this line a guest path missing from `filesystem.allowWrite`
      // only ever surfaces as an unexplained EROFS inside the workload.
      dependencies.logger.info(
        `[cloud-hypervisor] stage=filesystem-write-policy boundary ${writeBoundary.join(' ')} ` +
        '(writes outside these paths fail with EROFS; for paths under originally writable exports, ' +
        'widen filesystem.allowWrite to permit them)',
      );
    }
    stage = 'topology-revalidation';
    await infrastructure.revalidate();
    for (
      let bootAttempt = 1;
      bootAttempt <= CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS;
      bootAttempt += 1
    ) {
      if (bootAttempt > 1) {
        const delay = CLOUD_HYPERVISOR_BOOT_RETRY_DELAYS_MS[bootAttempt - 2];
        dependencies.logger.warn(
          `[cloud-hypervisor] stage=boot-recovery attempt=${bootAttempt}/` +
          `${CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS} delay=${delay}ms`,
        );
        await dependencies.sleep(delay);
      }
      manager = dependencies.createManager(
        verifiedCloudHypervisor,
        workDir,
        infrastructure,
        exports,
        identity,
        mountEnforcement,
        preflightResult,
      );
      try {
        stage = 'vmm-configuration';
        await manager.start();
        const {
          guestIp,
          guestGatewayIp,
          guestPrefixLength,
          guestInterfaceName,
        } = manager;
        if (
          !guestIp ||
          !guestGatewayIp ||
          guestPrefixLength === undefined ||
          !guestInterfaceName
        ) {
          throw new Error(
            'Cloud Hypervisor manager did not expose the configured guest network plan',
          );
        }
        environment = buildCloudHypervisorGuestEnvironment(
          config,
          infrastructure,
          guestIp,
          exports,
        );
        stage = 'guest-boot';
        await manager.startInstance();
        stage = 'guest-network-readiness';
        await waitForGuestNetworkReady({
          manager,
          environment,
          identity,
          bootAttempt,
        });
        stage = 'guest-connectivity';
        await probeGuestConnectivity({
          manager,
          environment,
          identity,
          config,
          infrastructure,
          logger: dependencies.logger,
          bootAttempt,
          captureGuestNetworkStateForDiagnostics: () =>
            captureGuestNetworkStateForDiagnostics({ manager, environment, identity }),
        });
        dependencies.logger.info(
          `[cloud-hypervisor] stage=ready boot-attempt=${bootAttempt}/` +
          `${CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS}`,
        );
        return {
          manager,
          environment,
          identity,
          infrastructure,
          diagnosticsCollected,
        };
      } catch (error) {
        dependencies.logger.warn(
          `[cloud-hypervisor] stage=${stage} status=failed ` +
          `boot-attempt=${bootAttempt}/${CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS}: ` +
          formatError(error),
        );
        const finalAttempt = bootAttempt === CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS;
        const cleanupResult = await cleanupFailedBootAttempt({
          manager,
          bootAttempt,
          startupError: error,
          finalAttempt,
          diagnosticsDirectory: getBootDiagnosticsDirectory(config, bootAttempt),
          failedBootDiagnostics,
          logger: dependencies.logger,
        });
        if (cleanupResult.managerCleared) {
          cleanedManagers.add(manager);
          manager = undefined;
        }
        if (cleanupResult.environmentCleared) environment = undefined;
        if (cleanupResult.diagnosticsCollected) {
          diagnosticsCollected = true;
          markDiagnosticsCollected();
        }
        if (
          error instanceof CloudHypervisorRetryableReadinessError &&
          !agentExecutionStarted() &&
          !finalAttempt
        ) {
          continue;
        }
        if (error instanceof CloudHypervisorRetryableReadinessError) {
          error.attachDiagnostics(failedBootDiagnostics, finalAttempt);
        }
        markStopped();
        stopped = true;
        throw error;
      }
    }
  } catch (error) {
    await cleanupArtifactSnapshot();
    if (!stopped) {
      dependencies.logger.warn(
        `[cloud-hypervisor] stage=${stage} status=failed: ${formatError(error)}`,
      );
    }
    throw error;
  }
  throw new Error('Cloud Hypervisor boot loop exited without creating a manager');
}
