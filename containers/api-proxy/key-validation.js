'use strict';

const { fetchJson, httpProbe, extractModelIds } = require('./model-discovery');
const { logRequest } = require('./logging');
const { resolveModel } = require('./model-resolver');

/** @type {Record<string, string[]|null>} */
const cachedModels = {};
let modelFetchComplete = false;

/** @type {Record<string, { status: 'pending'|'valid'|'auth_rejected'|'network_error'|'inconclusive'|'skipped', message: string }>} */
const keyValidationResults = {};
let keyValidationComplete = false;

let getRegisteredAdapters = () => [];
let getModelAliases = () => null;

function configureKeyValidation(options = {}) {
  if (typeof options.getRegisteredAdapters === 'function') getRegisteredAdapters = options.getRegisteredAdapters;
  if (typeof options.getModelAliases === 'function') getModelAliases = options.getModelAliases;
}

function resetModelCacheState() {
  for (const key of Object.keys(cachedModels)) {
    delete cachedModels[key];
  }
  modelFetchComplete = false;
}

function resetKeyValidationState() {
  for (const key of Object.keys(keyValidationResults)) {
    delete keyValidationResults[key];
  }
  keyValidationComplete = false;
}

function setModelFetchComplete(value) {
  modelFetchComplete = Boolean(value);
}

function setKeyValidationComplete(value) {
  keyValidationComplete = Boolean(value);
}

function isModelFetchComplete() {
  return modelFetchComplete;
}

function isKeyValidationComplete() {
  return keyValidationComplete;
}

async function refreshProviderModelsForResolution(provider) {
  const adapter = getRegisteredAdapters().find(a => a.name === provider);
  const config = adapter?.getModelsFetchConfig?.();
  if (!config) return;

  try {
    const json = await fetchJson(config.url, config.opts, 10_000);
    const extracted = extractModelIds(json);
    if (Array.isArray(extracted) && extracted.length > 0) {
      cachedModels[config.cacheKey] = extracted;
      logRequest('debug', 'model_cache_refresh', {
        provider,
        cache_key: config.cacheKey,
        models_count: extracted.length,
      });
    }
  } catch (err) {
    logRequest('debug', 'model_cache_refresh_failed', {
      provider,
      error: String(err && err.message ? err.message : err),
    });
  }
}

