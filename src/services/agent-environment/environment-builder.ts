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
import { AgentEnvironmentParams } from './types';

export function buildAgentEnvironment(params: AgentEnvironmentParams): Record<string, string> {
  const excludedEnvVars = buildExclusionSet(params.config);
  const environment = buildCoreEnvironment(params);

  buildToolEnvironment({ config: params.config, environment });
  buildProxyEnvironment({ config: params.config, networkConfig: params.networkConfig, environment });
  recoverHostPaths(environment);
  passthroughHostEnvironment({ config: params.config, environment, excludedEnvVars });
  buildOtelEnvironment({ config: params.config, environment, excludedEnvVars });
  buildGitHubActionsEnvironment({ config: params.config, environment, excludedEnvVars });
  warnLargeEnvironmentIfNeeded(params.config.envAll, environment);
  buildApiProxyEnvironment({ ...params, environment });
  buildSslEnvironment(environment, params.sslConfig);

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
