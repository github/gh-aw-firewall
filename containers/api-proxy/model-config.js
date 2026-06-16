'use strict';

const { parseModelAliases, filterResolvableAliases } = require('./model-resolver');
const { rewriteModelInBody } = require('./model-body-rewriter');
const { sanitizeForLog, logRequest } = require('./logging');
const { diag } = require('./token-persistence');
const { getCopilotModelFallbackPolicy } = require('./providers/copilot-auth');
const { ALLOWED_MODELS, DISALLOWED_MODELS } = require('./guards/model-policy-guard');

const MODEL_ALIASES_RAW = (process.env.AWF_MODEL_ALIASES || '').trim() || undefined;
const MODEL_ALIASES = parseModelAliases(MODEL_ALIASES_RAW);
const DEFAULT_MODEL_FALLBACK = Object.freeze({ enabled: true, strategy: 'middle_power', excludeEngines: Object.freeze([]) });

/**
 * The effective model policy config used during alias resolution.
 * Null means "no policy" (all models are permitted).
 */
const MODEL_POLICY_CONFIG = (ALLOWED_MODELS || DISALLOWED_MODELS)
  ? { allowedModels: ALLOWED_MODELS, disallowedModels: DISALLOWED_MODELS }
  : null;

function parseExcludeEngines(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter(engine => typeof engine === 'string')
      .map(engine => engine.trim().toLowerCase())
      .filter(Boolean),
  )];
}

function parseModelFallbackConfig(rawConfig) {
  if (!rawConfig) return { ...DEFAULT_MODEL_FALLBACK, excludeEngines: [] };
  try {
    const parsed = JSON.parse(rawConfig);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_MODEL_FALLBACK, excludeEngines: [] };
    }
    const enabled = parsed.enabled === undefined ? true : Boolean(parsed.enabled);
    const strategy = typeof parsed.strategy === 'string' && parsed.strategy.trim()
      ? parsed.strategy.trim()
      : DEFAULT_MODEL_FALLBACK.strategy;
    const excludeEngines = parseExcludeEngines(parsed.excludeEngines);
    return { enabled, strategy, excludeEngines };
  } catch {
    return { ...DEFAULT_MODEL_FALLBACK, excludeEngines: [] };
  }
}

const MODEL_FALLBACK_RAW = (process.env.AWF_MODEL_FALLBACK || '').trim() || undefined;
const MODEL_FALLBACK = parseModelFallbackConfig(MODEL_FALLBACK_RAW);

if (MODEL_ALIASES) {
  logRequest('info', 'startup', {
    message: 'Model aliases loaded',
    alias_count: Object.keys(MODEL_ALIASES.models).length,
    aliases: Object.keys(MODEL_ALIASES.models),
  });
} else if (MODEL_ALIASES_RAW) {
  logRequest('warn', 'startup', {
    message: 'AWF_MODEL_ALIASES is set but could not be parsed — model aliasing disabled',
  });
}

logRequest('info', 'startup', {
  message: 'Model fallback policy loaded',
  model_fallback: MODEL_FALLBACK,
});

function getModelFallbackPolicyForProvider(provider) {
  if (MODEL_FALLBACK.excludeEngines && MODEL_FALLBACK.excludeEngines.includes(provider.toLowerCase())) {
    return {
      effective: { ...MODEL_FALLBACK, enabled: false },
      suppressed: true,
      suppression_reason: 'excluded_by_config',
    };
  }
  if (provider !== 'copilot') {
    return { effective: MODEL_FALLBACK, suppressed: false };
  }
  return getCopilotModelFallbackPolicy(MODEL_FALLBACK, process.env);
}

function getModelFallbackForProvider(provider) {
  return getModelFallbackPolicyForProvider(provider).effective;
}

function getEffectiveModelFallbackForReflect(adapters) {
  const effectiveByProvider = {};
  for (const adapter of adapters) {
    const policy = getModelFallbackPolicyForProvider(adapter.name);
    effectiveByProvider[adapter.name] = {
      ...policy.effective,
      suppressed: policy.suppressed,
      ...(policy.suppression_reason ? { suppression_reason: policy.suppression_reason } : {}),
    };
  }
  return effectiveByProvider;
}

function makeModelBodyTransform(provider, cachedModels, refreshProviderModelsForResolution) {
  if (!MODEL_ALIASES) return null;
  const providerModelFallback = getModelFallbackForProvider(provider);
  return async (body) => {
    let result = rewriteModelInBody(body, provider, MODEL_ALIASES.models, cachedModels, providerModelFallback, MODEL_POLICY_CONFIG);
    if (!result || (result.fallback && result.fallback.activated)) {
      await refreshProviderModelsForResolution(provider);
      result = rewriteModelInBody(body, provider, MODEL_ALIASES.models, cachedModels, providerModelFallback, MODEL_POLICY_CONFIG);
    }
    if (!result) return null;
    const originalModel = sanitizeForLog(result.originalModel) || '(none)';
    const resolvedModel = sanitizeForLog(result.resolvedModel);
    if (providerModelFallback.enabled && result.fallback) {
      if (result.fallback.activated) {
        logRequest('warn', 'model_fallback_activated', {
          provider,
          original_model: originalModel,
          fallback_model: resolvedModel,
          reason: result.fallback.reason,
          available_models_count: result.fallback.available_models_count,
          selection_method: result.fallback.selection_method,
        });
        logRequest('debug', 'model_fallback_candidates', {
          provider,
          original_model: originalModel,
          candidates: result.fallback.candidates,
          selection_method: result.fallback.selection_method,
        });
      } else {
        logRequest('info', 'model_fallback_skipped', {
          provider,
          original_model: originalModel,
          reason: result.fallback.reason,
          selection_method: result.fallback.selection_method,
        });
      }
    }
    for (const line of result.log) {
      logRequest('info', 'model_resolution', { message: line, provider });
      diag('model_alias_resolution_step', {
        provider,
        original_model: originalModel,
        resolved_model: resolvedModel,
        step: line,
      });
    }
    logRequest('info', 'model_rewrite', {
      provider,
      original_model: originalModel,
      resolved_model: resolvedModel,
    });
    diag('model_alias_rewrite', {
      provider,
      original_model: originalModel,
      resolved_model: resolvedModel,
      resolution_steps: result.log,
    });
    return result.body;
  };
}

module.exports = {
  MODEL_ALIASES,
  MODEL_FALLBACK,
  MODEL_POLICY_CONFIG,
  parseModelFallbackConfig,
  makeModelBodyTransform,
  filterResolvableAliases,
  getEffectiveModelFallbackForReflect,
};
