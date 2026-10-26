import lifecycle from './model-information.compat.generated.json';
import naming from './model-information.naming.generated.json';
import { resolveIdentity } from './model-information-contract/resolution';

interface CopilotModelValidationSuccess {
  valid: true;
  resolvedModel: string;
}

interface CopilotModelValidationFailure {
  valid: false;
  reason: 'retired' | 'unsupported';
  message: string;
}

type CopilotModelValidationResult =
  | CopilotModelValidationSuccess
  | CopilotModelValidationFailure;

const RETIRED_COPILOT_MODEL_ALIASES = new Map(Object.entries(lifecycle.retired));

/**
 * Compatibility projection of canonical Copilot CLI availability, plus the
 * legacy `auto` selector. This does not assert native-API or Copilot-API support.
 * Author facts in shared/model-information/sources and run models:generate.
 */
const SUPPORTED_COPILOT_MODELS = new Set(lifecycle.supported);

const CLI_NAMING = {
  models: naming.models.filter(model => SUPPORTED_COPILOT_MODELS.has(model.identity.rawId) ||
    RETIRED_COPILOT_MODEL_ALIASES.has(model.identity.rawId)),
};

function suggestionFor(model: string): string | undefined {
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of lifecycle.suggestionOrder) {
    const distance = levenshtein(model, candidate);
    if (!best || distance < best.distance) {
      best = { candidate, distance };
    }
  }
  return best && best.distance <= 6 ? best.candidate : undefined;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[a.length][b.length];
}

/** @internal Exposed for unit tests — catalog sync guard uses this to verify pricing parity. */
// ts-prune-ignore-next
export const testHelpers = {
  supportedCopilotModels: new Set(SUPPORTED_COPILOT_MODELS) as ReadonlySet<string>,
};

export function validateCopilotModel(rawModel: string): CopilotModelValidationResult {
  const trimmed = rawModel.trim();
  if (!trimmed) {
    return { valid: true, resolvedModel: trimmed };
  }
  const normalized = trimmed.toLowerCase();
  const resolution = resolveIdentity(trimmed, { provider: 'copilot', channel: 'copilot-cli' },
    CLI_NAMING, { caseInsensitive: true, separators: true, providerPrefix: false });
  // CLI validation deliberately excludes API parameter syntax and family-level guesses.
  const canonicalModel = !resolution.parameterSuffix &&
    ['exact', 'alias'].includes(resolution.matchKind) ? resolution.wireId : undefined;

  const retiredReplacement = canonicalModel && RETIRED_COPILOT_MODEL_ALIASES.get(canonicalModel);
  if (retiredReplacement) {
    return {
      valid: false,
      reason: 'retired',
      message: `Error: model '${trimmed}' is retired or unsupported. Did you mean '${retiredReplacement}'?`,
    };
  }

  if (canonicalModel && SUPPORTED_COPILOT_MODELS.has(canonicalModel)) {
    return { valid: true, resolvedModel: canonicalModel };
  }
  if (normalized === 'auto') return { valid: true, resolvedModel: 'auto' };

  const suggested = suggestionFor(normalized);
  return {
    valid: false,
    reason: 'unsupported',
    message: suggested
      ? `Error: model '${trimmed}' is unsupported or unrecognized by this AWF version. Did you mean '${suggested}'?`
      : `Error: model '${trimmed}' is unsupported or unrecognized by this AWF version.`,
  };
}
