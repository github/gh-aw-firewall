import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import type { HostEnclaveExecutorBackend, HostExecutorInvocationPlan, HostExecutorBackendResult } from './host-executor-server';
import { HOST_EXECUTOR_ID_PATTERN, HOST_EXECUTOR_MAX_RESULT_BYTES } from './host-executor-protocol';
import { readBoundedEnclaveResult } from './invocation-result';
import { serializeFiniteSchema } from '../bounded-execution/finite-schema';
import {
  assertDockerHostPath, dockerWritableBudget, mountDockerHostStorage, cleanupDockerHostStorage, resolveDockerHostTool,
  ownDockerHostStorageFile,
} from './docker-host-storage';
import { dockerHelperStorageTarget, hasDockerHostMountCapability } from './docker-storage-helper';
import { resolveDockerPublicEnclaveDebugPaths } from './public-debug';
import { preservePublicEnclaveArtifacts, readPublicEnclaveFile } from './public-debug-artifacts';
import { PublicEnclaveOperationRecorder, type PublicEnclaveOperationStage } from './public-debug-events';
import { projectEnclaveSessionDiagnostics } from '../cloud-hypervisor/enclave-session-diagnostics';
import {
  assertDockerHostContainer, assertDockerHostOwnerStopped, captureDockerHostOwner,
  DockerHostRecoveryJournal, expectedDockerHostContainer,
  inspectDockerHostContainer, isDockerHostOwnerLive, removeDockerHostContainer,
  type DockerHostCommand, type DockerHostRecoveryRecord,
} from './docker-host-recovery';

/* eslint-disable @typescript-eslint/no-require-imports */
const { deriveQueryContainerSpec } = require('../../containers/enclave/script-executor/script-runner-spec.js');
const { deriveEnclaveContainerSpec, withDynamicBinding } = require('../../containers/enclave/agent-executor/enclave-runner-spec.js');
const { DockerEnclaveRunner } = require('../../containers/enclave/agent-executor/docker-enclave-runner.js');
const { buildAgentTask } = require('../../containers/enclave/mcp-server/agent-executor.js');
/* eslint-enable @typescript-eslint/no-require-imports */

export type DockerHostRunnerConfig = Readonly<Record<string, string | number | boolean | undefined>>;

export interface DockerHostExecutorEntry {
  entryId: string;
  executorKind: 'script' | 'agent';
  /** Trusted validated configuration accepted by the existing audited runner builder. */
  config: DockerHostRunnerConfig;
  /** Invocation tmpfs backing every writable host bind, including result/session/agent. */
  hostWritableBytes: number;
  /** Hard aggregate admission bound: host tmpfs + all container tmpfs + shm. */
  aggregateWritableBytes: number;
  runtimeName?: 'runsc';
}

export interface DockerHostAgentAuthority {
  githubAgentId?: string;
  githubBearer?: string;
  /** Trusted static seed repository, or the exactly admitted dynamic selector. */
  repository?: string;
  readMode?: 'live' | 'pinned';
}

export interface DockerHostAuthoritySettlement {
  outcome: HostExecutorBackendResult['outcome'];
  outputBytes: number;
  executionSeconds: number;
  /** Resource proof only; revocation is additionally required before success. */
  cleanupComplete: boolean;
  /** Unknown admission or cleanup is charged at the configured maximum. */
  uncertain: boolean;
}

export interface DockerHostEnclaveExecutorOptions {
  runId: string;
  journalDir: string;
  entries: readonly DockerHostExecutorEntry[];
  /** Retained for source callers; audited builders are statically embedded in the CLI. */
  containersDir?: string;
  /** Only a local Unix socket with same-host mount visibility is supported. */
  dockerSocketPath?: string;
  /** Trusted host admission callback; no credentials or launch controls come from the broker. */
  resolveAgentAuthority?: (plan: HostExecutorInvocationPlan, signal: AbortSignal) => Promise<DockerHostAgentAuthority>;
  /** Mandatory for dynamic entries: only proved revocation permits result release. */
  settleAgentAuthority?: (plan: HostExecutorInvocationPlan, settlement: DockerHostAuthoritySettlement) => Promise<{ revoked: boolean }>;
  /** Test seam; production uses the credential-free, bounded Docker CLI below. */
  dockerCommand?: DockerHostCommand;
  /** Set only by the trusted lifecycle after unauthenticated public visibility verification. */
  publicDebug?: boolean;
}

