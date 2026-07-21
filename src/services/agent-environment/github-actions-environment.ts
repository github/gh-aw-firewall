import {
  extractGhHostFromServerUrl,
  readEnvFile,
} from '../../github-env';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';
import { PROXY_ENV_VARS } from '../../upstream-proxy';
import { copyEnvEntries } from '../../env-utils';

interface GitHubActionsEnvironmentParams {
  config: WrapperConfig;
  environment: Record<string, string>;
  excludedEnvVars: Set<string>;
}

export function buildGitHubActionsEnvironment(params: GitHubActionsEnvironmentParams): void {
  const { config, environment, excludedEnvVars } = params;
  const ghHost = extractGhHostFromServerUrl(process.env.GITHUB_SERVER_URL);

  if (ghHost) {
    environment.GH_HOST = ghHost;
    logger.debug(`Set GH_HOST=${ghHost} from GITHUB_SERVER_URL`);
  } else if (environment.GH_HOST) {
    delete environment.GH_HOST;
    logger.debug('Removed GH_HOST from environment; falling back to gh CLI default since GITHUB_SERVER_URL did not yield a custom host override');
  }

  if (process.env.AWF_ONE_SHOT_TOKEN_DEBUG) {
    environment.AWF_ONE_SHOT_TOKEN_DEBUG = process.env.AWF_ONE_SHOT_TOKEN_DEBUG;
  }

  if (config.envFile) {
    const fileEnv = readEnvFile(config.envFile);
    copyEnvEntries(fileEnv, environment, {
      excludedKeys: excludedEnvVars,
      noOverwrite: true,
    });
  }

  if (config.additionalEnv) {
    // Proxy vars are in the exclusion set to prevent host proxy leakage via
    // envAll, but explicit --env overrides (additionalEnv) should still be
    // able to set them (e.g. NO_PROXY customization).
    const proxyVarSet = new Set<string>(PROXY_ENV_VARS);
    copyEnvEntries(config.additionalEnv, environment, {
      excludedKeys: excludedEnvVars,
      allowKeys: proxyVarSet,
    });
  }

  if (environment.NO_PROXY !== environment.no_proxy) {
    if (Object.prototype.hasOwnProperty.call(config.additionalEnv ?? {}, 'NO_PROXY')) {
      environment.no_proxy = environment.NO_PROXY;
    } else if (Object.prototype.hasOwnProperty.call(config.additionalEnv ?? {}, 'no_proxy')) {
      environment.NO_PROXY = environment.no_proxy;
    }
  }
}
