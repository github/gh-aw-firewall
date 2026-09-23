'use strict';

const { createRoutingError } = require('./routing-errors');

const CLASSIFIER_MESSAGE_OVERHEAD_TOKENS = 64;
const CLASSIFIER_OUTPUT_TOKENS = 512;
const CLASSIFIER_REASONING_OUTPUT_TOKENS = 2_048;

function buildClassifierRequest(mapping, plan) {
  if (!mapping || typeof mapping.wireModel !== 'string' || !mapping.wireModel) {
    throw createRoutingError('routing_configuration_error', 'The classifier choice has no executable wire model');
  }
  if (!plan || typeof plan.system_prompt !== 'string' || !plan.system_prompt) {
    throw createRoutingError('routing_contract_error', 'The classifier plan has no system prompt');
  }
  if (typeof plan.prompt !== 'string') throw createRoutingError('routing_contract_error', 'The classifier plan prompt is invalid');
  if (mapping.protocol === 'responses') {
    const maxOutputTokens = mapping.effort === undefined ? CLASSIFIER_OUTPUT_TOKENS : CLASSIFIER_REASONING_OUTPUT_TOKENS;
    return Object.freeze({
      path: '/responses',
      body: Object.freeze({
        model: mapping.wireModel, instructions: plan.system_prompt,
        input: Object.freeze([Object.freeze({ role: 'user', content: plan.prompt })]),
        tools: Object.freeze([]), stream: false, max_output_tokens: maxOutputTokens,
        ...(mapping.effort === undefined ? {} : { reasoning: Object.freeze({ effort: mapping.effort }) }),
      }),
      outputAllowance: maxOutputTokens,
    });
  }
  if (mapping.protocol === 'chat-completions') {
    return Object.freeze({
      path: '/chat/completions',
      body: Object.freeze({
        model: mapping.wireModel,
        messages: Object.freeze([
          Object.freeze({ role: 'system', content: plan.system_prompt }),
          Object.freeze({ role: 'user', content: plan.prompt }),
        ]),
        tools: Object.freeze([]), stream: false, max_tokens: CLASSIFIER_OUTPUT_TOKENS,
        ...(mapping.effort === undefined ? {} : { reasoning_effort: mapping.effort }),
      }),
      outputAllowance: CLASSIFIER_OUTPUT_TOKENS,
    });
  }
  throw createRoutingError('routing_configuration_error', 'The classifier choice uses an unverified protocol');
}

function preflightClassifierRequest(mapping, plan) {
  if (!Number.isInteger(mapping.contextWindow) || mapping.contextWindow <= 0) {
    throw createRoutingError('routing_configuration_error', 'The classifier choice has no authoritative context capacity');
  }
  const request = buildClassifierRequest(mapping, plan);
  // Serialized UTF-8 bytes conservatively exceed these payloads' token count;
  // the fixed allowance covers provider message framing.
  const promptTokensBound = Buffer.byteLength(JSON.stringify(request.body), 'utf8') + CLASSIFIER_MESSAGE_OVERHEAD_TOKENS;
  const requiredTokens = promptTokensBound + request.outputAllowance;
  return Object.freeze({ request, promptTokensBound, requiredTokens, eligible: requiredTokens <= mapping.contextWindow });
}

function parseProviderEnvelope(raw) {
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    const value = typeof text === 'string' ? JSON.parse(text) : text;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function extractClassifierOutput(protocol, raw) {
  const response = parseProviderEnvelope(raw);
  if (!response) return null;
  if (protocol === 'chat-completions') {
    const choices = response.choices;
    if (!Array.isArray(choices) || choices.length !== 1) return null;
    return typeof choices[0]?.message?.content === 'string' ? choices[0].message.content : null;
  }
  if (protocol === 'responses') {
    if (typeof response.output_text === 'string') return response.output_text;
    const outputTexts = [];
    for (const item of Array.isArray(response.output) ? response.output : []) {
      for (const content of Array.isArray(item?.content) ? item.content : []) {
        if (content?.type === 'output_text' && typeof content.text === 'string') outputTexts.push(content.text);
      }
    }
    return outputTexts.length === 1 ? outputTexts[0] : null;
  }
  return null;
}

module.exports = {
  CLASSIFIER_MESSAGE_OVERHEAD_TOKENS, CLASSIFIER_OUTPUT_TOKENS, CLASSIFIER_REASONING_OUTPUT_TOKENS,
  buildClassifierRequest, extractClassifierOutput, preflightClassifierRequest,
};
