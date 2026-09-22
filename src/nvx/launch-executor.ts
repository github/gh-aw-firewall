import { promises as fs } from 'fs';
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

const STATUS_MAX_BYTES = 64 * 1024;
const OPENVMM_DISCOVERY_TIMEOUT_MS = 5_000;
const PROCESS_POLL_MS = 20;
const TERMINATION_GRACE_MS = 2_000;
const OPENVMM_REPL_PROMPT = Buffer.from('openvmm> ');
const OPENVMM_REPL_PROMPT_TIMEOUT_MS = 5_000;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050001;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const DENIED_X86_64_SYSCALLS = [
  101, // ptrace
  155, // pivot_root
  163, // acct
  165, // mount
  166, // umount2
  167, // swapon
  168, // swapoff
  169, // reboot
  172, // iopl
  173, // ioperm
  175, // init_module
  176, // delete_module
  179, // quotactl
  246, // kexec_load
  248, // add_key
  249, // request_key
  250, // keyctl
  272, // unshare
  298, // perf_event_open
  303, // name_to_handle_at
  304, // open_by_handle_at
  308, // setns
  310, // process_vm_readv
  311, // process_vm_writev
  313, // finit_module
  320, // kexec_file_load
  321, // bpf
  323, // userfaultfd
  429, // move_mount
  430, // fsopen
  431, // fsconfig
  432, // fsmount
  433, // fspick
  442, // mount_setattr
] as const;

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
  ];
};

