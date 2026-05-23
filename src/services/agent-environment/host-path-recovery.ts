import {
  TOOLCHAIN_ENV_VARS,
  readGitHubEnvEntries,
  readGitHubPathEntries,
  mergeGitHubPathEntries,
} from '../../github-env';
import { logger } from '../../logger';

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
