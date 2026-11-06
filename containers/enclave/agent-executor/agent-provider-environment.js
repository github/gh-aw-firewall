'use strict';

function agentProviderEnvironment(engine, endpoint, model, directory, budgetToken) {
  const token = budgetToken?.slice('Bearer '.length) || '******';
  switch (engine) {
    case 'copilot':
      return {
        COPILOT_HOME: `${directory}/copilot`,
        COPILOT_CLI_DIST_DIR: '/usr/local/lib/node_modules/@github/copilot/runtime',
        COPILOT_OFFLINE: 'true',
        COPILOT_GITHUB_TOKEN: '******',
        COPILOT_TOKEN: budgetToken || '******',
        COPILOT_PROVIDER_BEARER_TOKEN: token,
        COPILOT_API_URL: endpoint,
        COPILOT_PROVIDER_BASE_URL: endpoint,
        COPILOT_MODEL: model,
      };
    case 'codex':
      return {
        // AWF owns the outer sandbox; never derive native execution policy from a task.
        AWF_ENCLAVE_AGENT_CODEX_BYPASS_APPROVALS: 'true',
        CODEX_HOME: `${directory}/codex`,
        OPENAI_BASE_URL: `${endpoint}/v1`,
        OPENAI_API_KEY: token,
      };
    case 'claude':
      return {
        CLAUDE_CONFIG_DIR: `${directory}/claude`,
        ANTHROPIC_BASE_URL: endpoint,
        ANTHROPIC_API_KEY: '******',
        ANTHROPIC_AUTH_TOKEN: token,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
      };
    default:
      throw new Error('Unsupported enclave agent engine');
  }
}

module.exports = { agentProviderEnvironment };
