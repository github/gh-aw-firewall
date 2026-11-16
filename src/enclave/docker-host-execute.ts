import * as fs from 'fs';
import * as path from 'path';
import type { HostEnclaveExecutorBackend, HostExecutorInvocationPlan, HostExecutorBackendResult } from './host-executor-server';
import { HOST_EXECUTOR_ID_PATTERN, HOST_EXECUTOR_MAX_RESULT_BYTES } from './host-executor-protocol';
import { readBoundedEnclaveResult } from './invocation-result';
import { serializeFiniteSchema } from '../bounded-execution/finite-schema';
import {
  assertDockerHostPath, mountDockerHostStorage,
  ownDockerHostStorageFile,
} from './docker-host-storage';
import { dockerHelperStorageTarget } from './docker-storage-helper';
import { resolveDockerPublicEnclaveDebugPaths } from './public-debug';
import { preservePublicEnclaveArtifacts } from './public-debug-artifacts';
import {
  PublicEnclaveOperationRecorder, type PublicEnclaveOperationStage,
} from './public-debug-events';
import { prepareRootOwnedDebugDirectory, writeAuditFile } from '../cloud-hypervisor/diagnostics';
import {
  removeDockerHostContainer, type DockerHostRecoveryRecord,
} from './docker-host-recovery';
import {
  type DockerHostContext, type InvocationAuthorityState,
  type DockerHostAgentAuthority, type DockerHostAuthoritySettlement,
} from './docker-host-context';
import type { DockerHostContainerOperations } from './docker-host-container';

/* eslint-disable @typescript-eslint/no-require-imports */
const { deriveQueryContainerSpec } = require('../../containers/enclave/script-executor/script-runner-spec.js');
const { deriveEnclaveContainerSpec, withDynamicBinding } = require('../../containers/enclave/agent-executor/enclave-runner-spec.js');
const { DockerEnclaveRunner } = require('../../containers/enclave/agent-executor/docker-enclave-runner.js');
const { buildAgentTask } = require('../../containers/enclave/mcp-server/agent-executor.js');
/* eslint-enable @typescript-eslint/no-require-imports */

function privateFile(
  directory: string, name: string, value: string, mode: 0o400 | 0o444 | 0o600 | 0o644 = 0o444,
): void {
  const target = path.join(directory, name);
  fs.writeFileSync(target, value, { flag: 'wx', mode });
  fs.chmodSync(target, mode);
}