export interface DockerHostEnclaveExecutorBackend extends HostEnclaveExecutorBackend {
  /** Caller must hold exclusive host run ownership before reconciling resources. */
  prepare(): Promise<void>;
  close(): Promise<void>;
}

function defaultDockerCommand(socket: string): DockerHostCommand {
  const executable = resolveDockerHostTool(['/usr/bin/docker', '/usr/local/bin/docker']);
  return (args, signal) => new Promise((resolve) => {
    execFile(executable, ['--host', `unix://${socket}`, ...args], {
      timeout: 30_000, killSignal: 'SIGKILL', signal, maxBuffer: 128 * 1024,
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
    }, (error, stdout, stderr) => {
      const missingImage = error?.code === 1 && typeof stderr === 'string'
        ? /^Error response from daemon: No such image: ([^\r\n]+)\r?\n?$/.exec(stderr)?.[1] : undefined;
      resolve({
        exitCode: error ? typeof error.code === 'number' ? error.code : 1 : 0,
        stdout: typeof stdout === 'string' ? stdout : '',
        ...(missingImage ? { imageUnavailable: missingImage } : {}),
      });
    });
  });
}

function pause(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 50)); }

const activeDockerHostBackends = new Map<string, Set<symbol>>();

interface InvocationAuthorityState {
  attempted: boolean;
  resolved: boolean;
  prepared: boolean;
  resourcesPossible: boolean;
  launchedAt?: number;
  diagnostic?: PublicEnclaveOperationRecorder;
  dockerState?: { running: false; exitCode: number | null; oomKilled: boolean | null };
}

function privateFile(directory: string, name: string, value: string, mode: 0o400 | 0o444 | 0o600 = 0o444): void {
  const target = path.join(directory, name);
  fs.writeFileSync(target, value, { flag: 'wx', mode });
  fs.chmodSync(target, mode);
}

/**
 * Docker is only a workload adapter. Admission, settlement, leases and result
 * release remain exclusively in the shared host executor server.
 */
