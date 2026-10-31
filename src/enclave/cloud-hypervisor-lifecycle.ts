import * as fs from 'fs';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import type { CloudHypervisorManagerDependencies } from '../cloud-hypervisor/manager-types';
import type {
  HostEnclaveExecutorDependencies,
  HostExecutorAgentPolicy,
} from '../cloud-hypervisor/host-enclave-executor';
import {
  startCloudHypervisorEnclaveHostService,
  type CloudHypervisorEnclaveHostServiceOptions,
} from './cloud-hypervisor-host-service';
import type { HostExecutorRunState } from './host-executor-server';
import { HostExecutorLifecycleRegistry, drainHostExecutorLifecycle } from './host-executor-lifecycle';
import { deriveHostExecutorRunState } from './host-executor-run-state';
import { readEnclaveRunId, resolveEnclavePaths, type EnclavePaths } from './paths';
import { updateEnclaveStartupProgress } from './startup-progress';
import {
  HostPreflightReporter, markHostPreflightError, type HostPreflightProgress,
  HostPreflightCleanupError,
} from '../cloud-hypervisor/host-preflight-progress';
import {
  persistHostExecutorProxyUsage, persistHostExecutorProxyResponseDiagnostics,
  readHostExecutorInvocationDiagnostics,
} from './host-executor-diagnostics';
import { readEnclaveProxyUsage, readEnclaveProxyEventEvidence, unavailableEnclaveProxyUsage } from './proxy-usage';
import { captureEnclaveProxyContainerLog, preservePublicEnclaveProxyDiagnostics } from './proxy-debug-retention';
import { preserveHostExecutorInvocationEvidence } from '../cloud-hypervisor/diagnostics';
import { resolveCloudHypervisorManagerDependencies } from '../cloud-hypervisor/manager';
import {
  resolvePublicEnclaveDebugConfig,
  verifyPublicEnclaveDebugRepositories,
  PublicDebugVisibilityError,
  ENCLAVE_DEBUG_ARTIFACT_PROTECTED_ROOT,
  ENCLAVE_DEBUG_ARTIFACT_ROOT,
} from './public-debug';
import { logger } from '../logger';
import { getOrCreateEnclaveModelBudgetSecret } from './model-budget-capability';
import {
  getStaticGithubExecutorCapability,
  releaseStaticGithubExecutorCapability,
  takeStaticGithubExecutorCapability,
} from './static-github-handoff';

export const CLOUD_HYPERVISOR_ENCLAVE_STORAGE_REQUIRED =
  'Cloud Hypervisor enclaves require the trusted hard-bounded writable-storage provider (#9394); '
  + 'it is not installed. No listener or VM is started; enclaves never fall back.';

/**
 * Trusted host integration boundary for #9394, not a config/env feature flag.
 * The provider must enforce aggregate per-invocation capacity (script 1 GiB,
 * agent 512 MiB, from CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES) across ALL
 * writable exports/storage, including sparse files and concurrent writers,
 * artifact/rootfs snapshots, and runtime state. Enforcement precedes
 * host/artifact resource creation and remains until close succeeds.
 * A capacity check, sparse-file size, or invocation/guest tmpfs alone is insufficient.
 */
export interface TrustedCloudHypervisorEnclaveStorageProvider {
  assertAvailable(config: WrapperConfig, publish?: (progress: HostPreflightProgress) => void): Promise<void>;
  prepareRun(options: CloudHypervisorEnclaveHostServiceOptions): Promise<{
    readonly backendDependencies?: Partial<HostEnclaveExecutorDependencies>;
    readonly managerDependencies?: CloudHypervisorManagerDependencies;
    close(): Promise<void>;
  }>;
}

export function isCloudHypervisorEnclaveSelected(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true
    && Object.values(config.enclaves.executors)
      .some((entry) => entry.enabled && entry.runtime === 'cloud-hypervisor');
}

export async function assertCloudHypervisorEnclavePrerequisites(
  config: WrapperConfig,
  storageProvider?: TrustedCloudHypervisorEnclaveStorageProvider,
): Promise<void> {
  if (!isCloudHypervisorEnclaveSelected(config)) return;
  if (!storageProvider) {
    const report = new HostPreflightReporter('provider-selection', (hostPreflight) =>
      updateEnclaveStartupProgress(config, { hostPreflight }));
    await report.check('storage-provider', () => {
      throw markHostPreflightError(new Error(CLOUD_HYPERVISOR_ENCLAVE_STORAGE_REQUIRED), 'requirement-not-met');
    });
    return;
  }
  await storageProvider.assertAvailable(config, (hostPreflight) =>
    updateEnclaveStartupProgress(config, { hostPreflight }));
}

