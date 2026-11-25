import type { MicrovmInfrastructureSnapshot } from '../microvm/infrastructure';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import { createSensitivePathAudit } from '../sensitive-paths';
import { writeSensitivePathAudit } from '../sensitive-path-audit';
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
import { assertCloudHypervisorEnclaveLifecycleReady } from '../enclave/cloud-hypervisor-lifecycle';
import { assertCloudHypervisorEnclaveExportsIsolated } from '../enclave/mount-policy';
import { assertRoutingStateNotExportedToGuest } from '../routing/bootstrap';
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
import {
  createPrimaryReadinessReporter,
  PRIMARY_READINESS_DIRECTORY,
  type PrimaryBootStage,
} from './primary-readiness';

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
  /**
   * Publishes the in-flight manager to the facade as soon as it exists so a
   * concurrent `stop()` (e.g. from the signal handler, which runs while
   * `start()` is still awaiting boot and readiness probes) can terminate the
   * VMM/virtiofsd processes instead of leaving them orphaned.
   */
  publishManager(manager: CloudHypervisorManagerAdapter | undefined): void;
  /** True once a concurrent stop()/preserve() has begun tearing the run down. */
  isStopped(): boolean;
  markStopped(): void;
  markDiagnosticsCollected(): void;
  failedBootDiagnostics: string[];
  cleanedManagers: Set<CloudHypervisorManagerAdapter>;
}

export interface CloudHypervisorBootLoopResult {
  manager: CloudHypervisorManagerAdapter;
  environment: Record<string, string>;
  identity: { uid: number; gid: number };
  diagnosticsCollected: boolean;
}

interface BootContext {
  readonly options: CloudHypervisorBootLoopOptions;
  stage: PrimaryBootStage;
  bootAttempt: number;
  readiness?: ReturnType<typeof createPrimaryReadinessReporter>;
  manager?: CloudHypervisorManagerAdapter;
  diagnosticsCollected: boolean;
  stopped: boolean;
}

interface BootInfrastructure {
  cloudHypervisor: ReturnType<typeof requireCloudHypervisorConfig>;
  verifiedCloudHypervisor: ReturnType<typeof requireCloudHypervisorConfig>;
  preflightResult: CloudHypervisorPreflightResult;
  infrastructure: MicrovmInfrastructureSnapshot;
  identity: { uid: number; gid: number };
}

function publish(
  context: BootContext,
  state: 'starting' | 'ready' | 'failed' = 'starting',
): void {
  context.readiness?.publish(
    context.stage,
    state,
    context.bootAttempt,
    context.manager?.paths.runDirectory,
    context.manager?.guestIp,
  );
}

function publishFailure(context: BootContext, retry = false): void {
  try {
    publish(context, retry ? 'starting' : 'failed');
  } catch {
    context.options.dependencies.logger.warn(
      '[cloud-hypervisor] Primary readiness failure publication failed',
    );
  }
}

async function composeInfrastructure(context: BootContext): Promise<void> {
  const {
    config, workDir, allowedDomains, proxyLogsDir, skipPull,
    onNetworkReady, onInfrastructureReady, dependencies, isStopped,
  } = context.options;
  if (config.enclaves?.enabled) {
    await assertCloudHypervisorEnclaveLifecycleReady(config);
    if (!onInfrastructureReady) {
      throw new Error('Cloud Hypervisor enclaves require compiler-owned MCP gateway readiness');
    }
  }
  let infrastructureReady = false;
  context.stage = 'compose-infrastructure';
  publish(context);
  await dependencies.startInfrastructure(
    workDir,
    allowedDomains,
    proxyLogsDir,
    skipPull,
    onNetworkReady,
    config.enclaves?.enabled && onInfrastructureReady ? (async () => {
      if (isStopped()) throw new Error('Cloud Hypervisor infrastructure startup aborted by shutdown');
      await onInfrastructureReady();
      infrastructureReady = true;
    }) : onInfrastructureReady,
  );

  if (isStopped()) throw new Error('Cloud Hypervisor infrastructure startup aborted by shutdown');
  if (config.enclaves?.enabled) {
    if (!infrastructureReady) {
      throw new Error('Cloud Hypervisor infrastructure did not complete MCP gateway readiness');
    }
    await assertCloudHypervisorEnclaveLifecycleReady(config);
  }
}

