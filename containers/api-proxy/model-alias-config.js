/**
 * Parsing and normalization of model alias configuration.
 */

/**
 * Parse model aliases configuration from a raw JSON string.
 *
 * @param {string|null|undefined} rawConfig - JSON string from AWF_MODEL_ALIASES env var
 * @returns {{ models: Record<string, string[]> } | null} Parsed config or null if invalid/absent
 */
function parseModelAliases(rawConfig) {
  if (!rawConfig) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!parsed.models || typeof parsed.models !== 'object' || Array.isArray(parsed.models)) return null;

  const aliases = new Map();
  for (const name of Object.keys(parsed.models)) {
    const normalized = name.toLowerCase();
    const previous = aliases.get(normalized);
    if (previous !== undefined) {
      const error = new Error(
        `AWF_MODEL_ALIASES contains case-insensitive alias collision "${previous}" and "${name}"; rename one alias`,
      );
      error.code = 'ambiguous_model_alias';
      throw error;
    }
    aliases.set(normalized, name);
  }

  // Validate structure: each value must be either:
  //   - string[] (legacy alias syntax)
  //   - { patterns: string[], fallback?: boolean } (extended alias syntax)
  for (const [, value] of Object.entries(parsed.models)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry !== 'string') return null;
      }
      continue;
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!Array.isArray(value.patterns)) return null;
    for (const entry of value.patterns) {
      if (typeof entry !== 'string') return null;
    }
    if (value.fallback !== undefined && typeof value.fallback !== 'boolean') return null;
  }

  return { models: parsed.models };
}

/**
 * Normalize a raw alias definition into { patterns, fallback } shape.
 * @param {string[]|object} rawAlias
 * @returns {{ patterns: string[], fallback: boolean }}
 */
function resolveAliasDefinition(rawAlias) {
  if (Array.isArray(rawAlias)) {
    return { patterns: rawAlias, fallback: true };
  }
  if (!rawAlias || typeof rawAlias !== 'object' || Array.isArray(rawAlias)) {
    return { patterns: [], fallback: true };
  }
  return {
    patterns: Array.isArray(rawAlias.patterns) ? rawAlias.patterns : [],
    fallback: rawAlias.fallback !== false,
  };
}

module.exports = { parseModelAliases, resolveAliasDefinition };
