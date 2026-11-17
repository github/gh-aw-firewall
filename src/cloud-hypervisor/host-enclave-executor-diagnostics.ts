import * as path from 'path';
import type { HostExecutorInvocationPlan } from '../enclave/host-executor-server';
import type { HostExecutorInvocationDiagnostics } from '../enclave/host-executor-diagnostics';
import { preservePublicEnclaveArtifacts, readPublicEnclaveFile, type PublicEnclaveFailure,
  type PublicEnclaveStage, type PublicEnclaveStream } from '../enclave/public-debug-artifacts';
import {
  projectPublicEnclaveEntrypointEvent, PublicEnclaveOperationRecorder, type PublicEnclaveOperationStage,
} from '../enclave/public-debug-events';
import { preservePublicEnclaveSession } from './diagnostics';
import { projectEnclaveSessionDiagnostics, readEnclaveSessionDiagnostics, type EnclaveSessionDiagnostics } from './enclave-session-diagnostics';
import type { HostEnclaveExecutorDependencies, HostExecutorAgentPolicy } from './enclave-executor-types';
import { agentEnvironmentSecrets } from './enclave-invocation-staging';
import type { HostEnclaveInvocationResources } from './host-enclave-executor-cleanup';
import { resolveCloudHypervisorManagerDependencies } from './manager';
import type { CloudHypervisorManagerDependencies } from './manager-types';

export function invocationOperationStage(id: string): PublicEnclaveOperationStage {
  if (['policy', 'input-staging', 'export-plan'].includes(id)) return 'authority-handoff';
  if (['snapshot', 'snapshot-digest', 'workload-profile'].includes(id)) return 'storage-probe';
  if (id === 'manager-create') return 'workload-create';
  if (['manager-start', 'instance-start'].includes(id)) return 'workload-start';
  if (id === 'guest-execute') return 'workload-exit';
  if (id === 'result-read') return 'output-validation';
  return 'storage-preparation';
}

/** Evidence retention precedes destructive cleanup; failures keep the source resources. */
export class HostEnclaveInvocationEvidence {
  readonly operations?: PublicEnclaveOperationRecorder;
  stage: PublicEnclaveStage = 'setup';
  failure: PublicEnclaveFailure = 'setup-failed';
  exitCode: number | null = null;
  private artifact?: Parameters<typeof preservePublicEnclaveArtifacts>[0];
  private sessionMetadata?: EnclaveSessionDiagnostics;

  constructor(
    private readonly plan: HostExecutorInvocationPlan,
    private readonly diagnostic: HostExecutorInvocationDiagnostics,
    private readonly debug: {
      directory?: string;
      protectedRoot?: string;
      managerDependencies?: CloudHypervisorManagerDependencies;
    },
  ) {
    this.operations = debug.directory ? new PublicEnclaveOperationRecorder() : undefined;
  }

  async retainPolicyFailure(dependencies: HostEnclaveExecutorDependencies): Promise<void> {
    await (dependencies.preservePublicArtifacts ?? preservePublicEnclaveArtifacts)({
      directory: path.join(this.debug.directory!, this.plan.runId, this.plan.invocationId),
      protectedRoot: this.debug.protectedRoot!,
      stdout: { status: 'unavailable' }, stderr: { status: 'unavailable' }, session: { status: 'unavailable' },
      secrets: [], dependencies: resolveCloudHypervisorManagerDependencies(this.debug.managerDependencies),
      envelope: {
        version: 1, runId: this.plan.runId, invocationId: this.plan.invocationId, entryId: this.plan.entryId,
        executorKind: this.plan.executorKind, runtime: 'cloud-hypervisor', stage: 'setup', failure: 'setup-failed',
        exitCode: null, workloadStopped: true, workloadLaunched: false, ...this.operations!.snapshot(),
      },
    });
  }

  private secrets(policy: HostExecutorAgentPolicy | undefined): string[] {
    return policy ? [
      policy.githubBearer ?? '', policy.githubAgentId ?? '', policy.modelBudgetSecret ?? '',
      ...agentEnvironmentSecrets(policy, this.plan),
    ] : [];
  }