async function discoverInfrastructure(
  context: BootContext,
  preflightResult: CloudHypervisorPreflightResult,
): Promise<BootInfrastructure> {
  const { config, dependencies } = context.options;
  context.stage = 'infrastructure-discovery';
  publish(context);
  const cloudHypervisor = requireCloudHypervisorConfig(config);
  const verifiedCloudHypervisor = {
    ...cloudHypervisor,
    cloudHypervisorBinary: preflightResult.cloudHypervisorBinary,
    kernelPath: preflightResult.kernelPath,
    rootfsPath: preflightResult.rootfsPath,
    supervisorPath: preflightResult.supervisorPath,
    sha256: preflightResult.artifactDigests,
  };
  const infrastructure = await dependencies.resolveInfrastructure(
    Boolean(config.enableApiProxy),
    preflightResult.tools.ip,
    config.topologyAttach,
  );
  const identity = dependencies.identity();
  return { cloudHypervisor, verifiedCloudHypervisor, preflightResult, infrastructure, identity };
}

async function enforceFilesystemWritePolicy(
  context: BootContext,
  cloudHypervisor: BootInfrastructure['cloudHypervisor'],
): Promise<ReturnType<typeof planCloudHypervisorFilesystemWriteEnforcement>> {
  const { config, workDir, dependencies } = context.options;
  context.stage = 'filesystem-write-policy';
  publish(context);
  const resolvedExports = await dependencies.resolveExports(cloudHypervisor.mountPolicy);
  assertCloudHypervisorEnclaveExportsIsolated(config, resolvedExports);
  assertRoutingStateNotExportedToGuest(config, resolvedExports);
  // Planned before the boot loop so an invalid or unmatched
  // `filesystem.allowWrite` entry fails closed before virtiofsd, the VMM,
  // or the guest is launched, and so every boot attempt reuses one
  // decision instead of re-resolving host paths per attempt.
  const enforcement = planCloudHypervisorFilesystemWriteEnforcement(
    resolvedExports,
    config.filesystemAllowWrite,
  );
  const { sensitiveMasks, unclassifiedPaths, writeBoundary } = enforcement;
  writeSensitivePathAudit(
    config.auditDir || path.join(workDir, 'audit'),
    createSensitivePathAudit(
      'cloud-hypervisor',
      sensitiveMasks.map(({ id, path: maskPath, reason }) => ({
        id,
        path: maskPath,
        reason,
      })),
      unclassifiedPaths,
    ),
  );
  if (unclassifiedPaths.length > 0) {
    dependencies.logger.warn(
      `[cloud-hypervisor] stage=sensitive-path-policy unclassified /tmp/gh-aw children: ` +
      `${unclassifiedPaths.join(', ')} (warning-only; classify each path before enabling enforcement)`,
    );
  }
  if (writeBoundary.length > 0) {
    // Without this line a guest path missing from `filesystem.allowWrite`
    // only ever surfaces as an unexplained EROFS inside the workload.
    dependencies.logger.info(
      `[cloud-hypervisor] stage=filesystem-write-policy boundary ${writeBoundary.join(' ')} ` +
      '(writes outside these paths fail with EROFS; for paths under originally writable exports, ' +
      'widen filesystem.allowWrite to permit them)',
    );
  }
  return enforcement;
}

async function revalidateTopology(
  context: BootContext,
  infrastructure: MicrovmInfrastructureSnapshot,
): Promise<void> {
  context.stage = 'topology-revalidation';
  publish(context);
  await infrastructure.revalidate();
}

async function startVmm(
  context: BootContext,
  manager: CloudHypervisorManagerAdapter,
  { infrastructure }: BootInfrastructure,
  { exports }: ReturnType<typeof planCloudHypervisorFilesystemWriteEnforcement>,
): Promise<Record<string, string>> {
  context.stage = 'vmm-configuration';
  publish(context);
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
  return buildCloudHypervisorGuestEnvironment(
    context.options.config,
    infrastructure,
    guestIp,
    exports,
  );
}

async function bootGuest(
  context: BootContext,
  manager: CloudHypervisorManagerAdapter,
  environment: Record<string, string>,
  { identity, infrastructure }: BootInfrastructure,
): Promise<void> {
  const { config, dependencies, isStopped } = context.options;
  context.stage = 'guest-boot';
  publish(context);
  await manager.startInstance();
  context.stage = 'guest-network-readiness';
  publish(context);
  await waitForGuestNetworkReady({
    manager,
    environment,
    identity,
    bootAttempt: context.bootAttempt,
  });
  context.stage = 'guest-connectivity';
  publish(context);
  await probeGuestConnectivity({
    manager,
    environment,
    identity,
    config,
    infrastructure,
    logger: dependencies.logger,
    bootAttempt: context.bootAttempt,
    captureGuestNetworkStateForDiagnostics: () =>
      captureGuestNetworkStateForDiagnostics({ manager, environment, identity }),
  });
  // The facade owns concurrent shutdown and deduplicates manager teardown.
  if (isStopped()) {
    publish(context, 'failed');
  } else {
    context.stage = 'ready';
    publish(context, 'ready');
    dependencies.logger.info(
      `[cloud-hypervisor] stage=ready boot-attempt=${context.bootAttempt}/` +
      `${CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS}`,
    );
  }
}

