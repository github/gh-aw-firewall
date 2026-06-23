import { logger } from '../../logger';
import { WrapperConfig, API_PROXY_PORTS } from '../../types';
import { getLowerCaseProcessEnvValue } from '../../env-utils';

interface AnthropicCredentialEnvParams {
  config: WrapperConfig;
  proxyIp: string;
}

function shouldProxyAnthropic(config: WrapperConfig): boolean {
  const normalizedAuthType = getLowerCaseProcessEnvValue('AWF_AUTH_TYPE') || '';
  const normalizedAuthProvider = getLowerCaseProcessEnvValue('AWF_AUTH_PROVIDER') || '';
  return Boolean(config.anthropicApiKey || (normalizedAuthType === 'github-oidc' && normalizedAuthProvider === 'anthropic'));
}

export function buildAnthropicCredentialEnv(params: AnthropicCredentialEnvParams): Record<string, string> {
  const { config, proxyIp } = params;
  if (!shouldProxyAnthropic(config)) {
    return {};
  }

  const anthropicProxyUrl = `http://${proxyIp}:${API_PROXY_PORTS.ANTHROPIC}`;
  const agentEnvAdditions: Record<string, string> = {
    ANTHROPIC_BASE_URL: anthropicProxyUrl,
  };

  logger.debug(`Anthropic API will be proxied through sidecar at ${anthropicProxyUrl}`);
  if (config.anthropicApiTarget) {
    logger.debug(`Anthropic API target overridden to: ${config.anthropicApiTarget}`);
  }
  if (config.anthropicApiBasePath) {
    logger.debug(`Anthropic API base path set to: ${config.anthropicApiBasePath}`);
  }

  // Set placeholder credentials for Claude Code CLI credential isolation.
  // Real authentication happens via ANTHROPIC_BASE_URL pointing to api-proxy.
  // Use sk-ant- prefix so Claude Code's key-format validation passes.
  //
  // NOTE: ANTHROPIC_API_KEY is NOT set here — it is excluded from the agent env
  // via excluded-vars.ts when enableApiProxy is active. Setting it (even as a
  // placeholder) would cause Claude Code to attempt direct auth with it instead
  // of routing through ANTHROPIC_BASE_URL.
  agentEnvAdditions.ANTHROPIC_AUTH_TOKEN = 'sk-ant-placeholder-key-for-credential-isolation';
  logger.debug('ANTHROPIC_AUTH_TOKEN set to placeholder value for credential isolation');

  // Set API key helper for Claude Code CLI to use credential isolation
  // The helper script returns a placeholder key; real authentication happens via ANTHROPIC_BASE_URL
  agentEnvAdditions.CLAUDE_CODE_API_KEY_HELPER = '/usr/local/bin/get-claude-key.sh';
  logger.debug('Claude Code API key helper configured: /usr/local/bin/get-claude-key.sh');

  return agentEnvAdditions;
}
