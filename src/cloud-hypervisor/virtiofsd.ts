import { promises as fs } from 'fs';
import * as path from 'path';
import execa, { type ExecaChildProcess } from 'execa';
import type { CloudHypervisorCgroup } from './launcher';
import type { CloudHypervisorDirectoryExport } from './exports';

const SOCKET_READY_TIMEOUT_MS = 5_000;
const SOCKET_READY_INTERVAL_MS = 25;
const STOP_TIMEOUT_MS = 2_000;
const CAPTURE_LIMIT_BYTES = 256 * 1024;

export interface VirtiofsdDevice {
  readonly export: CloudHypervisorDirectoryExport;
  readonly socketPath: string;
  readonly logPath: string;
}

export interface VirtiofsdDependencies {
  launch(
    command: string,
    args: string[],
    options: {
      reject: false;
      stdio: ['ignore', 'pipe', 'pipe'];
      env: NodeJS.ProcessEnv;
      extendEnv: false;
    },
  ): ExecaChildProcess<string>;
  lstat(filePath: string): Promise<{ isSocket(): boolean }>;
  chown(filePath: string, uid: number, gid: number): Promise<void>;
  writeFile(filePath: string, contents: Buffer, options: { mode: number }): Promise<void>;
  rm(filePath: string, options: { force: true }): Promise<void>;
  mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
  rmdir(directory: string): Promise<void>;
  runTool(command: string, args: readonly string[]): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}

