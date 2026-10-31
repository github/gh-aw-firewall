import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  dockerStorageHelperArguments, isDockerHelperStorageTarget, runDockerStorageHelper,
} from './docker-storage-helper';

export interface DockerHostMountIdentity {
  mountId: string;
  device: string;
  root: string;
  source: string;
  target: string;
  bytes: number;
}

export function dockerMemoryBytes(value: string | number): number {
  const match = /^([1-9][0-9]*)([bkmg])?$/i.exec(String(value));
  if (!match) throw new Error('Invalid Docker storage limit');
  const bytes = Number(match[1]) * ({ b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]?.toLowerCase() || 'b']!);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Invalid Docker storage limit');
  return bytes;
}

/** Docker's implicit script shm allocation must be counted too. */
export function dockerWritableBudget(
  kind: 'script' | 'agent', tmpfsLimit: string | undefined, hostBytes: number, aggregateBytes: number,
): { hostBytes: number; containerBytes: number; aggregateBytes: number } {
  const containerBytes = kind === 'script'
    ? dockerMemoryBytes(tmpfsLimit || '16m') + dockerMemoryBytes(tmpfsLimit || '1g') + 64 * 1024 ** 2
    : 2 * dockerMemoryBytes(tmpfsLimit!);
  if (![hostBytes, aggregateBytes].every((v) => Number.isSafeInteger(v) && v > 0)
    || hostBytes % 4096 !== 0 || hostBytes + containerBytes > aggregateBytes) {
    throw new Error('Docker enclave writable allocations exceed the aggregate budget');
  }
  return { hostBytes, containerBytes, aggregateBytes };
}

export function assertDockerHostPath(target: string): void {
  if (!path.isAbsolute(target) || path.normalize(target) !== target || /[:,\n\r\0]/.test(target)) {
    throw new Error('Docker enclave paths require normalized local absolute paths');
  }
  let current = path.parse(target).root;
  for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()
        || (stat.uid !== 0 && stat.uid !== process.getuid?.())
        || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
        throw new Error('Unsafe Docker enclave path ancestor');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Privileged host helpers must never be resolved through agent-writable PATH entries. */
export function resolveDockerHostTool(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) continue;
    const resolved = fs.realpathSync(candidate);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) continue;
    let ancestor = path.dirname(resolved);
    let trusted = true;
    while (ancestor !== path.parse(ancestor).root) {
      const parent = fs.statSync(ancestor);
      if (parent.uid !== 0 || (parent.mode & 0o022) !== 0) { trusted = false; break; }
      ancestor = path.dirname(ancestor);
    }
    if (trusted) return resolved;
  }
  throw new Error('Docker enclaves require root-owned immutable system helper binaries');
}

function decodeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

export function inspectDockerHostTmpfs(
  target: string, source: string, bytes: number, mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8'),
): DockerHostMountIdentity {
  const matches = mountInfo.trim().split('\n').map((line) => line.split(' '))
    .filter((fields) => decodeMount(fields[4] || '') === target);
  if (matches.length !== 1) throw new Error('Docker enclave storage is not one exact mount');
  const fields = matches[0];
  const separator = fields.indexOf('-');
  const options = new Set(`${fields[5]},${fields[separator + 3]}`.split(','));
  if (separator < 6 || fields[separator + 1] !== 'tmpfs'
    || decodeMount(fields[separator + 2]) !== source || fields[3] !== '/'
    || !['rw', 'nosuid', 'nodev', 'noexec'].every((v) => options.has(v))) {
    throw new Error('Docker enclave storage is not a restricted AWF tmpfs');
  }
  const capacityOption = [...options].find((v) => v.startsWith('size='));
  if (!capacityOption || dockerMemoryBytes(capacityOption.slice(5)) !== bytes) {
    throw new Error('Docker enclave tmpfs capacity does not match its budget');
  }
  return { mountId: fields[0], device: fields[2], root: fields[3], source, target, bytes };
}

function mountCommand(command: string, args: string[]): Promise<void> {
  const executable = resolveDockerHostTool([`/usr/bin/${command}`, `/bin/${command}`]);
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      timeout: 30_000, maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    }, (error) => {
      if (error) reject(new Error('Docker enclave storage operation failed'));
      else resolve();
    });
  });
}

