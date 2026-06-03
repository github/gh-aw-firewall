import { PROXY_ENV_VARS } from '../../upstream-proxy';
import { WrapperConfig } from '../../types';

export function buildExclusionSet(config: WrapperConfig): Set<string> {
  const excludedEnvVars = new Set([
    'PATH',
    'PWD',
    'OLDPWD',
    'SHLVL',
    '_',
    'SUDO_COMMAND',
    'SUDO_USER',
    'SUDO_UID',
    'SUDO_GID',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_RESULTS_URL',
    ...PROXY_ENV_VARS,
    'AWF_PREFLIGHT_BINARY',
    'AWF_STAGED_RUNNER_BINARY_NAME',
    'AWF_GEMINI_ENABLED',
    'MCP_GATEWAY_HOST_DOMAIN',
  ]);

  if (config.enableApiProxy) {
    excludedEnvVars.add('OPENAI_API_KEY');
    excludedEnvVars.add('OPENAI_KEY');
    excludedEnvVars.add('CODEX_API_KEY');
    excludedEnvVars.add('ANTHROPIC_API_KEY');
    excludedEnvVars.add('CLAUDE_API_KEY');
    excludedEnvVars.add('COPILOT_GITHUB_TOKEN');
    excludedEnvVars.add('COPILOT_PROVIDER_API_KEY');
    excludedEnvVars.add('GEMINI_API_KEY');
    excludedEnvVars.add('GOOGLE_GEMINI_BASE_URL');
    excludedEnvVars.add('GEMINI_API_BASE_URL');
  }

  if (config.difcProxyHost) {
    excludedEnvVars.add('GITHUB_TOKEN');
    excludedEnvVars.add('GH_TOKEN');
  }

  if (config.excludeEnv && config.excludeEnv.length > 0) {
    for (const name of config.excludeEnv) {
      excludedEnvVars.add(name);
    }
  }

  return excludedEnvVars;
}
