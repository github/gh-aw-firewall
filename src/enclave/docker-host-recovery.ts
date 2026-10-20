import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { dockerMemoryBytes, assertDockerHostPath, type DockerHostMountIdentity } from './docker-host-storage';

export interface DockerHostCommandResult { exitCode: number; stdout: string }
export type DockerHostCommand = (args: readonly string[], signal?: AbortSignal) => Promise<DockerHostCommandResult>;

export interface DockerHostOwnerIdentity { pid: number; startTicks: string; bootId: string }

function processStart(pid: number): { startTicks: string; state: string } {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const suffix = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (!/^[0-9]+$/.test(suffix[19] || '') || !/^[A-Z]$/.test(suffix[0] || '')) {
    throw new Error('Docker enclave host process identity is unavailable');
  }
  return { startTicks: suffix[19], state: suffix[0] };
}

export function captureDockerHostOwner(): DockerHostOwnerIdentity {
  return {
    pid: process.pid, startTicks: processStart(process.pid).startTicks,
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  };
}

export function assertDockerHostOwnerStopped(owner: DockerHostOwnerIdentity | undefined, current: DockerHostOwnerIdentity): void {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1
    || !/^[0-9]+$/.test(owner.startTicks) || !/^[0-9a-f-]{36}$/.test(owner.bootId)) {
    throw new Error('Docker enclave recovery lacks verified host ownership');
  }
  // Reconciliation by this same trusted process is also guarded by the
  // adapter's in-process active-execution registry.
  if (owner.pid === current.pid && owner.startTicks === current.startTicks && owner.bootId === current.bootId) return;
  if (owner.bootId !== current.bootId) return;
  try {
    const live = processStart(owner.pid);
    if (live.startTicks === owner.startTicks && !['Z', 'X'].includes(live.state)) {
      throw new Error('Docker enclave host owner is still alive');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export interface DockerHostExpectedContainer {
  name: string;
  image: string;
  entrypoint: string;
  user: string;
  network: string;
  runtime?: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  binds: string[];
  tmpfs: Record<string, string>;
  memory: number;
  cpus: number;
  pids: number;
  shm: number;
  security: string[];
  ulimits: { Name: string; Soft: number; Hard: number }[];
  workdir: string;
  hostname: string;
  command?: string[];
}

export interface DockerHostRecoveryRecord {
  version: 1;
  runId: string;
  invocationId: string;
  entryId: string;
  storageTarget: string;
  storageSource: string;
  storageBytes: number;
  owner: DockerHostOwnerIdentity;
  mount?: DockerHostMountIdentity;
  mountPending?: boolean;
  expected?: DockerHostExpectedContainer;
  containerId?: string;
  /** No absence proof is sufficient while a daemon create may still complete. */
  createPending?: boolean;
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function sorted(values: readonly string[] | null | undefined): string { return JSON.stringify([...(values || [])].sort()); }
function securityOption(value: string): string {
  if (!value.startsWith('seccomp=')) return value;
  const profile = value.slice(8);
  return `seccomp=${JSON.stringify(JSON.parse(profile.startsWith('{') ? profile : fs.readFileSync(profile, 'utf8')))}`;
}

/** Journal stores hashes rather than runtime bearer/model-budget environment values. */
export function expectedDockerHostContainer(args: readonly string[]): DockerHostExpectedContainer {
  const values = new Map<string, string[]>();
  for (let i = 1; i < args.length - 1; i++) {
    const key = args[i];
    if (['--read-only'].includes(key)) continue;
    const value = args[++i];
    values.set(key, [...values.get(key) || [], value]);
  }
  const one = (key: string) => values.get(key)?.[0] || '';
  const map = (key: string, hash = false) => Object.fromEntries((values.get(key) || []).map((value) => {
    const index = value.indexOf('=');
    return [value.slice(0, index), hash ? digest(value.slice(index + 1)) : value.slice(index + 1)];
  }));
  return {
    name: one('--name'), image: args[args.length - 1], entrypoint: one('--entrypoint'),
    user: one('--user'), network: one('--network'), runtime: one('--runtime') || undefined,
    labels: map('--label'), env: map('--env', true), binds: values.get('-v') || [],
    tmpfs: Object.fromEntries((values.get('--tmpfs') || []).map((v) => [v.slice(0, v.indexOf(':')), v.slice(v.indexOf(':') + 1)])),
    memory: dockerMemoryBytes(one('--memory')), cpus: Math.round(Number(one('--cpus')) * 1e9),
    pids: Number(one('--pids-limit')), shm: dockerMemoryBytes(one('--shm-size') || '64m'),
    security: (values.get('--security-opt') || []).map(securityOption),
    ulimits: (values.get('--ulimit') || []).map((value) => {
      const [Name, limits] = value.split('=');
      const [soft, hard = soft] = limits.split(':').map(Number);
      return { Name, Soft: soft, Hard: hard };
    }).sort((a, b) => a.Name.localeCompare(b.Name)),
    workdir: one('--workdir'), hostname: one('--hostname'),
  };
}

/** Inspected immutable IDs are never enough: also verify the complete launch boundary. */
export function assertDockerHostContainer(
  inspected: unknown, expected: DockerHostExpectedContainer, immutableId?: string,
): asserts inspected is Record<string, any> { // Docker's inspect wire representation.
  const c = inspected as Record<string, any>;
  const h = c?.HostConfig;
  const config = c?.Config;
  const fail = () => { throw new Error('Docker enclave immutable identity or configuration mismatch'); };
  if (!c || !h || !config || !/^[0-9a-f]{64}$/.test(c.Id)
    || (immutableId !== undefined && c.Id !== immutableId)
    || c.Name !== `/${expected.name}` || config.Image !== expected.image
    || JSON.stringify(config.Entrypoint) !== JSON.stringify([expected.entrypoint])
    || JSON.stringify(config.Cmd || []) !== JSON.stringify(expected.command || []) || config.User !== expected.user
    || config.WorkingDir !== expected.workdir || config.Hostname !== expected.hostname
    || h.NetworkMode !== expected.network || !h.ReadonlyRootfs || h.Privileged
    || sorted(h.CapDrop) !== '["ALL"]' || (h.CapAdd?.length || 0) !== 0
    || sorted((h.SecurityOpt || []).map(securityOption)) !== sorted(expected.security)
    || h.Memory !== expected.memory || h.MemorySwap !== expected.memory
    || h.NanoCpus !== expected.cpus || h.PidsLimit !== expected.pids || h.ShmSize !== expected.shm
    || (expected.runtime !== undefined && h.Runtime !== expected.runtime)
    || (expected.runtime === undefined && h.Runtime !== 'runc')
    || h.LogConfig?.Type !== 'none' || h.AutoRemove
    || sorted(h.Binds) !== sorted(expected.binds)
    || sorted(Object.entries(h.Tmpfs || {}).map(([k, v]) => `${k}:${v}`))
      !== sorted(Object.entries(expected.tmpfs).map(([k, v]) => `${k}:${v}`))
    || JSON.stringify([...(h.Ulimits || [])].map(({ Name, Soft, Hard }) => ({ Name, Soft, Hard }))
      .sort((a, b) => a.Name.localeCompare(b.Name))) !== JSON.stringify(expected.ulimits)
    || (h.Devices?.length || 0) || (h.DeviceRequests?.length || 0) || (h.VolumesFrom?.length || 0)
    || (h.ExtraHosts?.length || 0) || (h.Links?.length || 0)
    || Object.keys(h.PortBindings || {}).length || h.PublishAllPorts
    || h.PidMode || (h.IpcMode && h.IpcMode !== 'private') || h.UsernsMode) fail();
  if (sorted(Object.keys(c.NetworkSettings?.Networks || {})) !== sorted([expected.network])) fail();
  for (const [key, value] of Object.entries(expected.labels)) {
    if (config.Labels?.[key] !== value) fail();
  }
  const env = Object.fromEntries((config.Env || []).map((v: string) => {
    const at = v.indexOf('=');
    return [v.slice(0, at), digest(v.slice(at + 1))];
  }));
  if (Object.entries(expected.env).some(([key, value]) => env[key] !== value)) fail();
  const mounts = (c.Mounts || []).map((m: any) => `${m.Source}:${m.Destination}:${m.RW ? 'rw' : 'ro'}`);
  if (sorted(mounts) !== sorted(expected.binds) || (c.Mounts || []).some((m: any) => m.Type !== 'bind')) fail();
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_DIRECTORY | fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export class DockerHostRecoveryJournal {
  constructor(readonly directory: string, readonly runId: string) {
    if (!/^[0-9a-f]{16,64}$/.test(runId)) throw new Error('Invalid Docker enclave recovery run identity');
    assertDockerHostPath(directory);
    let ancestor = path.parse(directory).root;
    for (const component of directory.slice(ancestor.length).split(path.sep)) {
      ancestor = path.join(ancestor, component);
      if (!fs.existsSync(ancestor)) {
        fs.mkdirSync(ancestor, { mode: 0o700 });
        syncDirectory(path.dirname(ancestor));
      }
    }
    const stat = fs.lstatSync(directory);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
      throw new Error('Docker enclave journal requires private host-owned durable storage');
    }
    const type = Number(fs.statfsSync(directory).type);
    if ([0x01021994, 0x858458f6].includes(type)) throw new Error('Docker enclave journal must survive tmpfs cleanup');
  }

  private filename(record: Pick<DockerHostRecoveryRecord, 'entryId' | 'invocationId'>): string {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(record.entryId) || !/^[0-9a-f]{16,64}$/.test(record.invocationId)) {
      throw new Error('Invalid Docker enclave journal identity');
    }
    return path.join(this.directory, `${this.runId}-${record.entryId}-${record.invocationId}.json`);
  }

  write(record: DockerHostRecoveryRecord, exclusive = false): void {
    const target = this.filename(record);
    const staging = `${target}.${randomBytes(16).toString('hex')}`;
    const fd = fs.openSync(staging, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      if (exclusive) { fs.linkSync(staging, target); fs.unlinkSync(staging); }
      else fs.renameSync(staging, target);
      syncDirectory(this.directory);
    } finally { if (fs.existsSync(staging)) fs.unlinkSync(staging); }
  }

  records(): DockerHostRecoveryRecord[] {
    return fs.readdirSync(this.directory).filter((name) => name.startsWith(`${this.runId}-`) && name.endsWith('.json')).map((name) => {
      const target = path.join(this.directory, name);
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 128 * 1024 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
          throw new Error('Invalid Docker enclave recovery journal');
        }
        const record = JSON.parse(fs.readFileSync(fd, 'utf8')) as DockerHostRecoveryRecord;
        if (record.version !== 1 || record.runId !== this.runId || this.filename(record) !== target
          || (record.containerId !== undefined && !/^[0-9a-f]{64}$/.test(record.containerId))
          || record.storageSource !== `awf-enclave-${record.runId}-${record.entryId}-${record.invocationId}`
          || !Number.isSafeInteger(record.storageBytes) || record.storageBytes < 1
          || typeof record.storageTarget !== 'string') {
          throw new Error('Invalid Docker enclave recovery record');
        }
        assertDockerHostPath(record.storageTarget);
        return record;
      } finally { fs.closeSync(fd); }
    });
  }

  remove(record: DockerHostRecoveryRecord): void {
    fs.unlinkSync(this.filename(record));
    syncDirectory(this.directory);
  }
}

