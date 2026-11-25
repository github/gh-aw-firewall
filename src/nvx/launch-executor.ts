import { constants, promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { createHash } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import type { Readable, Writable } from 'stream';
import {
  NvxPreparedExecution,
  type NvxOneShotExecutionRequest,
  type NvxOneShotExecutionResult,
  type NvxProcessResult,
} from './one-shot-adapter';
import type { NvxLaunchExecutor, NvxLaunchHooks } from './manager';
import type { NvxPhase3dLaunchPlan } from './runtime-lifecycle';
import {
  buildOpenvmmSeccompFilter,
  DENIED_X86_64_SYSCALLS,
  X32_SYSCALL_BIT,
} from './openvmm-seccomp';
import { createOpenvmmStdoutGate, endStream, pump, writeStream } from './openvmm-streams';
import { readSandboxStatus } from './sandbox-status';

const OPENVMM_DISCOVERY_TIMEOUT_MS = 5_000;
const PROCESS_POLL_MS = 20;
const TERMINATION_GRACE_MS = 2_000;
const OPENVMM_REPL_PROMPT_TIMEOUT_MS = 5_000;

type NvxLaunchChild = Omit<ChildProcess, 'stdio'> & {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  stdio: [
    Writable | null,
    Readable | null,
    Readable | null,
    Writable | null,
    Readable | null,
    Writable | null,
    null,
    null,
  ];
};

interface NvxLaunchOptions {
  readonly plan: NvxPhase3dLaunchPlan;
  readonly request: NvxOneShotExecutionRequest;
  readonly hooks: NvxLaunchHooks;
}

interface OpenvmmLaunch {
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly sandboxGate: Writable;
  readonly sandboxStatus: Readable;
  readonly exit: ReturnType<typeof waitForExit>;
  hasExited(): boolean;
}

interface LaunchSupervision {
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  interrupted(): boolean;
  dispose(): void;
}

export interface NvxLaunchExecutorDependencies {
  spawn(
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      detached: boolean;
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', number, number];
    },
  ): NvxLaunchChild;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  writeFile(filePath: string, contents: string): Promise<void>;
  readlink(filePath: string): Promise<string>;
  stat(filePath: string): Promise<{ dev: bigint; ino: bigint }>;
  open(filePath: string, flags: number): Promise<FileHandle>;
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(milliseconds: number): Promise<void>;
  prepareExecution(
    request: NvxOneShotExecutionRequest,
    outcomePath: string,
  ): Promise<Pick<NvxPreparedExecution, 'onStdout' | 'onStderr' | 'finish'>>;
}

const defaultDependencies: NvxLaunchExecutorDependencies = {
  spawn: (command, args, options) =>
    spawn(command, [...args], options) as unknown as NvxLaunchChild,
  readFile: fs.readFile,
  writeFile: fs.writeFile,
  readlink: fs.readlink,
  stat: (filePath) => fs.stat(filePath, { bigint: true }),
  open: fs.open,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  prepareExecution: (request, outcomePath) =>
    NvxPreparedExecution.create(request, outcomePath),
};

export class DirectOpenvmmLaunchExecutor implements NvxLaunchExecutor {
  private child: NvxLaunchChild | undefined;
  private cgroupPath: string | undefined;
  private terminating: Promise<void> | undefined;

  constructor(
    private readonly dependencies: NvxLaunchExecutorDependencies = defaultDependencies,
  ) {}

  async execute(options: NvxLaunchOptions): Promise<NvxOneShotExecutionResult> {
    if (this.child) throw new Error('NVX direct executor already has an active launch');
    const prepared = await this.dependencies.prepareExecution(
      options.request,
      options.plan.outcomePath,
    );
    const launch = await this.startLaunch(options);
    const stdoutGate = createOpenvmmStdoutGate(
      launch.stdout,
      (chunk) => prepared.onStdout(chunk),
    );
    const stderrPump = pump(launch.stderr, (chunk) => prepared.onStderr(chunk));
    const sandboxStatus = readSandboxStatus(launch.sandboxStatus);
    const supervision = this.supervise(options.request);

    try {
      await this.waitForReadiness(options, launch, sandboxStatus.pid, supervision);
      if (supervision.interrupted()) {
        await this.terminate();
      } else {
        stdoutGate.arm();
        await writeStream(launch.stdin, Buffer.from([0x11]));
        await stdoutGate.waitForPrompt(OPENVMM_REPL_PROMPT_TIMEOUT_MS);
        await writeStream(launch.stdin, Buffer.from('resume\n'));
      }

      const processResult = await this.finishLaunch(launch.exit, supervision, [
        stdoutGate.completed, stderrPump, sandboxStatus.completed,
      ]);
      return await prepared.finish(processResult);
    } catch (error) {
      await this.terminate();
      if (supervision.interrupted()) {
        const processResult = await this.finishLaunch(launch.exit, supervision, [
          stdoutGate.completed,
          stderrPump,
          sandboxStatus.completed.catch(() => undefined),
        ]);
        return prepared.finish(processResult);
      }
      throw error;
    } finally {
      supervision.dispose();
      this.resetLaunch();
    }
  }

