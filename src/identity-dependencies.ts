import { promises as fs } from 'fs';
import execa from 'execa';

export interface DefaultIdentityDependencies {
  readonly mkdir: typeof fs.mkdir;
  readonly writeFile: typeof fs.writeFile;
  readonly readFile: typeof fs.readFile;
  readonly rm: typeof fs.rm;
  readonly rmdir: typeof fs.rmdir;
  readonly lstat: typeof fs.lstat;
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly pid: number;
  readonly processStartTime: (pid: number) => Promise<string | undefined>;
}

export interface IdentityCommandError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Creates hardened filesystem and process helpers for privileged identity and lock management.
 * Commands receive only a fixed system PATH, while callers provide their process start-time reader.
 */
export function createDefaultIdentityDependencies(
  processStartTime: DefaultIdentityDependencies['processStartTime'],
): DefaultIdentityDependencies {
  return {
    mkdir: fs.mkdir,
    writeFile: fs.writeFile,
    readFile: fs.readFile,
    rm: fs.rm,
    rmdir: fs.rmdir,
    lstat: fs.lstat,
    run: async (command, args) => {
      // Identity tool paths are absolute paths returned by the root-only preflight.
      // eslint-disable-next-line local/no-unsafe-execa
      const result = await execa(command, [...args], {
        reject: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
        extendEnv: false,
      });
      if (result.exitCode !== 0) {
        throw Object.assign(new Error(
          `${command} ${args.join(' ')} exited with code ${result.exitCode}: ` +
          `${result.stderr.trim() || result.stdout.trim()}`,
        ), {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        } satisfies Pick<IdentityCommandError, 'exitCode' | 'stdout' | 'stderr'>);
      }
      return { stdout: result.stdout, stderr: result.stderr };
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    pid: process.pid,
    processStartTime,
  };
}