export async function inspectDockerHostContainer(docker: DockerHostCommand, name: string, signal?: AbortSignal): Promise<Record<string, any> | undefined> {
  const result = await docker(['container', 'inspect', name], signal);
  if (result.exitCode !== 0) {
    // An arbitrary inspect failure is not evidence that a container is absent.
    const filter = /^[0-9a-f]{64}$/.test(name) ? `id=${name}` : `name=^/${name}$`;
    const listed = await docker(['ps', '-aq', '--no-trunc', '--filter', filter], signal);
    if (listed.exitCode === 0 && listed.stdout.trim() === '') return undefined;
    throw new Error('Docker enclave absence could not be proven');
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('Invalid Docker enclave inspect response');
  return parsed[0];
}

export async function removeDockerHostContainer(docker: DockerHostCommand, record: DockerHostRecoveryRecord): Promise<void> {
  if (!record.expected) {
    if (record.containerId) throw new Error('Docker enclave recovery lacks its immutable launch specification');
    return;
  }
  const inspected = await inspectDockerHostContainer(docker, record.expected.name);
  if (!inspected) {
    if (record.createPending) throw new Error('Docker enclave create completion remains uncertain');
    if (record.containerId) {
      const byId = await inspectDockerHostContainer(docker, record.containerId);
      if (byId) throw new Error('Docker enclave immutable container was renamed');
    }
    return;
  }
  assertDockerHostContainer(inspected, record.expected, record.containerId);
  if (inspected.State?.Running) {
    const killed = await docker(['kill', inspected.Id]);
    if (killed.exitCode !== 0) {
      const after = await inspectDockerHostContainer(docker, inspected.Id);
      if (after?.State?.Running) throw new Error('Docker enclave termination could not be proven');
    }
  }
  const removed = await docker(['rm', '-f', inspected.Id]);
  if (removed.exitCode !== 0 || await inspectDockerHostContainer(docker, inspected.Id)
    || await inspectDockerHostContainer(docker, record.expected.name)) {
    throw new Error('Docker enclave removal could not be proven');
  }
}
