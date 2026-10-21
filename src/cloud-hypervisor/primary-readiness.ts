import * as fs from 'fs';
import * as path from 'path';
import { assertRealDirectory } from '../fs-utils';

export const PRIMARY_READINESS_FILENAME = 'awf-primary-vm-readiness.json';
export const PRIMARY_READINESS_DIRECTORY = 'cloud-hypervisor';
export const PRIMARY_BOOT_STAGES = [
  'preflight', 'compose-infrastructure', 'infrastructure-discovery',
  'filesystem-write-policy', 'topology-revalidation', 'vmm-configuration',
  'guest-boot', 'guest-network-readiness', 'guest-connectivity', 'ready',
] as const;

export type PrimaryBootStage = typeof PRIMARY_BOOT_STAGES[number];

/**
 * Host-only progress, separate from gateway readiness. The run ID selects the
 * durable cleanup journal; consumers must still verify its owner and resources.
 */
export function createPrimaryReadinessReporter(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRealDirectory(directory);
  const file = path.join(directory, PRIMARY_READINESS_FILENAME);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW, 0o600);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || (stat.mode & 0o777) !== 0o600) {
    fs.closeSync(fd);
    throw new Error('Unsafe primary VM readiness file');
  }
  return {
    publish(
      stage: PrimaryBootStage,
      state: 'starting' | 'ready' | 'failed',
      bootAttempt: number,
      runDirectory?: string,
    ): void {
      const runId = runDirectory ? path.basename(runDirectory) : null;
      if (runId !== null && !/^[A-Za-z0-9_.-]{1,128}$/.test(runId)) {
        throw new Error('Invalid primary VM readiness identity');
      }
      const record = JSON.stringify({
        schemaVersion: 1, ownerPid: process.pid, stage, state, bootAttempt, runId,
      }) + '\n';
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, record, 0, 'utf8');
      fs.fsyncSync(fd);
    },
    close(): void { fs.closeSync(fd); },
  };
}
