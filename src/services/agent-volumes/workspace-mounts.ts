import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';
import { INIT_SIGNAL_DIR, LEGACY_INIT_SIGNAL_DIR } from '../../constants';
import { CREDENTIAL_ENTRIES, HOME_FORBIDDEN_SUBDIRS, HOME_TOOL_PATHS, systemDirectories } from '../../config/mount-policy';
import { applyHostPathPrefixToVolumes } from '../host-path-prefix';
import {
  extractCommandBinaryName,
  shouldUseDockerHostStaging,
  stageHostFile,
} from './docker-host-staging';

interface WorkspaceMountsParams {
  config: WrapperConfig;
  projectRoot: string;
  effectiveHome: string;
  workspaceDir: string;
  agentLogsPath: string;
  sessionStatePath: string;
  initSignalDir: string;
}

export function buildWorkspaceMounts(params: WorkspaceMountsParams): string[] {
  const { config, projectRoot, effectiveHome, workspaceDir, agentLogsPath, sessionStatePath, initSignalDir } = params;

  const mounts: string[] = [
    '/tmp:/tmp:rw',
    `${workspaceDir}:${workspaceDir}:rw`,
    `${agentLogsPath}:${effectiveHome}/.copilot/logs:rw`,
    `${sessionStatePath}:${effectiveHome}/.copilot/session-state:rw`,
    `${initSignalDir}:${INIT_SIGNAL_DIR}:rw`,
    // Agent images released before the signal directory moved to /run wait on
    // the legacy path instead. Exposing the same source there keeps a newer CLI
    // working with an older pinned `--image-tag`. Read-only on purpose: the
    // agent only polls for `ready`, and the init container writes through its
    // own read-write mount at INIT_SIGNAL_DIR.
    `${initSignalDir}:${LEGACY_INIT_SIGNAL_DIR}:ro`,
  ];

  if (config.enableApiProxy) {
    const healthCheckScript = path.resolve(projectRoot, 'containers/agent/api-proxy-health-check.sh');
    try {
      if (fs.statSync(healthCheckScript).isFile()) {
        mounts.push(`${healthCheckScript}:/usr/local/bin/api-proxy-health-check.sh:ro`);
      }
    } catch {
      // Optional mount — skip if the source file is unavailable.
    }
  }

  if (shouldUseDockerHostStaging(config.dockerHostPathPrefix)) {
    const commandExecutable = config.agentCommand.trim().split(/\s+/, 1)[0] || '';
    const binaryName = extractCommandBinaryName(config.agentCommand);
    const binarySourcePath = binaryName ? resolveBinaryPath(binaryName, commandExecutable) : undefined;
    if (binaryName && binarySourcePath) {
      const stagedBinaryPath = stageHostFile(config, binarySourcePath, `bin/${binaryName}`, 0o755);
      if (stagedBinaryPath) {
        mounts.push(`${stagedBinaryPath}:/tmp/awf-runner-bin/${binaryName}:ro`);
      }
    }
  }

  mounts.push(...buildContainerWorkDirMounts({ config, workspaceDir, effectiveHome }));

  return mounts;
}

interface ContainerWorkDirMountsParams {
  config: WrapperConfig;
  workspaceDir: string;
  effectiveHome: string;
}

