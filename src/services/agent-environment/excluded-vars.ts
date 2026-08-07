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
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    ...PROXY_ENV_VARS,
    'AWF_PREFLIGHT_BINARY',
    'AWF_STAGED_RUNNER_BINARY_NAME',
    'AWF_GEMINI_ENABLED',
    'MCP_GATEWAY_HOST_DOMAIN',
    'AWF_ENCLAVE_MCP_CAPABILITY',
    'AWF_ENCLAVE_MCP_GATEWAY_IDENTITY',
    'AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT',
    'AWF_ENCLAVE_MCP_GATEWAY_CONTAINER',
    'AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS',
  ]);

  if (config.enableApiProxy) {
    excludedEnvVars.add('OPENAI_API_KEY');
    excludedEnvVars.add('OPENAI_KEY');
    excludedEnvVars.add('CODEX_API_KEY');
    excludedEnvVars.add('ANTHROPIC_API_KEY');
    excludedEnvVars.add('ANTHROPIC_AUTH_TOKEN');
    excludedEnvVars.add('CLAUDE_API_KEY');
    excludedEnvVars.add('COPILOT_GITHUB_TOKEN');
    excludedEnvVars.add('COPILOT_PROVIDER_API_KEY');
    excludedEnvVars.add('GEMINI_API_KEY');
    excludedEnvVars.add('GOOGLE_GEMINI_BASE_URL');
    excludedEnvVars.add('GEMINI_API_BASE_URL');
    excludedEnvVars.add('GOOGLE_API_KEY');
    excludedEnvVars.add('GOOGLE_VERTEX_BASE_URL');
    // GitHub tokens are excluded when API proxy is enabled (strict mode):
    // the agent must not hold live credentials that can be extracted via
    // /proc/self/environ or environment inspection.
    excludedEnvVars.add('GITHUB_TOKEN');
    excludedEnvVars.add('GH_TOKEN');
    excludedEnvVars.add('GITHUB_PERSONAL_ACCESS_TOKEN');
    excludedEnvVars.add('COPILOT_GITHUB_TOKEN');
    excludedEnvVars.add('GITHUB_API_TOKEN');
    excludedEnvVars.add('GITHUB_PAT');
    excludedEnvVars.add('GH_ACCESS_TOKEN');
    // Exclude the OpenAI endpoint override so the sidecar-isolated endpoint
    // URL is never visible to the untrusted agent via its environment.
    excludedEnvVars.add('OPENAI_ENDPOINT_OVERRIDE');
  }

  if (config.difcProxyHost) {
    // Redundant with enableApiProxy block above, kept for explicit documentation:
    // when DIFC proxy handles GitHub auth, tokens must never reach the agent.
    excludedEnvVars.add('GITHUB_TOKEN');
    excludedEnvVars.add('GH_TOKEN');
    excludedEnvVars.add('GITHUB_PERSONAL_ACCESS_TOKEN');
    excludedEnvVars.add('COPILOT_GITHUB_TOKEN');
    excludedEnvVars.add('GITHUB_API_TOKEN');
    excludedEnvVars.add('GITHUB_PAT');
    excludedEnvVars.add('GH_ACCESS_TOKEN');
  }

  if (config.enclaves?.enabled) {
    // Enclaves read private repositories on the primary agent's behalf. A
    // GitHub token in the primary environment would bypass mcpg and defeat
    // repository isolation, so strip tokens independently of proxy settings.
    excludedEnvVars.add('GITHUB_TOKEN');
    excludedEnvVars.add('GH_TOKEN');
    excludedEnvVars.add('GITHUB_PERSONAL_ACCESS_TOKEN');
    excludedEnvVars.add('COPILOT_GITHUB_TOKEN');
    excludedEnvVars.add('GITHUB_API_TOKEN');
    excludedEnvVars.add('GITHUB_PAT');
    excludedEnvVars.add('GH_ACCESS_TOKEN');
  }

  if (config.excludeEnv && config.excludeEnv.length > 0) {
    for (const name of config.excludeEnv) {
      excludedEnvVars.add(name);
    }
  }

  return excludedEnvVars;
}
