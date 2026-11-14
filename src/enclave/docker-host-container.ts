import * as fs from 'fs';
import * as path from 'path';
import { cleanupDockerHostStorage, ownDockerHostStorageFile } from './docker-host-storage';
import { resolveDockerPublicEnclaveDebugPaths } from './public-debug';
import { preservePublicEnclaveArtifacts, readPublicEnclaveFile, type PublicEnclaveStream } from './public-debug-artifacts';
import { projectPublicEnclaveEntrypointEvent, type PublicEnclaveOperationRecorder } from './public-debug-events';
import {
  assertDockerHostContainer, DockerHostRecoveryJournal, expectedDockerHostContainer,
  inspectDockerHostContainer, removeDockerHostContainer, type DockerHostRecoveryRecord,
} from './docker-host-recovery';
import type { DockerHostContext } from './docker-host-context';

export type DockerHostContainerOperations = ReturnType<typeof createDockerHostContainerOperations>;

function pause(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 50)); }

export function createDockerHostContainerOperations(context: DockerHostContext) {
  const { options, docker, journal, entries, publicArtifacts } = context;

  async function labelledIds(invocationId?: string): Promise<string[]> {
    const args = ['ps', '-aq', '--no-trunc', '--filter', `label=awf.enclave.run=${options.runId}`];
    if (invocationId) args.push('--filter', `label=awf.enclave.invocation=${invocationId}`);
    const listed = await docker(args);
    if (listed.exitCode !== 0) throw new Error('Docker enclave reconciliation failed');
    const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.some((id) => !/^[0-9a-f]{64}$/.test(id))) throw new Error('Invalid immutable Docker enclave ID');
    return ids;
  }

  async function reconcileCreate(record: DockerHostRecoveryRecord): Promise<void> {
    if (record.createPending && record.expected) {
      const created = await inspectDockerHostContainer(docker, record.expected.name);
      assertDockerHostContainer(created, record.expected, record.containerId);
      record.containerId = created.Id;
      record.createPending = false;
      const recoveryJournal = record.runId === options.runId ? journal
        : new DockerHostRecoveryJournal(options.journalDir, record.runId);
      recoveryJournal.write(record);
    }
  }

  async function cleanup(record: DockerHostRecoveryRecord, secrets: readonly string[] = [],
    diagnostic?: PublicEnclaveOperationRecorder): Promise<void> {
    await reconcileCreate(record);
    const remove = () => removeDockerHostContainer(docker, record, state => {
      if (record.publicDebug && !record.expected?.name.endsWith('-probe')) record.publicDebug.dockerState ??= state;
    });
    if (diagnostic) await diagnostic.check('cleanup', remove, true);
    else await remove();
    if ((await labelledIds(record.invocationId)).length !== 0) throw new Error('Uncertain Docker enclave containers remain');
    if (record.publicDebug && (record.publicDebug.pending || record.publicDebug.cleanupFailure)
      && !(record.publicDebug.retained && record.runId !== options.runId)) {
      // Recovery has no runtime credentials to redact. Never destroy the source
      // or guess authorization from labels after losing that custody.
      if (!options.publicDebug || record.runId !== options.runId
        || (secrets.length === 0 && !record.publicDebug.retained)) {
        throw new Error('Public Docker diagnostic retention requires trusted recovery; source is preserved');
      }
      const entry = entries.get(record.entryId)!;
      const uid = process.getuid?.() ?? 0;
      const { protectedRoot, root: artifactRoot } = resolveDockerPublicEnclaveDebugPaths();
      const source = secrets.length === 0 && record.publicDebug.retained
        ? path.join(artifactRoot, record.runId, record.invocationId) : record.storageTarget;
      let streams: [PublicEnclaveStream, PublicEnclaveStream, PublicEnclaveStream] = [
        { status: 'unavailable' }, { status: 'unavailable' },
        { status: entry.executorKind === 'agent' ? 'unavailable' : 'not-applicable' },
      ];
      let collectionFailed = false;
      try {
        for (const name of secrets.length === 0 || !record.mount ? [] : ['stdout.log', 'stderr.log', ...(entry.executorKind === 'agent' ? ['session.jsonl'] : [])]) {
          try {
            await ownDockerHostStorageFile(
              record.mount!, name, name === 'session.jsonl' ? uid : entry.uid,
              name === 'session.jsonl' ? process.getgid?.() ?? 0 : entry.gid, true,
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
        }
        if (record.mount || source !== record.storageTarget) {
          streams = await Promise.all([
            readPublicEnclaveFile(source, 'stdout.log', uid),
            readPublicEnclaveFile(source, 'stderr.log', uid),
            entry.executorKind === 'agent' ? readPublicEnclaveFile(source,
              source === record.storageTarget ? 'session.jsonl' : 'enclave-session.log', uid)
              : Promise.resolve({ status: 'not-applicable' as const }),
          ]);
        }
      } catch (error) {
        // Host evidence does not require unsafe or incompletely prepared files.
        // Retain it without reading those files, and preserve their recovery source.
        collectionFailed = true;
        diagnostic?.fail('cleanup', error, true);
      }
      const [stdout, stderr, session] = streams;
      if (diagnostic) {
        diagnostic.record(projectPublicEnclaveEntrypointEvent({ session, stderr, secrets }));
        Object.assign(record.publicDebug, diagnostic.snapshot());
      }
      const artifact: Parameters<typeof preservePublicEnclaveArtifacts>[0] = {
        directory: path.join(artifactRoot, record.runId, record.invocationId),
        protectedRoot, stdout, stderr, session, secrets,
        envelope: {
          version: 1, runId: record.runId, invocationId: record.invocationId, entryId: record.entryId,
          executorKind: entry.executorKind, runtime: 'docker', workloadStopped: true,
          stage: record.publicDebug.stage, failure: record.publicDebug.failure, exitCode: record.publicDebug.exitCode,
          stages: record.publicDebug.stages, primaryFailure: record.publicDebug.primaryFailure,
          cleanupFailure: record.publicDebug.cleanupFailure, dockerState: record.publicDebug.dockerState,
          workloadLaunched: Boolean(record.containerId && record.expected && !record.expected.name.endsWith('-probe')),
        },
        owner: { uid, gid: process.getgid?.() ?? 0 },
        dependencies: { ...fs.promises, resolveIdentity: () => ({ uid, gid: process.getgid?.() ?? 0 }) },
      };
      publicArtifacts.set(record.invocationId, { artifact, collectionFailed });
      try { await preservePublicEnclaveArtifacts(artifact); } catch (error) {
        diagnostic?.fail('cleanup', error, true, 'retention-failed');
        record.publicDebug.stage = 'retention';
        record.publicDebug.failure = 'retention-failed';
        journal.write(record);
        throw error;
      }
      if (collectionFailed) throw new Error('Public Docker diagnostic source requires recovery');
      record.publicDebug.pending = false;
      record.publicDebug.retained = true;
      journal.write(record);
    }
    // A crash between mount(2) and journal update is reconciled using the
    // unique source name and exact restrictive mount/capacity, never a path alone.
    if (diagnostic) await diagnostic.check('cleanup', () => cleanupDockerHostStorage(record), true);
    else await cleanupDockerHostStorage(record);
    journal.remove(record);
  }

  async function createContainer(record: DockerHostRecoveryRecord, args: string[], command?: string[]): Promise<string> {
    record.expected = expectedDockerHostContainer(args);
    if (command) record.expected.command = command;
    delete record.containerId;
    record.createPending = true;
    journal.write(record);
    const created = await docker(['create', ...args.slice(1), ...(command || [])]);
    if (created.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(created.stdout.trim())) {
      const imageAbsent = created.exitCode !== 0 && created.imageUnavailable === record.expected.image;
      if (imageAbsent && !await inspectDockerHostContainer(docker, record.expected.name)
        && (await labelledIds(record.invocationId)).length === 0) {
        // --pull never plus a definitive no-image daemon response cannot create
        // a workload. Transport/cancellation failures never take this path.
        record.createPending = false;
        journal.write(record);
      }
      throw Object.assign(new Error('Docker enclave creation failed'), imageAbsent ? { code: 'ENOENT' } : {});
    }
    const id = created.stdout.trim();
    const inspected = await inspectDockerHostContainer(docker, id);
    assertDockerHostContainer(inspected, record.expected, id);
    record.containerId = id;
    record.createPending = false;
    journal.write(record);
    return id;
  }

  async function runContainer(record: DockerHostRecoveryRecord, id: string, signal: AbortSignal,
    launched?: () => void, diagnostic?: PublicEnclaveOperationRecorder,
    exited?: (state: { running: false; exitCode: number; oomKilled: boolean | null }) => void): Promise<number> {
    if (signal.aborted) throw new Error('Docker enclave cancelled before start');
    launched?.();
    const start = async () => {
      const started = await docker(['start', id], signal);
      if (started.exitCode !== 0) throw new Error('Docker enclave start failed');
    };
    if (diagnostic) await diagnostic.check('workload-start', start);
    else await start();
    while (!signal.aborted) {
      const current = await inspectDockerHostContainer(docker, id, signal);
      assertDockerHostContainer(current, record.expected!, id);
      if (!current.State?.Running) {
        if (!Number.isInteger(current.State?.ExitCode)) throw new Error('Invalid Docker enclave exit status');
        exited?.({
          running: false, exitCode: current.State.ExitCode,
          oomKilled: typeof current.State.OOMKilled === 'boolean' ? current.State.OOMKilled : null,
        });
        diagnostic?.event('workload-exit', 'succeeded');
        return current.State.ExitCode;
      }
      await pause();
    }
    throw new Error('Docker enclave cancelled');
  }

  return { labelledIds, reconcileCreate, cleanup, createContainer, runContainer };
}
