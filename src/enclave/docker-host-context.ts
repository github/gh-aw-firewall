import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import type { HostEnclaveExecutorBackend, HostExecutorInvocationPlan, HostExecutorBackendResult } from './host-executor-server';
import { HOST_EXECUTOR_ID_PATTERN } from './host-executor-protocol';
import { dockerWritableBudget, resolveDockerHostTool } from './docker-host-storage';
import { hasDockerHostMountCapability } from './docker-storage-helper';
import { createDockerHostRecoveryState, type DockerHostCommand } from './docker-host-recovery';
import type { preservePublicEnclaveArtifacts } from './public-debug-artifacts';
import type { PublicEnclaveOperationRecorder } from './public-debug-events';

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

export interface InvocationAuthorityState {
  attempted: boolean;
  resolved: boolean;
  prepared: boolean;
  resourcesPossible: boolean;
  launchedAt?: number;
  diagnostic?: PublicEnclaveOperationRecorder;
  dockerState?: { running: false; exitCode: number | null; oomKilled: boolean | null };
}

interface DockerHostPreparedEntry extends DockerHostExecutorEntry {
  seccompProfile: string;
  uid: number;
  gid: number;
}

export interface DockerHostContext extends ReturnType<typeof createDockerHostRecoveryState> {
  options: DockerHostEnclaveExecutorOptions;
  docker: DockerHostCommand;
  helperStorage: boolean;
  entries: Map<string, DockerHostPreparedEntry>;
  ready: Promise<void> | undefined;
  closed: boolean;
  cleanupIncomplete: boolean;
  backendOwners: Map<string, Set<symbol>>;
  active: Set<{ controller: AbortController; done: Promise<HostExecutorBackendResult> }>;
  publicArtifacts: Map<string, {
    artifact: Parameters<typeof preservePublicEnclaveArtifacts>[0]; collectionFailed: boolean;
  }>;
}

// Shared across backend instances, not just invocations of one factory.
export const activeDockerHostBackends = new Map<string, Set<symbol>>();

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

export function createDockerHostContext(options: DockerHostEnclaveExecutorOptions): DockerHostContext {
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
    if (entry.executorKind === 'agent'
      && !['copilot', 'codex', 'claude'].includes(String(entry.config.engine))) {
      throw new Error('Unsupported Docker enclave agent engine');
    }
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
  return {
    options, docker, helperStorage, entries, ...createDockerHostRecoveryState(options),
    ready: undefined, closed: false, cleanupIncomplete: false,
    backendOwners: activeDockerHostBackends,
    active: new Set(), publicArtifacts: new Map(),
  };
}