  async retain(
    resources: HostEnclaveInvocationResources,
    policy: HostExecutorAgentPolicy | undefined,
    stderr: Buffer,
    outcome: string,
    cleanupError: unknown,
  ): Promise<unknown> {
    const { plan, diagnostic } = this;
    const role = plan.executorKind;
    const dependencies = resources.dependencies;
    if (role === 'agent' && (resources.managerStopped || !resources.manager) && resources.mounted) {
      try {
        if (stderr.length) diagnostic.guestFileOperations(projectEnclaveSessionDiagnostics(stderr));
        await resources.journal?.verifyMount();
        const sessionMetadata = await (dependencies.readSessionDiagnostics ?? readEnclaveSessionDiagnostics)(
          plan.invocationHostDir, undefined, undefined,
          this.debug.directory ? (metadata) => {
            this.sessionMetadata = JSON.parse(metadata) as EnclaveSessionDiagnostics;
            return (dependencies.preservePublicSession ?? preservePublicEnclaveSession)(
              path.join(this.debug.directory!, plan.runId, plan.invocationId),
              this.debug.protectedRoot!, `${metadata}\n`, this.secrets(policy),
              resolveCloudHypervisorManagerDependencies(
                resources.storage?.managerDependencies ?? this.debug.managerDependencies,
              ),
            );
          } : undefined,
        );
        diagnostic.guestSession(sessionMetadata);
        if (this.debug.directory) this.sessionMetadata = sessionMetadata;
      } catch (error) {
        this.operations?.fail('cleanup', error, true, 'retention-failed');
        diagnostic.guestSession({ status: 'read-failed' });
        cleanupError ??= error;
      }
    } else if (role === 'agent' && resources.manager && !resources.managerStopped) {
      diagnostic.guestSession({ status: 'not-stopped' });
    }
    if (this.debug.directory && (!resources.manager || resources.managerStopped)) {
      try {
        await resources.journal?.publicDebugRetention?.(true);
        const directory = path.join(this.debug.directory, plan.runId, plan.invocationId);
        const [stdout, stderrStream, session] = await Promise.all([
          readPublicEnclaveFile(directory, 'stdout.log', 0, 0),
          readPublicEnclaveFile(directory, 'stderr.log', 0, 0),
          this.sessionMetadata ? Promise.resolve<PublicEnclaveStream>({
            status: this.sessionMetadata.status === 'captured' || this.sessionMetadata.status === 'empty'
              || this.sessionMetadata.status === 'invalid' ? 'captured'
              : this.sessionMetadata.status === 'not-stopped' ? 'unavailable' : this.sessionMetadata.status,
          }) : role === 'agent' ? readPublicEnclaveFile(directory, 'enclave-session.log', 0, 0)
            : Promise.resolve({ status: 'not-applicable' as const }),
        ]);
        const secrets = this.secrets(policy);
        this.operations?.record(projectPublicEnclaveEntrypointEvent({
          sessionMetadata: this.sessionMetadata, session, stderr: stderrStream, secrets,
        }));
        this.artifact = {
          directory, protectedRoot: this.debug.protectedRoot!,
          stdout, stderr: stderrStream, session, sessionMetadata: this.sessionMetadata, secrets,
          envelope: {
            version: 1, runId: plan.runId, invocationId: plan.invocationId, entryId: plan.entryId,
            executorKind: role, runtime: 'cloud-hypervisor', workloadStopped: true,
            stage: this.stage, failure: outcome === 'timeout' ? 'timeout'
              : outcome === 'cancelled' ? 'cancelled' : this.failure, exitCode: this.exitCode,
            workloadLaunched: Boolean(resources.manager), ...this.operations?.snapshot(),
            vmCountersAvailable: resources.manager?.publicDiagnosticEvidence?.().vmCountersAvailable ?? false,
          },
          dependencies: resolveCloudHypervisorManagerDependencies(
            resources.storage?.managerDependencies ?? this.debug.managerDependencies,
          ),
        };
        await (dependencies.preservePublicArtifacts ?? preservePublicEnclaveArtifacts)(this.artifact);
        if (cleanupError === undefined) await resources.journal?.publicDebugRetention?.(false);
      } catch (error) {
        this.operations?.fail('cleanup', error, true, 'retention-failed');
        cleanupError ??= error;
      }
    }
    return cleanupError;
  }

  async refreshCleanupFailure(dependencies: HostEnclaveExecutorDependencies, cleanupError: unknown): Promise<void> {
    if (cleanupError !== undefined && this.artifact && this.operations?.cleanupFailure) {
      try {
        await (dependencies.preservePublicArtifacts ?? preservePublicEnclaveArtifacts)({
          ...this.artifact,
          envelope: { ...this.artifact.envelope, ...this.operations.snapshot() },
        });
      } catch { /* The original retained evidence or the invocation source is preserved. */ }
    }
  }
}
