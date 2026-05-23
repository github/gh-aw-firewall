import {
  extractGhHostFromServerUrl,
  readEnvFile,
} from '../../github-env';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';

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
    for (const [key, value] of Object.entries(fileEnv)) {
      if (!excludedEnvVars.has(key) && !Object.prototype.hasOwnProperty.call(environment, key)) {
        environment[key] = value;
      }
    }
  }

  if (config.additionalEnv) {
    Object.assign(environment, config.additionalEnv);
  }

  if (environment.NO_PROXY !== environment.no_proxy) {
    if (config.additionalEnv?.NO_PROXY) {
      environment.no_proxy = environment.NO_PROXY;
    } else if (config.additionalEnv?.no_proxy) {
      environment.NO_PROXY = environment.no_proxy;
    }
  }
}
