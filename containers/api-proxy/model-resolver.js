/**
 * Model alias resolution for AWF API proxy.
 *
 * Resolves model aliases and fallbacks against a set of available models,
 * enabling transparent model name rewriting in the proxy without requiring
 * the agent to know which concrete model IDs are available.
 *
 * Config schema (passed via AWF_MODEL_ALIASES env var as JSON):
 * {
 *   "models": {
 *     "sonnet": ["copilot/*sonnet*", "anthropic/*sonnet*"],
 *     "gpt-5-codex": ["copilot/gpt-5*-codex", "openai/gpt-5*-codex"],
 *     "": ["sonnet", "gpt-5*-codex"]   // default policy (empty string key)
 *   }
 * }
 *
 * Model ref syntax: "providerid/modelid" where modelid supports * wildcards.
 * Resolution is recursive (aliases can reference other aliases), loop-detected,
 * case-insensitive, and sorted by semver semantics (highest version first).
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

  // Validate structure: each value must be an array of strings
  for (const [, value] of Object.entries(parsed.models)) {
    if (!Array.isArray(value)) return null;
    for (const entry of value) {
      if (typeof entry !== 'string') return null;
    }
  }

  return { models: parsed.models };
}

/**
 * Case-insensitive glob pattern matching supporting * wildcards.
 *
 * @param {string} pattern - Glob pattern (supports * as wildcard)
 * @param {string} str - String to match against
 * @returns {boolean}
 */
function globMatch(pattern, str) {
  const p = pattern.toLowerCase();
  const s = str.toLowerCase();
  // Build a regex from the glob pattern:
  // - Escape all regex special chars except *
  // - Replace * with .*
  const regexStr = '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr).test(s);
}

/**
 * Extract all decimal-separated numeric segments from a model name.
 * Used for semver-style version comparison.
 *
 * Examples:
 *   "claude-sonnet-4.6"  → [4, 6]
 *   "gpt-4o"             → [4]
 *   "gemini-1.5-pro"     → [1, 5]
 *   "my-model"           → []
 *
 * @param {string} modelName
 * @returns {number[]}
 */
function extractVersionNumbers(modelName) {
  const matches = modelName.match(/\d+/g);
  return matches ? matches.map(Number) : [];
}

/**
 * Compare two model names by version numbers (highest version first).
 * Falls back to lexicographic comparison when no version numbers are present.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative if a should sort before b (i.e. a is higher version)
 */
function compareByVersion(a, b) {
  const av = extractVersionNumbers(a);
  const bv = extractVersionNumbers(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const ai = i < av.length ? av[i] : 0;
    const bi = i < bv.length ? bv[i] : 0;
    if (ai !== bi) return bi - ai; // Highest version first
  }
  return a.localeCompare(b); // Lexicographic fallback
}

/**
 * Resolve a model name through the alias chain for a given provider.
 *
 * Resolution algorithm:
 * 1. Look up requestedModel in aliases (case-insensitive key match)
 * 2. For each entry in the alias list:
 *    a. If entry is "provider/pattern" — match against available models for that provider
 *       (only entries matching currentProvider are considered)
 *    b. If entry has no "/" — recursively resolve as another alias
 * 3. Collect all candidates, sort by version (highest first), return the best match
 *
 * @param {string} requestedModel - Model name from the request body (or "" for default)
 * @param {Record<string, string[]>} aliases - Alias map from parseModelAliases()
 * @param {Record<string, string[]|null>} availableModels - Cached provider models
 * @param {string} currentProvider - Provider handling this request (e.g. "copilot")
 * @param {string[]} [chain=[]] - Accumulates visited alias names for loop detection
 * @returns {{ resolvedModel: string, log: string[] } | null}
 */
