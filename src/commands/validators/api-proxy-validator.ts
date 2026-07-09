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
 * Recursively resolves an alias key to its first concrete (non-wildcard) model
 * name, following nested alias references with cycle detection.
 *
 * Resolution rules for each pattern:
 *   - Contains `*`         → runtime wildcard, skip.
 *   - Contains `/`         → provider-scoped (e.g. `copilot/gpt-4.1`), cannot
 *                            be validated without provider context, skip.
 *   - Matches an alias key  → nested alias reference, recurse.
 *   - Otherwise             → plain concrete model name, return it.
 *
 * @param aliasKey  Alias name to start resolution from (case-insensitive).
 * @param aliases   Full alias map (values are arrays of patterns).
 * @param visited   Accumulates visited keys for cycle detection; callers should
 *                  not pass this argument — it is used by recursive calls only.
 * @returns The first concrete model name found, or `undefined` when all paths
 *          are wildcards, provider-scoped, or form a cycle.
 */
function resolveAliasToFirstConcrete(
  aliasKey: string,
  aliases: Record<string, string[]>,
  visited: Set<string> = new Set(),
): string | undefined {
  const normalizedKey = aliasKey.toLowerCase();

  // Cycle guard
  if (visited.has(normalizedKey)) return undefined;
  visited.add(normalizedKey);

  // Pre-compute the set of lowercased alias keys once to avoid repeated
  // Object.keys() calls inside the pattern loop.
  const aliasKeySet = new Set(Object.keys(aliases).map(k => k.toLowerCase()));

  // Find the alias entry (case-insensitive); destructure to get the patterns.
  const entry = Object.entries(aliases).find(([k]) => k.toLowerCase() === normalizedKey);
  if (!entry) return undefined;

  for (const pattern of entry[1]) {
    // Runtime wildcard — cannot validate at preflight
    if (pattern.includes('*')) continue;

    // Provider-scoped pattern (e.g. "copilot/gpt-4.1") — unvalidatable without
    // provider context, skip.
    if (pattern.includes('/')) continue;

    // Nested alias reference — recurse with a snapshot of the visited set so
    // that sibling patterns after a failed/cyclic branch remain reachable.
    // (Passing `visited` directly would mark siblings visited during a failed
    // branch and incorrectly skip them on subsequent iterations.)
    if (aliasKeySet.has(pattern.toLowerCase())) {
      const resolved = resolveAliasToFirstConcrete(pattern, aliases, new Set(visited));
      if (resolved !== undefined) return resolved;
      continue;
    }

    // Plain concrete model name
    return pattern;
  }

  return undefined;
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
    // Check whether COPILOT_MODEL is a runtime alias key.  Aliases are resolved
    // later by the api-proxy using AWF_MODEL_ALIASES.  Recursively resolve the
    // alias chain (with cycle protection) to find the first concrete model name
    // and validate it at preflight so that misconfigured alias chains are caught
    // early.  If the chain contains only wildcards or provider-scoped patterns,
    // validation is skipped — the actual model is only known at request time.
    const isAlias = !!config.modelAliases &&
      Object.keys(config.modelAliases).some(k => k.toLowerCase() === copilotModel.toLowerCase());

    if (isAlias) {
      // Recursively resolve to the first concrete model name and validate it.
      // COPILOT_MODEL is left as the alias name so the api-proxy can perform
      // its own availability-aware resolution at request time.
      const firstConcrete = resolveAliasToFirstConcrete(copilotModel, config.modelAliases!);
      if (firstConcrete !== undefined) {
        const aliasValidation = validateCopilotModel(firstConcrete);
        if (!aliasValidation.valid) {
          logger.error(
            `Error: alias '${copilotModel}' resolves to model '${firstConcrete}' which is ${aliasValidation.reason === 'retired' ? 'retired or unsupported' : 'unsupported or unrecognized by this AWF version'}.`,
          );
          logger.error(aliasValidation.message);
          process.exit(1);
        }
      }
      // Alias is valid (or all paths are wildcards/provider-scoped) — leave
      // COPILOT_MODEL as the alias name for the api-proxy.
    } else {
      // Not an alias: validate and normalise the concrete model name directly.
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
}

/** @internal Exported only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const testHelpers = { resolveAliasToFirstConcrete };