const defaultDependencies: VirtiofsdDependencies = {
  launch: (command, args, options) => execa(command, args, options),
  lstat: fs.lstat,
  chown: fs.chown,
  writeFile: fs.writeFile,
  rm: (filePath, options) => fs.rm(filePath, options),
  mkdir: fs.mkdir,
  rmdir: fs.rmdir,
  runTool: async (command, args) => {
    const result = await execa(command, [...args], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      extendEnv: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `${command} ${args.join(' ')} exited with code ${result.exitCode}: ` +
        `${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  },
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

interface RunningDaemon extends VirtiofsdDevice {
  readonly process: ExecaChildProcess<string>;
  readonly stdout: BoundedCapture;
  readonly stderr: BoundedCapture;
  readonlyBindPath?: string;
  socketRemoved: boolean;
}

export class VirtiofsdManager {
  private readonly running: RunningDaemon[] = [];

  constructor(
    private readonly binaryPath: string,
    private readonly runDirectory: string,
    private readonly shareDirectory: string,
    private readonly identity: { uid: number; gid: number },
    private readonly cgroup: Pick<CloudHypervisorCgroup, 'assign'>,
    private readonly tools: { readonly mount: string; readonly umount: string },
    private readonly dependencies: VirtiofsdDependencies = defaultDependencies,
  ) {}

  async start(exports: readonly CloudHypervisorDirectoryExport[]): Promise<VirtiofsdDevice[]> {
    try {
      for (const [index, directoryExport] of exports.entries()) {
        await this.startOne(directoryExport, index);
      }
      return this.running.map(({ export: item, socketPath, logPath }) => ({
        export: item,
        socketPath,
        logPath,
      }));
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new Error(
          `virtiofsd startup failed: ${formatError(error)}; cleanup failed: ${formatError(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    const remaining: RunningDaemon[] = [];
    for (const daemon of [...this.running].reverse()) {
      let processTerminated = daemon.process.exitCode !== null || daemon.process.signalCode !== null;
      try {
        if (!processTerminated) {
          daemon.process.kill('SIGTERM', { forceKillAfterTimeout: STOP_TIMEOUT_MS });
        }
        await daemon.process;
        processTerminated = daemon.process.exitCode !== null || daemon.process.signalCode !== null;
      } catch (error) {
        processTerminated = daemon.process.exitCode !== null || daemon.process.signalCode !== null;
        if (!processTerminated) {
          errors.push(error);
        }
      }
      if (!processTerminated) {
        remaining.unshift(daemon);
        continue;
      }
      try {
        const diagnostic = Buffer.concat([
          Buffer.from('--- stdout ---\n'),
          daemon.stdout.contents(),
          Buffer.from('\n--- stderr ---\n'),
          daemon.stderr.contents(),
          Buffer.from('\n'),
        ]);
        await this.dependencies.writeFile(daemon.logPath, diagnostic, { mode: 0o600 });
      } catch (error) {
        errors.push(error);
      }
      if (!daemon.socketRemoved) {
        try {
          await this.dependencies.rm(daemon.socketPath, { force: true });
          daemon.socketRemoved = true;
        } catch (error) {
          errors.push(error);
        }
      }
      if (daemon.readonlyBindPath) {
        try {
          await this.dependencies.runTool(this.tools.umount, [daemon.readonlyBindPath]);
          await this.dependencies.rmdir(daemon.readonlyBindPath);
          daemon.readonlyBindPath = undefined;
        } catch (error) {
          errors.push(error);
        }
      }
      if (!daemon.socketRemoved || daemon.readonlyBindPath) {
        remaining.unshift(daemon);
      }
    }
    this.running.splice(0, this.running.length, ...remaining);
    if (this.running.length === 0) {
      try {
        await this.dependencies.rmdir(this.shareDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new Error(`virtiofsd cleanup failed: ${errors.map(formatError).join('; ')}`);
    }
  }

  private async startOne(
    directoryExport: CloudHypervisorDirectoryExport,
    index: number,
  ): Promise<void> {
    const socketPath = path.join(this.runDirectory, `virtiofs-${index}.sock`);
    const logPath = path.join(this.runDirectory, `virtiofs-${index}.log`);
    let sharedDirectory = directoryExport.source;
    let readonlyBindPath: string | undefined;
    if (directoryExport.mode === 'ro') {
      readonlyBindPath = path.join(this.shareDirectory, `${index}-${directoryExport.tag}`);
      await this.dependencies.mkdir(readonlyBindPath, { recursive: true, mode: 0o700 });
      let bindMounted = false;
      try {
        await this.dependencies.runTool(this.tools.mount, [
          '--bind',
          directoryExport.source,
          readonlyBindPath,
        ]);
        bindMounted = true;
        await this.dependencies.runTool(this.tools.mount, [
          '-o',
          'remount,bind,ro,nosuid,nodev',
          readonlyBindPath,
        ]);
      } catch (error) {
        if (bindMounted) {
          try {
            await this.dependencies.runTool(this.tools.umount, [readonlyBindPath]);
          } catch {
            // Preserve the original mount setup failure.
          }
        }
        await this.dependencies.rmdir(readonlyBindPath).catch(() => undefined);
        throw error;
      }
      sharedDirectory = readonlyBindPath;
    }
    const args = buildVirtiofsdArgs(directoryExport, socketPath, sharedDirectory);
    const child = this.dependencies.launch(this.binaryPath, args, {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      extendEnv: false,
    });
    const stdout = new BoundedCapture(CAPTURE_LIMIT_BYTES);
    const stderr = new BoundedCapture(CAPTURE_LIMIT_BYTES);
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.append(chunk));
    const daemon: RunningDaemon = {
      export: directoryExport,
      socketPath,
      logPath,
      process: child,
      stdout,
      stderr,
      readonlyBindPath,
      socketRemoved: false,
    };
    this.running.push(daemon);
    if (!child.pid) throw new Error(`virtiofsd for "${directoryExport.tag}" did not expose a PID`);
    await this.cgroup.assign(child.pid);
    await this.waitForSocket(daemon);
    await this.dependencies.chown(socketPath, this.identity.uid, this.identity.gid);
  }

  private async waitForSocket(daemon: RunningDaemon): Promise<void> {
    const deadline = Date.now() + SOCKET_READY_TIMEOUT_MS;
    do {
      if (daemon.process.exitCode !== null || daemon.process.signalCode !== null) {
        throw new Error(
          `virtiofsd for "${daemon.export.tag}" exited before socket readiness: ${
            daemon.stderr.contents().toString('utf8').trim() || 'no diagnostics'
          }`,
        );
      }
      try {
        const stat = await this.dependencies.lstat(daemon.socketPath);
        if (!stat.isSocket()) {
          throw new Error(`virtiofsd path is not a Unix socket: ${daemon.socketPath}`);
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await this.dependencies.sleep(SOCKET_READY_INTERVAL_MS);
    } while (Date.now() < deadline);
    throw new Error(
      `virtiofsd for "${daemon.export.tag}" did not create its socket within ${SOCKET_READY_TIMEOUT_MS}ms`,
    );
  }
}

export function buildVirtiofsdArgs(
  directoryExport: CloudHypervisorDirectoryExport,
  socketPath: string,
  sharedDirectory = directoryExport.source,
): string[] {
  if (!path.isAbsolute(socketPath)) {
    throw new Error(`virtiofsd socket path must be absolute: ${socketPath}`);
  }
  return [
    `--socket-path=${socketPath}`,
    `--shared-dir=${sharedDirectory}`,
    '--sandbox=namespace',
    '--seccomp=kill',
    '--cache=auto',
    '--inode-file-handles=never',
  ];
}

class BoundedCapture {
  private buffer = Buffer.alloc(0);

  constructor(private readonly limit: number) {}

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.buffer = Buffer.concat([this.buffer, chunk]).subarray(-this.limit);
  }

  contents(): Buffer {
    return this.buffer;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
