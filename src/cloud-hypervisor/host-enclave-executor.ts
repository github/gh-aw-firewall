import { promises as fs } from 'fs';
import { resolveOperatorIdentity } from '../sudo-identity';
export { readBoundedEnclaveResult as readBoundedCloudHypervisorEnclaveResult } from '../enclave/invocation-result';
import type {
  HostEnclaveExecutorBackend,
  HostExecutorInvocationPlan,
  HostExecutorBackendResult,
} from '../enclave/host-executor-server';
import {
  HostExecutorResourceJournal,
  reapHostExecutorResources,
} from '../enclave/host-executor-resource-journal';
import { hostExecutorJournalDirectory, hostExecutorVmRunId } from '../enclave/host-executor-journal';
import { HostPreflightReporter } from './host-preflight-progress';
import { resolveInvocationPolicy } from './host-enclave-executor-policy';
import { HostEnclaveInvocationResources } from './host-enclave-executor-cleanup';
import {
  HostEnclaveInvocationInterruption, startGuestWorkload, type HostEnclaveExecutionOptions,
} from './host-enclave-execution-phases';
import { HostEnclaveExecutionProgress, readHostEnclaveResult } from './host-enclave-result';
import { cleanupHostEnclaveInvocation } from './host-enclave-cleanup';
import { DurableCloudHypervisorCleanupRegistry } from './cleanup-registry';
import {
  assertBoundedEnclaveStorage, mountBoundedEnclaveStorage, unmountBoundedEnclaveStorage,
} from './enclave-storage';
import {
  createArtifactSnapshot,
  createCommonArtifactSnapshot,
} from './artifact-snapshot';
import { CloudHypervisorManager } from './manager';
import { copySparseFileWithRsync, runCloudHypervisorCommonPreflight } from './preflight';
import {
  preflightCloudHypervisorEnclaveArtifacts,
  resolveTrustedAttestationTool,
} from './enclave-artifact-preflight';
import type {
  CreateCloudHypervisorHostEnclaveExecutorOptions,
  HostEnclaveExecutorDependencies,
  HostExecutorAgentPolicy,
} from './enclave-executor-types';

export type {
  CloudHypervisorEnclaveArtifactPreflightOptions,
  CreateCloudHypervisorHostEnclaveExecutorOptions,
  HostEnclaveExecutorDependencies,
  HostEnclaveExecutorManager,
  HostExecutorAgentPolicy,
  VerifiedCloudHypervisorEnclaveArtifacts,
} from './enclave-executor-types';
export { preflightCloudHypervisorEnclaveArtifacts } from './enclave-artifact-preflight';

const defaultDependencies: HostEnclaveExecutorDependencies = {
  createArtifactSnapshot: (sources, copy, onDirectoryCreated, report) =>
    createArtifactSnapshot(sources, copy, onDirectoryCreated, undefined, report),
  createCommonArtifactSnapshot: (sources, copy, onDirectoryCreated, report) =>
    createCommonArtifactSnapshot(sources, copy, onDirectoryCreated, undefined, report),
  createResourceJournal: (run, plan, vmRunId) => HostExecutorResourceJournal.create(run, plan, vmRunId),
  copySparseFile: copySparseFileWithRsync,
  removeArtifactSnapshot: async (directory) => fs.rm(directory, { recursive: true, force: true }),
  createManager: (
    config, workDir, profile, runId, artifacts, managerDependencies, launchReport, managerStartReport,
  ) => new CloudHypervisorManager(
    config,
    workDir,
    managerDependencies,
    runId,
    profile,
    undefined,
    artifacts,
    true,
    launchReport,
    managerStartReport,
  ),
  mountTmpfs: mountBoundedEnclaveStorage,
  unmount: unmountBoundedEnclaveStorage,
  verifyStorage: assertBoundedEnclaveStorage,
  mkdir: fs.mkdir,
  realpath: fs.realpath,
  lstat: fs.lstat,
  writeFile: fs.writeFile,
  chmod: fs.chmod,
  chown: fs.chown,
  rm: fs.rm,
  resolveIdentity: () => {
    const identity = resolveOperatorIdentity();
    if (!identity) {
      throw new Error('Cloud Hypervisor enclave storage requires a non-root operator uid/gid');
    }
    return identity;
  },
};

/**
 * Performs all trusted host/artifact checks before returning an executor that
 * can be passed to createHostExecutorServer. This is intentionally not called
 * by user-facing runtime selection while the Cloud Hypervisor enclave gate is
 * closed.
 */
