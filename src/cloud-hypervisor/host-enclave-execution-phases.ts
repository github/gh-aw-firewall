import * as path from 'path';
import type { HostExecutorBackendResult, HostExecutorRunState } from '../enclave/host-executor-server';
import type { HostExecutorInvocationDiagnostics } from '../enclave/host-executor-diagnostics';
import { HOST_EXECUTOR_TIMEOUT_GRACE_MS } from '../enclave/host-executor-protocol';
import { guestExecutionFailureReason } from '../microvm/vsock-client';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { HostExecutorAgentPolicy, VerifiedCloudHypervisorEnclaveArtifacts } from './enclave-executor-types';
import { agentEnvironment, agentEnvironmentSecrets } from './enclave-invocation-staging';
import type { HostEnclaveInvocationResources } from './host-enclave-executor-cleanup';
import { assertGithubCapabilityLifetime } from './host-enclave-executor-policy';
import { stageHostEnclaveInvocation } from './host-enclave-executor-staging';
import type { HostEnclaveExecutionProgress } from './host-enclave-result';
import { markHostPreflightError } from './host-preflight-progress';
import { resolveCloudHypervisorManagerDependencies } from './manager';
import type { CloudHypervisorManagerDependencies } from './manager-types';
import type { CloudHypervisorCommonPreflightResult } from './preflight';
import { CLOUD_HYPERVISOR_ENCLAVE_ENTRYPOINTS, CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES } from './workload-profile';

export interface HostEnclaveExecutionOptions {
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
}

export class HostEnclaveInvocationInterruption {
  timedOut = false;
  aborted: boolean;
  private readonly interruption: Promise<never>;
  private rejectInterruption?: (error: Error) => void;
  private readonly deadline: ReturnType<typeof setTimeout>;

  constructor(
    private readonly resources: HostEnclaveInvocationResources,
    private readonly signal: AbortSignal,
    private readonly diagnostic: HostExecutorInvocationDiagnostics,
  ) {
    this.aborted = signal.aborted;
    this.interruption = new Promise<never>((_resolve, reject) => {
      this.rejectInterruption = reject;
    });
    void this.interruption.catch(() => undefined);
    signal.addEventListener('abort', this.abortManager, { once: true });
    this.deadline = setTimeout(() => {
      this.timedOut = true;
      this.abortManager();
    }, resources.plan.timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS);
  }

  private readonly abortManager = (): void => {
    this.aborted = true;
    this.diagnostic.milestone(this.timedOut ? 'deadline-expired' : 'cancellation');
    void this.resources.manager?.cancel('host executor cancelled').catch(() => undefined);
    if (this.resources.manager) void this.resources.stopManager().catch(() => undefined);
    this.rejectInterruption?.(markHostPreflightError(new Error('Host executor invocation was interrupted'),
      this.timedOut ? 'invocation-timeout' : 'invocation-cancelled'));
  };

  readonly race = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, this.interruption]);

  readonly assertActive = (): void => {
    if (this.aborted) throw new Error('Host executor invocation was cancelled');
  };

  failureOutcome(): HostExecutorBackendResult {
    return this.timedOut ? { outcome: 'timeout' }
      : this.aborted || this.signal.aborted ? { outcome: 'cancelled' } : { outcome: 'executor-failure' };
  }

  dispose(): void {
    this.signal.removeEventListener('abort', this.abortManager);
    clearTimeout(this.deadline);
  }
}

export async function startGuestWorkload(
  resources: HostEnclaveInvocationResources,
  options: HostEnclaveExecutionOptions,
  policy: HostExecutorAgentPolicy | undefined,
  progress: HostEnclaveExecutionProgress,
  interruption: HostEnclaveInvocationInterruption,
  runId: string,
) {
  const { plan } = resources;
  const { report, check, diagnostic, evidence, stderr } = progress;
  const { artifacts, profile } = await stageHostEnclaveInvocation(
    resources,
    {
      run: options.runState, preflight: options.preflight, enclaveArtifacts: options.enclaveArtifacts,
      policy, publicDebug: Boolean(options.publicDebugArtifactDirectory),
    },
    {
      report, check, race: interruption.race, assertActive: interruption.assertActive,
      resourcePublished: () => diagnostic.resourcePublished(options.runState, plan),
    },
  );
  const managerConfig = {
    ...options.config,
    cloudHypervisorBinary: artifacts.cloudHypervisorBinary,
  };
  const managerDependencies = resources.storage?.managerDependencies ?? options.managerDependencies;
  const debugDirectory = options.publicDebugArtifactDirectory;
  const enclaveDebugArtifactDirectory = debugDirectory
    ? (() => {
        const baseDirectory = path.resolve(debugDirectory);
        const candidateDirectory = path.resolve(baseDirectory, plan.runId, plan.invocationId);
        const relative = path.relative(baseDirectory, candidateDirectory);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error('Invalid debug artifact directory path components');
        }
        return candidateDirectory;
      })()
    : undefined;
  resources.manager = await check('manager-create', () => resources.dependencies.createManager(
    managerConfig,
    resources.storage?.workDir ?? options.workDir,
    profile,
    runId,
    artifacts,
    debugDirectory
      ? {
          ...resolveCloudHypervisorManagerDependencies(managerDependencies),
          enclaveDebugArtifactDirectory,
          enclaveDebugArtifactProtectedRoot: options.publicDebugArtifactProtectedRoot,
          enclaveDebugSecrets: policy ? [
            policy.githubBearer ?? '', policy.githubAgentId ?? '', policy.modelBudgetSecret ?? '',
            ...agentEnvironmentSecrets(policy, plan),
          ] : [],
        }
      : managerDependencies,
    report.fork('vm-launch'),
    report,
  ));
  interruption.assertActive();
  await check('manager-start', () => interruption.race(resources.track(resources.manager!.start())));
  interruption.assertActive();
  await check('instance-start', () => interruption.race(resources.track(resources.manager!.startInstance())));
  interruption.assertActive();
  assertGithubCapabilityLifetime(policy, plan.timeoutMs);
  evidence.stage = 'execution';
  evidence.failure = 'execution-exception';
  const role = plan.executorKind;
  return check('guest-execute', () => interruption.race(resources.manager!.execute({
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
    ...(role === 'agent' ? { stderr } : {}),
  }).catch((error: unknown) => {
    const reason = guestExecutionFailureReason(error);
    throw reason ? markHostPreflightError(error, reason) : error;
  })));
}
