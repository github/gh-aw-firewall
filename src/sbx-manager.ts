/**
 * Docker sbx (sandbox) microVM lifecycle manager.
 *
 * Manages the agent process inside a Docker sbx microVM while AWF's
 * infrastructure containers (Squid, api-proxy) remain in Docker Compose
 * on the host.  All sbx egress is chained through AWF's Squid proxy via
 * the `DOCKER_SANDBOXES_PROXY` environment variable.
 *
 * ## Lifecycle
 *
 * 1. `createSandbox()` — `sbx create` with workspace mounts
 * 2. `execInSandbox()` — `sbx exec` to run the agent command, streams
 *    stdout/stderr and collects exit code
 * 3. `removeSandbox()` — `sbx stop` + `sbx rm` for cleanup
 *
 * ## Proxy chaining
 *
 * `DOCKER_SANDBOXES_PROXY` is a daemon-level env var that routes all
 * sandbox egress through the specified proxy.  In CI (one sandbox per
 * runner), this is safe to set globally.  AWF sets it to Squid's address
 * (`http://<squidIp>:3128`) before creating the sandbox, so all agent
 * traffic flows through AWF's domain ACL.
 */

import execa from 'execa';
import { logger } from './logger';

/** Name prefix for AWF-managed sandboxes. */
const SBX_NAME_PREFIX = 'awf-agent';

/**
 * Env vars that must NEVER reach the sbx CLI or sandbox interior.
 * Patterns are matched case-insensitively against env var names.
 */
const SECRET_ENV_PATTERNS = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /KEY/i,
  /CREDENTIAL/i,
  /PAT$/i,
  /^DOCKER_PAT$/i,
  /^DOCKER_USERNAME$/i,
];

/** Default sandbox name (single-sandbox-per-run model). */
export const SBX_DEFAULT_NAME = `${SBX_NAME_PREFIX}-${process.pid}`;

export interface SbxConfig {
  /** Sandbox name (defaults to `awf-agent-<pid>`). */
  name?: string;
  /** Workspace directory to mount into the sandbox. */
  workspaceDir: string;
  /** Squid proxy IP for DOCKER_SANDBOXES_PROXY. */
  squidIp: string;
  /** Squid proxy port (default 3128). */
  squidPort?: number;
  /** Additional workspace mounts (read-only paths). */
  extraMounts?: string[];
}

export interface SbxExecOptions {
  timeoutMinutes?: number;
  workDir?: string;
  environment?: Record<string, string>;
  tty?: boolean;
}

/**
 * Strips secret-bearing env vars from process.env so they never reach
 * the sbx CLI or the sandbox interior.  Returns a shallow copy with
 * only non-secret entries plus any explicit overrides.
 */
export function sanitizeEnvForSbx(
  overrides: Record<string, string> = {},
): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_ENV_PATTERNS.some((p) => p.test(key))) {
      clean[key] = value;
    }
  }
  return { ...clean, ...overrides };
}

/**
 * Creates a Docker sbx sandbox with workspace mounts.
 * Sets `DOCKER_SANDBOXES_PROXY` to chain all egress through AWF's Squid.
 */