async function probeProvider(provider, url, opts, timeoutMs) {
  keyValidationResults[provider] = { status: 'pending', message: 'Validating...' };
  try {
    const status = await httpProbe(url, opts, timeoutMs);

    if (status >= 200 && status < 300) {
      keyValidationResults[provider] = { status: 'valid', message: `HTTP ${status}` };
      logRequest('info', 'key_validation', { provider, status: 'valid', httpStatus: status });
    } else if (status === 401 || status === 403) {
      keyValidationResults[provider] = { status: 'auth_rejected', message: `HTTP ${status} — token expired or invalid` };
      logRequest('warn', 'key_validation', { provider, status: 'auth_rejected', httpStatus: status });
    } else if (status === 400) {
      keyValidationResults[provider] = { status: 'valid', message: `HTTP ${status} (auth accepted, probe body rejected)` };
      logRequest('info', 'key_validation', { provider, status: 'valid', httpStatus: status, note: 'probe body rejected but auth accepted' });
    } else {
      keyValidationResults[provider] = { status: 'inconclusive', message: `HTTP ${status}` };
      logRequest('warn', 'key_validation', { provider, status: 'inconclusive', httpStatus: status });
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    keyValidationResults[provider] = { status: 'network_error', message };
    logRequest('warn', 'key_validation', { provider, status: 'network_error', error: message });
  }
}

async function validateApiKeys(adapters = []) {
  const mode = (process.env.AWF_VALIDATE_KEYS || 'warn').toLowerCase();
  if (mode === 'off') {
    logRequest('info', 'key_validation', { message: 'Key validation disabled (AWF_VALIDATE_KEYS=off)' });
    keyValidationComplete = true;
    return;
  }

  const TIMEOUT_MS = 10_000;
  const probes = [];

  for (const adapter of adapters) {
    const probe = adapter.getValidationProbe?.();
    if (!probe) continue;

    if (probe.skip) {
      keyValidationResults[adapter.name] = { status: 'skipped', message: probe.reason };
      logRequest('info', 'key_validation', { provider: adapter.name, ...keyValidationResults[adapter.name] });
      continue;
    }

    probes.push(probeProvider(adapter.name, probe.url, probe.opts, TIMEOUT_MS));
  }

  if (probes.length === 0) {
    logRequest('info', 'key_validation', { message: 'No providers to validate' });
    keyValidationComplete = true;
    return;
  }

  await Promise.allSettled(probes);
  keyValidationComplete = true;
  _summarizeValidationFailures(mode);
}

function _summarizeValidationFailures(mode) {
  const failures = Object.entries(keyValidationResults)
    .filter(([, r]) => r.status === 'auth_rejected');

  if (failures.length > 0) {
    for (const [provider, result] of failures) {
      logRequest('error', 'key_validation_failed', {
        provider,
        message: `${provider.toUpperCase()} API key validation failed — ${result.message}. Rotate the secret and re-run.`,
      });
    }
    if (mode === 'strict') {
      logRequest('error', 'key_validation_strict_exit', {
        message: `AWF_VALIDATE_KEYS=strict: exiting due to ${failures.length} auth failure(s)`,
        providers: failures.map(([p]) => p),
      });
      process.exit(1);
    }
  } else {
    logRequest('info', 'key_validation', { message: 'All configured API keys validated successfully' });
  }
}

async function fetchStartupModels(adapters = []) {
  const TIMEOUT_MS = 10_000;
  const fetches = [];

  for (const adapter of adapters) {
    const config = adapter.getModelsFetchConfig?.();
    if (!config) continue;

    fetches.push(
      fetchJson(config.url, config.opts, TIMEOUT_MS).then((json) => {
        cachedModels[config.cacheKey] = extractModelIds(json);
      })
    );
  }

  await Promise.allSettled(fetches);
  modelFetchComplete = true;
}

function validateRequestedModel() {
  const requestedModel = (process.env.AWF_REQUESTED_MODEL || '').trim();
  if (!requestedModel) return;

  const allModels = [];
  for (const models of Object.values(cachedModels)) {
    if (Array.isArray(models)) allModels.push(...models);
  }

  if (allModels.length === 0) {
    logRequest('warn', 'model_validation_skipped', {
      requested_model: requestedModel,
      message: 'Cannot validate requested model — no model lists available from providers',
    });
    return;
  }

  const normalizedRequested = requestedModel.toLowerCase();
  const found = allModels.some(m => m.toLowerCase() === normalizedRequested);

  let aliasResolved = false;
  const modelAliases = getModelAliases();
  if (!found && modelAliases) {
    for (const provider of Object.keys(cachedModels)) {
      const result = resolveModel(requestedModel, modelAliases.models, cachedModels, provider, [], { enabled: false });
      if (result) {
        aliasResolved = true;
        break;
      }
    }
  }

  if (!found && !aliasResolved) {
    const availableModels = allModels.slice(0, 20).join(', ');
    const truncated = allModels.length > 20 ? ` (and ${allModels.length - 20} more)` : '';
    logRequest('error', 'model_unavailable_at_startup', {
      requested_model: requestedModel,
      available_count: allModels.length,
      message: `Requested model '${requestedModel}' is not available in any configured provider's model list. ` +
        `This typically means the model is retired, restricted, or misspelled. ` +
        `Available models: ${availableModels}${truncated}`,
    });
  } else {
    logRequest('info', 'model_validation', {
      requested_model: requestedModel,
      resolved_via: aliasResolved ? 'alias' : 'direct',
      message: `Requested model '${requestedModel}' is available`,
    });
  }
}

module.exports = {
  keyValidationResults,
  cachedModels,
  configureKeyValidation,
  resetKeyValidationState,
  resetModelCacheState,
  isKeyValidationComplete,
  isModelFetchComplete,
  setKeyValidationComplete,
  setModelFetchComplete,
  refreshProviderModelsForResolution,
  probeProvider,
  validateApiKeys,
  fetchStartupModels,
  validateRequestedModel,
};
