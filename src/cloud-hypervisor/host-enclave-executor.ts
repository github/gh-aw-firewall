import { promises as fs } from 'fs';
import * as path from 'path';
import { resolveOperatorIdentity } from '../sudo-identity';
import { readBoundedEnclaveResult as readBoundedCloudHypervisorEnclaveResult } from '../enclave/invocation-result';
export { readBoundedEnclaveResult as readBoundedCloudHypervisorEnclaveResult } from '../enclave/invocation-result';
import type {
  HostEnclaveExecutorBackend,
  HostExecutorInvocationPlan,
  HostExecutorRunState,
  HostExecutorBackendResult,
} from '../enclave/host-executor-server';
import { HOST_EXECUTOR_MAX_RESULT_BYTES, HOST_EXECUTOR_TIMEOUT_GRACE_MS } from '../enclave/host-executor-protocol';
import {
  HostExecutorResourceJournal,
  reapHostExecutorResources,
} from '../enclave/host-executor-resource-journal';
import { HostExecutorInvocationDiagnostics } from '../enclave/host-executor-diagnostics';
import {
  hostExecutorJournalDirectory,
  hostExecutorVmRunId,
} from '../enclave/host-executor-journal';
import { HostPreflightReporter, markHostPreflightError } from './host-preflight-progress';
import { guestExecutionFailureReason } from '../microvm/vsock-client';
import { HostEnclaveStderr } from './host-enclave-executor-stderr';
import { assertGithubCapabilityLifetime, resolveInvocationPolicy } from './host-enclave-executor-policy';
import { HostEnclaveInvocationResources } from './host-enclave-executor-cleanup';
import { stageHostEnclaveInvocation } from './host-enclave-executor-staging';
import { HostEnclaveInvocationEvidence, invocationOperationStage } from './host-enclave-executor-diagnostics';
import { DurableCloudHypervisorCleanupRegistry } from './cleanup-registry';
import {
  assertBoundedEnclaveStorage, mountBoundedEnclaveStorage, unmountBoundedEnclaveStorage,
} from './enclave-storage';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import {
  createArtifactSnapshot,
  createCommonArtifactSnapshot,
} from './artifact-snapshot';
import type { CloudHypervisorEnclaveRole } from './enclave-artifact-manifest';
import {
  CloudHypervisorManager,
  resolveCloudHypervisorManagerDependencies,
} from './manager';
import type {
  CloudHypervisorManagerDependencies,
} from './manager-types';
import type { CloudHypervisorCommonPreflightResult } from './preflight';
import { copySparseFileWithRsync, runCloudHypervisorCommonPreflight } from './preflight';
import {
  preflightCloudHypervisorEnclaveArtifacts,
  resolveTrustedAttestationTool,
} from './enclave-artifact-preflight';
import {
  agentEnvironmentSecrets,
  agentEnvironment,
} from './enclave-invocation-staging';
import type {
  CreateCloudHypervisorHostEnclaveExecutorOptions,
  HostEnclaveExecutorDependencies,
  HostExecutorAgentPolicy,
  VerifiedCloudHypervisorEnclaveArtifacts,
} from './enclave-executor-types';
import {
  CLOUD_HYPERVISOR_ENCLAVE_ENTRYPOINTS,
  CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES,
} from './workload-profile';

export type {
  CloudHypervisorEnclaveArtifactPreflightOptions,
  CreateCloudHypervisorHostEnclaveExecutorOptions,
  HostEnclaveExecutorDependencies,
  HostEnclaveExecutorManager,
  HostExecutorAgentPolicy,
  VerifiedCloudHypervisorEnclaveArtifacts,
} from './enclave-executor-types';
export { preflightCloudHypervisorEnclaveArtifacts } from './enclave-artifact-preflight';

const OUTPUT_NAME = 'out';

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

