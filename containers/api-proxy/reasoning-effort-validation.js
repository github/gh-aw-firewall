'use strict';

const { getRequestReasoning, assessReasoningEffort } = require('./model-reasoning');

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

function validateReasoningEffort(body, provider, url, runtimeCatalog, req, options) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.model !== 'string') return;

  const requested = getReasoningEffort(parsed, url);
  if (!requested || (requested.value !== undefined && typeof requested.value !== 'string')) return;
  const decision = getRequestReasoning(parsed.model, provider, runtimeCatalog, req, options);
  if (assessReasoningEffort(decision, requested.value).admitted) return;
  const supported = decision.supportedEfforts;

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
