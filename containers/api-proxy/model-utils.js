'use strict';

/**
 * Standalone model name utilities for AWF API proxy.
 *
 * Pure string/pattern helpers with no dependency on alias resolution state.
 * These utilities are used by model-resolver.js and may be reused by other
 * modules such as model-discovery.js.
 */

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
  // Build a regex from the glob pattern.
  // Escape ALL regex metacharacters so they match literally, then restore *→.*.
  // The documented syntax supports only * as a wildcard; characters like ? that
  // are regex quantifiers must match literally.
  const regexStr = '^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
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

module.exports = {
  globMatch,
  extractVersionNumbers,
  compareByVersion,
};