export async function createCloudHypervisorHostEnclaveExecutor(
  options: CreateCloudHypervisorHostEnclaveExecutorOptions,
  dependencies: Partial<HostEnclaveExecutorDependencies> = {},
): Promise<CloudHypervisorHostEnclaveExecutorBackend> {
  options.onPreflightStage?.('artifact-preflight');
  const environment = options.environment ?? process.env;
  const releaseTag = options.config.artifactReleaseTag;
  const manifestPath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST;
  const manifestBundlePath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE;
  const scriptRootfsPath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS;
  const agentRootfsPath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS;
  const rootfsPath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS;
  if (!releaseTag || !manifestPath || !manifestBundlePath
    || (!rootfsPath && (!scriptRootfsPath || !agentRootfsPath))) {
    throw new Error('Cloud Hypervisor enclave artifacts have not been staged and verified');
  }
  const attestationToolPath = await resolveTrustedAttestationTool(environment);
  options.onPreflightStage?.('host-preflight');
  const preflight = await (dependencies.preflight ?? runCloudHypervisorCommonPreflight)(options.config);
  try {
    options.onPreflightStage?.('recovery');
    await reapHostExecutorResources(
      hostExecutorJournalDirectory(options.runState),
      options.managerDependencies?.cleanupRegistry ?? new DurableCloudHypervisorCleanupRegistry(),
      preflight.tools,
    );
    options.onPreflightStage?.('artifact-preflight');
    const enclaveArtifacts = await (dependencies.preflightEnclaveArtifacts ?? preflightCloudHypervisorEnclaveArtifacts)({
      releaseTag,
      manifestPath,
      manifestBundlePath,
      rootfsPath,
      scriptRootfsPath,
      agentRootfsPath,
      attestationToolPath,
    }, undefined, undefined, new HostPreflightReporter('bounded-artifacts', options.onHostPreflight,
      undefined, { phase: 'preflight', profile: 'common' }));
    return new CloudHypervisorHostEnclaveExecutorBackend({
      runState: options.runState,
      config: options.config,
      workDir: options.workDir,
      publicDebugArtifactDirectory: options.publicDebugArtifactDirectory,
      publicDebugArtifactProtectedRoot: options.publicDebugArtifactProtectedRoot,
      preflight,
      enclaveArtifacts,
      agentPolicies: options.agentPolicies,
      managerDependencies: options.managerDependencies,
      ownsPreflightSnapshot: dependencies.preflight === undefined,
    }, dependencies);
  } catch (error) {
    await (dependencies.removeArtifactSnapshot ?? defaultDependencies.removeArtifactSnapshot)(
      preflight.artifactSnapshotDirectory,
    );
    throw error;
  }
}

/**
 * Trusted host-side executor. The broker can select only a pre-admitted
 * static seed and finite-schema payload; all VM, network, storage, deadline,
 * credential, and agent settings are host-derived.
 */
export class CloudHypervisorHostEnclaveExecutorBackend implements HostEnclaveExecutorBackend {
  private readonly dependencies: HostEnclaveExecutorDependencies;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly options: HostEnclaveExecutionOptions,
    dependencies: Partial<HostEnclaveExecutorDependencies> = {},
  ) {
    if (
      !options.config.previewEnabled ||
      options.config.developmentAllowUnattestedArtifacts === true ||
      options.config.artifactReleaseTag !== options.enclaveArtifacts.manifest.release.tag
    ) {
      throw new Error('Host enclave execution requires the matching trusted Cloud Hypervisor release');
    }
    this.dependencies = { ...defaultDependencies, ...dependencies };
    if (
      Boolean(options.config.enclaveDebugPublic) !== Boolean(options.publicDebugArtifactDirectory)
      || Boolean(options.publicDebugArtifactDirectory) !== Boolean(options.publicDebugArtifactProtectedRoot)
    ) {
      throw new Error('Public enclave debug requires host-verified public fixtures and a protected artifact directory');
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.options.ownsPreflightSnapshot
      ? this.dependencies.removeArtifactSnapshot(this.options.preflight.artifactSnapshotDirectory)
      : Promise.resolve();
    return this.closePromise;
  }

  async execute(
    plan: HostExecutorInvocationPlan,
    signal: AbortSignal,
  ): Promise<HostExecutorBackendResult> {
    if (this.closed) return { outcome: 'executor-failure' };
    if (signal.aborted) return { outcome: 'cancelled' };
    if (plan.selector !== undefined || plan.seedHostPath === undefined) {
      return { outcome: 'executor-failure' };
    }
    const progress = new HostEnclaveExecutionProgress(this.options.runState, plan, {
      directory: this.options.publicDebugArtifactDirectory,
      protectedRoot: this.options.publicDebugArtifactProtectedRoot,
      managerDependencies: this.options.managerDependencies,
    });
    let policy: HostExecutorAgentPolicy | undefined;
    try { policy = await progress.check('policy', () => resolveInvocationPolicy(plan, this.options.agentPolicies)); } catch (error) {
      if (!progress.evidence.operations) throw error;
      try {
        await progress.evidence.retainPolicyFailure(this.dependencies);
      } catch { return { outcome: 'executor-failure', cleanupComplete: false }; }
      return { outcome: 'executor-failure' };
    }
    const resources = new HostEnclaveInvocationResources(plan, this.dependencies, this.options.preflight.tools, progress.diagnostic);
    const runId = hostExecutorVmRunId(plan);
    const interruption = new HostEnclaveInvocationInterruption(resources, signal, progress.diagnostic);
    let outcome: HostExecutorBackendResult = { outcome: 'executor-failure' };
    try {
      interruption.assertActive();
      const executionResult = await startGuestWorkload(resources, this.options, policy, progress, interruption, runId);
      outcome = await readHostEnclaveResult(resources, policy, progress, interruption, executionResult, signal);
    } catch {
      outcome = interruption.failureOutcome();
    } finally {
      outcome = await cleanupHostEnclaveInvocation(resources, policy, progress, interruption, outcome, this.dependencies);
    }
    if (outcome.cleanupComplete === false) this.closed = true;
    return outcome;
  }
}