export interface NvxLaunchExecutorDependencies {
  spawn(
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      detached: boolean;
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'];
    },
  ): NvxLaunchChild;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  writeFile(filePath: string, contents: string): Promise<void>;
  readlink(filePath: string): Promise<string>;
  stat(filePath: string): Promise<{ dev: bigint; ino: bigint }>;
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

  async execute(options: {
    readonly plan: NvxPhase3dLaunchPlan;
    readonly request: NvxOneShotExecutionRequest;
    readonly hooks: NvxLaunchHooks;
  }): Promise<NvxOneShotExecutionResult> {
    if (this.child) throw new Error('NVX direct executor already has an active launch');
    const prepared = await this.dependencies.prepareExecution(
      options.request,
      options.plan.outcomePath,
    );
    this.cgroupPath = options.plan.layout.cgroupPath;
    const child = this.dependencies.spawn(
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
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    if (
      !child.pid ||
      !child.stdin ||
      !child.stdio[3] ||
      !child.stdio[4] ||
      !child.stdio[5]
    ) {
      await this.terminate();
      throw new Error('NVX direct executor did not receive required process file descriptors');
    }
    const exit = waitForExit(child);
    await endStream(child.stdio[5], buildOpenvmmSeccompFilter());

    const stdoutGate = createOpenvmmStdoutGate(child.stdout, prepared.onStdout);
    const stderrPump = pump(child.stderr, (chunk) => prepared.onStderr(chunk));
    let timedOut = false;
    let cancelled = false;
    let timeout: NodeJS.Timeout | undefined;
    const terminateFor = (reason: 'timeout' | 'cancelled'): void => {
      if (timedOut || cancelled) return;
      timedOut = reason === 'timeout';
      cancelled = reason === 'cancelled';
      void this.terminate().catch(() => undefined);
    };
    if (options.request.timeoutMs !== undefined) {
      timeout = setTimeout(() => terminateFor('timeout'), options.request.timeoutMs);
    }
    const onAbort = (): void => terminateFor('cancelled');
    options.request.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (options.request.abortSignal?.aborted) onAbort();

    try {
      await options.hooks.launcherStarted(child.pid);
      const sandboxPid = await Promise.race([
        readSandboxPid(child.stdio[4]),
        rejectOnExit(exit, 'before Bubblewrap reported its sandbox PID'),
      ]);
      await options.hooks.sandboxStarted(sandboxPid);
      child.stdio[3].end();

      const openvmmPid = await discoverOpenvmmPid(
        options.plan.layout.cgroupPath,
        options.request.nvxRoot + '/openvmm',
        this.dependencies,
        () => timedOut || cancelled,
      );
      const mountNamespace = await this.dependencies.readlink(`/proc/${openvmmPid}/ns/mnt`);
      const mountNamespaceInode = parseMountNamespaceInode(mountNamespace);
      await options.hooks.openvmmReady(openvmmPid, mountNamespaceInode);
      if (timedOut || cancelled) {
        await this.terminate();
      } else {
        stdoutGate.arm();
        await writeStream(child.stdin, Buffer.from([0x11]));
        await stdoutGate.waitForPrompt(OPENVMM_REPL_PROMPT_TIMEOUT_MS);
        await writeStream(child.stdin, Buffer.from('resume\n'));
      }

      const processExit = await exit;
      if (timedOut || cancelled) await this.terminate();
      await Promise.all([stdoutGate.completed, stderrPump]);
      const processResult: NvxProcessResult = {
        exitCode: processExit.exitCode,
        signal: processExit.signal,
        timedOut,
        cancelled,
      };
      return await prepared.finish(processResult);
    } catch (error) {
      await this.terminate();
      if (timedOut || cancelled) {
        const processExit = await exit;
        await Promise.all([stdoutGate.completed, stderrPump]);
        return prepared.finish({
          exitCode: processExit.exitCode,
          signal: processExit.signal,
          timedOut,
          cancelled,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      options.request.abortSignal?.removeEventListener('abort', onAbort);
      this.child = undefined;
      this.cgroupPath = undefined;
      this.terminating = undefined;
    }
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

async function readSandboxPid(stream: Readable): Promise<number> {
  let contents = Buffer.alloc(0);
  for await (const chunk of stream) {
    contents = Buffer.concat([
      contents,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    if (contents.length > STATUS_MAX_BYTES) {
      throw new Error('Bubblewrap JSON status exceeded the bounded size limit');
    }
    if (contents.includes(0x0a)) break;
  }
  if (contents.length === 0) throw new Error('Bubblewrap did not report JSON status');
  let status: unknown;
  try {
    status = JSON.parse(contents.toString('utf8').trim());
  } catch (error) {
    throw new Error(`Bubblewrap JSON status is malformed: ${formatError(error)}`);
  }
  const pid = (status as { ['child-pid']?: unknown })?.['child-pid'];
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
    throw new Error('Bubblewrap JSON status has no valid child-pid');
  }
  return pid as number;
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

async function pump(
  source: Readable | null,
  destination: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  if (!source) return;
  for await (const chunk of source) {
    await destination(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

function createOpenvmmStdoutGate(
  source: Readable | null,
  destination: (chunk: Buffer) => Promise<void>,
): {
  readonly completed: Promise<void>;
  arm(): void;
  waitForPrompt(timeoutMs: number): Promise<void>;
} {
  if (!source) throw new Error('OpenVMM stdout pipe is unavailable');
  let armed = false;
  let foundPrompt = false;
  let pending = Buffer.alloc(0);
  let resolvePrompt: (() => void) | undefined;
  let rejectPrompt: ((error: Error) => void) | undefined;
  const prompt = new Promise<void>((resolve, reject) => {
    resolvePrompt = resolve;
    rejectPrompt = reject;
  });
  void prompt.catch(() => undefined);
  const completed = (async () => {
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!armed || foundPrompt) {
          await destination(buffer);
          continue;
        }
        pending = Buffer.concat([pending, buffer]);
        const promptIndex = pending.indexOf(OPENVMM_REPL_PROMPT);
        if (promptIndex >= 0) {
          const before = pending.subarray(0, promptIndex);
          const after = pending.subarray(promptIndex + OPENVMM_REPL_PROMPT.length);
          pending = Buffer.alloc(0);
          foundPrompt = true;
          if (before.length > 0) await destination(before);
          if (after.length > 0) await destination(after);
          resolvePrompt?.();
          continue;
        }
        const safeLength = Math.max(0, pending.length - OPENVMM_REPL_PROMPT.length + 1);
        if (safeLength > 0) {
          await destination(pending.subarray(0, safeLength));
          pending = pending.subarray(safeLength);
        }
      }
      if (pending.length > 0) await destination(pending);
      if (armed && !foundPrompt) {
        rejectPrompt?.(new Error('OpenVMM stdout closed before the REPL prompt'));
      }
    } catch (error) {
      rejectPrompt?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  })();
  return {
    completed,
    arm: () => {
      if (armed) throw new Error('OpenVMM REPL prompt gate is already armed');
      armed = true;
    },
    waitForPrompt: async (timeoutMs) => {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          prompt,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Timed out waiting for the OpenVMM REPL prompt')),
              timeoutMs,
            );
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  };
}

function writeStream(stream: Writable, contents: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(contents, (error) => error ? reject(error) : resolve());
  });
}

function endStream(stream: Writable, contents: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end(contents, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

function buildOpenvmmSeccompFilter(): Buffer {
  const instructions: Array<readonly [number, number, number, number]> = [
    [0x20, 0, 0, 4],
    [0x15, 1, 0, AUDIT_ARCH_X86_64],
    [0x06, 0, 0, SECCOMP_RET_KILL_PROCESS],
    [0x20, 0, 0, 0],
  ];
  for (const syscall of DENIED_X86_64_SYSCALLS) {
    instructions.push(
      [0x15, 0, 1, syscall],
      [0x06, 0, 0, SECCOMP_RET_ERRNO_EPERM],
    );
  }
  instructions.push([0x06, 0, 0, SECCOMP_RET_ALLOW]);
  const filter = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jumpTrue, jumpFalse, value], index) => {
    const offset = index * 8;
    filter.writeUInt16LE(code, offset);
    filter.writeUInt8(jumpTrue, offset + 2);
    filter.writeUInt8(jumpFalse, offset + 3);
    filter.writeUInt32LE(value, offset + 4);
  });
  return filter;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