function resolveModel(requestedModel, aliases, availableModels, currentProvider, chain = []) {
  const log = [];
  const key = requestedModel.toLowerCase();

  // ── Loop detection ────────────────────────────────────────────────────────
  if (chain.includes(key)) {
    log.push(`[model-resolver] loop detected: "${requestedModel}" already in chain [${chain.join(' → ')}]`);
    return null;
  }
  const newChain = [...chain, key];

  // ── Find alias entry (case-insensitive) ───────────────────────────────────
  const aliasEntry = Object.entries(aliases).find(([k]) => k.toLowerCase() === key);

  if (!aliasEntry) {
    // No alias defined — check if the model directly matches an available model for
    // this provider. If yes, pass it through as-is (no rewrite needed).
    const providerModels = (availableModels[currentProvider] || []);
    const direct = providerModels.find(m => m.toLowerCase() === key);
    if (direct) {
      log.push(`[model-resolver] direct match: "${requestedModel}" → "${direct}"`);
      return { resolvedModel: direct, log };
    }
    // No match at all — cannot resolve.
    return null;
  }

  const [aliasKey, patterns] = aliasEntry;
  log.push(`[model-resolver] alias: "${requestedModel}" → [${patterns.join(', ')}]`);

  // ── Expand each pattern ───────────────────────────────────────────────────
  const candidates = [];

  for (const pattern of patterns) {
    const slashIdx = pattern.indexOf('/');

    if (slashIdx === -1) {
      // Recursive alias reference (no provider prefix)
      const sub = resolveModel(pattern, aliases, availableModels, currentProvider, newChain);
      if (sub) {
        log.push(...sub.log);
        candidates.push(sub.resolvedModel);
      }
    } else {
      // "provider/modelpattern" ref — only match for the current provider
      const patternProvider = pattern.slice(0, slashIdx).toLowerCase();
      const modelPattern = pattern.slice(slashIdx + 1);

      if (patternProvider !== currentProvider.toLowerCase()) continue;

      const providerModels = (availableModels[currentProvider] || []);
      for (const model of providerModels) {
        if (globMatch(modelPattern, model)) {
          candidates.push(model);
        }
      }
    }
  }

  if (candidates.length === 0) {
    log.push(`[model-resolver] no candidates found for "${aliasKey}" on provider "${currentProvider}"`);
    return null;
  }

  // ── Sort by version (highest first) and pick the best ────────────────────
  // Deduplicate while preserving sort order
  const unique = [...new Set(candidates)];
  unique.sort(compareByVersion);

  const resolved = unique[0];
  log.push(
    `[model-resolver] resolved: "${requestedModel}" → "${resolved}"` +
    (unique.length > 1
      ? ` (${unique.length} candidates: ${unique.slice(0, 5).join(', ')}${unique.length > 5 ? ', …' : ''})`
      : '')
  );

  return { resolvedModel: resolved, log };
}

/**
 * Attempt to rewrite the "model" field in a JSON request body using the alias map.
 *
 * Returns the rewritten body buffer and the resolution log when a rewrite occurs.
 * Returns null when no rewrite is needed or possible.
 *
 * @param {Buffer} body - Raw request body bytes
 * @param {string} provider - Current provider (e.g. "copilot")
 * @param {Record<string, string[]>} aliases - Parsed alias map
 * @param {Record<string, string[]|null>} availableModels - Cached models per provider
 * @returns {{ body: Buffer, originalModel: string, resolvedModel: string, log: string[] } | null}
 */
function rewriteModelInBody(body, provider, aliases, availableModels) {
  // Only attempt rewrite for non-empty bodies
  if (!body || body.length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null; // Non-JSON body — skip
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  // Determine the requested model. If absent, try the default alias ("").
  const originalModel = typeof parsed.model === 'string' ? parsed.model : '';

  const resolution = resolveModel(originalModel, aliases, availableModels, provider);
  if (!resolution) return null;

  const { resolvedModel, log } = resolution;

  // No rewrite needed if the model is already the resolved value
  if (resolvedModel === parsed.model) return null;

  // Patch the body
  parsed.model = resolvedModel;
  const newBody = Buffer.from(JSON.stringify(parsed), 'utf8');

  return { body: newBody, originalModel, resolvedModel, log };
}

module.exports = {
  parseModelAliases,
  globMatch,
  extractVersionNumbers,
  compareByVersion,
  resolveModel,
  rewriteModelInBody,
};
