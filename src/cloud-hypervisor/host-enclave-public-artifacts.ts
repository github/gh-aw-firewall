import * as path from 'path';
import type { HostExecutorInvocationDiagnostics } from '../enclave/host-executor-diagnostics';
import type { HostExecutorBackendResult, HostExecutorInvocationPlan } from '../enclave/host-executor-server';
import { preservePublicEnclaveArtifacts, readPublicEnclaveFile, type PublicEnclaveFailure,
  type PublicEnclaveStage, type PublicEnclaveStream } from '../enclave/public-debug-artifacts';
import {
  projectPublicEnclaveEntrypointEvent, PublicEnclaveOperationRecorder, type PublicEnclaveOperationStage,
} from '../enclave/public-debug-events';
import { preservePublicEnclaveSession } from './diagnostics';
import type { HostEnclaveExecutorDependencies, HostEnclaveExecutorManager,
  HostExecutorAgentPolicy } from './enclave-executor-types';
import { agentEnvironmentSecrets } from './enclave-invocation-staging';
import { readEnclaveSessionDiagnostics, type EnclaveSessionDiagnostics } from './enclave-session-diagnostics';
import type { HostEnclaveInvocationFilesystem } from './host-enclave-filesystem';
import { resolveCloudHypervisorManagerDependencies } from './manager';
import type { CloudHypervisorManagerDependencies } from './manager-types';

export function hostEnclaveOperationStage(id: string): PublicEnclaveOperationStage {
  if (['policy', 'input-staging', 'export-plan'].includes(id)) return 'authority-handoff';
  if (['snapshot', 'snapshot-digest', 'workload-profile'].includes(id)) return 'storage-probe';
  if (id === 'manager-create') return 'workload-create';
  if (['manager-start', 'instance-start'].includes(id)) return 'workload-start';
  if (id === 'guest-execute') return 'workload-exit';
  if (id === 'result-read') return 'output-validation';
  return 'storage-preparation';
}

export class HostEnclavePublicArtifacts {
  readonly operations: PublicEnclaveOperationRecorder | undefined;
  stage: PublicEnclaveStage = 'setup';
  failure: PublicEnclaveFailure = 'setup-failed';
  exitCode: number | null = null;
  private sessionMetadata: EnclaveSessionDiagnostics | undefined;
  private artifact: Parameters<typeof preservePublicEnclaveArtifacts>[0] | undefined;

  constructor(private readonly options: {
    readonly plan: HostExecutorInvocationPlan;
    readonly publicDebugArtifactDirectory?: string;
    readonly publicDebugArtifactProtectedRoot?: string;
    readonly managerDependencies?: CloudHypervisorManagerDependencies;
  }) {
    this.operations = options.publicDebugArtifactDirectory ? new PublicEnclaveOperationRecorder() : undefined;
  }

  private get directory(): string {
    return path.join(this.options.publicDebugArtifactDirectory!, this.options.plan.runId, this.options.plan.invocationId);
  }

  private secrets(policy: HostExecutorAgentPolicy | undefined): string[] {
    return policy ? [
      policy.githubBearer ?? '', policy.githubAgentId ?? '', policy.modelBudgetSecret ?? '',
      ...agentEnvironmentSecrets(policy, this.options.plan),
    ] : [];
  }

  async preserveSetupFailure(
    dependencies: Pick<HostEnclaveExecutorDependencies, 'preservePublicArtifacts'>,
  ): Promise<void> {
    const { plan } = this.options;
    await (dependencies.preservePublicArtifacts ?? preservePublicEnclaveArtifacts)({
      directory: this.directory,
      protectedRoot: this.options.publicDebugArtifactProtectedRoot!,
      stdout: { status: 'unavailable' }, stderr: { status: 'unavailable' }, session: { status: 'unavailable' },
      secrets: [], dependencies: resolveCloudHypervisorManagerDependencies(this.options.managerDependencies),
      envelope: {
        version: 1, runId: plan.runId, invocationId: plan.invocationId, entryId: plan.entryId,
        executorKind: plan.executorKind, runtime: 'cloud-hypervisor', stage: 'setup', failure: 'setup-failed',
        exitCode: null, workloadStopped: true, workloadLaunched: false, ...this.operations!.snapshot(),
      },
    });
  }