function filePath(directory: string, name: string): string {
  const result = path.join(directory, name);
  if (path.dirname(result) !== directory) throw new Error('Invalid enclave artifact path');
  return result;
}

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
    private readonly options: {
      readonly runState: HostExecutorRunState;
      readonly config: CloudHypervisorOptions;
      readonly workDir: string;
      readonly publicDebugArtifactDirectory?: string;
      readonly publicDebugArtifactProtectedRoot?: string;
      readonly preflight: CloudHypervisorCommonPreflightResult;
      readonly enclaveArtifacts: VerifiedCloudHypervisorEnclaveArtifacts;
      readonly agentPolicies?: Readonly<Record<string, HostExecutorAgentPolicy>>;
      readonly managerDependencies?: CloudHypervisorManagerDependencies;
      readonly ownsPreflightSnapshot?: boolean;
    },
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
    const diagnostic = new HostExecutorInvocationDiagnostics(this.options.runState, plan);
    const wrapperStderr = new HostEnclaveStderr();
    const report = new HostPreflightReporter(
      'host-invocation',
      diagnostic.publish,
      (failedReport, _id, error) => diagnostic.classifyFailure(failedReport, error),
    );
    const evidence = new HostEnclaveInvocationEvidence(plan, diagnostic, {
      directory: this.options.publicDebugArtifactDirectory,
      protectedRoot: this.options.publicDebugArtifactProtectedRoot,
      managerDependencies: this.options.managerDependencies,
    });
    const publicOperations = evidence.operations;
    const check = <T>(id: Parameters<HostPreflightReporter['check']>[0], operation: () => Promise<T> | T) => {
      const run = () => diagnostic.check(report, id, operation);
      return publicOperations ? publicOperations.check(invocationOperationStage(id), run) : run();
    };
    const cleanupOperation = <T>(operation: () => Promise<T>) =>
      publicOperations ? publicOperations.check('cleanup', operation, true) : operation();
    const role: CloudHypervisorEnclaveRole = plan.executorKind;
    let policy: HostExecutorAgentPolicy | undefined;
    try { policy = await check('policy', () => resolveInvocationPolicy(plan, this.options.agentPolicies)); } catch (error) {
      if (!publicOperations) throw error;
      try {
        await evidence.retainPolicyFailure(this.dependencies);
      } catch { return { outcome: 'executor-failure', cleanupComplete: false }; }
      return { outcome: 'executor-failure' };
    }
    const filesystemState: { timedOut: boolean; aborted: boolean } = {
      timedOut: false,
      aborted: signal.aborted,
    };
    const resources = new HostEnclaveInvocationResources(plan, this.dependencies, this.options.preflight.tools, diagnostic);
    let outcome: HostExecutorBackendResult = { outcome: 'executor-failure' };
    let guestWorkloadFailed = false;
    let cleanupError: unknown;
    const runId = hostExecutorVmRunId(plan);
    let rejectInterruption: ((error: Error) => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    void interruption.catch(() => undefined);
    const raceInterruption = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, interruption]);
    const abortManager = (): void => {
      filesystemState.aborted = true;
      diagnostic.milestone(filesystemState.timedOut ? 'deadline-expired' : 'cancellation');
      void resources.manager?.cancel('host executor cancelled').catch(() => undefined);
      if (resources.manager) void resources.stopManager().catch(() => undefined);
      rejectInterruption?.(markHostPreflightError(new Error('Host executor invocation was interrupted'),
        filesystemState.timedOut ? 'invocation-timeout' : 'invocation-cancelled'));
    };
    signal.addEventListener('abort', abortManager, { once: true });
    const deadline = setTimeout(() => {
      filesystemState.timedOut = true;
      abortManager();
    }, plan.timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS);
    try {
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      const { artifacts, profile } = await stageHostEnclaveInvocation(
        resources,
        {
          run: this.options.runState, preflight: this.options.preflight, enclaveArtifacts: this.options.enclaveArtifacts,
          policy, publicDebug: Boolean(this.options.publicDebugArtifactDirectory),
        },
        {
          report, check, race: raceInterruption,
          assertActive: () => { if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled'); },
          resourcePublished: () => diagnostic.resourcePublished(this.options.runState, plan),
        },
      );
      const managerConfig = {
        ...this.options.config,
        cloudHypervisorBinary: artifacts.cloudHypervisorBinary,
      };
      const managerDependencies = resources.storage?.managerDependencies ?? this.options.managerDependencies;
      const debugDirectory = this.options.publicDebugArtifactDirectory;
      resources.manager = await check('manager-create', () => resources.dependencies.createManager(
        managerConfig,
        resources.storage?.workDir ?? this.options.workDir,
        profile,
        runId,
        artifacts,
        debugDirectory
          ? {
              ...resolveCloudHypervisorManagerDependencies(managerDependencies),
              enclaveDebugArtifactDirectory: path.join(debugDirectory, plan.runId, plan.invocationId),
              enclaveDebugArtifactProtectedRoot: this.options.publicDebugArtifactProtectedRoot,
              enclaveDebugSecrets: policy ? [
                policy.githubBearer ?? '', policy.githubAgentId ?? '', policy.modelBudgetSecret ?? '',
                ...agentEnvironmentSecrets(policy, plan),
              ] : [],
            }
          : managerDependencies,
        report.fork('vm-launch'),
        report,
      ));
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      await check('manager-start', () => raceInterruption(resources.track(resources.manager!.start())));
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      await check('instance-start', () => raceInterruption(resources.track(resources.manager!.startInstance())));
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      assertGithubCapabilityLifetime(policy, plan.timeoutMs);
      evidence.stage = 'execution';
      evidence.failure = 'execution-exception';
      const executionResult = await check('guest-execute', () => raceInterruption(resources.manager!.execute({
        argv: [CLOUD_HYPERVISOR_ENCLAVE_ENTRYPOINTS[role]],
        cwd: '/',
        uid: CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES[role].uid,
        gid: CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES[role].gid,
        timeoutMs: plan.timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS,
        env: role === 'agent' && policy ? {
          ...agentEnvironment(policy, plan),
          ...(debugDirectory ? { AWF_ENCLAVE_AGENT_DEBUG_RAW_SESSION_LOGS: 'true' } : {}),
        } : debugDirectory ? { AWF_ENCLAVE_SCRIPT_DEBUG_PROGRESS: 'true' } : {},
        onDiagnostics: diagnostic.guestExecution,
        ...(role === 'agent' ? { stderr: wrapperStderr } : {}),
      }).catch((error: unknown) => {
        const reason = guestExecutionFailureReason(error);
        throw reason ? markHostPreflightError(error, reason) : error;
      })));
      diagnostic.milestone('guest-complete');
      evidence.exitCode = executionResult.exitCode;
      evidence.failure = executionResult.exitCode === 0 && executionResult.signal === null ? 'none' : 'workload-exit';
      if (filesystemState.timedOut || executionResult.timedOut) {
        diagnostic.fail(report, 'guest-execute', markHostPreflightError(
          new Error('Host executor invocation timed out'), 'invocation-timeout'));
        outcome = { outcome: 'timeout' };
      } else if (filesystemState.aborted || signal.aborted) {
        diagnostic.fail(report, 'guest-execute', markHostPreflightError(
          new Error('Host executor invocation was cancelled'), 'invocation-cancelled'));
        outcome = { outcome: 'cancelled' };
      } else if (executionResult.exitCode !== 0 || executionResult.signal !== null) {
        publicOperations?.fail('workload-exit', undefined, false, 'workload-exit');
        diagnostic.fail(report, 'guest-execute', markHostPreflightError(
          new Error('Host executor guest command failed'), 'command-failed'));
        outcome = { outcome: 'executor-failure' };
        guestWorkloadFailed = true;
      } else {
        // Result reads require the VM to have stopped, but cleanup failures
        // must remain distinct from the invocation's original failure.
        const cleanupReport = report.fork('host-invocation-cleanup');
        await cleanupOperation(() => diagnostic.check(cleanupReport, 'manager-stop', () => raceInterruption(resources.stopManager())));
        resources.managerStopped = true;
        await cleanupOperation(() => diagnostic.check(cleanupReport, 'manager-record', () => raceInterruption(resources.manager!.completeCleanupRecord())));
        if (filesystemState.timedOut || filesystemState.aborted || signal.aborted) {
          outcome = filesystemState.timedOut ? { outcome: 'timeout' } : { outcome: 'cancelled' };
        } else {
          const outputPath = filePath(filePath(plan.invocationHostDir, 'output'), OUTPUT_NAME);
          const maxBytes = role === 'agent'
            ? policy?.maxOutputBytes ?? HOST_EXECUTOR_MAX_RESULT_BYTES
            : HOST_EXECUTOR_MAX_RESULT_BYTES;
          diagnostic.milestone('result-read-start');
          evidence.stage = 'result';
          evidence.failure = 'result-invalid';
          const resultValue = await check('result-read', () => raceInterruption(readBoundedCloudHypervisorEnclaveResult(
            outputPath,
            plan.schema,
            maxBytes,
          )));
          diagnostic.milestone('result-read-complete');
          outcome = resultValue === undefined
            ? { outcome: 'schema-failure' }
            : { outcome: 'success', result: resultValue };
          if (resultValue === undefined) {
            publicOperations?.fail('output-validation', undefined, false, 'result-invalid');
            diagnostic.fail(report, 'result-read', markHostPreflightError(
              new Error('Host executor result is invalid'), 'result-invalid'));
          }
          if (resultValue !== undefined) {
            evidence.stage = 'complete';
            evidence.failure = 'none';
          }
        }
      }
    } catch {
      outcome = filesystemState.timedOut
        ? { outcome: 'timeout' }
        : filesystemState.aborted || signal.aborted
        ? { outcome: 'cancelled' }
        : { outcome: 'executor-failure' };
    } finally {
      diagnostic.milestone('work-complete', outcome.outcome);
      diagnostic.milestone('cleanup-start');
      signal.removeEventListener('abort', abortManager);
      clearTimeout(deadline);
      const cleanupReport = report.fork('host-invocation-cleanup');
      const cleanupCheck = <T>(id: Parameters<HostPreflightReporter['check']>[0], operation: () => Promise<T>) => {
        const run = () => diagnostic.check(cleanupReport, id, operation);
        return cleanupOperation(run);
      };
      cleanupError = await resources.drainAndStop(cleanupCheck);
      cleanupError = await evidence.retain(resources, policy, wrapperStderr.captured(), outcome.outcome, cleanupError);
      cleanupError = await resources.removeResources(cleanupCheck, cleanupError, this.dependencies);
      await evidence.refreshCleanupFailure(resources.dependencies, cleanupError);
    }
    diagnostic.milestone('cleanup-complete', cleanupError === undefined ? outcome.outcome : 'executor-failure');
    if (cleanupError !== undefined || diagnostic.persistenceFailed) {
      this.closed = true;
      return { outcome: 'executor-failure', cleanupComplete: false };
    }
    if (guestWorkloadFailed && outcome.outcome === 'executor-failure') {
      return { outcome: 'executor-failure', cleanupComplete: true, recoverableFailure: true };
    }
    return outcome;
  }
}
