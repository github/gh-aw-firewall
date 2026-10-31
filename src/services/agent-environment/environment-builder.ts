import { ENV_SIZE_WARNING_THRESHOLD } from '../../constants';
import { logger } from '../../logger';
import { buildApiProxyEnvironment } from './api-proxy-environment';
import { buildCoreEnvironment } from './core-environment';
import { passthroughHostEnvironment } from './env-passthrough';
import { buildExclusionSet } from './excluded-vars';
import { buildGitHubActionsEnvironment } from './github-actions-environment';
import { recoverHostPaths } from './host-path-recovery';
import { buildOtelEnvironment, buildSslEnvironment } from './observability-environment';
import { buildProxyEnvironment } from './proxy-environment';
import { buildToolEnvironment } from './tool-specific-environment';
import { enforceGithubTokenIsolation, getGithubTokenEnvValues } from './github-token-isolation';
import { isRouterOtelHostEnvVar } from '../router-otel-env';
import { AgentEnvironmentParams } from './types';
import { COPILOT_BROKER_PRIVATE_ENV, COPILOT_BROKER_CONTEXT_ENV } from '../../copilot-token-broker';

export function buildAgentEnvironment(params: AgentEnvironmentParams): Record<string, string> {
  const excludedEnvVars = buildExclusionSet(params.config);
  const environment = buildCoreEnvironment(params);

  buildToolEnvironment({ config: params.config, environment });
  buildProxyEnvironment({ config: params.config, networkConfig: params.networkConfig, environment });
  recoverHostPaths(environment);
  passthroughHostEnvironment({ config: params.config, environment, excludedEnvVars });
  buildOtelEnvironment({ config: params.config, environment, excludedEnvVars });
  buildGitHubActionsEnvironment({ config: params.config, environment, excludedEnvVars });
  // Router export settings, including collector headers, belong to the router only. Drop the
  // whole reserved namespace, whether --env-all, --env-file or --env supplied it.
  for (const name of Object.keys(environment)) {
    if (isRouterOtelHostEnvVar(name)) delete environment[name];
  }
  warnLargeEnvironmentIfNeeded(params.config.envAll, environment);
  buildApiProxyEnvironment({ ...params, environment });
  buildSslEnvironment(environment, params.sslConfig);
  for (const name of COPILOT_BROKER_PRIVATE_ENV) delete environment[name];
  if (params.config.copilotTokenBroker) {
    for (const name of COPILOT_BROKER_CONTEXT_ENV) delete environment[name];
  }
  if (params.config.enclaves?.enabled) {
    enforceGithubTokenIsolation(
      environment,
      [...getGithubTokenEnvValues(), params.config.githubToken],
      'agent sandbox',
    );
  }

  return environment;
}

function warnLargeEnvironmentIfNeeded(envAll: boolean | undefined, environment: Record<string, string>): void {
  if (!envAll) {
    return;
  }

  const totalEnvBytes = Object.entries(environment)
    .reduce((sum, [key, value]) => sum + key.length + (value?.length ?? 0) + 2, 0);
  if (totalEnvBytes > ENV_SIZE_WARNING_THRESHOLD) {
    logger.warn(
      `⚠️  Total container environment size is ${(totalEnvBytes / 1024).toFixed(0)} KB — ` +
      'may cause E2BIG (Argument list too long) errors when combined with large command arguments'
    );
    logger.warn('   Consider using --exclude-env to remove unnecessary variables');
  }
}