  private async startLaunch(options: NvxLaunchOptions): Promise<OpenvmmLaunch> {
    const images = await openCheckedImages(options.request, this.dependencies);
    this.cgroupPath = options.plan.layout.cgroupPath;
    let child: NvxLaunchChild;
    let launcherExited = false;
    let exit: ReturnType<typeof waitForExit>;
    try {
      try {
        child = this.dependencies.spawn(
          options.plan.launchCommand.command,
          options.plan.launchCommand.args,
          {
            cwd: options.plan.layout.runDirectory,
            env: {
              PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
              LANG: 'C.UTF-8',
              LC_ALL: 'C.UTF-8',
              OPENVMM_LOG: 'off',
              TERM: 'dumb',
            },
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', images[0].fd, images[1].fd],
          },
        );
        this.child = child;
        exit = waitForExit(child).then((result) => {
          launcherExited = true;
          return result;
        });
        void exit.catch(() => undefined);
      } finally {
        await closeImages(images);
      }
      if (
        !child.pid ||
        !child.stdin ||
        !child.stdio[3] ||
        !child.stdio[4] ||
        !child.stdio[5]
      ) {
        throw new Error('NVX direct executor did not receive required process file descriptors');
      }
      await endStream(
        child.stdio[5],
        buildOpenvmmSeccompFilter(options.plan.launchCommand.allowCallerMount),
      );
      return {
        pid: child.pid,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        sandboxGate: child.stdio[3],
        sandboxStatus: child.stdio[4],
        exit,
        hasExited: () => launcherExited,
      };
    } catch (error) {
      try {
        await this.terminate();
      } finally {
        this.resetLaunch();
      }
      throw error;
    }
  }

  private async waitForReadiness(
    options: NvxLaunchOptions,
    launch: OpenvmmLaunch,
    sandboxPidReported: Promise<number>,
    supervision: LaunchSupervision,
  ): Promise<void> {
    await options.hooks.launcherStarted(launch.pid);
    const sandboxPid = await Promise.race([
      sandboxPidReported,
      rejectOnExit(launch.exit, 'before Bubblewrap reported its sandbox PID'),
    ]);
    await options.hooks.sandboxStarted(sandboxPid);
    launch.sandboxGate.end();

    const openvmmPid = await Promise.race([
      discoverOpenvmmPid(
        options.plan.layout.cgroupPath,
        options.request.nvxRoot + '/openvmm',
        this.dependencies,
        () => supervision.interrupted() || launch.hasExited(),
      ),
      rejectOnExit(launch.exit, 'before AWF discovered the OpenVMM process'),
    ]);
    const mountNamespace = await this.dependencies.readlink(`/proc/${openvmmPid}/ns/mnt`);
    const mountNamespaceInode = parseMountNamespaceInode(mountNamespace);
    await options.hooks.openvmmReady(openvmmPid, mountNamespaceInode);
  }

  private supervise(request: NvxOneShotExecutionRequest): LaunchSupervision {
    let timedOut = false;
    let cancelled = false;
    let timeout: NodeJS.Timeout | undefined;
    const terminateFor = (reason: 'timeout' | 'cancelled'): void => {
      if (timedOut || cancelled) return;
      timedOut = reason === 'timeout';
      cancelled = reason === 'cancelled';
      void this.terminate().catch(() => undefined);
    };
    if (request.timeoutMs !== undefined) {
      timeout = setTimeout(() => terminateFor('timeout'), request.timeoutMs);
    }
    const onAbort = (): void => terminateFor('cancelled');
    request.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (request.abortSignal?.aborted) onAbort();

    return {
      get timedOut() { return timedOut; },
      get cancelled() { return cancelled; },
      interrupted: () => timedOut || cancelled,
      dispose: () => {
        clearTimeout(timeout);
        request.abortSignal?.removeEventListener('abort', onAbort);
      },
    };
  }

  private async finishLaunch(
    exit: ReturnType<typeof waitForExit>,
    supervision: LaunchSupervision,
    completed: readonly Promise<void>[],
  ): Promise<NvxProcessResult> {
    const processExit = await exit;
    if (supervision.interrupted()) await this.terminate();
    await Promise.all(completed);
    return {
      exitCode: processExit.exitCode,
      signal: processExit.signal,
      timedOut: supervision.timedOut,
      cancelled: supervision.cancelled,
    };
  }

  private resetLaunch(): void {
    this.child = undefined;
    this.cgroupPath = undefined;
    this.terminating = undefined;
  }

  async terminate(): Promise<void> {
    if (this.terminating) return this.terminating;
    const child = this.child;
    const cgroupPath = this.cgroupPath;
    if (!child?.pid && !cgroupPath) return;
    this.terminating = (async () => {
      await this.signalLaunch(child?.pid, cgroupPath, 'SIGTERM');
      await this.dependencies.sleep(TERMINATION_GRACE_MS);
      await this.signalLaunch(child?.pid, cgroupPath, 'SIGKILL');
    })();
    return this.terminating;
  }

