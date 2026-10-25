import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from './host-executor-server';
import { HOST_EXECUTOR_ID_PATTERN } from './host-executor-protocol';
import type { HostPreflightReporter, HostPreflightCheck } from '../cloud-hypervisor/host-preflight-progress';

export const HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY =
  '/var/lib/awf-cloud-hypervisor/host-executor-journal';
export const HOST_EXECUTOR_STORAGE_ROOT = '/run/awf-cloud-hypervisor/enclave-storage';

export function hostExecutorStorageDirectory(vmRunId: string): string {
  if (!HOST_EXECUTOR_ID_PATTERN.test(vmRunId)) throw new Error('Invalid invocation storage ID');
  return path.join(HOST_EXECUTOR_STORAGE_ROOT, vmRunId);
}

export function hostExecutorJournalDirectory(run: Pick<HostExecutorRunState, 'journalDir'>): string {
  return run.journalDir ?? HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY;
}

export function hostExecutorVmRunId(
  invocation: Pick<HostExecutorInvocationPlan, 'runId' | 'entryId' | 'invocationId'>,
): string {
  return createHash('sha256').update(JSON.stringify([
    'awf-host-enclave-v1', invocation.runId, invocation.entryId, invocation.invocationId,
  ])).digest('hex').slice(0, 32);
}

export function prepareDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    throw new Error('Host executor journal requires a normalized absolute directory');
  }
  // Reject symlinked ancestors before creating or writing anything.
  let current = path.parse(directory).root;
  for (const component of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe journal ancestor');
      if (stat.uid !== 0 && stat.uid !== process.getuid?.()) throw new Error('Untrusted journal ancestor owner');
      if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
        throw new Error('Writable journal ancestor');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      syncDirectory(path.dirname(current));
    }
  }
  const stat = fs.lstatSync(directory);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('Host executor journal requires private owner-only storage');
  }
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function persist(target: string, value: unknown, exclusive = false, report?: HostPreflightReporter): void {
  const check = <T>(id: HostPreflightCheck, operation: () => T): T =>
    report ? report.checkSync(id, operation) : operation();
  const staging = `${target}.write-${randomBytes(16).toString('hex')}`;
  const fd = check('journal-open', () => fs.openSync(staging,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600));
  try {
    check('journal-write', () => fs.writeFileSync(fd, `${JSON.stringify(value)}\n`));
    check('journal-file-sync', () => fs.fsyncSync(fd));
  } finally { check('journal-file-close', () => fs.closeSync(fd)); }
  try {
    check('journal-publish', () => {
      if (exclusive) {
        fs.linkSync(staging, target);
        fs.unlinkSync(staging);
      } else {
        fs.renameSync(staging, target);
      }
    });
    check('journal-directory-sync', () => syncDirectory(path.dirname(target)));
  } finally {
    check('journal-staging-remove', () => {
      if (fs.existsSync(staging)) fs.unlinkSync(staging);
    });
  }
}