async function runBootAttempts(
  context: BootContext,
  discovered: BootInfrastructure,
  filesystem: ReturnType<typeof planCloudHypervisorFilesystemWriteEnforcement>,
): Promise<CloudHypervisorBootLoopResult> {
  const {
    config, workDir, dependencies, isStopped, publishManager, agentExecutionStarted,
    failedBootDiagnostics, cleanedManagers, markDiagnosticsCollected, markStopped,
  } = context.options;
  const { verifiedCloudHypervisor, infrastructure, identity, preflightResult } = discovered;
  for (
    context.bootAttempt = 1;
    context.bootAttempt <= CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS;
    context.bootAttempt += 1
  ) {
    const bootAttempt = context.bootAttempt;
    if (bootAttempt > 1) {
      const delay = CLOUD_HYPERVISOR_BOOT_RETRY_DELAYS_MS[bootAttempt - 2];
      dependencies.logger.warn(
        `[cloud-hypervisor] stage=boot-recovery attempt=${bootAttempt}/` +
        `${CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS} delay=${delay}ms`,
      );
      await dependencies.sleep(delay);
    }
    if (isStopped()) {
      throw new Error('Cloud Hypervisor microVM boot aborted by shutdown');
    }
    if (config.enclaves?.enabled) {
      await assertCloudHypervisorEnclaveLifecycleReady(config);
      if (isStopped()) throw new Error('Cloud Hypervisor microVM boot aborted by shutdown');
    }
    const manager = dependencies.createManager(
      verifiedCloudHypervisor,
      workDir,
      infrastructure,
      filesystem.exports,
      identity,
      filesystem.mountEnforcement,
      preflightResult,
    );
    context.manager = manager;
    publishManager(manager);
    try {
      const environment = await startVmm(context, manager, discovered, filesystem);
      await bootGuest(context, manager, environment, discovered);
      return {
        manager,
        environment,
        identity,
        diagnosticsCollected: context.diagnosticsCollected,
      };
    } catch (error) {
      dependencies.logger.warn(
        `[cloud-hypervisor] stage=${context.stage} status=failed ` +
        `boot-attempt=${bootAttempt}/${CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS}: ` +
        formatError(error),
      );
      const finalAttempt = bootAttempt === CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS;
      const retry = error instanceof CloudHypervisorRetryableReadinessError
        && !agentExecutionStarted() && !finalAttempt;
      publishFailure(context, retry);
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
        context.manager = undefined;
        publishManager(undefined);
      }
      if (cleanupResult.diagnosticsCollected) {
        context.diagnosticsCollected = true;
        markDiagnosticsCollected();
      }
      if (retry) {
        continue;
      }
      if (error instanceof CloudHypervisorRetryableReadinessError) {
        error.attachDiagnostics(failedBootDiagnostics, finalAttempt);
      }
      markStopped();
      context.stopped = true;
      throw error;
    }
  }
  throw new Error('Cloud Hypervisor boot loop exited without creating a manager');
}

export async function runCloudHypervisorBootLoop(
  options: CloudHypervisorBootLoopOptions,
): Promise<CloudHypervisorBootLoopResult> {
  const context: BootContext = {
    options,
    stage: 'preflight',
    bootAttempt: 0,
    diagnosticsCollected: false,
    stopped: false,
  };
  const {
    config, workDir, proxyLogsDir, dependencies,
    ensurePreflight, getPreflightResult, cleanupArtifactSnapshot,
  } = options;
  dependencies.logger.info(
    '[cloud-hypervisor] runtime=cloud-hypervisor maturity=preview fallback=disabled',
  );
  try {
    if (config.enclaves?.enabled) {
      context.readiness = createPrimaryReadinessReporter(path.join(
        proxyLogsDir || path.join(workDir, 'proxy-logs'),
        PRIMARY_READINESS_DIRECTORY,
      ));
    }
    publish(context);
    await ensurePreflight();
    const preflightResult = getPreflightResult();
    if (!preflightResult) {
      throw new Error('Cloud Hypervisor preflight did not produce verified artifacts');
    }
    await composeInfrastructure(context);
    const discovered = await discoverInfrastructure(context, preflightResult);
    const filesystem = await enforceFilesystemWritePolicy(context, discovered.cloudHypervisor);
    await revalidateTopology(context, discovered.infrastructure);
    return await runBootAttempts(context, discovered, filesystem);
  } catch (error) {
    publishFailure(context);
    await cleanupArtifactSnapshot();
    if (!context.stopped) {
      dependencies.logger.warn(
        `[cloud-hypervisor] stage=${context.stage} status=failed: ${formatError(error)}`,
      );
    }
    throw error;
  } finally {
    context.readiness?.close();
  }
}
