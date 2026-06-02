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
  effectiveTokenModelMultipliers: Record<string, number> | undefined;
  effectiveTokenDefaultModelMultiplier: number | undefined;
  maxModelMultiplier?: number;
  maxRuns: number | undefined;
  memoryLimit: string | undefined;
  agentImage: string | undefined;
}

/**
 * Validates log-level, model-multiplier, and resource-limit options.
 *
 * Covers the following option groups:
 *  - `--log-level` / `logLevel`
 *  - `--anthropic-cache-tail-ttl`
 *  - `--max-effective-tokens`, `--max-model-multiplier`, `--max-runs`
 *  - `--memory-limit`, `--agent-image`, `--build-local`
 *
 * Calls `process.exit(1)` on any validation failure so the caller always
 * receives a fully-validated result.
 */
export function validateLogAndLimits(options: Record<string, unknown>): LogAndLimitsResult {
  // --- Log level -----------------------------------------------------------

  const logLevel = options.logLevel as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    console.error(`Invalid log level: ${logLevel}`);
    process.exit(1);
  }

  // Validate --anthropic-cache-tail-ttl if provided
  validateAnthropicCacheTailTtl(options.anthropicCacheTailTtl as string | undefined);

  // --- Model multipliers ---------------------------------------------------

  // Model aliases may be injected via config file (not a Commander option),
  // so access through a Record cast with a proper type annotation.
  const modelAliases = (options as Record<string, unknown>).modelAliases as
    | Record<string, string[]>
    | undefined;
  const maxEffectiveTokensOption = (options as Record<string, unknown>).maxEffectiveTokens as
    | string
    | number
    | undefined;
  const effectiveTokenDefaultModelMultiplierOption = (options as Record<string, unknown>)
    .effectiveTokenDefaultModelMultiplier as string | number | undefined;
  // Config-file multipliers (already a Record<string, number>)
  const configFileMultipliers = (options as Record<string, unknown>)
    .effectiveTokenModelMultipliers as Record<string, number> | undefined;
  // CLI multipliers via --max-model-multiplier (model:multiplier,... format)
  const maxModelMultiplierRaw = (options as Record<string, unknown>).maxModelMultiplier as
    | string
    | undefined;
  let cliMultipliers: Record<string, number> | undefined;
  if (maxModelMultiplierRaw !== undefined) {
    const parsed = parseModelMultipliersCli(maxModelMultiplierRaw);
    if ('error' in parsed) {
      console.error(`Error: ${parsed.error}`);
      process.exit(1);
    }
    cliMultipliers = parsed.multipliers;
  }
  // CLI flag overrides config-file values for the same model name.
  const effectiveTokenModelMultipliers =
    configFileMultipliers || cliMultipliers
      ? { ...configFileMultipliers, ...cliMultipliers }
      : undefined;
  const maxEffectiveTokens =
    maxEffectiveTokensOption !== undefined ? Number(maxEffectiveTokensOption) : undefined;
  const effectiveTokenDefaultModelMultiplier =
    effectiveTokenDefaultModelMultiplierOption !== undefined
      ? Number(effectiveTokenDefaultModelMultiplierOption)
      : undefined;

  if (
    maxEffectiveTokens !== undefined &&
    (!Number.isInteger(maxEffectiveTokens) || maxEffectiveTokens <= 0)
  ) {
    console.error('Error: Invalid maxEffectiveTokens value (must be a positive integer)');
    process.exit(1);
  }

  if (
    effectiveTokenDefaultModelMultiplier !== undefined &&
    (!Number.isFinite(effectiveTokenDefaultModelMultiplier) || effectiveTokenDefaultModelMultiplier <= 0)
  ) {
    console.error('Error: Invalid effectiveTokenDefaultModelMultiplier value (must be > 0)');
    process.exit(1);
  }

  const maxModelMultiplierOption = (options as Record<string, unknown>).maxModelMultiplier as
    | string
    | number
    | undefined;
  const maxModelMultiplier =
    maxModelMultiplierOption !== undefined ? Number(maxModelMultiplierOption) : undefined;

  if (
    maxModelMultiplier !== undefined &&
    (!Number.isFinite(maxModelMultiplier) || maxModelMultiplier <= 0)
  ) {
    console.error('Error: Invalid maxModelMultiplier value (must be > 0)');
    process.exit(1);
  }

  const maxRunsOption = (options as Record<string, unknown>).maxRuns as
    | string
    | number
    | undefined;
  const maxRuns = maxRunsOption !== undefined ? Number(maxRunsOption) : undefined;

  if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns <= 0)) {
    console.error('Error: Invalid maxRuns value (must be a positive integer)');
    process.exit(1);
  }

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
    modelAliases,
    maxEffectiveTokens,
    effectiveTokenModelMultipliers,
    effectiveTokenDefaultModelMultiplier,
    maxModelMultiplier,
    maxRuns,
    memoryLimit: memoryLimit.value,
    agentImage: agentImageResult.agentImage,
  };
}