export async function mountDockerHostStorage(target: string, source: string, bytes: number): Promise<DockerHostMountIdentity> {
  if (isDockerHelperStorageTarget(target)) {
    const response = await runDockerStorageHelper(dockerStorageHelperArguments('mount', target, source, bytes));
    const identity = inspectDockerHostTmpfs(target, source, bytes);
    if (JSON.stringify(identity) !== JSON.stringify(response)) throw new Error('Docker enclave helper mount identity mismatch');
    const stat = fs.statfsSync(target);
    if (Number(stat.type) !== 0x01021994 || Number(stat.blocks) * Number(stat.bsize) !== bytes) {
      throw new Error('Docker enclave helper capacity mismatch');
    }
    return identity;
  }
  assertDockerHostPath(target);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(target).length !== 0) throw new Error('Docker enclave mount target is not empty');
  await mountCommand('mount', [
    '-t', 'tmpfs', '-o', `rw,nosuid,nodev,noexec,size=${bytes},mode=0700`, source, target,
  ]);
  const identity = inspectDockerHostTmpfs(target, source, bytes);
  const stat = fs.statfsSync(target);
  if (Number(stat.type) !== 0x01021994 || Number(stat.blocks) * Number(stat.bsize) !== bytes) {
    throw new Error('Docker enclave tmpfs filesystem capacity could not be verified');
  }
  return identity;
}

/** Only call after immutable-ID removal and labelled-container absence are proven. */
export async function unmountDockerHostStorage(identity: DockerHostMountIdentity): Promise<void> {
  const current = inspectDockerHostTmpfs(identity.target, identity.source, identity.bytes);
  if (JSON.stringify(current) !== JSON.stringify(identity)) throw new Error('Docker enclave mount identity changed');
  if (isDockerHelperStorageTarget(identity.target)) {
    await runDockerStorageHelper(dockerStorageHelperArguments('unmount', identity.target, identity.source, identity.bytes));
  } else await mountCommand('umount', ['--', identity.target]);
  const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  if (mounts.split('\n').some((line) => decodeMount(line.split(' ')[4] || '') === identity.target)) {
    throw new Error('Docker enclave mount remains after unmount');
  }
  if (!isDockerHelperStorageTarget(identity.target)) fs.rmdirSync(identity.target);
}

export async function cleanupDockerHostStorage(record: {
  storageTarget: string; storageSource: string; storageBytes: number; mount?: DockerHostMountIdentity; mountPending?: boolean;
}): Promise<void> {
  if (isDockerHelperStorageTarget(record.storageTarget)) {
    const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    if (record.mount && mounts.split('\n').some((line) => decodeMount(line.split(' ')[4] || '') === record.storageTarget)) {
      const current = inspectDockerHostTmpfs(record.storageTarget, record.storageSource, record.storageBytes);
      if (JSON.stringify(current) !== JSON.stringify(record.mount)) throw new Error('Docker enclave mount identity changed');
    }
    const result = await runDockerStorageHelper(dockerStorageHelperArguments(
      'unmount', record.storageTarget, record.storageSource, record.storageBytes,
    )) as { clean?: boolean };
    if (result.clean !== true) throw new Error('Docker enclave helper cleanup was not proven');
    return;
  }
  assertDockerHostPath(record.storageTarget);
  const mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const mounted = mountInfo.split('\n').some((line) => decodeMount(line.split(' ')[4] || '') === record.storageTarget);
  if (mounted) {
    const identity = record.mount || inspectDockerHostTmpfs(record.storageTarget, record.storageSource, record.storageBytes, mountInfo);
    await unmountDockerHostStorage(identity);
  } else if (record.mountPending) {
    throw new Error('Docker enclave storage mount completion remains uncertain');
  } else if (fs.existsSync(record.storageTarget)) {
    if (fs.readdirSync(record.storageTarget).length) throw new Error('Unverified Docker enclave storage remains');
    fs.rmdirSync(record.storageTarget);
  }

}

/** No payload or credential bytes cross the helper boundary. */
export async function ownDockerHostStorageFile(
  identity: DockerHostMountIdentity, name: string, uid: number, gid: number, reclaim = false,
): Promise<void> {
  if (isDockerHelperStorageTarget(identity.target)) {
    const result = await runDockerStorageHelper([
      ...dockerStorageHelperArguments(reclaim ? 'reclaim' : 'own', identity.target, identity.source, identity.bytes),
      name, ...(reclaim ? [] : [String(uid), String(gid)]),
    ]) as { owned?: boolean };
    if (result.owned !== true) throw new Error('Docker enclave ownership was not proven');
  } else if (!reclaim) fs.chownSync(path.join(identity.target, name), uid, gid);
}