  async readSession(
    filesystem: HostEnclaveInvocationFilesystem,
    policy: HostExecutorAgentPolicy | undefined,
    diagnostic: HostExecutorInvocationDiagnostics,
  ): Promise<void> {
    const dependencies = filesystem.dependencies;
    await filesystem.journal?.verifyMount();
    const metadata = await (dependencies.readSessionDiagnostics ?? readEnclaveSessionDiagnostics)(
      this.options.plan.invocationHostDir,
      undefined,
      undefined,
      this.options.publicDebugArtifactDirectory
        ? (value) => {
          this.sessionMetadata = JSON.parse(value) as EnclaveSessionDiagnostics;
          return (dependencies.preservePublicSession ?? preservePublicEnclaveSession)(
            this.directory,
            this.options.publicDebugArtifactProtectedRoot!,
            `${value}\n`,
            this.secrets(policy),
            resolveCloudHypervisorManagerDependencies(
              filesystem.storage?.managerDependencies ?? this.options.managerDependencies,
            ),
          );
        }
        : undefined,
    );
    diagnostic.guestSession(metadata);
    if (this.options.publicDebugArtifactDirectory) this.sessionMetadata = metadata;
  }

  async preserve(
    filesystem: HostEnclaveInvocationFilesystem,
    policy: HostExecutorAgentPolicy | undefined,
    outcome: HostExecutorBackendResult,
    manager: HostEnclaveExecutorManager | undefined,
  ): Promise<void> {
    const { plan } = this.options;
    const directory = this.directory;
    const metadata = this.sessionMetadata;
    const [stdout, stderr, session] = await Promise.all([
      readPublicEnclaveFile(directory, 'stdout.log', 0, 0),
      readPublicEnclaveFile(directory, 'stderr.log', 0, 0),
      metadata ? Promise.resolve<PublicEnclaveStream>({
        status: metadata.status === 'captured' || metadata.status === 'empty'
          || metadata.status === 'invalid' ? 'captured'
          : metadata.status === 'not-stopped' ? 'unavailable' : metadata.status,
      })
        : plan.executorKind === 'agent' ? readPublicEnclaveFile(directory, 'enclave-session.log', 0, 0)
        : Promise.resolve({ status: 'not-applicable' as const }),
    ]);
    const secrets = this.secrets(policy);
    this.operations?.record(projectPublicEnclaveEntrypointEvent({
      sessionMetadata: metadata, session, stderr, secrets,
    }));
    this.artifact = {
      directory, protectedRoot: this.options.publicDebugArtifactProtectedRoot!,
      stdout, stderr, session, sessionMetadata: metadata,
      secrets,
      envelope: {
        version: 1, runId: plan.runId, invocationId: plan.invocationId, entryId: plan.entryId,
        executorKind: plan.executorKind, runtime: 'cloud-hypervisor', workloadStopped: true,
        stage: this.stage, failure: outcome.outcome === 'timeout' ? 'timeout'
          : outcome.outcome === 'cancelled' ? 'cancelled' : this.failure, exitCode: this.exitCode,
        workloadLaunched: Boolean(manager),
        ...this.operations?.snapshot(),
        vmCountersAvailable: manager?.publicDiagnosticEvidence?.().vmCountersAvailable ?? false,
      },
      dependencies: resolveCloudHypervisorManagerDependencies(
        filesystem.storage?.managerDependencies ?? this.options.managerDependencies,
      ),
    };
    await (filesystem.dependencies.preservePublicArtifacts ?? preservePublicEnclaveArtifacts)(this.artifact);
  }

  async preserveCleanupFailure(
    dependencies: Pick<HostEnclaveExecutorDependencies, 'preservePublicArtifacts'>,
  ): Promise<void> {
    if (!this.artifact || !this.operations?.cleanupFailure) return;
    try {
      await (dependencies.preservePublicArtifacts ?? preservePublicEnclaveArtifacts)({
        ...this.artifact,
        envelope: { ...this.artifact.envelope, ...this.operations.snapshot() },
      });
    } catch { /* The original retained evidence or the invocation source is preserved. */ }
  }
}
