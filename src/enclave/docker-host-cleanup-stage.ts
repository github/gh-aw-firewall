import * as fs from 'fs';
import * as path from 'path';
import type { DockerHostContext, DockerHostInvocationStage } from './docker-host-context';
import type { DockerHostContainerOperations } from './docker-host-container';
import type { HostExecutorBackendResult } from './host-executor-server';
import { removeDockerHostContainer } from './docker-host-recovery';
import { ownDockerHostStorageFile } from './docker-host-storage';
import { resolveDockerPublicEnclaveDebugPaths } from './public-debug';
import { preservePublicEnclaveArtifacts } from './public-debug-artifacts';

export async function reclaimDockerHostOutput(
  context: DockerHostContext, stage: DockerHostInvocationStage,
): Promise<void> {
  const { record, entry, debugCheck } = stage;
  // Remove first: only a proven stopped/removed container may yield output.
  await debugCheck('cleanup', () => removeDockerHostContainer(context.docker, record), true);
  await debugCheck('cleanup', () => ownDockerHostStorageFile(record.mount!, 'out', entry.uid, entry.gid, true), true);
  if (entry.executorKind === 'agent') {
    await debugCheck('cleanup', () => ownDockerHostStorageFile(
      record.mount!, 'session.jsonl', process.getuid?.() ?? 0, process.getgid?.() ?? 0, true,
    ), true);
  }
}

async function retainDockerHostCleanupFailure(context: DockerHostContext, stage: DockerHostInvocationStage): Promise<void> {
  const { record, entry, authorityState } = stage;
  const diagnostic = authorityState.diagnostic;
  const debug = record.publicDebug!;
  Object.assign(debug, diagnostic?.snapshot());
  context.journal.write(record);
  const capture = context.publicArtifacts.get(record.invocationId);
  if (capture) {
    const { artifact, collectionFailed } = capture;
    try {
      await preservePublicEnclaveArtifacts({
        ...artifact, envelope: {
          ...artifact.envelope, ...diagnostic?.snapshot(),
          stage: debug.stage, failure: debug.failure,
        },
      });
      if (!collectionFailed) {
        debug.pending = false;
        debug.retained = true;
      }
      context.journal.write(record);
    } catch { /* Initial retained evidence or the invocation source remains protected. */ }
  } else {
    // Host-only classification requires no stream read or stop claim.
    // This export never settles retention custody or authorizes deletion.
    const { protectedRoot, root } = resolveDockerPublicEnclaveDebugPaths();
    const uid = process.getuid?.() ?? 0;
    try {
      await preservePublicEnclaveArtifacts({
        directory: path.join(root, record.runId, record.invocationId), protectedRoot,
        stdout: { status: 'unavailable' }, stderr: { status: 'unavailable' },
        session: { status: 'unavailable' }, secrets: [],
        owner: { uid, gid: process.getgid?.() ?? 0 },
        dependencies: { ...fs.promises, resolveIdentity: () => ({ uid, gid: process.getgid?.() ?? 0 }) },
        envelope: {
          version: 1, runId: record.runId, invocationId: record.invocationId, entryId: record.entryId,
          executorKind: entry.executorKind, runtime: 'docker',
          stage: debug.stage, failure: debug.failure,
          exitCode: debug.exitCode, workloadStopped: false,
          workloadLaunched: Boolean(record.expected && !record.expected.name.endsWith('-probe')),
          ...diagnostic?.snapshot(),
        },
      });
    } catch { /* The recovery journal and source remain protected. */ }
  }
}

export async function finalizeDockerHostExecution(
  context: DockerHostContext, containers: DockerHostContainerOperations,
  stage: DockerHostInvocationStage, result: HostExecutorBackendResult, debugSecrets: readonly string[],
): Promise<HostExecutorBackendResult> {
  const { record, signal, authorityState } = stage;
  const diagnostic = authorityState.diagnostic;
  if (record.publicDebug) {
    Object.assign(record.publicDebug, diagnostic?.snapshot());
    if (signal.aborted) record.publicDebug.failure = 'cancelled';
    else if (result.outcome === 'success') {
      record.publicDebug.stage = 'complete';
      record.publicDebug.failure = 'none';
    }
    context.journal.write(record);
  }
  try { await containers.cleanup(record, debugSecrets, diagnostic); }
  catch (error) {
    diagnostic?.fail('cleanup', error, true, 'cleanup-failed');
    if (record.publicDebug) await retainDockerHostCleanupFailure(context, stage);
    return { outcome: result.outcome === 'cancelled' ? 'cancelled' : 'executor-failure', cleanupComplete: false };
  }
  return signal.aborted ? { outcome: 'cancelled' } : result;
}