export async function createSandbox(config: SbxConfig): Promise<string> {
  const name = config.name || SBX_DEFAULT_NAME;
  const squidPort = config.squidPort || 3128;
  const proxyUrl = `http://${config.squidIp}:${squidPort}`;

  logger.info(`[sbx] Creating sandbox "${name}" with proxy ${proxyUrl}`);

  // Verify daemon is running and authenticated before attempting create
  // (sbx has no 'auth status' command; 'sbx ls' requires auth so we use it as a probe)
  const authCheck = await execa('sbx', ['ls'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
    timeout: 10_000,
  });
  if ((authCheck.exitCode ?? 1) !== 0) {
    const daemonCheck = await execa('sbx', ['daemon', 'status'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
      timeout: 10_000,
    });
    logger.error(`[sbx] Not authenticated. daemon status: ${(daemonCheck.stdout || '').trim()}`);
    throw new Error(
      `sbx is not authenticated (sbx ls exit=${authCheck.exitCode}). ` +
      `Ensure 'sbx login' was called with a running daemon. ` +
      `Daemon: ${(daemonCheck.stdout || '').trim()}. ` +
      `Error: ${(authCheck.stderr || '').trim()}`
    );
  }
  logger.info('[sbx] Auth verified ✓');

  const args = [
    'create',
    '--name', name,
    'shell',  // shell agent provides a generic sandbox
    config.workspaceDir,
  ];

  // Add extra mounts passed from AWF config.
  // AWF uses Docker-style "host:container:mode" format but sbx uses positional
  // paths with optional :ro suffix (host path = container path in microVM).
  const seenPaths = new Set<string>([config.workspaceDir]);
  if (config.extraMounts) {
    for (const mount of config.extraMounts) {
      const parts = mount.split(':');
      const hostPath = parts[0];
      if (seenPaths.has(hostPath)) continue; // deduplicate
      seenPaths.add(hostPath);
      // Determine mode: last segment is 'ro' or 'rw' if there are 2+ colons
      const mode = parts.length >= 3 ? parts[parts.length - 1] : (parts.length === 2 && (parts[1] === 'ro' || parts[1] === 'rw') ? parts[1] : undefined);
      if (mode === 'ro') {
        args.push(`${hostPath}:ro`);
      } else {
        args.push(hostPath);
      }
    }
  }

  // Mount /tmp so agent runtime files (prompts, logs) are accessible.
  // Mount /usr/local/bin for Copilot CLI and other installed tools.
  // Mount $HOME for agent writable dirs (.cache, .config, .local, etc.)
  const homePath = process.env.HOME || '/home/runner';
  for (const sysPath of ['/tmp', '/usr/local/bin', homePath]) {
    if (!seenPaths.has(sysPath)) {
      seenPaths.add(sysPath);
      args.push(sysPath);
    }
  }

  logger.info(`[sbx] Running: sbx ${args.join(' ')}`);

  const env = sanitizeEnvForSbx();
  delete env.XDG_CONFIG_HOME;
  env.DOCKER_SANDBOXES_PROXY = proxyUrl;

  const createResult = await execa('sbx', args, {
    env,
    input: 'y\n',
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
    timeout: 120_000, // 2 minute timeout for sandbox creation
  });

  const stdout = (createResult.stdout || '').trim();
  const stderr = (createResult.stderr || '').trim();
  const sbxSucceeded = stdout.includes('Created sandbox');
  const exitCode = createResult.exitCode ?? 1;

  if (exitCode !== 0 && !sbxSucceeded) {
    // Log full debug output for diagnostics
    if (stdout) logger.info(`[sbx] create stdout: ${stdout.substring(0, 2000)}`);
    if (stderr) logger.info(`[sbx] create stderr: ${stderr.substring(0, 2000)}`);
    throw new Error(
      `sbx create failed (exit ${exitCode}): ${stderr || stdout || 'unknown error'}`
    );
  }

  logger.info(`[sbx] Sandbox "${name}" created (exit=${exitCode}, detected=${sbxSucceeded}). stdout=${stdout.substring(0, 200)}`);
  return name;
}

/**
 * Executes a command inside the sandbox, streaming stdout/stderr.
 * Returns the exit code of the command.
 */
export async function execInSandbox(
  name: string,
  command: string,
  options?: SbxExecOptions,
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

  args.push(name, 'bash', '-lc', command);

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

/**
 * Stops and removes the sandbox.
 */
export async function removeSandbox(name: string): Promise<void> {
  logger.info(`Removing sandbox "${name}"...`);

  try {
    const stopResult = await execa('sbx', ['stop', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
    });
    if ((stopResult.exitCode ?? 1) !== 0) {
      const stderr = stopResult.stderr?.trim();
      logger.warn(
        `Failed to stop sandbox "${name}" (exit ${(stopResult.exitCode ?? 1)}${stderr ? `: ${stderr}` : ''})`
      );
    }
  } catch {
    // stop may fail if already stopped — that's fine
  }

  const rmResult = await execa('sbx', ['rm', '--force', name], {
    stdio: ['ignore', 'pipe', 'pipe'],
    reject: false,
  });
  if ((rmResult.exitCode ?? 1) !== 0) {
    const stderr = rmResult.stderr?.trim();
    logger.warn(
      `Failed to remove sandbox "${name}" (exit ${(rmResult.exitCode ?? 1)}${stderr ? `: ${stderr}` : ''})`
    );
    return;
  }

  logger.info(`Sandbox "${name}" removed`);
}

/**
 * Checks if the sbx CLI is available on the system.
 */
export async function isSbxAvailable(): Promise<boolean> {
  try {
    await execa('sbx', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
