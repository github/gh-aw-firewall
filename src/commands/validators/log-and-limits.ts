import { LogLevel } from '../../types';
import { logger } from '../../logger';
import {
  validateAnthropicCacheTailTtl,
} from '../../api-proxy-config';
import {
  parseModelMultipliersCli,
  parseMemoryLimit,
} from '../../option-parsers';
import { processAgentImageOption } from '../../domain-utils';

/**
 * The result produced by {@link validateLogAndLimits}.
 */
export interface LogAndLimitsResult {
  logLevel: LogLevel;
  modelAliases: Record<string, string[]> | undefined;
  maxEffectiveTokens: number | undefined;
  maxAiCredits: number | undefined;
  effectiveTokenModelMultipliers: Record<string, number> | undefined;
  effectiveTokenDefaultModelMultiplier: number | undefined;
  maxModelMultiplierCap?: number;
  maxRuns: number | undefined;
  maxPermissionDenied: number | undefined;
  maxCacheMisses: number | undefined;
  memoryLimit: string | undefined;
  agentImage: string | undefined;
}

type ValidatorOptions = Record<string, unknown>;

type ModelMultiplierOptionsResult = Pick<
  LogAndLimitsResult,
  | 'modelAliases'
  | 'maxEffectiveTokens'
  | 'maxAiCredits'
  | 'effectiveTokenModelMultipliers'
  | 'effectiveTokenDefaultModelMultiplier'
  | 'maxModelMultiplierCap'
>;

type RunLimitsResult = Pick<
  LogAndLimitsResult,
  'maxRuns' | 'maxPermissionDenied' | 'maxCacheMisses'
>;

function exitValidationError(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseOptionalNumber(option: string | number | undefined): number | undefined {
  return option !== undefined ? Number(option) : undefined;
}

function validatePositiveIntegerOption(optionName: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    exitValidationError(`Error: Invalid ${optionName} value (must be a positive integer)`);
  }
}

function validatePositiveNumberOption(optionName: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    exitValidationError(`Error: Invalid ${optionName} value (must be > 0)`);
  }
}

function validateModelMultiplierOptions(options: ValidatorOptions): ModelMultiplierOptionsResult {
  // Model aliases may be injected via config file (not a Commander option),
  // so access through a Record cast with a proper type annotation.
  const modelAliases = options.modelAliases as Record<string, string[]> | undefined;
  const maxEffectiveTokensOption = options.maxEffectiveTokens as string | number | undefined;
  const maxAiCreditsOption = options.maxAiCredits as string | number | undefined;
  const effectiveTokenDefaultModelMultiplierOption = options
    .effectiveTokenDefaultModelMultiplier as string | number | undefined;
  // Config-file multipliers (already a Record<string, number>)
  const configFileMultipliers = options.effectiveTokenModelMultipliers as
    | Record<string, number>
    | undefined;
  // CLI multipliers via --max-model-multiplier (model:multiplier,... format)
  const maxModelMultiplierRaw = options.maxModelMultiplier as string | undefined;
  let cliMultipliers: Record<string, number> | undefined;
  if (maxModelMultiplierRaw !== undefined) {
    const parsed = parseModelMultipliersCli(maxModelMultiplierRaw);
    if ('error' in parsed) {
      exitValidationError(`Error: ${parsed.error}`);
    }
    cliMultipliers = parsed.multipliers;
  }

  const effectiveTokenModelMultipliers =
    configFileMultipliers || cliMultipliers
      ? { ...configFileMultipliers, ...cliMultipliers }
      : undefined;
  const maxEffectiveTokens = parseOptionalNumber(maxEffectiveTokensOption);
  const maxAiCredits = parseOptionalNumber(maxAiCreditsOption);
  const effectiveTokenDefaultModelMultiplier = parseOptionalNumber(
    effectiveTokenDefaultModelMultiplierOption,
  );
  const maxModelMultiplierCap = parseOptionalNumber(
    options.maxModelMultiplierCap as string | number | undefined,
  );

  validatePositiveIntegerOption('maxEffectiveTokens', maxEffectiveTokens);
  validatePositiveNumberOption('maxAiCredits', maxAiCredits);
  validatePositiveNumberOption(
    'effectiveTokenDefaultModelMultiplier',
    effectiveTokenDefaultModelMultiplier,
  );
  validatePositiveNumberOption('maxModelMultiplierCap', maxModelMultiplierCap);

  return {
    modelAliases,
    maxEffectiveTokens,
    maxAiCredits,
    effectiveTokenModelMultipliers,
    effectiveTokenDefaultModelMultiplier,
    maxModelMultiplierCap,
  };
}

function validateRunLimits(options: ValidatorOptions): RunLimitsResult {
  const maxRuns = parseOptionalNumber(options.maxRuns as string | number | undefined);
  const maxPermissionDenied = parseOptionalNumber(
    options.maxPermissionDenied as string | number | undefined,
  );
  const maxCacheMisses = parseOptionalNumber(options.maxCacheMisses as string | number | undefined);

  validatePositiveIntegerOption('maxRuns', maxRuns);
  validatePositiveIntegerOption('maxPermissionDenied', maxPermissionDenied);
  validatePositiveIntegerOption('maxCacheMisses', maxCacheMisses);

  return {
    maxRuns,
    maxPermissionDenied,
    maxCacheMisses,
  };
}

/**
 * Validates log-level, model-multiplier, and resource-limit options.
 *
 * Covers the following option groups:
 *  - `--log-level` / `logLevel`
 *  - `--anthropic-cache-tail-ttl`
 *  - `--max-effective-tokens`, `--max-ai-credits`, `--effective-token-default-model-multiplier`, `--max-model-multiplier`, `--max-model-multiplier-cap`
 *  - `--max-runs`, `--max-permission-denied`, `--max-cache-misses`
 *  - `--memory-limit`, `--agent-image`, `--build-local`
 *
 * Calls `process.exit(1)` on any validation failure so the caller always
 * receives a fully-validated result.
 */
export function validateLogAndLimits(options: ValidatorOptions): LogAndLimitsResult {
  // --- Log level -----------------------------------------------------------

  const logLevel = options.logLevel as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    exitValidationError(`Invalid log level: ${logLevel}`);
  }

  // Validate --anthropic-cache-tail-ttl if provided
  validateAnthropicCacheTailTtl(options.anthropicCacheTailTtl as string | undefined);

  // --- Model multipliers ---------------------------------------------------
  const modelMultiplierOptions = validateModelMultiplierOptions(options);
  const runLimits = validateRunLimits(options);

  logger.setLevel(logLevel);

  // --- Resource limits -----------------------------------------------------

  // Validate memory limit
  const memoryLimit = parseMemoryLimit(options.memoryLimit as string);
  if (memoryLimit.error) {
    logger.error(memoryLimit.error);
    process.exit(1);
  }

  // Validate agent image option
  const agentImageResult = processAgentImageOption(
    options.agentImage as string | undefined,
    options.buildLocal as boolean,
  );
  if (agentImageResult.error) {
    logger.error(agentImageResult.error);
    process.exit(1);
  }
  if (agentImageResult.infoMessage) {
    logger.info(agentImageResult.infoMessage);
  }

  return {
    logLevel,
    ...modelMultiplierOptions,
    ...runLimits,
    memoryLimit: memoryLimit.value,
    agentImage: agentImageResult.agentImage,
  };
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const logAndLimitsTestHelpers = {
  validateModelMultiplierOptions,
  validateRunLimits,
};
