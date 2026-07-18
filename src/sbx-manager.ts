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
import * as fs from 'fs';
import * as path from 'path';
import { copyEnvEntries } from './env-utils';
import { logger } from './logger';
import { HOME_TOOL_SUBDIRS } from './services/agent-volumes/home-whitelist';
import { credentialEntriesUnderMountedParents } from './config/mount-policy';

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
  copyEnvEntries(process.env, clean, {
    keyPredicate: (key) => !SECRET_ENV_PATTERNS.some((p) => p.test(key)),
  });
  return { ...clean, ...overrides };
}

/** Records a credential path that was moved aside before `sbx create`. */
interface ScrubbedCredential {
  /** Original host path (inside a wholesale-mounted home dir). */
  original: string;
  /** Backup location the path was moved to (outside any mount). */
  backup: string;
}

/**
 * Credential paths moved aside for the current sandbox, plus the temp backup
 * root that holds them. Module-level because scrub happens in createSandbox and
 * restore happens later in removeSandbox (after the live mount is gone).
 */
let scrubbedCredentials: ScrubbedCredential[] = [];
let credentialBackupRoot: string | undefined;

/**
 * Moves known credential stores out of the wholesale-mounted `$HOME` tool dirs
 * before the sandbox is created, so they never enter the microVM. The paths are
 * moved (not deleted) to a backup dir at the home root — which is NOT one of the
 * mounted subdirs — and restored by {@link restoreHomeCredentials} after the
 * sandbox is torn down. This is the sbx analog of compose mode's `/dev/null`
 * credential overlays; the credential list comes from the central mount policy
 * so the two backends can't drift.
 */
