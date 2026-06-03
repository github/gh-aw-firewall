import { MAX_ENV_VALUE_SIZE } from '../../constants';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';

interface EnvPassthroughParams {
  config: WrapperConfig;
  environment: Record<string, string>;
  excludedEnvVars: Set<string>;
}

export function passthroughHostEnvironment(params: EnvPassthroughParams): void {
  const { config, environment, excludedEnvVars } = params;

  if (config.envAll) {
    const skippedLargeVars: string[] = [];
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !excludedEnvVars.has(key) && !Object.prototype.hasOwnProperty.call(environment, key)) {
        const valueSizeBytes = Buffer.byteLength(value, 'utf8');
        if (valueSizeBytes > MAX_ENV_VALUE_SIZE) {
          skippedLargeVars.push(`${key} (${(valueSizeBytes / 1024).toFixed(0)} KB)`);
          continue;
        }
        environment[key] = value;
      }
    }

    if (skippedLargeVars.length > 0) {
      logger.warn(`Skipped ${skippedLargeVars.length} oversized env var(s) from --env-all passthrough (>${(MAX_ENV_VALUE_SIZE / 1024).toFixed(0)} KB each):`);
      for (const entry of skippedLargeVars) {
        logger.warn(`  - ${entry}`);
      }
      logger.warn('Use --env VAR="$VAR" to explicitly pass large values if needed.');
    }
    return;
  }

  const alwaysForwardVars = [
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_PERSONAL_ACCESS_TOKEN',
    'USER',
    'XDG_CONFIG_HOME',
    'GITHUB_SERVER_URL',
    'GITHUB_API_URL',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'DOCKER_HOST',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_API_VERSION',
    'DOCKER_DEFAULT_PLATFORM',
    'COPILOT_OTEL_FILE_EXPORTER_PATH',
  ] as const;

  for (const v of alwaysForwardVars) {
    if (process.env[v]) {
      environment[v] = process.env[v]!;
    }
  }

  if (!config.enableApiProxy) {
    for (const v of [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'ANTHROPIC_API_KEY',
      'COPILOT_GITHUB_TOKEN',
      'COPILOT_PROVIDER_API_KEY',
    ] as const) {
      if (process.env[v]) {
        environment[v] = process.env[v]!;
      }
    }
  }

  if (process.env.TERM && !config.tty) {
    environment.TERM = process.env.TERM;
  }

  if (config.enableDind && config.awfDockerHost?.startsWith('unix://')) {
    environment.DOCKER_HOST = config.awfDockerHost;
  }
}
