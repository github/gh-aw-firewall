import { promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';

const CLEANUP_DIRECTORY_NAME = 'pending-cleanup';

export interface CleanupRegistryDependencies {
  readonly rootDirectory?: string;
  readonly effectiveUid?: number;
  readonly processId?: number;
  readonly readFile?: typeof fs.readFile;
  readonly readlink?: typeof fs.readlink;
  readonly realpath?: typeof fs.realpath;
  readonly lstat?: typeof fs.lstat;
  readonly stat?: typeof fs.stat;
  readonly mkdir?: typeof fs.mkdir;
  readonly readdir?: typeof fs.readdir;
  readonly rename?: typeof fs.rename;
  readonly link?: typeof fs.link;
  readonly unlink?: typeof fs.unlink;
  readonly rm?: typeof fs.rm;
  readonly rmdir?: typeof fs.rmdir;
  readonly open?: typeof fs.open;
  readonly kill?: typeof process.kill;
  readonly run?: (
    command: string,
    args: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface ResolvedCleanupDependencies {
  readonly rootDirectory: string;
  readonly effectiveUid: number;
  readonly processId: number;
  readonly readFile: typeof fs.readFile;
  readonly readlink: typeof fs.readlink;
  readonly realpath: typeof fs.realpath;
  readonly lstat: typeof fs.lstat;
  readonly stat: typeof fs.stat;
  readonly mkdir: typeof fs.mkdir;
  readonly readdir: typeof fs.readdir;
  readonly rename: typeof fs.rename;
  readonly link: typeof fs.link;
  readonly unlink: typeof fs.unlink;
  readonly rm: typeof fs.rm;
  readonly rmdir: typeof fs.rmdir;
  readonly open: typeof fs.open;
  readonly kill: typeof process.kill;
  readonly run: NonNullable<CleanupRegistryDependencies['run']>;
  readonly sleep: NonNullable<CleanupRegistryDependencies['sleep']>;
}

export function resolveCleanupDependencies(
  dependencies: CleanupRegistryDependencies = {},
): ResolvedCleanupDependencies {
  const runRoot = dependencies.rootDirectory ?? '/run/awf-cloud-hypervisor';
  return {
    rootDirectory: path.join(runRoot, CLEANUP_DIRECTORY_NAME),
    effectiveUid: dependencies.effectiveUid ?? process.geteuid?.() ?? -1,
    processId: dependencies.processId ?? process.pid,
    readFile: dependencies.readFile ?? fs.readFile,
    readlink: dependencies.readlink ?? fs.readlink,
    realpath: dependencies.realpath ?? fs.realpath,
    lstat: dependencies.lstat ?? fs.lstat,
    stat: dependencies.stat ?? fs.stat,
    mkdir: dependencies.mkdir ?? fs.mkdir,
    readdir: dependencies.readdir ?? fs.readdir,
    rename: dependencies.rename ?? fs.rename,
    link: dependencies.link ?? fs.link,
    unlink: dependencies.unlink ?? fs.unlink,
    rm: dependencies.rm ?? fs.rm,
    rmdir: dependencies.rmdir ?? fs.rmdir,
    open: dependencies.open ?? fs.open,
    kill: dependencies.kill ?? process.kill,
    run: dependencies.run ?? runCommand,
    sleep: dependencies.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

async function runCommand(
  command: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // `command` is the absolute `ip` path returned by the root-only preflight.
  // eslint-disable-next-line local/no-unsafe-execa
  const result = await execa(command, [...args], {
    reject: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    extendEnv: false,
    timeout: 10_000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

export async function runChecked(
  run: ResolvedCleanupDependencies['run'],
  command: string,
  args: readonly string[],
): Promise<void> {
  const result = await run(command, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with code ${result.exitCode}: ` +
      `${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

export async function pathExists(
  filePath: string,
  lstat: typeof fs.lstat,
): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
