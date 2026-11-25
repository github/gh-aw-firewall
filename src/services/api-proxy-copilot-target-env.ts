import { COPILOT_ENV } from '../api-proxy-env-constants';
import { resolveCopilotApiRouting } from '../copilot-api-resolver';
import { resolveCopilotBrokerRuntime, validateCopilotBrokerTarget } from '../copilot-token-broker';
import { getConfigEnvValue } from '../env-utils';
import { normalizeApiTargetScheme } from '../host-env';
import { WrapperConfig } from '../types';

export function buildCopilotTargetEnv(config: WrapperConfig): Record<string, string> {
  const routingValue = (key: string): string | undefined =>
    getConfigEnvValue(config, key) ?? (process.env[key]?.trim() || undefined);
  const copilotProviderType = config.copilotProviderType || getConfigEnvValue(config, COPILOT_ENV.PROVIDER_TYPE);
  const copilotProviderBaseUrl = config.copilotProviderBaseUrl || routingValue(COPILOT_ENV.PROVIDER_BASE_URL);
  const copilotRouting = resolveCopilotApiRouting(
    { copilotApiTarget: config.copilotApiTarget },
    {
      COPILOT_API_TARGET: routingValue(COPILOT_ENV.API_TARGET),
      COPILOT_API_BASE_PATH: config.copilotApiBasePath ?? routingValue(COPILOT_ENV.API_BASE_PATH),
      COPILOT_PROVIDER_BASE_URL: copilotProviderBaseUrl,
    }
  );
  const env: Record<string, string> = {};
  const target = copilotRouting.copilotApiTarget ?? routingValue(COPILOT_ENV.API_TARGET);
  const basePath = copilotRouting.copilotApiBasePath ?? routingValue(COPILOT_ENV.API_BASE_PATH);
  if (target) env[COPILOT_ENV.API_TARGET] = normalizeApiTargetScheme(target);
  if (basePath) env[COPILOT_ENV.API_BASE_PATH] = basePath;

  // Copilot-specific provider passthrough
  if (copilotProviderType) env[COPILOT_ENV.PROVIDER_TYPE] = copilotProviderType;
  if (copilotProviderBaseUrl) env[COPILOT_ENV.PROVIDER_BASE_URL] = copilotProviderBaseUrl;
  if (config.copilotProviderApiKey) env[COPILOT_ENV.PROVIDER_API_KEY] = config.copilotProviderApiKey;

  // Pre-startup model validation (non-sensitive config value).
  // Prefer explicit requestedModel, but fall back to COPILOT_MODEL when present so
  // api-proxy can validate user-facing model aliases (apiProxy.models) at startup.
  const requestedModel = (config.requestedModel || getConfigEnvValue(config, 'COPILOT_MODEL') || '').trim();
  if (requestedModel) env.AWF_REQUESTED_MODEL = requestedModel;
  if (config.copilotByokExtraHeaders !== undefined) {
    env.AWF_BYOK_EXTRA_HEADERS = JSON.stringify(config.copilotByokExtraHeaders);
  }
  if (config.copilotByokExtraBodyFields !== undefined) {
    env.AWF_BYOK_EXTRA_BODY_FIELDS = JSON.stringify(config.copilotByokExtraBodyFields);
  }
  const providerSessionId = resolveProviderSessionId(config);
  if (providerSessionId) {
    env.AWF_PROVIDER_SESSION_ID = providerSessionId;
  }

  if (config.copilotTokenBroker) {
    resolveCopilotBrokerRuntime(config);
    validateCopilotBrokerTarget(env[COPILOT_ENV.API_TARGET], env[COPILOT_ENV.API_BASE_PATH]);
    env[COPILOT_ENV.API_TARGET] ??= 'api.githubcopilot.com';
  }
  return env;
}

function resolveProviderSessionId(config: WrapperConfig): string | undefined {
  // Auto-derivation from GITHUB_RUN_ID was removed because the Copilot
  // `session_id`/`x-session-id` convention causes strict OpenAI-compatible
  // BYOK targets (e.g. Azure OpenAI) to reject every request with HTTP 400.
  // Callers must opt in explicitly via the awf config (`apiProxy.targets.
  // copilot.sessionId`) or by setting AWF_PROVIDER_SESSION_ID in env.
  const value = config.copilotByokSessionId
    ?? getConfigEnvValue(config, 'AWF_PROVIDER_SESSION_ID')
    ?? process.env.AWF_PROVIDER_SESSION_ID;
  const normalizedValue = value?.trim();
  return normalizedValue || undefined;
}
