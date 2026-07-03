import { logger } from '../../logger';
import { WrapperConfig, API_PROXY_PORTS } from '../../types';
import { COPILOT_PLACEHOLDER_TOKEN } from '../../constants/placeholders';
import { getConfigEnvValue } from '../../env-utils';
import { buildProviderCredentialIsolationEnv } from './provider-credential-isolation';

interface CopilotCredentialEnvParams {
  config: WrapperConfig;
  proxyIp: string;
}

// Match GPT-5 and o3 family model IDs with optional provider prefixes (e.g. "openai/gpt-5",
// "copilot/o3-mini"). Prefix is intentionally broad because model providers/prefixes
// are runtime-configurable and not limited to a fixed allowlist.
const RESPONSES_WIRE_API_MODEL_PATTERN = /(^|[/:])(gpt-5|o3)([-_.]|$)/i;

function requiresResponsesWireApi(copilotModel: string): boolean {
  return RESPONSES_WIRE_API_MODEL_PATTERN.test(copilotModel);
}

export function buildCopilotCredentialEnv(params: CopilotCredentialEnvParams): Record<string, string> {
  const { config, proxyIp } = params;
  // Route Copilot CLI through the api-proxy sidecar in either of two BYOK modes:
  //
  //   (a) GitHub-token mode — user provides COPILOT_GITHUB_TOKEN. The sidecar holds
  //       the GitHub token and talks to api.githubcopilot.com (CAPI). Used by gh-aw
  //       and by direct `awf -- copilot ...` invocations.
  //
  //   (b) Direct-BYOK mode — user provides COPILOT_PROVIDER_API_KEY (typically with
  //       COPILOT_PROVIDER_BASE_URL) via --env / --env-file / --env-all to point
  //       Copilot CLI at an arbitrary upstream (Azure Foundry, OpenRouter, etc.).
  //       The sidecar still terminates locally; the user's real provider URL/key
  //       are forwarded to the sidecar (see api-proxy-service-config.ts) and the
  //       sidecar uses them as the upstream target while the agent only sees the
  //       loopback sidecar URL and a placeholder key.
  //
  // Both modes set the same agent-side env (offline + BYOK pointed at the sidecar)
  // so that COPILOT_PROVIDER_API_KEY / COPILOT_PROVIDER_BASE_URL never leak into
  // the agent.
  //
  // The trigger also fires when only COPILOT_PROVIDER_BASE_URL is supplied (without
  // a key). The sidecar does not currently support no-auth upstreams and will return
  // 503 in that case, but routing the request through the sidecar (rather than
  // letting the real BASE_URL leak into the agent) preserves the credential-isolation
  // invariant and surfaces a clear error instead of a silent bypass.
  // Reference: https://github.blog/changelog/2026-04-07-copilot-cli-now-supports-byok-and-local-models/
  const hasCopilotProviderApiKey = !!config.copilotProviderApiKey || !!getConfigEnvValue(config, 'COPILOT_PROVIDER_API_KEY');
  const hasCopilotProviderBaseUrl = !!config.copilotProviderBaseUrl || !!getConfigEnvValue(config, 'COPILOT_PROVIDER_BASE_URL');
  const enabled = !!(config.copilotGithubToken || hasCopilotProviderApiKey || hasCopilotProviderBaseUrl);

  const env = buildProviderCredentialIsolationEnv({
    providerName: 'GitHub Copilot',
    proxyIp,
    port: API_PROXY_PORTS.COPILOT,
    enabled,
    // COPILOT_API_URL: sidecar URL for the Copilot token/completion endpoint.
    // COPILOT_PROVIDER_BASE_URL: sidecar URL for the BYOK provider endpoint.
    baseUrlVarNames: ['COPILOT_API_URL', 'COPILOT_PROVIDER_BASE_URL'],
    target: config.copilotApiTarget,
    placeholders: {
      COPILOT_TOKEN: COPILOT_PLACEHOLDER_TOKEN,
    },
    // Enable Copilot CLI offline + BYOK mode so it skips the GitHub OAuth handshake
    // and talks directly to the sidecar without needing GitHub authentication for inference.
    extraEnv: {
      COPILOT_OFFLINE: 'true',
    },
  });

  if (!enabled) {
    return env;
  }

  // Credential-isolation placeholders for the BYOK auth variables. These MUST be
  // set here (in agentEnvAdditions, applied last in compose-generator) rather than
  // only in tool-specific-environment.ts, because `Object.assign(environment,
  // config.additionalEnv)` in github-actions-environment.ts otherwise overrides any
  // earlier placeholder with the user-supplied real value (e.g. when the user runs
  // `awf --env COPILOT_PROVIDER_API_KEY=...`). The real values are forwarded to the
  // sidecar (see api-proxy-service-config.ts); the agent only ever sees these
  // placeholders regardless of which env input path (--env / --env-file / --env-all)
  // the user used.
  if (config.copilotGithubToken) {
    env.COPILOT_GITHUB_TOKEN = COPILOT_PLACEHOLDER_TOKEN;
    logger.debug('COPILOT_GITHUB_TOKEN set to placeholder value for credential isolation');
  }
  // Only mask COPILOT_PROVIDER_API_KEY when the user actually supplied one. If
  // there is nothing to mask, omit it rather than injecting a placeholder that
  // would misleadingly tell Copilot CLI "a key is configured".
  if (hasCopilotProviderApiKey) {
    env.COPILOT_PROVIDER_API_KEY = COPILOT_PLACEHOLDER_TOKEN;
    logger.debug('COPILOT_PROVIDER_API_KEY set to placeholder value for credential isolation');
  }

  // Set the wire API based solely on the model, regardless of which auth path is active.
  // GPT-5-family models must use the /responses endpoint; setting this here ensures the
  // Copilot CLI uses the correct endpoint in both BYOK modes.
  const copilotModel = getConfigEnvValue(config, 'COPILOT_MODEL');
  if (copilotModel && requiresResponsesWireApi(copilotModel)) {
    env.COPILOT_PROVIDER_WIRE_API = 'responses';
    logger.debug(`COPILOT_PROVIDER_WIRE_API set to responses for model: ${copilotModel}`);
  }

  return env;
}