  private async signalLaunch(
    launcherPid: number | undefined,
    cgroupPath: string | undefined,
    signal: NodeJS.Signals,
  ): Promise<void> {
    if (signal === 'SIGKILL' && cgroupPath) {
      try {
        await this.dependencies.writeFile(`${cgroupPath}/cgroup.kill`, '1');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EOPNOTSUPP') throw error;
      }
    }
    const pids = cgroupPath
      ? await readCgroupPids(cgroupPath, this.dependencies).catch(() => [])
      : [];
    for (const pid of [...new Set(pids)].sort((left, right) => right - left)) {
      try {
        this.dependencies.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (launcherPid) {
      try {
        this.dependencies.kill(-launcherPid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
}

async function closeImages(images: readonly FileHandle[]): Promise<void> {
  const results = await Promise.allSettled(images.map((image) => image.close()));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

async function openCheckedImages(
  request: NvxOneShotExecutionRequest,
  dependencies: Pick<NvxLaunchExecutorDependencies, 'open'>,
): Promise<readonly [FileHandle, FileHandle]> {
  const images: FileHandle[] = [];
  try {
    const layers = request.filesystem.layers;
    if (layers.length !== 1 || layers[0].role !== 'distro') {
      throw new Error('NVX checked image handoff requires exactly one distro layer');
    }
    const distro = await dependencies.open(
      layers[0].path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    images.push(distro);
    const distroStat = await distro.stat();
    if (!distroStat.isFile() || (distroStat.mode & 0o7777) !== 0o400 ||
      !Number.isSafeInteger(distroStat.size) || distroStat.size < 1) {
      throw new Error('NVX checked distro image must be a nonempty regular file with mode 0400');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < distroStat.size) {
      const { bytesRead } = await distro.read(
        buffer, 0, Math.min(buffer.length, distroStat.size - position), position,
      );
      if (!bytesRead) throw new Error('NVX distro image size changed during descriptor verification');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const afterHash = await distro.stat();
    if (afterHash.size !== distroStat.size || afterHash.mode !== distroStat.mode ||
      afterHash.mtimeMs !== distroStat.mtimeMs || afterHash.ctimeMs !== distroStat.ctimeMs ||
      hash.digest('hex') !== layers[0].sha256) {
      throw new Error('NVX distro image digest changed after preparation');
    }
    const scratch = await dependencies.open(
      request.filesystem.scratch.path,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    images.push(scratch);
    const scratchStat = await scratch.stat();
    if (!scratchStat.isFile() || (scratchStat.mode & 0o7777) !== 0o600 ||
      !Number.isSafeInteger(scratchStat.size) || scratchStat.size < 1 ||
      scratchStat.size !== request.filesystem.scratch.sizeBytes) {
      throw new Error('NVX checked scratch image must be a regular file with mode 0600 and the prepared size');
    }
    return [distro, scratch];
  } catch (error) {
    await closeImages(images);
    throw error;
  }
}

async function discoverOpenvmmPid(
  cgroupPath: string,
  expectedExecutable: string,
  dependencies: NvxLaunchExecutorDependencies,
  cancelled: () => boolean,
): Promise<number> {
  const expected = await dependencies.stat(expectedExecutable);
  const deadline = Date.now() + OPENVMM_DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline && !cancelled()) {
    for (const pid of await readCgroupPids(cgroupPath, dependencies)) {
      try {
        const executable = await dependencies.stat(`/proc/${pid}/exe`);
        if (executable.dev === expected.dev && executable.ino === expected.ino) return pid;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await dependencies.sleep(PROCESS_POLL_MS);
  }
  throw new Error('Timed out discovering the exact OpenVMM process in the NVX cgroup');
}

async function readCgroupPids(
  cgroupPath: string,
  dependencies: Pick<NvxLaunchExecutorDependencies, 'readFile'>,
): Promise<number[]> {
  const contents = await dependencies.readFile(`${cgroupPath}/cgroup.procs`, 'utf8');
  return contents.split(/\r?\n/).filter(Boolean).map((value) => {
    if (!/^\d+$/.test(value)) throw new Error(`Malformed NVX cgroup PID: ${value}`);
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`Unsafe NVX cgroup PID: ${value}`);
    }
    return pid;
  });
}

function parseMountNamespaceInode(value: string): string {
  const match = /^mnt:\[(\d+)\]$/.exec(value);
  if (!match) throw new Error(`Malformed NVX mount namespace identity: ${value}`);
  return match[1];
}

function waitForExit(child: NvxLaunchChild): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function rejectOnExit(
  exit: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>,
  context: string,
): Promise<never> {
  const result = await exit;
  throw new Error(
    `NVX launcher exited ${context}: code=${String(result.exitCode)} signal=${String(result.signal)}`,
  );
}

/** @internal Exposed only for focused policy and descriptor tests. */
// ts-prune-ignore-next
export const testHelpers = {
  deniedX86_64Syscalls: DENIED_X86_64_SYSCALLS,
  deniedWithoutCallerMount: [...DENIED_X86_64_SYSCALLS, 122, 123],
  buildOpenvmmSeccompFilter,
  openCheckedImages,
  x32SyscallBit: X32_SYSCALL_BIT,
};