function scrubHomeCredentials(homePath: string): void {
  scrubbedCredentials = [];
  credentialBackupRoot = undefined;

  const mountedParents = new Set<string>(HOME_TOOL_SUBDIRS);
  for (const entry of credentialEntriesUnderMountedParents(mountedParents)) {
    const original = path.join(homePath, entry.path);
    if (!fs.existsSync(original)) continue;

    if (!credentialBackupRoot) {
      // A dotted dir at the home ROOT is never in the mounted subdir set, so
      // the backup itself can't leak into the VM.
      credentialBackupRoot = path.join(homePath, `.awf-sbx-cred-backup-${process.pid}`);
      try {
        fs.mkdirSync(credentialBackupRoot, { recursive: true });
      } catch (err) {
        logger.warn(`[sbx] Could not create credential backup dir: ${(err as Error).message}`);
        credentialBackupRoot = undefined;
        return;
      }
    }

    const backup = path.join(credentialBackupRoot, entry.path.replace(/\//g, '__'));
    try {
      fs.renameSync(original, backup);
      scrubbedCredentials.push({ original, backup });
      logger.info(`[sbx] Hid credential path from sandbox: ${entry.path}`);
    } catch (err) {
      logger.warn(`[sbx] Could not hide credential path ${original}: ${(err as Error).message}`);
    }
  }

  if (scrubbedCredentials.length > 0 && credentialBackupRoot) {
    logger.info(
      `[sbx] Moved ${scrubbedCredentials.length} credential path(s) aside to ${credentialBackupRoot} for the duration of the sandbox`,
    );
  }
}

/**
 * Restores any credential paths that {@link scrubHomeCredentials} moved aside.
 * Idempotent and non-throwing; safe to call even when nothing was scrubbed.
 * MUST run only after the sandbox is removed, because the home dirs are live
 * mounts — restoring while the VM is running would re-expose the secrets.
 */
export function restoreHomeCredentials(): void {
  for (const { original, backup } of scrubbedCredentials) {
    try {
      if (fs.existsSync(backup)) {
        fs.renameSync(backup, original);
      }
    } catch (err) {
      logger.warn(
        `[sbx] Could not restore credential path ${original} from ${backup}: ${(err as Error).message}. ` +
          `The original is preserved at ${backup}.`,
      );
    }
  }
  scrubbedCredentials = [];

  if (credentialBackupRoot) {
    try {
      fs.rmSync(credentialBackupRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of the (now-empty) backup dir
    }
    credentialBackupRoot = undefined;
  }
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

  // Mount /tmp so agent runtime files (prompts, logs) are accessible, and
  // /usr/local/bin for Copilot CLI and other installed tools.
  for (const sysPath of ['/tmp', '/usr/local/bin']) {
    if (!seenPaths.has(sysPath)) {
      seenPaths.add(sysPath);
      args.push(sysPath);
    }
  }

  // SECURITY: never mount the whole $HOME into the microVM. sbx mounts are
  // positional (host path == guest path) and cannot express the per-file
  // /dev/null credential overlays that compose mode uses (see
  // credential-hiding.ts), so the only way to keep host secrets out of the VM
  // is to curate which $HOME subdirs are mounted. The central mount policy
  // (HOME_TOOL_SUBDIRS) lists the allowed tool-state dirs including agent-state
  // dirs (.copilot, .gemini). Credential stores such as ~/.aws, ~/.ssh,
  // ~/.docker, ~/.kube, ~/.azure, ~/.gnupg, ~/.netrc and ~/.gitconfig are never
  // whitelisted, so they never enter the sandbox. Only paths that exist on the
  // host are mounted, because sbx requires the mount source to exist.
  //
  // Each whitelisted parent is mounted WHOLESALE (as a directory): sbx mounts
  // are positional, directory-granular virtiofs passthroughs and cannot mount an
  // individual file, so child-by-child expansion would drop loose files the
  // agent needs (e.g. ~/.copilot/mcp-config.json). Several of these dirs also
  // nest a credential store — e.g. .config/gh, .cargo/credentials,
  // .claude/.credentials.json, .gemini/oauth_creds.json.
  // Those specific paths are moved aside on the host BEFORE `sbx create` (see
  // scrubHomeCredentials below) and restored after teardown, so the benign tool
  // state stays available while the secrets never enter the microVM.
  const homePath = process.env.HOME || '/home/runner';
  for (const subdir of HOME_TOOL_SUBDIRS) {
    const hostSubdir = `${homePath}/${subdir}`;
    if (seenPaths.has(hostSubdir)) continue;
    if (!fs.existsSync(hostSubdir)) continue;
    seenPaths.add(hostSubdir);
    args.push(hostSubdir);
  }

  logger.info(`[sbx] Running: sbx ${args.join(' ')}`);

  // Move known credential stores out of the wholesale-mounted home dirs before
  // the sandbox exists, and remember them so they can be restored on teardown.
  scrubHomeCredentials(homePath);

  // Do NOT pass a custom `env` to sbx create. The sanitized env (which strips
  // vars matching TOKEN, SECRET, KEY, etc.) also strips variables the sbx CLI
  // needs internally for credential lookup against the daemon's auth store.
  // Since sbx create is a management command that talks to the local daemon
  // (not user code running inside the sandbox), inheriting process.env is safe —
  // these env vars never enter the sandbox interior. The sandbox interior's env
  // is controlled separately by execInSandbox() which uses sanitizeEnvForSbx().
  //
  // DOCKER_SANDBOXES_PROXY must NOT be set during create — it forces the daemon
  // to route Docker Hub registry auth through Squid, which isn't ready yet.
  // XDG_CONFIG_HOME must also be removed — the Copilot harness sets it to $HOME,
  // which makes the sbx CLI look for credentials in $HOME/ instead of the
  // default $HOME/.config/ where `sbx login` stored them.
  const savedProxy = process.env.DOCKER_SANDBOXES_PROXY;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.DOCKER_SANDBOXES_PROXY;
  delete process.env.XDG_CONFIG_HOME;

  const createResult = await execa('sbx', args, {
    input: 'y\n',
    stdio: ['pipe', 'pipe', 'pipe'],
    reject: false,
    timeout: 120_000, // 2 minute timeout for sandbox creation
  });

  // Restore env vars
  if (savedProxy !== undefined) {
    process.env.DOCKER_SANDBOXES_PROXY = savedProxy;
  }
  if (savedXdg !== undefined) {
    process.env.XDG_CONFIG_HOME = savedXdg;
  }

  const stdout = (createResult.stdout || '').trim();
  const stderr = (createResult.stderr || '').trim();
  const sbxSucceeded = stdout.includes('Created sandbox');
  const exitCode = createResult.exitCode ?? 1;

  if (exitCode !== 0 && !sbxSucceeded) {
    // Sandbox never came up — restore the scrubbed credentials immediately so a
    // failed run doesn't leave the user's home directory mutated.
    restoreHomeCredentials();
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
    // Still restore credentials — the sandbox is being torn down regardless, and
    // leaving the user's home scrubbed would be worse than a stale sandbox.
    restoreHomeCredentials();
    return;
  }

  // Sandbox is gone (mounts released) → safe to move credentials back.
  restoreHomeCredentials();

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
