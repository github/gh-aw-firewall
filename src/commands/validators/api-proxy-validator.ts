import { WrapperConfig } from '../../types';
import { logger } from '../../logger';
import {
  validateApiProxyConfig,
  emitApiProxyTargetWarnings,
  emitCliProxyStatusLogs,
  warnClassicPATWithCopilotModel,
} from '../../api-proxy-config';
import { validateCopilotModel } from '../../copilot-model';
import { getLowerCaseProcessEnvValue } from '../../env-utils';
import { readEnvVarFromEnvFiles } from '../../parsers/env-parsers';
import { NetworkOptionsResult } from './network-options';
import { AgentOptionsResult } from './agent-options';

/**
 * Validates and logs the API proxy configuration.  Emits warnings for missing
 * keys and target-domain mismatches. This guard is not expected to call
 * `process.exit(1)` (warnings only).
 */
export function validateApiProxyOptions(
  config: WrapperConfig,
  networkOptions: NetworkOptionsResult,
): void {
  // Validate and warn about API proxy configuration
  // Pass booleans (not actual keys) to prevent sensitive data flow to logger.
  // `copilotByokDirect` means the user supplied COPILOT_PROVIDER_API_KEY for direct-BYOK
  // mode (Azure Foundry, OpenRouter, etc.) without a GitHub token; the sidecar still
  // routes through it, so for "is there a Copilot path?" purposes either signal counts.
  const copilotByokDirect = !!config.copilotProviderApiKey;
  // Detect Anthropic WIF (GitHub OIDC) auth: the sidecar performs the OIDC token
  // exchange so no static ANTHROPIC_API_KEY is required.
  const hasAnthropicWif =
    getLowerCaseProcessEnvValue('AWF_AUTH_TYPE') === 'github-oidc' &&
    getLowerCaseProcessEnvValue('AWF_AUTH_PROVIDER') === 'anthropic';
  const apiProxyValidation = validateApiProxyConfig(
    config.enableApiProxy || false,
    !!config.openaiApiKey,
    !!config.anthropicApiKey,
    !!config.copilotGithubToken || copilotByokDirect,
    !!config.geminiApiKey,
    hasAnthropicWif,
    !!config.googleApiKey,
  );

  // Log API proxy status at info level for visibility
  if (config.enableApiProxy) {
    const copilotStatus = config.copilotGithubToken
      ? 'true (github-token)'
      : copilotByokDirect
        ? 'true (byok-direct)'
        : 'false';
    const anthropicStatus = config.anthropicApiKey
      ? 'true'
      : hasAnthropicWif
        ? 'true (wif)'
        : 'false';
    logger.info(
      `API proxy enabled: OpenAI=${!!config.openaiApiKey}, Anthropic=${anthropicStatus}, Copilot=${copilotStatus}, Gemini=${!!config.geminiApiKey}, Vertex=${!!config.googleApiKey}`,
    );
  }

  for (const warning of apiProxyValidation.warnings) {
    logger.warn(warning);
  }
  for (const msg of apiProxyValidation.debugMessages) {
    logger.debug(msg);
  }

  // Warn if custom API targets are not in --allow-domains
  emitApiProxyTargetWarnings(config, networkOptions.allowedDomains, logger.warn.bind(logger));

  // Log CLI proxy status
  emitCliProxyStatusLogs(config, logger.info.bind(logger), logger.warn.bind(logger));
}

/**
 * Resolves the effective `COPILOT_MODEL` value (from `--env`, env-file, or host
 * env when `--env-all` is active), warns on classic-PAT usage, and validates
 * the model identifier against the known-models list.
 * Calls `process.exit(1)` on any failure.
 */
export function validateCopilotModelOption(
  config: WrapperConfig,
  agentOptions: AgentOptionsResult,
): void {
  // Check if COPILOT_MODEL is set via --env/-e flags, --env-file, or host env (when --env-all is active)
  const copilotModelFromFlags = agentOptions.additionalEnv.COPILOT_MODEL;
  const copilotModelInEnvFile = readEnvVarFromEnvFiles(
    (config as { envFile?: unknown }).envFile,
    'COPILOT_MODEL',
  );
  const copilotModelInHostEnv = config.envAll ? process.env.COPILOT_MODEL : undefined;
  const copilotModel = (
    copilotModelFromFlags ??
    copilotModelInEnvFile ??
    copilotModelInHostEnv
  )?.trim();
  warnClassicPATWithCopilotModel(
    config.copilotGithubToken?.startsWith('ghp_') ?? false,
    !!copilotModel,
    logger.warn.bind(logger),
  );

  const hasCustomCopilotProviderBaseUrl = !!(
    config.copilotProviderBaseUrl ||
    config.additionalEnv?.COPILOT_PROVIDER_BASE_URL ||
    readEnvVarFromEnvFiles((config as { envFile?: unknown }).envFile, 'COPILOT_PROVIDER_BASE_URL') ||
    (config.envAll ? process.env.COPILOT_PROVIDER_BASE_URL : undefined)
  );
  if (
    copilotModel &&
    !hasCustomCopilotProviderBaseUrl &&
    (config.copilotGithubToken || config.copilotProviderApiKey)
  ) {
    const validation = validateCopilotModel(copilotModel);
    if (!validation.valid) {
      logger.error(validation.message);
      process.exit(1);
    }

    if (validation.resolvedModel !== copilotModel) {
      logger.info(
        `Normalized COPILOT_MODEL value '${copilotModel}' -> '${validation.resolvedModel}'`,
      );
    }
    config.additionalEnv = {
      ...(config.additionalEnv ?? {}),
      COPILOT_MODEL: validation.resolvedModel,
    };
  }
}
