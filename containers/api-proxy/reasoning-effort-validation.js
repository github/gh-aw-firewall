'use strict';

const { findRuntimeModel } = require('./runtime-model-catalog');

function getReasoningEffort(parsed, url) {
  let pathname;
  try {
    pathname = new URL(url, 'http://localhost').pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }

  if (/\/chat\/completions$/.test(pathname)) {
    return { field: 'reasoning_effort', value: parsed.reasoning_effort };
  }
  if (/\/responses$/.test(pathname)) {
    return { field: 'reasoning.effort', value: parsed.reasoning?.effort };
  }
  if (/\/messages$/.test(pathname)) {
    return { field: 'output_config.effort', value: parsed.output_config?.effort };
  }
  return null;
}

function getSupportedEfforts(model) {
  if (Array.isArray(model?.supportedReasoningEfforts)) return model.supportedReasoningEfforts;
  const supports = model?.capabilities?.supports;
  if (Array.isArray(supports?.reasoning_effort)) return supports.reasoning_effort;
  if (supports?.reasoningEffort === false) return [];
  return null;
}

function validateReasoningEffort(body, provider, url) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.model !== 'string') return;

  const requested = getReasoningEffort(parsed, url);
  if (!requested || typeof requested.value !== 'string') return;
  const model = findRuntimeModel(provider, parsed.model);
  const supported = getSupportedEfforts(model);
  if (!supported || supported.includes(requested.value)) return;

  const error = new Error(
    `${requested.field} ${JSON.stringify(requested.value)} is not supported by model ${parsed.model}; ` +
    `supported values: [${supported.join(' ')}]`,
  );
  error.statusCode = 400;
  error.type = 'invalid_request_error';
  error.code = 'unsupported_reasoning_effort';
  throw error;
}

module.exports = { validateReasoningEffort };
