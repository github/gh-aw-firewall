import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';

export const DOCKER_ENCLAVE_STORAGE_ROOT = '/var/lib/awf/enclave-storage';
export const DOCKER_ENCLAVE_HELPER_ROOT = '/var/lib/awf';
export const DOCKER_ENCLAVE_STORAGE_HELPER = '/var/lib/awf/enclave-storage-helper.py';
export const DOCKER_ENCLAVE_MAX_HOST_BYTES = 4 * 1024 ** 3;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const version: string = require('../../package.json').version;
const environment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };

export function hasDockerHostMountCapability(): boolean {
  try {
    const value = /^CapEff:\s*([0-9a-f]+)$/mi.exec(fs.readFileSync('/proc/self/status', 'utf8'))?.[1];
    return !!value && (BigInt(`0x${value}`) & (1n << 21n)) !== 0n;
  } catch { return false; }
}

function immutableFile(filename: string, executable: boolean): void {
  let current = '/';
  for (const component of filename.slice(1).split('/')) {
    current = path.join(current, component);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)
      || (current === filename ? !info.isFile() || (executable && !(info.mode & 0o111)) : !info.isDirectory())) {
      throw new Error('Untrusted Docker enclave storage helper installation');
    }
  }
}

function helperCommand(args: readonly string[]): { command: string; args: string[] } {
  immutableFile(DOCKER_ENCLAVE_STORAGE_HELPER, false);
  // Ubuntu's /usr/bin/python3 is a root-owned symlink; resolve its trusted target.
  const python = fs.realpathSync('/usr/bin/python3');
  immutableFile(python, true);
  const sudo = fs.realpathSync('/usr/bin/sudo');
  immutableFile(sudo, true);
  return { command: sudo, args: ['-n', '--', '/usr/bin/python3', '-I', DOCKER_ENCLAVE_STORAGE_HELPER, ...args] };
}

export function assertDockerStorageHelperAvailable(): void {
  try {
    const command = helperCommand(['probe', version]);
    const result = JSON.parse(execFileSync(command.command, command.args, {
      env: environment, timeout: 10_000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
    if (result.version !== version || result.uid !== process.getuid?.()
      || result.maxBytes !== DOCKER_ENCLAVE_MAX_HOST_BYTES
      || result.stateRoot !== dockerHelperHostStateRoot()) throw new Error('Helper version mismatch');
  } catch {
    throw new Error('Docker enclaves require the matching AWF host storage helper and noninteractive sudo authorization; reinstall AWF with install.sh (do not sudo the entire workflow)');
  }
}

export function dockerHelperHostStateRoot(): string {
  return path.join(DOCKER_ENCLAVE_STORAGE_ROOT, String(process.getuid?.()), 'host-state');
}

export function dockerHelperStorageTarget(runId: string, entryId: string, invocationId: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(runId) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(entryId)
    || !/^[0-9a-f]{16,64}$/.test(invocationId)) throw new Error('Invalid Docker helper allocation identity');
  return path.join(DOCKER_ENCLAVE_STORAGE_ROOT, String(process.getuid?.()), `${runId}-${entryId}`, invocationId);
}

export function isDockerHelperStorageTarget(target: string): boolean {
  return target.startsWith(`${DOCKER_ENCLAVE_STORAGE_ROOT}/`);
}

export function dockerStorageHelperArguments(operation: 'mount' | 'unmount' | 'own' | 'reclaim', target: string, source: string, bytes: number): string[] {
  const prefix = `${DOCKER_ENCLAVE_STORAGE_ROOT}/${process.getuid?.()}/`;
  const allocation = target.slice(prefix.length);
  const match = /^([0-9a-f]{16,64})-([a-z0-9][a-z0-9-]{0,62})\/([0-9a-f]{16,64})$/.exec(allocation);
  if (!target.startsWith(prefix) || !match || source !== `awf-enclave-${match[1]}-${match[2]}-${match[3]}`
    || !Number.isSafeInteger(bytes) || bytes < 4096 || bytes > DOCKER_ENCLAVE_MAX_HOST_BYTES || bytes % 4096) {
    throw new Error('Invalid Docker helper storage request');
  }
  return [operation, allocation, source, String(bytes)];
}

export function runDockerStorageHelper(args: string[]): Promise<unknown> {
  const command = helperCommand([version, ...args]);
  return new Promise((resolve, reject) => {
    execFile(command.command, command.args, {
      env: environment, timeout: 30_000, maxBuffer: 4096, killSignal: 'SIGKILL',
    }, (error, stdout) => {
      if (error) reject(new Error('Docker enclave storage helper failed; private recovery state is preserved'));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error('Invalid Docker enclave storage helper response')); }
      }
    });
  });
}
