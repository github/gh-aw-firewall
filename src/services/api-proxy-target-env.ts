import { OPENAI_ENV, ANTHROPIC_ENV, GEMINI_ENV, COPILOT_ENV, VERTEX_ENV, FOUNDRY_ENV } from '../api-proxy-env-constants';
import { resolveDatabricksOidcHost } from '../api-proxy-config-validation';
import { resolveCopilotApiRouting } from '../copilot-api-resolver';
import { getConfigEnvValue } from '../env-utils';
import { normalizeApiTargetScheme } from '../host-env';
import { resolveOpenAiBaseUrlFromEnv } from '../openai-base-url-env';
import { trustedServiceTargets } from '../trusted-service';
import { WrapperConfig } from '../types';
import { buildCopilotTargetEnv } from './api-proxy-copilot-target-env';
import { assertDatabricksTargetsMatchWorkspace } from './api-proxy-databricks-guard';

/**
 * Builds provider API target/basePath environment variables for the api-proxy container.
 * Centralizes the repetitive per-provider target/basePath conditional env generation.
 * @internal Exported for testing
 */
export function buildProviderTargetEnv(config: WrapperConfig): Record<string, string> {
  const routingValue = (key: string): string | undefined =>
    getConfigEnvValue(config, key) ?? (process.env[key]?.trim() || undefined);
  const databricksHost = resolveDatabricksOidcHost(config);
  const openAiEndpointOverride = resolveOpenAiEndpointOverride(config);
  const secretOpenAiBaseUrl = resolveOpenAiBaseUrlFromEnv(config.openaiBaseUrlEnv);
  let resolvedOpenAiTarget = secretOpenAiBaseUrl?.url ?? config.openaiApiTarget
    ?? routingValue(OPENAI_ENV.TARGET) ?? openAiEndpointOverride;
  let resolvedOpenAiBasePath = secretOpenAiBaseUrl
    ? (secretOpenAiBaseUrl.basePath || undefined)
    : config.openaiApiBasePath ?? routingValue(OPENAI_ENV.BASE_PATH);
  const env = buildCopilotTargetEnv(config);
  const copilotProviderType = env[COPILOT_ENV.PROVIDER_TYPE];
  const copilotProviderBaseUrl = env[COPILOT_ENV.PROVIDER_BASE_URL];
  if (!databricksHost && copilotProviderType?.trim().toLowerCase() === 'azure') {
    const azureRouting = resolveCopilotApiRouting({}, { COPILOT_PROVIDER_BASE_URL: copilotProviderBaseUrl });
    resolvedOpenAiTarget ??= azureRouting.copilotApiTarget;
    if (!secretOpenAiBaseUrl) resolvedOpenAiBasePath ||= azureRouting.copilotApiBasePath;
  }

  const providers: Array<{ target?: string; basePath?: string; envTarget: string; envBasePath: string }> = [
    { target: resolvedOpenAiTarget, basePath: resolvedOpenAiBasePath, envTarget: OPENAI_ENV.TARGET, envBasePath: OPENAI_ENV.BASE_PATH },
    { target: config.anthropicApiTarget, basePath: config.anthropicApiBasePath, envTarget: ANTHROPIC_ENV.TARGET, envBasePath: ANTHROPIC_ENV.BASE_PATH },
    { target: config.geminiApiTarget, basePath: config.geminiApiBasePath, envTarget: GEMINI_ENV.TARGET, envBasePath: GEMINI_ENV.BASE_PATH },
    { target: config.vertexApiTarget, basePath: config.vertexApiBasePath, envTarget: VERTEX_ENV.TARGET, envBasePath: VERTEX_ENV.BASE_PATH },
    { envTarget: FOUNDRY_ENV.TARGET, envBasePath: FOUNDRY_ENV.BASE_PATH },
  ];

  for (const { target, basePath, envTarget, envBasePath } of providers) {
    const effectiveTarget = target ?? routingValue(envTarget);
    const effectiveBasePath = basePath ?? (secretOpenAiBaseUrl && envTarget === OPENAI_ENV.TARGET ? undefined : routingValue(envBasePath));
    if (effectiveTarget) env[envTarget] = normalizeApiTargetScheme(effectiveTarget);
    if (effectiveBasePath) env[envBasePath] = effectiveBasePath;
  }
  if (secretOpenAiBaseUrl) {
    env.AWF_SENSITIVE_OPENAI_TARGET = secretOpenAiBaseUrl.host;
  }

  const targets = { ...env, ...trustedServiceTargets(config) };
  if (databricksHost) {
    assertDatabricksTargetsMatchWorkspace(targets, databricksHost);
  }
  return targets;
}

export function resolveOpenAiEndpointOverride(config: WrapperConfig): string | undefined {
  return getConfigEnvValue(config, 'OPENAI_ENDPOINT_OVERRIDE')
    ?? process.env.OPENAI_ENDPOINT_OVERRIDE?.trim()
    ?? undefined;
}
