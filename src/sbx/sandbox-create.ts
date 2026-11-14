import execa from 'execa';
import { copyEnvEntries } from '../env-utils';
import { logger } from '../logger';
import { HOME_TOOL_PATHS } from '../config/mount-policy';
import { getRealUserHome } from '../host-identity';
import { CredentialScrubHandle, resolveExistingHomeToolDirectory } from './credential-scrub';

/** Default sandbox name (single-sandbox-per-run model). */
export const SBX_DEFAULT_NAME = `awf-agent-${process.pid}`;

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

/**
 * Strips secret-bearing env vars from process.env so they never reach
 * the sbx CLI or the sandbox interior. Returns a shallow copy with
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

/**
 * Runs an sbx management command with create-time environment fixes applied.
 *
 * `DOCKER_SANDBOXES_PROXY` must be absent before AWF's containers are ready,
 * and `XDG_CONFIG_HOME` must not redirect the sbx CLI away from its normal
 * credential store. Both variables are always restored, even on failure.
 * This mutates process.env: callers must serialize creation in one process.
 */
export async function withCreateSandboxEnvironment<T>(fn: () => Promise<T>): Promise<T> {
  const savedProxy = process.env.DOCKER_SANDBOXES_PROXY;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.DOCKER_SANDBOXES_PROXY;
  delete process.env.XDG_CONFIG_HOME;
  try {
    return await fn();
  } finally {
    if (savedProxy !== undefined) {
      process.env.DOCKER_SANDBOXES_PROXY = savedProxy;
    } else {
      delete process.env.DOCKER_SANDBOXES_PROXY;
    }
    if (savedXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = savedXdg;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
  }
}

export interface SbxCreateConfig {
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

/** Creates a sandbox using the lifecycle's credential backup handle. */
export async function createSandboxInternal(
  config: SbxCreateConfig,
  credentials: CredentialScrubHandle,
): Promise<string> {
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

  // AWF's Docker-style mounts become positional sbx paths with optional :ro.
  const seenPaths = new Set<string>([config.workspaceDir]);
  if (config.extraMounts) {
    for (const mount of config.extraMounts) {
      const parts = mount.split(':');
      const hostPath = parts[0];
      if (seenPaths.has(hostPath)) continue; // deduplicate
      seenPaths.add(hostPath);
      const mode = parts.length >= 3 ? parts[parts.length - 1] : (parts.length === 2 && (parts[1] === 'ro' || parts[1] === 'rw') ? parts[1] : undefined);
      if (mode === 'ro') {
        args.push(`${hostPath}:ro`);
      } else {
        args.push(hostPath);
      }
    }
  }

  // Agent runtime files and installed CLI tools must be accessible.
  for (const sysPath of ['/tmp', '/usr/local/bin']) {
    if (!seenPaths.has(sysPath)) {
      seenPaths.add(sysPath);
      args.push(sysPath);
    }
  }

  // SECURITY: never mount the whole $HOME. sbx's directory-granular virtiofs
  // mounts cannot express compose's per-file /dev/null credential overlays.
  // Mount only central-policy tool paths, moving nested credentials aside first.
  // Narrow .local descendants exclude sandboxd's CA key and microVM state.
  // Resolve home exactly as buildCoreEnvironment() does, including SUDO_USER,
  // so rootless tools are mounted at the HOME injected into the sandbox.
  const homePath = getRealUserHome();
  const mountedHomePaths = new Set<string>();
  for (const toolPath of HOME_TOOL_PATHS) {
    const resolved = resolveExistingHomeToolDirectory(homePath, toolPath);
    if (!resolved) continue;
    const hostToolPath = resolved.source;
    if (seenPaths.has(hostToolPath)) continue;
    seenPaths.add(hostToolPath);
    args.push(hostToolPath);
    if (resolved.relativeHomePath) {
      mountedHomePaths.add(resolved.relativeHomePath);
    }
  }

  logger.info(`[sbx] Running: sbx ${args.join(' ')}`);

  credentials.scrubHomeCredentials(homePath, mountedHomePaths, seenPaths);

  // Do NOT pass a custom env to this management command: sanitizing it strips
  // variables needed for daemon credential lookup, not sandbox user code.
  // The interior's env is controlled separately by execInSandbox().
  // Remove the proxy (registry auth must not use the not-yet-ready Squid)
  // and XDG_CONFIG_HOME (the harness can redirect the CLI's credential store).
  const createResult = await withCreateSandboxEnvironment(() => execa('sbx', args, {
    input: 'y\n',
    stdio: ['pipe', 'pipe', 'pipe'],
    reject: false,
    timeout: 120_000, // 2 minute timeout for sandbox creation
  }));

  const stdout = (createResult.stdout || '').trim();
  const stderr = (createResult.stderr || '').trim();
  const sbxSucceeded = stdout.includes('Created sandbox');
  const exitCode = createResult.exitCode ?? 1;

  if (exitCode !== 0 && !sbxSucceeded) {
    // No live mounts exist after a failed create, so restore immediately.
    credentials.restoreHomeCredentials();
    if (stdout) logger.info(`[sbx] create stdout: ${stdout.substring(0, 2000)}`);
    if (stderr) logger.info(`[sbx] create stderr: ${stderr.substring(0, 2000)}`);
    throw new Error(
      `sbx create failed (exit ${exitCode}): ${stderr || stdout || 'unknown error'}`
    );
  }

  logger.info(`[sbx] Sandbox "${name}" created (exit=${exitCode}, detected=${sbxSucceeded}). stdout=${stdout.substring(0, 200)}`);
  return name;
}
