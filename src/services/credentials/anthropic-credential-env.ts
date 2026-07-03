import { WrapperConfig, API_PROXY_PORTS } from '../../types';
import { getLowerCaseProcessEnvValue } from '../../env-utils';
import { buildProviderCredentialIsolationEnv } from './provider-credential-isolation';

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
  // Set placeholder credentials for Claude Code CLI credential isolation.
  // Real authentication happens via ANTHROPIC_BASE_URL pointing to api-proxy.
  // Use sk-ant- prefix so Claude Code's key-format validation passes.
  //
  // NOTE: ANTHROPIC_API_KEY is NOT set here — it is excluded from the agent env
  // via excluded-vars.ts when enableApiProxy is active. Setting it (even as a
  // placeholder) would cause Claude Code to attempt direct auth with it instead
  // of routing through ANTHROPIC_BASE_URL.
  return buildProviderCredentialIsolationEnv({
    providerName: 'Anthropic',
    proxyIp,
    port: API_PROXY_PORTS.ANTHROPIC,
    enabled: shouldProxyAnthropic(config),
    baseUrlVarNames: ['ANTHROPIC_BASE_URL'],
    target: config.anthropicApiTarget,
    basePath: config.anthropicApiBasePath,
    placeholders: {
      ANTHROPIC_AUTH_TOKEN: 'sk-ant-placeholder-key-for-credential-isolation',
    },
    // Set API key helper for Claude Code CLI to use credential isolation.
    // The helper script returns a placeholder key; real authentication happens via ANTHROPIC_BASE_URL.
    extraEnv: {
      CLAUDE_CODE_API_KEY_HELPER: '/usr/local/bin/get-claude-key.sh',
    },
  });
}