export function createDockerHostExecution(
  context: DockerHostContext, containers: DockerHostContainerOperations, initialize: () => Promise<void>,
): Pick<HostEnclaveExecutorBackend, 'execute'> {
  const { options, docker, helperStorage, entries, journal, owner, ownerKey, backendIdentity, backendOwners, active, publicArtifacts } = context;
  const { cleanup, createContainer, runContainer } = containers;

  async function execute(plan: HostExecutorInvocationPlan, signal: AbortSignal, authorityState: InvocationAuthorityState): Promise<HostExecutorBackendResult> {
    const diagnostic = authorityState.diagnostic;
    const debugCheck = <T>(stage: PublicEnclaveOperationStage, operation: () => Promise<T> | T) =>
      diagnostic ? diagnostic.check(stage, operation) : Promise.resolve().then(operation);
    const entry = entries.get(plan.entryId);
    if (!entry || plan.runId !== options.runId || plan.executorKind !== entry.executorKind
      || !HOST_EXECUTOR_ID_PATTERN.test(plan.invocationId)) return { outcome: 'executor-failure' };
    if (context.closed) return { outcome: 'cancelled' };
    await debugCheck('storage-preparation', () => (context.ready ||= initialize()));
    authorityState.prepared = true;
    if (context.closed || signal.aborted) return { outcome: 'cancelled' };
    await debugCheck('storage-preparation', () => assertDockerHostPath(plan.invocationHostDir));
    if (path.basename(plan.invocationHostDir) !== plan.invocationId) return { outcome: 'executor-failure' };
    const storageTarget = helperStorage
      ? dockerHelperStorageTarget(plan.runId, plan.entryId, plan.invocationId) : plan.invocationHostDir;
    let authority: DockerHostAgentAuthority = {};
    if (entry.executorKind === 'agent' && options.resolveAgentAuthority) {
      authorityState.attempted = plan.selector !== undefined;
      authority = await debugCheck('authority-handoff', () => options.resolveAgentAuthority!(plan, signal));
      authorityState.resolved = true;
    }
    else diagnostic?.event('authority-handoff', 'not-applicable');
    if (signal.aborted) return { outcome: 'cancelled' };
    const config: Record<string, any> = {
      ...entry.config,
      hostWorkDir: path.dirname(storageTarget),
      hostSeedsDir: plan.seedHostPath ? path.dirname(plan.seedHostPath) : '',
      runLabelKey: 'awf.enclave.run', invocationLabelKey: 'awf.enclave.invocation',
      containerPrefix: `awf-enclave-${entry.executorKind}-${entry.entryId}`,
      querySeccompPath: path.join(storageTarget, 'seccomp.json'),
      enclaveSeccompPath: path.join(storageTarget, 'seccomp.json'),
    };
    if (entry.executorKind === 'agent') {
      if (Boolean(config.dynamicEnabled) !== (plan.selector !== undefined)) return { outcome: 'executor-failure' };
      if (config.dynamicEnabled) {
        if (authority.repository !== plan.selector || !authority.githubBearer) return { outcome: 'executor-failure' };
        Object.assign(config, withDynamicBinding(config, { repository: authority.repository, readMode: authority.readMode }));
      }
    }
    if (!config.dynamicEnabled && (!plan.seedId || !plan.seedHostPath)) return { outcome: 'executor-failure' };
    if (plan.seedHostPath) await debugCheck('storage-preparation', () => assertDockerHostPath(plan.seedHostPath!));
    const derived = entry.executorKind === 'script'
      ? deriveQueryContainerSpec({ config, runId: plan.runId, invocationId: plan.invocationId, runtimeName: entry.runtimeName })
      : deriveEnclaveContainerSpec({ config, runId: plan.runId, invocationId: plan.invocationId, seedId: plan.seedId, runtimeName: entry.runtimeName });
    const args: string[] = [...derived.launchArgs];
    // Retain the audited script entrypoint, mounting the immutable seed directly
    // instead of making an unbounded host-side seed copy.
    if (entry.executorKind === 'script') {
      const source = `${storageTarget}/repo:/awf/seed:ro`;
      args[args.indexOf(source)] = `${plan.seedHostPath}:/awf/seed:ro`;
    }
    args.splice(1, 0, '--log-driver', 'none');
    const credential = (key: string, value: unknown): value is string => typeof value === 'string'
      && /secret|token|bearer|authorization|api.?key/i.test(key)
      && !/tokens|path|directory|file|budget|limit/i.test(key);
    const debugSecrets = Object.entries(config).filter(([key, value]) => credential(key, value))
      .map(([, value]) => value as string);
    debugSecrets.push(
      authority.githubAgentId || '', authority.githubBearer || '',
      config.modelBudgetSecret || '', '******',
    );
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--env') {
        const value = args[i + 1] || '';
        const at = value.indexOf('=');
        const contents = value.slice(at + 1);
        if (at > 0 && credential(value.slice(0, at), contents)) debugSecrets.push(contents);
      }
    }
    if (options.publicDebug) {
      args.splice(args.length - 1, 0, '--env', 'AWF_ENCLAVE_DEBUG_PUBLIC=true',
        ...(entry.executorKind === 'agent' ? ['--env', 'AWF_ENCLAVE_AGENT_DEBUG_RAW_SESSION_LOGS=true'] : []),
        '-v', `${storageTarget}/stdout.log:/awf/stdout.log:rw`,
        '-v', `${storageTarget}/stderr.log:/awf/stderr.log:rw`);
    }
    const record: DockerHostRecoveryRecord = {
      version: 1, runId: plan.runId, entryId: plan.entryId, invocationId: plan.invocationId,
      storageTarget,
      storageSource: `awf-enclave-${plan.runId}-${plan.entryId}-${plan.invocationId}`,
      storageBytes: entry.hostWritableBytes, mountPending: true, owner,
      ...(options.publicDebug ? { publicDebug: {
        pending: true, stage: 'setup' as const, failure: 'setup-failed' as const, exitCode: null,
      } } : {}),
    };
    authorityState.resourcesPossible = true;
    journal.write(record, true);
    let result: HostExecutorBackendResult;
    try {
      try {
        record.mount = await debugCheck('storage-preparation',
          () => mountDockerHostStorage(record.storageTarget, record.storageSource, record.storageBytes));
      } finally {
        record.mountPending = false;
        journal.write(record);
      }
      // A local Unix socket does not imply shared mount namespaces (DinD).
      // Probe the *actual* bind's device/inode/capacity from inside the daemon.
      const stat = await debugCheck('storage-preparation', () => {
        fs.writeFileSync(path.join(record.storageTarget, 'seccomp.json'), entry.seccompProfile, { flag: 'wx', mode: 0o400 });
        return fs.statSync(record.storageTarget);
      });
      const probeArgs = [...args];
      const bindArgs: string[] = [];
      for (let i = 0; i < probeArgs.length; i++) {
        if (probeArgs[i] === '-v') { i++; continue; }
        bindArgs.push(probeArgs[i]);
      }
      bindArgs[bindArgs.indexOf('--network') + 1] = 'none';
      bindArgs[bindArgs.indexOf('--name') + 1] += '-probe';
      bindArgs[bindArgs.indexOf('--entrypoint') + 1] = entry.executorKind === 'script' ? '/usr/bin/python3' : '/usr/bin/env';
      bindArgs.splice(bindArgs.length - 3, 0, '-v', `${record.storageTarget}:/awf/host-storage-probe:ro`);
      const probeCommand = [...(entry.executorKind === 'agent' ? ['python3'] : []), '-c', 'import os; p="/awf/host-storage-probe"; s=os.stat(p); v=os.statvfs(p); ' +
        `assert s.st_dev==${stat.dev} and s.st_ino==${stat.ino} and v.f_blocks*v.f_frsize==${record.storageBytes}`];
      const probe = await debugCheck('storage-probe', () => createContainer(record, bindArgs, probeCommand));
      await debugCheck('storage-probe', async () => {
        if (await runContainer(record, probe, signal) !== 0) throw new Error('Docker daemon cannot see the verified invocation tmpfs');
      });
      if (diagnostic) await diagnostic.check('cleanup', () => removeDockerHostContainer(docker, record), true);
      else await removeDockerHostContainer(docker, record);
      delete record.containerId;
      delete record.expected;
      journal.write(record);
      const stageFile = async (
        name: string, value: string, mode: 0o400 | 0o444 | 0o600 | 0o644 = 0o444,
        uid = entry.uid, gid = entry.gid,
      ) => {
        if (name === 'session.jsonl' && uid === entry.uid) {
          throw new Error('Enclave session transcript requires a separate supervisor identity');
        }
        privateFile(record.storageTarget, name, value, mode);
        if (mode !== 0o444) await ownDockerHostStorageFile(record.mount!, name, uid, gid);
      };
      await debugCheck('authority-handoff', async () => {
        await stageFile('out', '', 0o600);
        if (options.publicDebug) {
          await stageFile('stdout.log', '', 0o600);
          await stageFile('stderr.log', '', 0o600);
        }
        if (entry.executorKind === 'script') await stageFile('script.py', plan.payload);
        else {
          const task = buildAgentTask(plan.payload, {
            githubEnabled: Boolean(config.githubEnabled || config.dynamicEnabled),
            privateRepo: authority.repository,
          });
          if (Buffer.byteLength(task) > 64 * 1024) throw new Error('Docker enclave scoped task exceeds the audited input bound');
          await stageFile('task.txt', task);
          await stageFile('schema.json', JSON.stringify(serializeFiniteSchema(plan.schema)));
          await stageFile(
            'session.jsonl', '', 0o644, process.getuid?.() ?? 0, process.getgid?.() ?? 0,
          );
          const agentDirectory = path.join(record.storageTarget, 'agent');
          fs.mkdirSync(agentDirectory, { mode: 0o700 });
          fs.chmodSync(agentDirectory, 0o700);
          await ownDockerHostStorageFile(record.mount!, 'agent', entry.uid, entry.gid);
          if (config.githubEnabled) {
            if (!/^[A-Za-z0-9_-]{32,128}$/.test(authority.githubAgentId || '')) throw new Error('Invalid static GitHub enclave authority');
            await stageFile('github-agent-id', authority.githubAgentId!, 0o400);
          }
          if (config.dynamicEnabled) {
            if (!/^[\x21-\x7e]{16,512}$/.test(authority.githubBearer || '')) throw new Error('Invalid dynamic GitHub enclave authority');
            await stageFile('github-bearer', authority.githubBearer!, 0o400);
          }
        }
      });
      if (entry.executorKind === 'agent') {
        await debugCheck('network-isolation', () => new DockerEnclaveRunner(config, {
          docker: { runDocker: (values: string[]) => docker(values) },
        }).assertNetworkIsolated());
      }
      const id = await debugCheck('workload-create', () => createContainer(record, args));
      if (record.publicDebug) {
        record.publicDebug.stage = 'execution';
        record.publicDebug.failure = 'execution-exception';
        journal.write(record);
      }
      const exitCode = await runContainer(record, id, signal, () => { authorityState.launchedAt = Date.now(); },
        diagnostic, state => { authorityState.dockerState = state; });
      if (exitCode !== 0) diagnostic?.fail('workload-exit', undefined, false, 'workload-exit');
      if (record.publicDebug) {
        record.publicDebug.exitCode = exitCode;
        record.publicDebug.stage = exitCode === 0 ? 'result' : 'execution';
        record.publicDebug.failure = exitCode === 0 ? 'result-invalid' : 'workload-exit';
        record.publicDebug.dockerState = authorityState.dockerState;
        journal.write(record);
      }
      // Remove first: only a proven stopped/removed container may yield output.
      const remove = () => removeDockerHostContainer(docker, record);
      if (diagnostic) await diagnostic.check('cleanup', remove, true);
      else await remove();
      const reclaimOutput = () => ownDockerHostStorageFile(record.mount!, 'out', entry.uid, entry.gid, true);
      if (diagnostic) await diagnostic.check('cleanup', reclaimOutput, true);
      else await reclaimOutput();
      if (entry.executorKind === 'agent') {
        const reclaimSession = () => ownDockerHostStorageFile(
          record.mount!, 'session.jsonl', process.getuid?.() ?? 0, process.getgid?.() ?? 0, true,
        );
        if (diagnostic) await diagnostic.check('cleanup', reclaimSession, true);
        else await reclaimSession();
      }
      if (signal.aborted) result = { outcome: 'cancelled' };
      else if (exitCode === 0) {
        const maximum = Math.min(Number(config.maxOutputBytes || HOST_EXECUTOR_MAX_RESULT_BYTES), HOST_EXECUTOR_MAX_RESULT_BYTES);
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
    if (record.publicDebug) {
      Object.assign(record.publicDebug, diagnostic?.snapshot());
      if (signal.aborted) record.publicDebug.failure = 'cancelled';
      else if (result.outcome === 'success') {
        record.publicDebug.stage = 'complete';
        record.publicDebug.failure = 'none';
      }
      journal.write(record);
    }
    try { await cleanup(record, debugSecrets, diagnostic); }
    catch (error) {
      diagnostic?.fail('cleanup', error, true, 'cleanup-failed');
      if (record.publicDebug) {
        Object.assign(record.publicDebug, diagnostic?.snapshot());
        journal.write(record);
        const capture = publicArtifacts.get(record.invocationId);
        if (capture) {
          const { artifact, collectionFailed } = capture;
          try {
            await preservePublicEnclaveArtifacts({
              ...artifact, envelope: {
                ...artifact.envelope, ...diagnostic?.snapshot(),
                stage: record.publicDebug.stage, failure: record.publicDebug.failure,
              },
            });
            if (!collectionFailed) {
              record.publicDebug.pending = false;
              record.publicDebug.retained = true;
            }
            journal.write(record);
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
                stage: record.publicDebug.stage, failure: record.publicDebug.failure,
                exitCode: record.publicDebug.exitCode, workloadStopped: false,
                workloadLaunched: Boolean(record.expected && !record.expected.name.endsWith('-probe')),
                ...diagnostic?.snapshot(),
              },
            });
          } catch { /* The recovery journal and source remain protected. */ }
        }
      }
      return { outcome: result.outcome === 'cancelled' ? 'cancelled' : 'executor-failure', cleanupComplete: false };
    }
    return signal.aborted ? { outcome: 'cancelled' } : result;
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
      const uncertain = result.cleanupComplete === false || !state.resolved;
      const settlement: DockerHostAuthoritySettlement = {
        outcome: result.outcome, uncertain, cleanupComplete: result.cleanupComplete !== false,
        outputBytes: uncertain ? Number(entry.config.maxOutputBytes || HOST_EXECUTOR_MAX_RESULT_BYTES)
          : result.result === undefined ? 0 : Buffer.byteLength(result.result),
        executionSeconds: uncertain ? Math.max(Math.ceil(plan.timeoutMs / 1000), Number(entry.config.timeoutSeconds || 0))
          : state.launchedAt === undefined ? 0 : Math.max(0, Math.ceil((Date.now() - state.launchedAt) / 1000)),
      };
      try {
        if (!(await options.settleAgentAuthority(plan, settlement)).revoked) throw new Error('Dynamic enclave revocation remains unresolved');
      } catch {
        result = { outcome: 'executor-failure', cleanupComplete: false };
      }
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
