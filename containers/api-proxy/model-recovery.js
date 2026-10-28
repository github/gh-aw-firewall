'use strict';

const { parseBodyAsObject } = require('./body-utils');
const { getRuntimeModels } = require('./runtime-model-catalog');
const { normalizeModel } = require('./routing-catalogue');
const { getRetiredModelBlockState } = require('./guards/retired-model-guard');
const { getCurrentGuardChecks } = require('./proxy-guards');
const { resolveModelIdentity } = require('./model-identity');
const { compareByVersion } = require('./model-utils');
const { sanitizeForLog } = require('./logging');
const { MODEL_FALLBACK } = require('./model-config');

const MAX_AUTOMATIC_RECOVERIES = 3;

function isAutomaticRecoveryEnabled(provider, req) {
  return MODEL_FALLBACK.enabled &&
    !MODEL_FALLBACK.excludeEngines.includes(provider) &&
    !req?.awfModelRecoveryDisabled &&
    !req?.awfScopedAuto &&
    req?.awfRequestContext?.purpose !== 'routing_classification' &&
    !!protocolForUrl(req?.url);
}

function recoveryRecords(provider, req) {
  return req?.awfRuntimePricing
    ? req.awfRuntimePricing[provider] || []
    : getRuntimeModels(provider) || [];
}

function nativeModel(model, provider) {
  return resolveModelIdentity(model, provider).wireId;
}

function getModelUnavailability(model, provider, req) {
  if (!model || !isAutomaticRecoveryEnabled(provider, req)) return null;
  const retired = getRetiredModelBlockState(model, provider);
  if (retired) return { reason: 'retired_model', suggestion: retired.suggestion };
  // Absence from a custom provider catalogue does not prove a deployment is
  // unavailable. Those backends recover only after an upstream model error.
  const records = recoveryRecords(provider, req);
  if (provider === 'copilot' && req?.awfModelCatalogAuthoritative && records.length > 0 &&
      nativeModel(model, provider).toLowerCase() !== 'auto' &&
      !records.some(record => record.id.toLowerCase() === nativeModel(model, provider).toLowerCase())) {
    return { reason: 'model_unavailable' };
  }
  return null;
}

function protocolForUrl(url) {
  const path = new URL(url, 'http://localhost').pathname.replace(/\/+$/, '');
  if (/\/responses$/.test(path)) return 'responses';
  if (/\/chat\/completions$/.test(path)) return 'chat-completions';
  if (/\/messages$/.test(path)) return 'messages';
  return null;
}

// Automatic recovery is deliberately stricter than explicit fallback: unknown
// capabilities are not evidence that a replacement can preserve a feature.
function isRecoveryCompatible(record, provider, parsed, url, originalRecord) {
  const protocol = protocolForUrl(url);
  if (!parsed || !protocol || record.modelPickerEnabled === false) return false;
  if (typeof parsed.model === 'string' && parsed.model.includes('?')) return false;
  const model = normalizeModel(record.id, record, provider);
  if (!model.protocols?.includes(protocol)) return false;
  if (record.supportedEndpoints && !record.supportedEndpoints.some(endpoint =>
    typeof endpoint === 'string' && !endpoint.includes(':') &&
    protocolForUrl(`/${endpoint.replace(/^\/?(?:v1\/)?/, '').replace('chat_completions', 'chat/completions')}`) === protocol)) return false;
  const supports = record.capabilities?.supports || {};
  const effort = protocol === 'responses' ? parsed.reasoning?.effort
    : protocol === 'messages' ? parsed.output_config?.effort : parsed.reasoning_effort;
  if (effort !== undefined && !model.efforts?.includes(effort)) return false;
  const original = normalizeModel(originalRecord?.id || parsed.model, originalRecord, provider);
  if (original?.contextWindow && (!model.contextWindow || model.contextWindow < original.contextWindow)) return false;
  const outputLimit = record.capabilities?.limits?.max_output_tokens;
  const originalOutputLimit = originalRecord?.capabilities?.limits?.max_output_tokens;
  const requestedOutput = parsed.max_tokens ?? parsed.max_completion_tokens ?? parsed.max_output_tokens;
  const requiredOutput = requestedOutput ??
    (Number.isFinite(originalOutputLimit) ? originalOutputLimit : undefined);
  if (requiredOutput !== undefined &&
      (!Number.isFinite(outputLimit) || outputLimit < requiredOutput)) return false;

  const coreFields = new Set([
    'model', 'messages', 'input', 'instructions', 'system', 'max_tokens',
    'max_completion_tokens', 'max_output_tokens', 'stream', 'stream_options',
    'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'reasoning',
    'output_config', 'response_format', 'text',
  ]);
  for (const [field, value] of Object.entries(parsed)) {
    if (value !== null && !coreFields.has(field) && supports[field] !== true) return false;
  }
  if (parsed.stream === true && supports.streaming !== true) return false;
  if (parsed.parallel_tool_calls === true && supports.parallel_tool_calls !== true) return false;
  if (parsed.stream_options && Object.keys(parsed.stream_options)
    .some(key => key !== 'include_usage' && supports[key] !== true)) return false;
  if (parsed.tool_choice && parsed.tool_choice !== 'none' && supports.tool_calls !== true) return false;
  if (parsed.response_format?.type && parsed.response_format.type !== 'text' &&
      supports.structured_outputs !== true) return false;
  if (parsed.text?.format?.type && parsed.text.format.type !== 'text' &&
      supports.structured_outputs !== true) return false;
  if (parsed.text && Object.keys(parsed.text).some(key => key !== 'format' && supports[key] !== true)) return false;
  if (parsed.reasoning && Object.keys(parsed.reasoning).some(key => key !== 'effort' && supports[key] !== true)) return false;
  if (parsed.output_config && Object.keys(parsed.output_config).some(key => key !== 'effort' && supports[key] !== true)) return false;

  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      const type = tool?.type || (tool?.name ? 'function' : null);
      if (type !== 'function' && type !== 'custom') return false;
      if (supports.tool_calls !== true) return false;
      if ((tool.strict === true || tool.function?.strict === true) && supports.structured_outputs !== true) return false;
      if (type === 'custom' && !(provider === 'copilot' && protocol === 'responses') &&
          supports.custom_tools !== true) return false;
    }
  }
  const pendingContent = [parsed.messages, parsed.input, parsed.system];
  while (pendingContent.length > 0) {
    const value = pendingContent.pop();
    if (!value || typeof value !== 'object') continue;
    if ((value.tool_calls || value.tool_call_id || value.type === 'tool_use' ||
        value.type === 'tool_result' || value.type === 'function_call' ||
        value.type === 'function_call_output') && supports.tool_calls !== true) return false;
    if (['image', 'image_url', 'input_image'].includes(value.type) && supports.vision !== true) return false;
    if (['input_audio', 'audio', 'video', 'file', 'input_file'].includes(value.type) &&
        supports[value.type] !== true) return false;
    if (value.type && ![
      'text', 'input_text', 'output_text', 'message', 'refusal', 'function',
      'tool_use', 'tool_result', 'function_call', 'function_call_output',
      'image', 'image_url', 'input_image', 'input_audio', 'audio', 'video',
      'file', 'input_file',
    ].includes(value.type) && supports[value.type] !== true) return false;
    for (const [key, child] of Object.entries(value)) {
      if ((value.type === 'tool_use' && key === 'input') ||
          (['image', 'image_url', 'input_image'].includes(value.type) && key === 'source')) continue;
      if (child && typeof child === 'object') pendingContent.push(child);
    }
  }
  return true;
}

