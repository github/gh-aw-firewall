import * as path from 'path';
import {
  TOOLCHAIN_ENV_VARS,
  readGitHubEnvEntries,
  readGitHubPathEntries,
  mergeGitHubPathEntries,
} from '../github-env';
import { logger } from '../logger';
import { CREDENTIAL_ENTRIES, HOME_FORBIDDEN_SUBDIRS, HOME_TOOL_PATHS, systemDirectories } from '../config/mount-policy';
import { WrapperConfig } from '../types';

export function recoverHostPaths(environment: Record<string, string>): void {
  if (process.env.PATH) {
    const githubPathEntries = readGitHubPathEntries();
    environment.AWF_HOST_PATH = mergeGitHubPathEntries(process.env.PATH, githubPathEntries);
    if (githubPathEntries.length > 0) {
      logger.debug(`Merged ${githubPathEntries.length} path(s) from $GITHUB_PATH into AWF_HOST_PATH`);
    }
  }

  const runningUnderSudo =
    process.getuid?.() === 0 && (Boolean(process.env.SUDO_UID) || Boolean(process.env.SUDO_USER));
  const githubEnvEntries = runningUnderSudo ? readGitHubEnvEntries() : {};

  for (const varName of TOOLCHAIN_ENV_VARS) {
    const value = process.env[varName] || (runningUnderSudo ? githubEnvEntries[varName] : undefined);
    if (value) {
      environment[`AWF_${varName}`] = value;
      if (!process.env[varName] && runningUnderSudo && githubEnvEntries[varName]) {
        logger.debug(`Recovered ${varName} from $GITHUB_ENV (sudo likely stripped it from process.env)`);
      }
    }
  }
}

/**
 * Host paths deliberately kept out of the sandbox. A caller-supplied working
 * directory inside one is never auto-mounted, so `--container-workdir ~/.ssh`
 * cannot defeat credential hiding.
 */
export function hiddenHostRoots(effectiveHome: string): string[] {
  return [
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

/** Converts a Docker mount target to its corresponding chroot-visible path. */
export function normalizeMountedChrootTarget(target: string): string {
  return target === '/host' ? '/' : target.replace(/^\/host(?=\/)/, '');
}

/** Container paths that already exist inside the chroot via another mount. */
export function mountedChrootRoots(
  config: WrapperConfig,
  workspaceDir: string,
  effectiveHome: string,
): string[] {
  const useSysroot = config.runnerTopology === 'arc-dind';
  const customTargets = (config.volumeMounts || [])
    .map((spec) => spec.split(':')[1] || '')
    .filter((target) => target.startsWith('/'))
    .map(normalizeMountedChrootTarget);

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
