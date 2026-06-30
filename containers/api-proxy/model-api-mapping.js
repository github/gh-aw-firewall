'use strict';

/**
 * AWF API Proxy — Model-to-API Endpoint Mapping
 *
 * Loads the model-api-mapping.json reference file and exposes it for
 * the /reflect management endpoint. This mapping documents which API
 * endpoints each model family supports (e.g. responses-only vs
 * chat/completions vs both).
 *
 * The mapping is informational — it does not alter proxy routing behavior.
 * Consumers (e.g. SDK drivers, harness scripts) can query /reflect to
 * determine the correct endpoint for a given model.
 */

const fs = require('fs');
const path = require('path');

/**
 * Paths to search for the mapping file, in priority order.
 * The first path that exists wins.
 */
const MAPPING_FILE_SEARCH_PATHS = [
  // Injected via env var (e.g. in CI or Docker)
  process.env.AWF_MODEL_API_MAPPING_PATH,
  // Relative to the api-proxy container directory
  path.join(__dirname, 'model-api-mapping.json'),
  // Relative to the repo root (local dev)
  path.join(__dirname, '../../docs/model-api-mapping.json'),
];

let _mapping = null;
let _loadError = null;

/**
 * Attempt to load the model-api-mapping.json from the search paths.
 * Called once at module load time. Safe to call again to reload.
 */
function loadMapping() {
  for (const filePath of MAPPING_FILE_SEARCH_PATHS) {
    if (!filePath) continue;
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        _mapping = JSON.parse(raw);
        _loadError = null;
        return;
      }
    } catch (err) {
      _loadError = err.message;
    }
  }
  // Not found in any search path — this is fine, mapping is optional
  _mapping = null;
  if (!_loadError) {
    _loadError = 'model-api-mapping.json not found in search paths';
  }
}

// Load on first require
loadMapping();

/**
 * Get the loaded mapping object, or null if not available.
 * @returns {object|null}
 */
function getModelApiMapping() {
  return _mapping;
}

/**
 * Look up the supported endpoints for a given model string.
 * Returns the matching entry or null if no match is found.
 *
 * @param {string} model - Model identifier (e.g. "gpt-5.5", "claude-sonnet-4-6")
 * @param {string} [provider] - Optional provider hint ("openai" or "anthropic")
 * @returns {{ family: string, endpoints: string[], notes: string } | null}
 */
function lookupModelEndpoints(model, provider) {
  if (!_mapping || !model) return null;

  const providers = provider
    ? [_mapping.providers[provider]].filter(Boolean)
    : Object.values(_mapping.providers || {});

  for (const prov of providers) {
    if (!prov || !Array.isArray(prov.models)) continue;
    for (const entry of prov.models) {
      if (!entry.patterns) continue;
      for (const pattern of entry.patterns) {
        if (matchesGlobPattern(model, pattern)) {
          return {
            family: entry.family,
            endpoints: entry.endpoints,
            notes: entry.notes || '',
          };
        }
      }
    }
  }
  return null;
}

/**
 * Simple glob matching: supports trailing `*` wildcard only.
 * @param {string} value
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesGlobPattern(value, pattern) {
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}

/**
 * Get the reflect-friendly summary for inclusion in /reflect response.
 * @returns {{ available: boolean, last_updated: string|null, providers: string[], error: string|null }}
 */
function getModelApiMappingReflect() {
  if (!_mapping) {
    return {
      available: false,
      last_updated: null,
      providers: [],
      error: _loadError,
    };
  }
  return {
    available: true,
    last_updated: _mapping.lastUpdated || null,
    providers: Object.keys(_mapping.providers || {}),
    models: _mapping.providers,
    error: null,
  };
}

module.exports = {
  getModelApiMapping,
  getModelApiMappingReflect,
  lookupModelEndpoints,
  loadMapping,
  matchesGlobPattern,
};