function getAutomaticRecoveryCandidates({ model, provider, body, url, req, isPermitted }) {
  if (!isAutomaticRecoveryEnabled(provider, req)) return [];
  const parsed = parseBodyAsObject(body);
  const records = recoveryRecords(provider, req);
  const originalRecord = records.find(record => record.id.toLowerCase() === nativeModel(model, provider).toLowerCase());
  const suggestion = getRetiredModelBlockState(model, provider)?.suggestion.toLowerCase();
  const permitted = isPermitted || ((candidate) => getCurrentGuardChecks(candidate, provider, {
    catalogue: req?.awfCatalogue, runtimeCatalog: req?.awfRuntimePricing,
  }).every(guard => !guard.isBlocked(guard.block)));
  return records.filter(record =>
    record.id.toLowerCase() !== nativeModel(model, provider).toLowerCase() &&
    !getRetiredModelBlockState(record.id, provider, { inputMode: 'native' }) &&
    isRecoveryCompatible(record, provider, parsed, url, originalRecord) &&
    permitted(record.id, provider))
    .map(record => record.id)
    .sort((left, right) =>
      (left.toLowerCase() === suggestion ? -1 : right.toLowerCase() === suggestion ? 1 : compareByVersion(left, right)));
}

function recordModelRecovery({ req, provider, requestedModel, fromModel, toModel, reason, requestId, logRequest }) {
  req.awfModelFallback = {
    requested_model: requestedModel, requested_provider: provider,
    model: toModel, provider, from_model: fromModel, from_provider: provider, reason,
    attempt: 1, failures: [{ provider, model: fromModel, reason }],
  };
  req.awfRouting?.onModelFallback?.(req.awfModelFallback);
  logRequest('warn', 'model_fallback', {
    request_id: requestId, provider,
    requested_model: sanitizeForLog(requestedModel),
    from_model: sanitizeForLog(fromModel), to_model: sanitizeForLog(toModel),
    from_provider: provider, to_provider: provider, reason,
  });
}

function recoverRequestModel(body, provider, req, requestId, logRequest) {
  const parsed = parseBodyAsObject(body);
  if (typeof parsed?.model !== 'string') return null;
  const state = getModelUnavailability(parsed.model, provider, req);
  if (!state) return null;
  if (getCurrentGuardChecks(null, provider).some(guard => guard.isBlocked(guard.block))) return null;
  const candidates = getAutomaticRecoveryCandidates({ model: parsed.model, provider, body, url: req.url, req });
  if (candidates.length === 0) {
    const error = new Error(`Model '${sanitizeForLog(parsed.model)}' is retired or unavailable and no compatible policy-permitted replacement is available`);
    error.statusCode = 400;
    error.type = state.reason === 'retired_model' ? 'retired_model' : 'invalid_request_error';
    error.code = 'model_recovery_exhausted';
    throw error;
  }
  const fromModel = parsed.model;
  parsed.model = candidates[0];
  req.awfRecoveryAttempts = [{ provider, model: fromModel }, { provider, model: parsed.model }];
  recordModelRecovery({
    req, provider, requestedModel: req.awfRequestedModelSelector || fromModel,
    fromModel, toModel: parsed.model, reason: state.reason, requestId, logRequest,
  });
  return Buffer.from(JSON.stringify(parsed));
}

module.exports = {
  MAX_AUTOMATIC_RECOVERIES,
  isAutomaticRecoveryEnabled,
  recoveryRecords,
  protocolForUrl,
  getModelUnavailability,
  getAutomaticRecoveryCandidates,
  isRecoveryCompatible,
  recoverRequestModel,
};