export function createDockerHostEnclaveExecutor(options: DockerHostEnclaveExecutorOptions): DockerHostEnclaveExecutorBackend {
  if (process.platform !== 'linux' || !HOST_EXECUTOR_ID_PATTERN.test(options.runId)) {
    throw new Error('Docker host enclaves require Linux and a trusted run identity');
  }
  const socket = options.dockerSocketPath
    ?? (process.env.DOCKER_HOST?.startsWith('unix://') ? process.env.DOCKER_HOST.slice(7) : '/var/run/docker.sock');
  if ((!options.dockerSocketPath && process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))
    || !path.isAbsolute(socket) || /[\0\r\n]/.test(socket)) {
    throw new Error('Docker host enclaves do not support remote or split-filesystem daemons');
  }
  if (!options.dockerCommand && !fs.statSync(socket).isSocket()) throw new Error('Docker host enclaves require a local Unix Docker socket');
  const docker = options.dockerCommand || defaultDockerCommand(socket);
  const helperStorage = !hasDockerHostMountCapability();
  const entries = new Map(options.entries.map((entry) => {
    if (options.publicDebug && (entry.runtimeName !== undefined || entry.config.dynamicEnabled)) {
      throw new Error('Public Docker diagnostics require static default-runtime entries');
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(entry.entryId)
      || !['script', 'agent'].includes(entry.executorKind)) throw new Error('Invalid Docker host enclave entry');
    dockerWritableBudget(entry.executorKind, entry.config.tmpfsLimit as string | undefined, entry.hostWritableBytes, entry.aggregateWritableBytes);
    if (entry.executorKind === 'agent' && entry.config.engine !== 'copilot') throw new Error('Unsupported Docker enclave agent engine');
    const uid = entry.config[entry.executorKind === 'script' ? 'queryUid' : 'enclaveUid'];
    const gid = entry.config[entry.executorKind === 'script' ? 'queryGid' : 'enclaveGid'];
    if (![uid, gid].every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) {
      throw new Error('Docker enclave UID and GID must be trusted non-root numeric identities');
    }
    if (helperStorage && (uid !== 65534 || gid !== 65534)) {
      throw new Error('Unprivileged Docker enclaves require the fixed 65534:65534 identity');
    }
    const image = entry.config[entry.executorKind === 'script' ? 'queryImage' : 'enclaveImage'];
    if (typeof image !== 'string' || !image || image.startsWith('-')) throw new Error('Invalid trusted Docker enclave image');
    const seccomp = entry.config[entry.executorKind === 'script' ? 'querySeccompPath' : 'enclaveSeccompPath'];
    if (typeof seccomp !== 'string' || !path.isAbsolute(seccomp)) throw new Error('Docker enclave seccomp policy is required');
    const fd = fs.openSync(seccomp, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let seccompProfile: string;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error('Invalid trusted Docker enclave seccomp policy');
      seccompProfile = JSON.stringify(JSON.parse(fs.readFileSync(fd, 'utf8')));
    } finally { fs.closeSync(fd); }
    return [entry.entryId, { ...entry, config: Object.freeze({ ...entry.config }), seccompProfile, uid: uid as number, gid: gid as number }] as const;
  }));
  if (entries.size !== options.entries.length) throw new Error('Duplicate Docker enclave entry');
  if ([...entries.values()].some((entry) => entry.config.dynamicEnabled)
    && (!options.resolveAgentAuthority || !options.settleAgentAuthority)) {
    throw new Error('Dynamic Docker enclaves require host-owned admission and revocation callbacks');
  }
  const journal = new DockerHostRecoveryJournal(options.journalDir, options.runId);
  const owner = captureDockerHostOwner();
  const ownerKey = `${options.journalDir}\0${options.runId}`;
  const backendIdentity = Symbol('docker-host-executor');
  let ready: Promise<void> | undefined;
  let closed = false;
  let cleanupIncomplete = false;
  const active = new Set<{ controller: AbortController; done: Promise<HostExecutorBackendResult> }>();
  const publicArtifacts = new Map<string, Parameters<typeof preservePublicEnclaveArtifacts>[0]>();

  async function labelledIds(invocationId?: string): Promise<string[]> {
    const args = ['ps', '-aq', '--no-trunc', '--filter', `label=awf.enclave.run=${options.runId}`];
    if (invocationId) args.push('--filter', `label=awf.enclave.invocation=${invocationId}`);
    const listed = await docker(args);
    if (listed.exitCode !== 0) throw new Error('Docker enclave reconciliation failed');
    const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.some((id) => !/^[0-9a-f]{64}$/.test(id))) throw new Error('Invalid immutable Docker enclave ID');
    return ids;
  }

  async function cleanup(record: DockerHostRecoveryRecord, secrets: readonly string[] = [],
    diagnostic?: PublicEnclaveOperationRecorder): Promise<void> {
    if (record.createPending && record.expected) {
      const created = await inspectDockerHostContainer(docker, record.expected.name);
      assertDockerHostContainer(created, record.expected, record.containerId);
      record.containerId = created.Id;
      record.createPending = false;
      journal.write(record);
    }
    const remove = () => removeDockerHostContainer(docker, record, state => {
      if (record.publicDebug && !record.expected?.name.endsWith('-probe')) record.publicDebug.dockerState ??= state;
    });
    if (diagnostic) await diagnostic.check('cleanup', remove, true);
    else await remove();
    if ((await labelledIds(record.invocationId)).length !== 0) throw new Error('Uncertain Docker enclave containers remain');
    if (record.publicDebug && (record.publicDebug.pending || record.publicDebug.cleanupFailure)) {
      // Recovery has no runtime credentials to redact. Never destroy the source
      // or guess authorization from labels after losing that custody.
      if (!options.publicDebug || record.runId !== options.runId
        || (secrets.length === 0 && !record.publicDebug.retained)) {
        throw new Error('Public Docker diagnostic retention requires trusted recovery; source is preserved');
      }
      const entry = entries.get(record.entryId)!;
      for (const name of secrets.length === 0 ? [] : ['stdout.log', 'stderr.log', ...(entry.executorKind === 'agent' ? ['session.jsonl'] : [])]) {
        try { await ownDockerHostStorageFile(record.mount!, name, entry.uid, entry.gid, true); }
        catch (error) {
          if (!fs.existsSync(path.join(record.storageTarget, name))) continue;
          throw error;
        }
      }
      const uid = process.getuid?.() ?? 0;
      const { protectedRoot, root: artifactRoot } = resolveDockerPublicEnclaveDebugPaths();
      const source = secrets.length === 0 && record.publicDebug.retained
        ? path.join(artifactRoot, record.runId, record.invocationId) : record.storageTarget;
      const [stdout, stderr, session] = secrets.length === 0 && !record.publicDebug.retained
        ? [{ status: 'unavailable' as const }, { status: 'unavailable' as const }, { status: 'unavailable' as const }]
        : await Promise.all([
        readPublicEnclaveFile(source, 'stdout.log', uid),
        readPublicEnclaveFile(source, 'stderr.log', uid),
        entry.executorKind === 'agent' ? readPublicEnclaveFile(source,
          source === record.storageTarget ? 'session.jsonl' : 'enclave-session.log', uid)
          : Promise.resolve({ status: 'not-applicable' as const }),
        ]);
      if (diagnostic) {
        const entrypoint = session.status === 'captured' && session.contents
          ? projectEnclaveSessionDiagnostics(session.contents)
          : stderr.status === 'captured' && stderr.contents
            ? projectEnclaveSessionDiagnostics(stderr.contents) : undefined;
        const initialized = entrypoint?.events?.some(event =>
          event.event === 'progress' && ['runtime-paths-ready', 'preflight-completed', 'engine-started'].includes(String(event.stage)));
        diagnostic.event('entrypoint-initialization', initialized ? 'succeeded' : 'unavailable');
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
          workloadLaunched: Boolean(record.expected && !record.expected.name.endsWith('-probe')),
        },
        owner: { uid, gid: process.getgid?.() ?? 0 },
        dependencies: { ...fs.promises, resolveIdentity: () => ({ uid, gid: process.getgid?.() ?? 0 }) },
      };
      publicArtifacts.set(record.invocationId, artifact);
      try { await preservePublicEnclaveArtifacts(artifact); } catch (error) {
        diagnostic?.fail('cleanup', error, true, 'retention-failed');
        record.publicDebug.stage = 'retention';
        record.publicDebug.failure = 'retention-failed';
        journal.write(record);
        throw error;
      }
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

  async function initialize(): Promise<void> {
    if ([...activeDockerHostBackends.get(ownerKey) || []].some((value) => value !== backendIdentity)) {
      throw new Error('Docker enclave run has another active host executor');
    }
    const info = await docker(['info', '--format', '{{json .}}']);
    if (info.exitCode !== 0) throw new Error('Local Docker enclave daemon is unavailable');
    const daemon = JSON.parse(info.stdout);
    if (daemon.OSType !== 'linux' || (daemon.SecurityOptions || []).some((v: string) => /rootless|userns/.test(v))) {
      throw new Error('Docker host enclave daemon filesystem/identity mode is unsupported');
    }
    const records = journal.records(true);
    const recoverable: DockerHostRecoveryRecord[] = [];
    for (const record of records) {
      if (record.runId !== options.runId && isDockerHostOwnerLive(record.owner, owner)) continue;
      assertDockerHostOwnerStopped(record.owner, owner);
      recoverable.push(record);
    }
    const known = new Set(records.map((record) => record.expected?.name).filter(Boolean));
    // Labels alone confer no cleanup authority. Every orphan must have a
    // durable intent and an inspected launch configuration before removal.
    for (const id of await labelledIds()) {
      const inspected = await inspectDockerHostContainer(docker, id);
      if (!inspected || !known.has(inspected.Name?.slice(1))) throw new Error('Unjournaled Docker enclave resources require operator recovery');
    }
    for (const record of recoverable) await cleanup(record);
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

  async function execute(plan: HostExecutorInvocationPlan, signal: AbortSignal, authorityState: InvocationAuthorityState): Promise<HostExecutorBackendResult> {
    const diagnostic = authorityState.diagnostic;
    const debugCheck = <T>(stage: PublicEnclaveOperationStage, operation: () => Promise<T> | T) =>
      diagnostic ? diagnostic.check(stage, operation) : Promise.resolve().then(operation);
    const entry = entries.get(plan.entryId);
    if (!entry || plan.runId !== options.runId || plan.executorKind !== entry.executorKind
      || !HOST_EXECUTOR_ID_PATTERN.test(plan.invocationId)) return { outcome: 'executor-failure' };
    if (closed) return { outcome: 'cancelled' };
    await (ready ||= initialize());
    authorityState.prepared = true;
    if (closed || signal.aborted) return { outcome: 'cancelled' };
    assertDockerHostPath(plan.invocationHostDir);
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
    if (plan.seedHostPath) assertDockerHostPath(plan.seedHostPath);
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
    const debugSecrets = Object.entries(config).filter(([key]) => /secret|token|bearer/i.test(key))
      .map(([, value]) => String(value || ''));
    debugSecrets.push(authority.githubAgentId || '', authority.githubBearer || '', '******');
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--env' && /TOKEN|AUTHORIZATION|SECRET|BEARER/.test(args[i + 1] || '')) {
        debugSecrets.push(args[i + 1].slice(args[i + 1].indexOf('=') + 1));
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
      fs.writeFileSync(path.join(record.storageTarget, 'seccomp.json'), entry.seccompProfile, { flag: 'wx', mode: 0o400 });
      // A local Unix socket does not imply shared mount namespaces (DinD).
      // Probe the *actual* bind's device/inode/capacity from inside the daemon.
      const stat = fs.statSync(record.storageTarget);
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
      await removeDockerHostContainer(docker, record);
      delete record.containerId;
      delete record.expected;
      journal.write(record);
      diagnostic?.event('authority-handoff', 'started');
      const stageFile = async (name: string, value: string, mode: 0o400 | 0o444 | 0o600 = 0o444) => {
        privateFile(record.storageTarget, name, value, mode);
        if (mode !== 0o444) await ownDockerHostStorageFile(record.mount!, name, entry.uid, entry.gid);
      };
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
        await stageFile('session.jsonl', '', 0o600);
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
        await debugCheck('storage-probe', () => new DockerEnclaveRunner(config, {
          docker: { runDocker: (values: string[]) => docker(values) },
        }).assertNetworkIsolated());
      }
      diagnostic?.event('authority-handoff', 'succeeded');
      const id = await debugCheck('workload-create', () => createContainer(record, args));
      if (record.publicDebug) {
        record.publicDebug.stage = 'execution';
        record.publicDebug.failure = 'execution-exception';
        journal.write(record);
      }
      const exitCode = await runContainer(record, id, signal, () => { authorityState.launchedAt = Date.now(); },
        diagnostic, state => { authorityState.dockerState = state; });
      if (record.publicDebug) {
        record.publicDebug.exitCode = exitCode;
        record.publicDebug.stage = 'result';
        record.publicDebug.failure = exitCode === 0 ? 'result-invalid' : 'workload-exit';
        record.publicDebug.dockerState = authorityState.dockerState;
        journal.write(record);
      }
      // Remove first: only a proven stopped/removed container may yield output.
      await removeDockerHostContainer(docker, record);
      const reclaimOutput = () => ownDockerHostStorageFile(record.mount!, 'out', entry.uid, entry.gid, true);
      if (diagnostic) await diagnostic.check('cleanup', reclaimOutput, true);
      else await reclaimOutput();
      if (entry.executorKind === 'agent') {
        await ownDockerHostStorageFile(record.mount!, 'session.jsonl', entry.uid, entry.gid, true);
      }
      if (signal.aborted) result = { outcome: 'cancelled' };
      else if (exitCode === 0) {
        const maximum = Math.min(Number(config.maxOutputBytes || HOST_EXECUTOR_MAX_RESULT_BYTES), HOST_EXECUTOR_MAX_RESULT_BYTES);
        const bounded = await debugCheck('output-validation',
          () => readBoundedEnclaveResult(path.join(record.storageTarget, 'out'), plan.schema, maximum));
        if (bounded === undefined) diagnostic?.fail('output-validation', undefined, false, 'result-invalid');
        result = bounded === undefined ? { outcome: 'schema-failure' } : { outcome: 'success', result: bounded };
      } else {
        diagnostic?.fail('workload-exit', undefined, false, 'workload-exit');
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
        const artifact = publicArtifacts.get(record.invocationId);
        if (artifact) {
          try {
            await preservePublicEnclaveArtifacts({
              ...artifact, envelope: {
                ...artifact.envelope, ...diagnostic?.snapshot(),
                stage: record.publicDebug.stage, failure: record.publicDebug.failure,
              },
            });
          } catch { /* Initial retained evidence or the invocation source remains protected. */ }
        }
      }
      return { outcome: result.outcome === 'cancelled' ? 'cancelled' : 'executor-failure', cleanupComplete: false };
    }
    return signal.aborted ? { outcome: 'cancelled' } : result;
  }

  async function executeAndSettle(plan: HostExecutorInvocationPlan, signal: AbortSignal): Promise<HostExecutorBackendResult> {
    const state: InvocationAuthorityState = {
      attempted: false, resolved: false, prepared: false, resourcesPossible: false,
      ...(options.publicDebug ? { diagnostic: new PublicEnclaveOperationRecorder() } : {}),
    };
    let result: HostExecutorBackendResult;
    try { result = await execute(plan, signal, state); }
    catch (error) {
      result = {
        outcome: signal.aborted ? 'cancelled' : 'executor-failure',
        ...(!state.prepared || state.resourcesPossible ? { cleanupComplete: false } : {}),
      };
      if (options.publicDebug && !state.resourcesPossible) {
        state.diagnostic!.fail(state.attempted ? 'authority-handoff' : 'storage-preparation', error);
        const { protectedRoot, root } = resolveDockerPublicEnclaveDebugPaths();
        const uid = process.getuid?.() ?? 0;
        try {
          await preservePublicEnclaveArtifacts({
            directory: path.join(root, plan.runId, plan.invocationId), protectedRoot,
            stdout: { status: 'unavailable' }, stderr: { status: 'unavailable' }, session: { status: 'unavailable' },
            secrets: [], owner: { uid, gid: process.getgid?.() ?? 0 },
            dependencies: { ...fs.promises, resolveIdentity: () => ({ uid, gid: process.getgid?.() ?? 0 }) },
            envelope: {
              version: 1, runId: plan.runId, invocationId: plan.invocationId, entryId: plan.entryId,
              executorKind: plan.executorKind, runtime: 'docker', stage: 'setup', failure: 'setup-failed',
              exitCode: null, workloadStopped: true, workloadLaunched: false, ...state.diagnostic!.snapshot(),
            },
          });
        } catch { result = { outcome: 'executor-failure', cleanupComplete: false }; }
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
    if (result.cleanupComplete === false) cleanupIncomplete = true;
    return result;
  }

  return {
    async prepare() {
      if (closed) throw new Error('Docker enclave backend is closed');
      await (ready ||= initialize());
    },
    execute(plan, signal) {
      const owners = activeDockerHostBackends.get(ownerKey) || new Set<symbol>();
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
      activeDockerHostBackends.set(ownerKey, owners);
      handle.done = executeAndSettle(plan, controller.signal).finally(() => {
        publicArtifacts.delete(plan.invocationId);
        signal.removeEventListener('abort', cancel);
        active.delete(handle);
        if (active.size === 0) {
          owners.delete(backendIdentity);
          if (owners.size === 0) activeDockerHostBackends.delete(ownerKey);
        }
      });
      return handle.done;
    },
    async close() {
      closed = true;
      for (const handle of active) handle.controller.abort();
      const results = await Promise.all([...active].map((handle) => handle.done));
      if (results.some((result) => result.cleanupComplete === false)) throw new Error('Docker enclave cleanup requires recovery');
      // Failed listener publication may close an unopened backend belonging
      // to a duplicate start. It must not reconcile a live run it never owned.
      if (ready) await ready;
      if (cleanupIncomplete) throw new Error('Docker enclave resource or authority cleanup requires recovery');
      publicArtifacts.clear();
    },
  };
}

/** Resource recovery only; caller must subsequently reconcile mcpg authorities. */
export async function recoverDockerHostEnclaveExecutor(
  options: Omit<DockerHostEnclaveExecutorOptions, 'resolveAgentAuthority' | 'settleAgentAuthority'>,
): Promise<void> {
  const noAuthorityDuringRecovery = async (): Promise<never> => {
    throw new Error('Docker resource recovery cannot acquire or settle authorities');
  };
  const backend = createDockerHostEnclaveExecutor({
    ...options, resolveAgentAuthority: noAuthorityDuringRecovery, settleAgentAuthority: noAuthorityDuringRecovery,
  });
  try { await backend.prepare(); }
  finally { await backend.close(); }
}
