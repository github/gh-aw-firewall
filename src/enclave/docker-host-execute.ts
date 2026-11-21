import * as fs from 'fs';
import * as path from 'path';
import type { HostEnclaveExecutorBackend, HostExecutorInvocationPlan, HostExecutorBackendResult } from './host-executor-server';
import { HOST_EXECUTOR_ID_PATTERN, HOST_EXECUTOR_MAX_RESULT_BYTES } from './host-executor-protocol';
import { readBoundedEnclaveResult } from './invocation-result';
import { resolveDockerPublicEnclaveDebugPaths } from './public-debug';
import { preservePublicEnclaveArtifacts } from './public-debug-artifacts';
import { PublicEnclaveOperationRecorder } from './public-debug-events';
import { prepareRootOwnedDebugDirectory, writeAuditFile } from '../cloud-hypervisor/diagnostics';
import {
  createDockerHostRecoveryRecord, settleDockerHostAuthority,
} from './docker-host-recovery';
import type { DockerHostContext, InvocationAuthorityState } from './docker-host-context';
import type { DockerHostContainerOperations } from './docker-host-container';
import {
  isDockerHostInvocationPathValid, isDockerHostPlanIdentityValid, type DockerHostDebugCheck,
} from './docker-host-plan-validation';
import { prepareDockerHostStorage } from './docker-host-storage-stage';
import { prepareDockerHostRun, runDockerHostWorkload } from './docker-host-run-stage';
import { reclaimDockerHostOutput, finalizeDockerHostExecution } from './docker-host-cleanup-stage';

