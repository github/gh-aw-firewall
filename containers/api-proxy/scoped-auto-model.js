'use strict';

const { parseBodyAsObject } = require('./body-utils');
const { compareByVersion, stripRedundantProviderPrefix } = require('./model-utils');
const { isModelPermittedByPolicy } = require('./guards/model-policy-guard');

const MODEL_PROVIDERS = Object.freeze({
  anthropic: /^claude[-.]/i,
  openai: /^(?:gpt[-.]|o[1-9](?:[-.]|$))/i,
  google: /^gemini[-.]/i,
});
const ENDPOINTS = Object.freeze(['messages', 'chat/completions', 'responses']);

function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return null;
  const normalized = endpoint.replace(/^\/(?:v1\/)?/, '').replace(/\/+$/, '');
  return normalized === 'chat_completions' ? 'chat/completions' : normalized;
}

function pickerError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.type = statusCode === 503 ? 'service_unavailable' : 'invalid_request_error';
  return error;
}

function parseScopedAutoRequest(body, req, provider) {
  const parsed = parseBodyAsObject(body);
  if (!parsed || !Object.hasOwn(parsed, 'model_provider')) return null;
  const model = stripRedundantProviderPrefix(parsed.model, provider);
  const queryIndex = typeof model === 'string' ? model.indexOf('?') : -1;
  const baseModel = queryIndex === -1 ? model : model.slice(0, queryIndex);
  const modelProvider = parsed.model_provider;
  if (
    typeof baseModel !== 'string' || baseModel.toLowerCase() !== 'auto' ||
    typeof modelProvider !== 'string' || !Object.hasOwn(MODEL_PROVIDERS, modelProvider)
  ) {
    throw pickerError(
      'model_provider requires model "auto" (optionally with a query suffix) and one of: anthropic, openai, google. It constrains the model family, not the inference backend.',
      'invalid_scoped_auto_request',
    );
  }
  let endpoint;
  try {
    endpoint = normalizeEndpoint(new URL(req?.url, 'http://localhost').pathname);
  } catch {
    endpoint = null;
  }
  if (req?.method !== 'POST' || !ENDPOINTS.includes(endpoint)) {
    throw pickerError(
      'Provider-scoped auto is supported on POST /messages, /chat/completions, and /responses (also with /v1 prefixes).',
      'unsupported_scoped_auto_endpoint',
    );
  }
  return {
    parsed,
    modelProvider,
    endpoint,
    parameterSuffix: queryIndex === -1 ? '' : model.slice(queryIndex),
    requiresCodex: provider === 'copilot' && endpoint === 'responses' &&
      Array.isArray(parsed.tools) && parsed.tools.some(tool => tool?.type === 'custom'),
  };
}

function getScopedAutoCandidates(provider, modelProvider, endpoint, models, records, policy, requiresCodex = false) {
  const available = new Set((models || []).map(model => model.toLowerCase()));
  const family = MODEL_PROVIDERS[modelProvider];
  if (!family) return [];
  const candidates = (records || []).filter(record =>
    typeof record?.id === 'string' &&
    available.has(record.id.toLowerCase()) &&
    family.test(record.id) &&
    record.modelPickerEnabled !== false &&
    Array.isArray(record.supportedEndpoints) &&
    record.supportedEndpoints.some(value => normalizeEndpoint(value) === endpoint) &&
    (!requiresCodex || /(?:^|[-.])codex(?:$|[-.])/i.test(record.id)) &&
    isModelPermittedByPolicy(record.id, policy?.allowedModels, policy?.disallowedModels, provider),
  ).map(record => record.id);
  return [...new Set(candidates)].sort((a, b) => {
    if (modelProvider === 'anthropic') {
      const rank = model => {
        const tier = ['sonnet', 'opus', 'haiku'].findIndex(value => model.toLowerCase().includes(value));
        return tier === -1 ? 3 : tier;
      };
      const tierOrder = rank(a) - rank(b);
      if (tierOrder) return tierOrder;
    }
    return compareByVersion(a, b);
  });
}

function rewriteScopedAutoRequest(selection, provider, models, records, policy) {
  const candidates = getScopedAutoCandidates(
    provider, selection.modelProvider, selection.endpoint, models, records, policy, selection.requiresCodex,
  ).map(model => `${model}${selection.parameterSuffix}`);
  if (candidates.length === 0) return null;
  const originalModel = selection.parsed.model;
  const parsed = { ...selection.parsed, model: candidates[0] };
  delete parsed.model_provider;
  return {
    body: Buffer.from(JSON.stringify(parsed), 'utf8'),
    originalModel,
    resolvedModel: candidates[0],
    candidates,
    log: [`[model-resolver] scoped auto (${selection.modelProvider}, ${selection.endpoint}): "${originalModel}" → "${candidates[0]}"`],
  };
}

function reflectScopedAuto(provider, models, records, policy) {
  return {
    model: 'auto',
    constraint_field: 'model_provider',
    model_providers: Object.keys(MODEL_PROVIDERS),
    preserves_backend: true,
    requires_advertised_endpoints: true,
    candidates: Object.fromEntries(Object.keys(MODEL_PROVIDERS).map(modelProvider => [
      modelProvider,
      Object.fromEntries(ENDPOINTS.map(endpoint => [
        endpoint, getScopedAutoCandidates(provider, modelProvider, endpoint, models, records, policy),
      ])),
    ])),
  };
}

module.exports = { parseScopedAutoRequest, rewriteScopedAutoRequest, reflectScopedAuto, pickerError };