export function deriveCloudHypervisorEnclaveRunState(
  config: WrapperConfig,
  paths: EnclavePaths,
): HostExecutorRunState {
  if (!config.enclaves || !isCloudHypervisorEnclaveSelected(config)) {
    throw new Error('Invalid trusted Cloud Hypervisor enclave configuration: no Cloud Hypervisor executor');
  }
  return deriveHostExecutorRunState(config, paths, 'Cloud Hypervisor enclave');
}

function deriveAgentPolicies(
  config: WrapperConfig,
): Readonly<Record<string, HostExecutorAgentPolicy>> {
  const agent = config.enclaves!.executors.agent;
  if (!agent.enabled) return {};
  const github = getStaticGithubExecutorCapability(config);
  return {
    agent: Object.freeze({
      model: agent.model,
      profile: agent.profile,
      maxOutputBytes: agent.maxOutputBytes,
      maxModelRequests: agent.maxModelRequests,
      maxModelTokens: agent.maxModelTokens,
      modelBudgetSecret: getOrCreateEnclaveModelBudgetSecret(config),
      ...(github ? {
        githubBearer: github.bearer,
        githubExpiresAt: github.expiresAt,
        githubAllowedTools: github.allowedTools,
      } : {}),
    }),
  };
}

const lifecycle = new HostExecutorLifecycleRegistry<
  WrapperConfig, Awaited<ReturnType<TrustedCloudHypervisorEnclaveStorageProvider['prepareRun']>>
>('Cloud Hypervisor enclave');

export async function startCloudHypervisorEnclaveLifecycle(
  config: WrapperConfig,
  storageProvider: TrustedCloudHypervisorEnclaveStorageProvider,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  takeStaticGithubExecutorCapability(config, environment);
  const paths = resolveEnclavePaths(config.workDir);
  if (lifecycle.has(paths.root)) throw new Error('Cloud Hypervisor enclave host executor already exists for this run');
  if (!config.cloudHypervisor) throw new Error('Cloud Hypervisor enclave runtime configuration is missing');
  const debugConfig = resolvePublicEnclaveDebugConfig(config);
  let options: CloudHypervisorEnclaveHostServiceOptions = {
    runtimeDir: paths.hostExecutorDir,
    runState: deriveCloudHypervisorEnclaveRunState(config, paths),
    config: debugConfig.cloudHypervisor!,
    workDir: paths.workDir,
    agentPolicies: deriveAgentPolicies(config),
    environment,
    onPreflightStage: (stage) => updateEnclaveStartupProgress(config, { stage }),
    onHostPreflight: (hostPreflight) => updateEnclaveStartupProgress(config, { hostPreflight }),
  };
  await lifecycle.start(paths.root, config, options.runState.runId, async (run) => {
    updateEnclaveStartupProgress(config, { stage: 'host-preflight' });
    if (debugConfig.cloudHypervisor!.enclaveDebugPublic) {
      try {
        await verifyPublicEnclaveDebugRepositories(debugConfig);
        run.publicDebugVerified = true;
        options = {
          ...options,
          publicDebugArtifactDirectory: ENCLAVE_DEBUG_ARTIFACT_ROOT,
          publicDebugArtifactProtectedRoot: ENCLAVE_DEBUG_ARTIFACT_PROTECTED_ROOT,
        };
        logger.warn(`Public enclave debug retains bounded redacted logs in ${ENCLAVE_DEBUG_ARTIFACT_ROOT}; do not publish these artifacts.`);
      } catch (error) {
        if (!(error instanceof PublicDebugVisibilityError)) throw error;
        options = { ...options, config: { ...options.config, enclaveDebugPublic: false } };
        logger.warn(`Public enclave debug capture and export disabled: ${error.message}. Enclave execution will continue without public debug artifacts.`);
      }
    }
    await assertCloudHypervisorEnclavePrerequisites(config, storageProvider);
    updateEnclaveStartupProgress(config, { stage: 'storage-preflight' });
    run.storage = await storageProvider.prepareRun(options);
    updateEnclaveStartupProgress(config, { stage: 'host-service' });
    run.server = await startCloudHypervisorEnclaveHostService({
      ...options,
      backendDependencies: run.storage.backendDependencies,
      managerDependencies: run.storage.managerDependencies,
    });
    updateEnclaveStartupProgress(config, { stage: 'host-service' });
  });
}

export function closeCloudHypervisorEnclaveAdmissions(config: WrapperConfig): void {
  lifecycle.closeAdmissions(resolveEnclavePaths(config.workDir).root, config);
}

export function assertCloudHypervisorEnclaveLifecycleReady(config: WrapperConfig): Promise<void> {
  return lifecycle.ready(resolveEnclavePaths(config.workDir).root, config);
}