function isAtOrBelow(candidate: string, root: string): boolean {
  if (root === '/') {
    return true;
  }
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Host paths that are deliberately kept out of the sandbox. A caller-supplied
 * working directory inside one of them is never auto-mounted, otherwise a
 * stray `--container-workdir ~/.ssh` would defeat credential hiding.
 */
function hiddenHostRoots(effectiveHome: string): string[] {
  return [
    // Host system trees AWF never exposes wholesale: `/etc` is exposed as a
    // small file allowlist, and the rest hold host state or kernel interfaces.
    '/etc',
    '/root',
    '/proc',
    '/run',
    '/boot',
    '/var/run',
    ...HOME_FORBIDDEN_SUBDIRS.map((subdir) => path.posix.join(effectiveHome, subdir)),
    ...CREDENTIAL_ENTRIES.map((entry) => path.posix.join(effectiveHome, entry.path)),
  ];
}

/** Container paths that already exist inside the chroot via another mount. */
function mountedChrootRoots(params: ContainerWorkDirMountsParams): string[] {
  const { config, workspaceDir, effectiveHome } = params;
  const useSysroot = config.runnerTopology === 'arc-dind';
  const customTargets = (config.volumeMounts || [])
    .map((spec) => spec.split(':')[1] || '')
    .filter((target) => target.startsWith('/'))
    .map((target) => (target === '/host' ? '/' : target.replace(/^\/host(?=\/)/, '')));

  return [
    workspaceDir,
    '/tmp',
    ...systemDirectories(useSysroot),
    ...HOME_TOOL_PATHS
      .filter((toolPath) => toolPath !== '.gemini' || Boolean(config.geminiApiKey || config.googleApiKey))
      .map((toolPath) => path.posix.join(effectiveHome, toolPath)),
    ...customTargets,
  ];
}

/**
 * Mounts the configured `--container-workdir` when no other mount already
 * exposes it inside the chroot.
 *
 * The entrypoint falls back to `/` when the requested working directory is
 * missing, which leaves agents (notably the codex engine) repeatedly trying to
 * `cd` into a workspace path that does not exist and re-discovering their
 * context until they abort. Mounting the directory — or warning explicitly when
 * that is not possible — keeps the in-container CWD equal to the host path the
 * engine was told to use. See github/gh-aw-firewall#8015.
 */
export function buildContainerWorkDirMounts(params: ContainerWorkDirMountsParams): string[] {
  const { config, effectiveHome } = params;
  const configuredWorkDir = config.containerWorkDir;
  if (!configuredWorkDir || !path.isAbsolute(configuredWorkDir)) {
    return [];
  }

  const workDir = path.posix.normalize(configuredWorkDir).replace(/\/+$/, '') || '/';
  // The empty chroot home volume and the filesystem root always exist.
  if (workDir === '/' || workDir === effectiveHome) {
    return [];
  }

  // Credential paths are checked first: a hidden path must never be mounted
  // just because a broader tool-directory mount appears to cover it.
  if (hiddenHostRoots(effectiveHome).some((root) => isAtOrBelow(workDir, root))) {
    logger.warn(
      `Container working directory ${workDir} is inside a host path that AWF deliberately hides from ` +
      'the sandbox; it will not be mounted and the agent will start in / instead'
    );
    return [];
  }

  if (mountedChrootRoots(params).some((root) => isAtOrBelow(workDir, root))) {
    return [];
  }

  if (!isExistingDirectory(workDir)) {
    logger.warn(
      `Container working directory ${workDir} does not exist on the host and is not covered by any ` +
      'mount; the agent will start in / instead'
    );
    return [];
  }

  logger.debug(`Mounting container working directory ${workDir} (not covered by another mount)`);
  return [`${workDir}:${workDir}:rw`, `${workDir}:/host${workDir}:rw`];
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function resolveBinaryPath(binaryName: string, commandExecutable: string): string | undefined {
  if (!binaryName) {
    return undefined;
  }

  if (commandExecutable.includes('/') || commandExecutable.includes('\\')) {
    const candidate = path.resolve(commandExecutable);
    return isExecutableFile(candidate) ? candidate : undefined;
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, binaryName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function buildCustomVolumeMounts(
  volumeMounts?: string[],
  dockerHostPathPrefix?: string,
  options: { quiet?: boolean } = {},
): string[] {
  if (!volumeMounts || volumeMounts.length === 0) {
    return [];
  }

  // `quiet` is used by callers that only re-derive the transformed specs for
  // comparison (e.g. the sysroot volume filter) and must not log them twice.
  const debug = (message: string) => {
    if (!options.quiet) logger.debug(message);
  };

  debug(`Adding ${volumeMounts.length} custom volume mount(s)`);

  // Custom mount sources always use the runner's filesystem view. Translate
  // them even when a source already starts with the daemon-side prefix; this
  // is required when both are /tmp/gh-aw in ARC/DinD safeoutputs workflows.
  const translatedMounts = applyHostPathPrefixToVolumes(
    volumeMounts,
    dockerHostPathPrefix,
    { translateAlreadyPrefixedPaths: true },
  );

  return translatedMounts.map((mount, index) => {
    const parts = mount.split(':');
    if (parts.length >= 2) {
      const hostPath = parts[0];
      const containerPath = parts[1];
      const mode = parts[2] || '';
      // Targets that already carry the chroot prefix (some callers emit both an
      // un-prefixed and a `/host`-prefixed mount) must not be prefixed again,
      // otherwise they land at `/host/host/…` and mount nothing meaningful.
      const chrootContainerPath =
        containerPath === '/host' || containerPath.startsWith('/host/')
          ? containerPath
          : `/host${containerPath}`;
      const transformedMount = mode
        ? `${hostPath}:${chrootContainerPath}:${mode}`
        : `${hostPath}:${chrootContainerPath}`;
      debug(`Adding custom volume mount: ${volumeMounts[index]} -> ${transformedMount} (chroot-adjusted)`);
      return transformedMount;
    }

    return mount;
  });
}
