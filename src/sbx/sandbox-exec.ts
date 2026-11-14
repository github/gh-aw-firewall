import execa from 'execa';
import { logger } from '../logger';
import { sanitizeEnvForSbx } from './sandbox-create';

/**
 * sbx runs bash -lc, whose login initialization resets PATH on Debian/Ubuntu.
 * Export afterwards so tools installed rootless in ~/.local/bin stay available.
 */
export function withLocalBinOnPath(command: string): string {
  return `export PATH="$HOME/.local/bin\${PATH:+:$PATH}"; ${command}`;
}

/**
 * Executes a command inside the sandbox, streaming stdout/stderr.
 * Returns the exit code of the command.
 */
export async function execInSandbox(
  name: string,
  command: string,
  options?: {
    timeoutMinutes?: number;
    workDir?: string;
    environment?: Record<string, string>;
    tty?: boolean;
  },
): Promise<{ exitCode: number }> {
  logger.info(`Executing in sandbox "${name}": ${command}`);

  const args = ['exec'];
  if (options?.workDir) {
    args.push('--workdir', options.workDir);
  }

  if (options?.tty) {
    args.push('--tty');
  }
  if (options?.environment) {
    for (const [key, value] of Object.entries(options.environment)) {
      args.push('--env', `${key}=${value}`);
    }
  }

  args.push(name, 'bash', '-lc', withLocalBinOnPath(command));

  try {
    const result = await execa('sbx', args, {
      env: sanitizeEnvForSbx(),
      stdio: ['ignore', 'inherit', 'inherit'],
      reject: false,
      timeout: options?.timeoutMinutes ? options.timeoutMinutes * 60 * 1000 : undefined,
    });

    const exitCode = result.exitCode ?? 1;

    if (exitCode === 0) {
      logger.info(`Sandbox command completed successfully`);
    } else {
      logger.warn(`Sandbox command exited with code ${exitCode}`);
    }

    return { exitCode };
  } catch (error: any) {
    if (error.timedOut) {
      logger.error(`Sandbox command timed out after ${options?.timeoutMinutes} minutes`);
      return { exitCode: 124 }; // match timeout convention
    }
    logger.error(`Sandbox exec failed: ${error.message}`);
    return { exitCode: 1 };
  }
}