function assertRecoveryComplete(paths: EnclavePaths, runId: string): void {
  if (!fs.existsSync(paths.hostExecutorJournalDir)) return;
  const stat = fs.lstatSync(paths.hostExecutorJournalDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Unsafe Cloud Hypervisor enclave recovery directory; private state is preserved');
  }
  for (const file of fs.readdirSync(paths.hostExecutorJournalDir)) {
    if (file !== `${runId}.journal` && !file.startsWith(`${runId}-`)) continue;
    if (file !== `${runId}.journal` && !file.endsWith('.resources.json')) {
      throw new Error('Cloud Hypervisor enclave resource cleanup is pending; recovery journals are preserved');
    }
    const fd = fs.openSync(path.join(paths.hostExecutorJournalDir, file),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const journalStat = fs.fstatSync(fd);
      if (!journalStat.isFile() || journalStat.uid !== process.getuid?.()
        || (journalStat.mode & 0o777) !== 0o600 || journalStat.size > 32 * 1024 * 1024) {
        throw new Error('Cloud Hypervisor enclave recovery journal is unsafe; private state is preserved');
      }
      const content = fs.readFileSync(fd, 'utf8');
      const complete = file.endsWith('.resources.json')
        ? (() => {
          const record = JSON.parse(content) as { runId?: unknown; state?: unknown };
          return record.runId === runId && record.state === 'cleaned';
        })()
        : content.endsWith('{"state":"closed"}\n') && !content.includes('"state":"cleanup-pending"');
      if (!complete) {
        throw new Error('Cloud Hypervisor enclave cleanup is uncertain; recovery journals are preserved');
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

export async function stopCloudHypervisorEnclaveLifecycle(config: WrapperConfig): Promise<void> {
  const paths = resolveEnclavePaths(config.workDir);
  if (!lifecycle.has(paths.root) && !isCloudHypervisorEnclaveSelected(config)) return;
  await lifecycle.stop(paths.root, config, () => {
    // A restarted host must not delete resource recovery records it did not reap.
    const runId = readEnclaveRunId(paths);
    if (runId && lifecycle.completed(paths.root, runId)) return;
    if (runId && fs.existsSync(paths.hostExecutorJournalDir)
      && fs.readdirSync(paths.hostExecutorJournalDir)
        .some((file) => file === `${runId}.journal` || file.startsWith(`${runId}-`))) {
      throw new Error('Cloud Hypervisor enclave recovery journals require trusted reconciliation before cleanup');
    }
    if (!runId && isCloudHypervisorEnclaveSelected(config) && fs.existsSync(paths.root)) {
      throw new Error('Cloud Hypervisor enclave run identity is missing; private recovery state is preserved');
    }
    return;
  }, async (run) => {
    const preserveEvidence = async (): Promise<void> => {
      const evidence = readHostExecutorInvocationDiagnostics({
        runId: run.runId, journalDir: paths.hostExecutorJournalDir,
      });
      await preserveHostExecutorInvocationEvidence(
        path.join(config.auditDir ?? path.join(config.workDir, 'audit'), 'diagnostics', 'cloud-hypervisor', 'host-executor'),
        evidence,
        resolveCloudHypervisorManagerDependencies(),
      );
    };
    await drainHostExecutorLifecycle({
      preserveEvidence,
      drain: async () => {
        await run.server?.close();
        assertRecoveryComplete(paths, run.runId);
        return Boolean(run.server);
      },
      // The dedicated proxy is shared across invocations. Capture only run-wide
      // counters after host execution drains, before compose/private-root teardown.
      collectDiagnostics: async (hostDrained) => {
        let evidenceError: unknown;
        try {
          persistHostExecutorProxyUsage({
            runId: run.runId, journalDir: paths.hostExecutorJournalDir,
          }, !config.enclaves?.executors.agent.enabled
            ? unavailableEnclaveProxyUsage('not-applicable')
            : hostDrained
              ? await readEnclaveProxyUsage(paths.apiProxyLogsDir)
              : unavailableEnclaveProxyUsage('not-drained'));
        } catch (error) {
          evidenceError = error;
        }
        if (run.publicDebugVerified && config.enclaves?.executors.agent.enabled) {
          try {
            const identity = { runId: run.runId, journalDir: paths.hostExecutorJournalDir };
            const { diagnostics, events } = hostDrained
              ? await readEnclaveProxyEventEvidence(paths.apiProxyLogsDir)
              : {
                diagnostics: { scope: 'run-cumulative' as const, status: 'not-drained' as const },
                events: [],
              };
            persistHostExecutorProxyResponseDiagnostics(identity, diagnostics);
            await preservePublicEnclaveProxyDiagnostics(
              identity, diagnostics, events, await captureEnclaveProxyContainerLog(),
            );
          } catch (error) {
            evidenceError ??= error;
          }
        }
        if (evidenceError !== undefined) throw evidenceError;
      },
      releaseStorage: async () => {
        await run.storage?.close();
        if (run.failed) throw new Error('Cloud Hypervisor enclave startup failed; private recovery state is preserved');
      },
      combineErrors: (cleanupError, evidenceError) => new HostPreflightCleanupError(cleanupError, evidenceError),
    });
  });
  releaseStaticGithubExecutorCapability(config);
}
