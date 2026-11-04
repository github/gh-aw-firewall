import { constants, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shellSingleQuote as quote } from '../cloud-hypervisor/backend-utils';
import {
  MAX_PROBE_BYTES, probeCommand, selectHarness,
  type HarnessContext, type HarnessProbe,
} from '../model-information-contract/harness-observation';
import type { NvxLiveMount } from './live-mount-policy';

const GUEST_CONTROL = '/run/awf-harness';
const GUEST_PROBE = `${GUEST_CONTROL}/probe`;
const GUEST_RELEASE = `${GUEST_CONTROL}/release`;
const READY_TIMEOUT_MS = 120_000;

/**
 * One-shot rendezvous over NVX's existing virtio-fs transport. Only the guest
 * writes probe output; the host publishes sanitized evidence before releasing it.
 */
export class NvxHarnessObservation {
  private root: string | undefined;
  private directory: string | undefined;
  private releaseDirectory: string | undefined;
  private ready = false;
  private closed = false;

  constructor(private readonly context: HarnessContext) {}

  async stage(uid: number, gid: number): Promise<readonly NvxLiveMount[]> {
    this.root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-nvx-harness-'));
    // The confined VMM must traverse the parent to export the private directory.
    await fs.chmod(this.root, 0o711);
    this.directory = path.join(this.root, 'probe');
    this.releaseDirectory = path.join(this.root, 'release');
    for (const directory of [this.directory, this.releaseDirectory]) {
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.chown(directory, uid, gid);
    }
    // NVX maps guest workload ownership to each share's owner. A separate
    // read-only share, not mode bits, keeps the release host-owned in the guest.
    return [
      { tag: 'harness-probe', hostPath: this.directory, guestTarget: GUEST_PROBE, mode: 'rw',
        deniedPaths: [], allowedPaths: [], writablePaths: [] },
      { tag: 'harness-release', hostPath: this.releaseDirectory, guestTarget: GUEST_RELEASE, mode: 'ro',
        deniedPaths: [], allowedPaths: [], writablePaths: [] },
    ];
  }

  wrap(command: string): string {
    return withNvxHarnessObservation(this.context, command);
  }

  readonly probe: HarnessProbe = async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!this.closed && Date.now() < deadline) {
      if (this.directory) {
        let file;
        try {
          file = await fs.open(path.join(this.directory, 'result'),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_PROBE_BYTES + 257) {
            throw new Error('Invalid NVX harness observation');
          }
          const buffer = Buffer.alloc(MAX_PROBE_BYTES + 258);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const [environment, status, ...output] = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
          if (environment !== this.context.environment || !/^\d{1,3}$/.test(status)) {
            throw new Error('Invalid NVX harness observation binding');
          }
          const stdout = output.join('\n');
          const exitCode = Number(status);
          this.ready = true;
          return {
            stdout, exitCode, timedOut: exitCode === 124 || exitCode === 137,
            overflow: Buffer.byteLength(stdout) > MAX_PROBE_BYTES,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        } finally {
          await file?.close();
        }
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('NVX harness observation timed out; command not started');
  };

  async release(): Promise<void> {
    if (!this.ready || !this.releaseDirectory) {
      throw new Error('NVX harness observation is not ready; command not started');
    }
    const temporary = path.join(this.releaseDirectory, 'allow.tmp');
    await fs.writeFile(temporary, `${this.context.environment}\n`, { flag: 'wx', mode: 0o444 });
    await fs.rename(temporary, path.join(this.releaseDirectory, 'allow'));
    this.ready = false;
  }

  async cleanup(): Promise<void> {
    this.closed = true;
    if (this.root) await fs.rm(this.root, { recursive: true, force: true });
    this.directory = undefined;
    this.releaseDirectory = undefined;
    this.root = undefined;
  }
}

/** Runs in the same non-login /bin/sh, UID/GID, cwd and exported env as the command. */
export function withNvxHarnessObservation(context: HarnessContext, command: string): string {
  const selection = selectHarness(context.binary || '');
  if (!selection || selection.name !== context.name) throw new Error('Invalid NVX selected harness');
  const probe = `${probeCommand(selection)}`;
  // BusyBox timeout signals only one PID. Bash job control gives both the probe
  // pipeline and watchdog their own groups, so neither leaves descendants behind.
  // -p suppresses startup evaluation without changing exported BASH_ENV.
  const bounded = `set -m
(
  set +m
  ( /bin/sh -c ${quote(probe)}; printf '%s\\n' "$?" >${GUEST_PROBE}/status ) | /usr/bin/head -c ${MAX_PROBE_BYTES + 1}
) &
probe=$!
(
  set +m
  /bin/sleep 10
  : >${GUEST_PROBE}/timed-out
  kill -TERM -- "-$probe" 2>/dev/null || :
  /bin/sleep 1
  kill -KILL -- "-$probe" 2>/dev/null || :
) &
watchdog=$!
wait "$probe" 2>/dev/null || :
if [ -f ${GUEST_PROBE}/timed-out ]; then
  wait "$watchdog" 2>/dev/null || :
  exit 124
fi
kill -TERM -- "-$watchdog" 2>/dev/null || :
wait "$watchdog" 2>/dev/null || :`;
  return `(
umask 077
if /bin/bash --noprofile --norc -p -c ${quote(bounded)} >${GUEST_PROBE}/stdout 2>/dev/null; then
  if [ -f ${GUEST_PROBE}/status ]; then IFS= read -r status <${GUEST_PROBE}/status; else status=126; fi
else
  status=$?
fi
cd ${quote(GUEST_PROBE)} || exit 125
printf '%s\\n%s\\n' ${quote(context.environment)} "$status" >result.tmp || exit 125
/bin/cat stdout >>result.tmp || exit 125
/bin/mv result.tmp result || exit 125
n=0
while [ "$n" -lt ${READY_TIMEOUT_MS / 100} ]; do
  if [ -f ${GUEST_RELEASE}/allow ]; then
    IFS= read -r decision <${GUEST_RELEASE}/allow
    [ "$decision" = ${quote(context.environment)} ] || exit 125
    exit 0
  fi
  /bin/sleep 0.1
  n=$((n + 1))
done
exit 125
) || exit 125
${command}`;
}