export function createDockerHostExecution(
  context: DockerHostContext, containers: DockerHostContainerOperations, initialize: () => Promise<void>,
): Pick<HostEnclaveExecutorBackend, 'execute'> {
  const { options, entries, journal, owner, ownerKey, backendIdentity, backendOwners, active, publicArtifacts } = context;

  async function execute(plan: HostExecutorInvocationPlan, signal: AbortSignal, authorityState: InvocationAuthorityState): Promise<HostExecutorBackendResult> {
    const diagnostic = authorityState.diagnostic;
    const debugCheck: DockerHostDebugCheck = (stage, operation, cleanup = false) =>
      diagnostic ? diagnostic.check(stage, operation, cleanup) : Promise.resolve().then(operation);
    const entry = entries.get(plan.entryId);
    if (!entry || !isDockerHostPlanIdentityValid(plan, options.runId, entry)) return { outcome: 'executor-failure' };
    if (context.closed) return { outcome: 'cancelled' };
    await debugCheck('storage-preparation', () => (context.ready ||= initialize()));
    authorityState.prepared = true;
    if (context.closed || signal.aborted) return { outcome: 'cancelled' };
    if (!await isDockerHostInvocationPathValid(plan, debugCheck)) return { outcome: 'executor-failure' };
    const invocation = { plan, entry, signal, authorityState, debugCheck };
    const launch = await prepareDockerHostRun(context, invocation);
    if ('outcome' in launch) return launch;
    const record = createDockerHostRecoveryRecord(plan, entry, launch.storageTarget, owner, options.publicDebug);
    const stage = { ...invocation, record };
    authorityState.resourcesPossible = true;
    journal.write(record, true);
    let result: HostExecutorBackendResult;
    try {
      await prepareDockerHostStorage(context, containers, stage, launch.args);
      const exitCode = await runDockerHostWorkload(context, containers, stage, launch);
      await reclaimDockerHostOutput(context, stage);
      if (signal.aborted) result = { outcome: 'cancelled' };
      else if (exitCode === 0) {
        const maximum = Math.min(Number(launch.config.maxOutputBytes || HOST_EXECUTOR_MAX_RESULT_BYTES), HOST_EXECUTOR_MAX_RESULT_BYTES);
        const bounded = await debugCheck('output-validation',
          () => readBoundedEnclaveResult(path.join(record.storageTarget, 'out'), plan.schema, maximum));
        if (bounded === undefined) diagnostic?.fail('output-validation', undefined, false, 'result-invalid');
        result = bounded === undefined ? { outcome: 'schema-failure' } : { outcome: 'success', result: bounded };
      } else {
        result = { outcome: 'executor-failure', recoverableFailure: true, cleanupComplete: true };
      }
    } catch (error) {
      if (diagnostic && !diagnostic.primaryFailure && !diagnostic.cleanupFailure) {
        diagnostic.fail(diagnostic.events[diagnostic.events.length - 1]?.stage ?? 'storage-preparation', error);
      }
      result = { outcome: signal.aborted ? 'cancelled' : 'executor-failure' };
    }
    return finalizeDockerHostExecution(context, containers, stage, result, launch.debugSecrets);
  }

  async function executeAndSettle(plan: HostExecutorInvocationPlan, signal: AbortSignal): Promise<HostExecutorBackendResult> {
    const entry = entries.get(plan.entryId);
    const publicEligible = options.publicDebug && plan.runId === options.runId
      && entry?.executorKind === plan.executorKind && HOST_EXECUTOR_ID_PATTERN.test(plan.invocationId)
      && plan.selector === undefined;
    const state: InvocationAuthorityState = {
      attempted: false, resolved: false, prepared: false, resourcesPossible: false,
      ...(publicEligible ? { diagnostic: new PublicEnclaveOperationRecorder() } : {}),
    };
    let result: HostExecutorBackendResult;
    try { result = await execute(plan, signal, state); }
    catch (error) {
      result = {
        outcome: signal.aborted ? 'cancelled' : 'executor-failure',
        ...(!state.prepared || state.resourcesPossible ? { cleanupComplete: false } : {}),
      };
      if (state.diagnostic && !state.prepared && !state.resourcesPossible) {
        const diagnostic = state.diagnostic;
        if (!diagnostic.primaryFailure) diagnostic.fail('storage-preparation', error);
        const retainUnavailable = async () => {
          const { protectedRoot, root } = resolveDockerPublicEnclaveDebugPaths();
          const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
          const dependencies = { ...fs.promises, resolveIdentity: () => identity };
          const prepared = await prepareRootOwnedDebugDirectory(
            path.join(root, plan.runId, plan.invocationId), protectedRoot, dependencies, identity,
          );
          await writeAuditFile(dependencies, path.join(prepared.directory, 'retention-unavailable.json'), `${JSON.stringify({
            version: 1, runId: plan.runId, invocationId: plan.invocationId, entryId: plan.entryId,
            executorKind: plan.executorKind, runtime: 'docker', stage: 'setup', status: 'unavailable',
            reason: 'host-reconciliation-incomplete', ...diagnostic.snapshot(),
          })}\n`, prepared.identity);
          const directory = await dependencies.open(prepared.directory,
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          try { await directory.sync(); } finally { await directory.close(); }
        };
        try { await retainUnavailable(); }
        catch (retentionError) {
          diagnostic.fail('cleanup', retentionError, true, 'retention-failed');
          try { await retainUnavailable(); } catch { /* Unreconciled resources remain untouched. */ }
        }
      }
      // Initialization may discover an earlier uncertain workload. Only completed
      // host reconciliation, not missing invocation files, proves no launch here.
      if (state.diagnostic && state.prepared && !state.resourcesPossible) {
        if (!state.diagnostic.primaryFailure) {
          state.diagnostic.fail(state.attempted ? 'authority-handoff' : 'storage-preparation', error);
        }
        const { protectedRoot, root } = resolveDockerPublicEnclaveDebugPaths();
        const uid = process.getuid?.() ?? 0;
        const artifact: Parameters<typeof preservePublicEnclaveArtifacts>[0] = {
          directory: path.join(root, plan.runId, plan.invocationId), protectedRoot,
          stdout: { status: 'unavailable' }, stderr: { status: 'unavailable' },
          session: { status: plan.executorKind === 'agent' ? 'unavailable' : 'not-applicable' },
          secrets: [], owner: { uid, gid: process.getgid?.() ?? 0 },
          dependencies: { ...fs.promises, resolveIdentity: () => ({ uid, gid: process.getgid?.() ?? 0 }) },
          envelope: {
            version: 1, runId: plan.runId, invocationId: plan.invocationId, entryId: plan.entryId,
            executorKind: plan.executorKind, runtime: 'docker', stage: 'setup', failure: 'setup-failed',
            exitCode: null, workloadStopped: true, workloadLaunched: false, ...state.diagnostic.snapshot(),
          },
        };
        try { await preservePublicEnclaveArtifacts(artifact); }
        catch (retentionError) {
          state.diagnostic.fail('cleanup', retentionError, true, 'retention-failed');
          artifact.envelope = {
            ...artifact.envelope, ...state.diagnostic.snapshot(), stage: 'retention', failure: 'retention-failed',
          };
          try { await preservePublicEnclaveArtifacts(artifact); } catch { /* No invocation source was allocated. */ }
          result = { outcome: 'executor-failure', cleanupComplete: false };
        }
      }
    }
    if (state.attempted && options.settleAgentAuthority) {
      const entry = entries.get(plan.entryId)!;
      result = await settleDockerHostAuthority(plan, entry, result, state,
        (invocation, settlement) => options.settleAgentAuthority!(invocation, settlement));
    }
    if (result.cleanupComplete === false) context.cleanupIncomplete = true;
    return result;
  }

  return {
    execute(plan, signal) {
      const owners = backendOwners.get(ownerKey) || new Set<symbol>();
      if ([...owners].some((value) => value !== backendIdentity)) {
        return Promise.resolve({ outcome: 'executor-failure', cleanupComplete: false });
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) controller.abort();
      const handle = { controller, done: Promise.resolve<HostExecutorBackendResult>({ outcome: 'executor-failure' }) };
      active.add(handle);
      owners.add(backendIdentity);
      backendOwners.set(ownerKey, owners);
      handle.done = executeAndSettle(plan, controller.signal).finally(() => {
        publicArtifacts.delete(plan.invocationId);
        signal.removeEventListener('abort', cancel);
        active.delete(handle);
        if (active.size === 0) {
          owners.delete(backendIdentity);
          if (owners.size === 0) backendOwners.delete(ownerKey);
        }
      });
      return handle.done;
    },
  };
}
