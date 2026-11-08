'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { REVISION, FEATURES, CONTRACTS } = require('./index');
const { translateChatRequest, translateResponsesRequest } = require('../wire-api-compat');
const { chatRequestToAnthropic } = require('../anthropic-chat-compat');
const { assessReasoningEffort } = require('../catalogue-contract/reasoning');

const ASSESSMENT_REVISION = 'awf-fallback-assessment-v1';
const CONTRACT_DIGEST = 'bd6db2fe3fea4b4879b0ef4289fc06271f812019131fb73c553e05362f51891a';
const REASON_CODES = Object.freeze([
  'assessment_limit', 'request_shape_unverified', 'direction_unimplemented', 'implementation_drift',
  'condition_unverified', 'unknown_required_feature', 'unknown_nested_field', 'translator_rejected', 'request_build_failed',
  'role_priority_loss', 'turn_boundary_loss', 'content_loss', 'refusal_loss',
  'tool_shape_invalid', 'tool_choice_invalid', 'parallel_enablement_unverified',
  'structured_output_invalid', 'image_fields_lost', 'modality_unsupported', 'stateful_unsupported',
  'reasoning_unsupported', 'cache_controls_unverified', 'token_limit_invalid', 'sampling_altered',
  'stream_options_invalid', 'response_requirement_unverified', 'response_usage_unavailable',
  'reasoning_effort_required', 'reasoning_effort_forbidden', 'reasoning_effort_unsupported',
  'reasoning_automatic_requires_known_support', 'reasoning_future_effort_not_selectable',
  'reasoning_direct_unknown_passthrough', 'reasoning_effort_accepted',
]);
const PROTOCOLS = new Set(['chat_completions', 'responses', 'anthropic_messages']);
const TRANSLATORS = Object.freeze({
  'chat-to-responses-request': translateChatRequest,
  'responses-to-chat-request': translateResponsesRequest,
  'chat-to-messages-request': chatRequestToAnthropic,
});

// Validate the shipped bytes once, not during assessment or reflection. A running
// process holds these implementations; a stale contract cannot authorize them.
const implementationsMatch = (() => {
  try {
    return REVISION === 'awf-directed-protocol-v1' &&
      createHash('sha256').update(JSON.stringify(CONTRACTS)).digest('hex') === CONTRACT_DIGEST &&
      CONTRACTS.every(contract => createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', contract.implementation.file)))
        .digest('hex') === contract.implementation.sha256);
  } catch {
    return false;
  }
})();

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const jsonResult = value => value !== null && value !== undefined &&
  (typeof value === 'string' || typeof value === 'boolean' ||
    typeof value === 'number' && Number.isFinite(value) || typeof value === 'object');
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const present = (body, key) => Object.hasOwn(body, key);

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function bounded(value, seen = new Set(), budget = { left: 8192 }, depth = 0) {
  if (--budget.left < 0 || depth > 32) return false;
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  if (Array.isArray(value) && value.length > budget.left) return false;
  seen.add(value);
  const values = Object.values(value);
  const result = values.length <= budget.left &&
    values.every(item => bounded(item, seen, budget, depth + 1));
  seen.delete(value);
  return result;
}

function featureFor(key) {
  if (/cache/.test(key)) return 'cache_controls';
  if (/reasoning|thinking/.test(key)) return 'reasoning_content';
  if (key === 'refusal') return 'refusal';
  if (/audio/.test(key)) return 'audio';
  if (['store', 'metadata', 'include', 'truncation', 'previous_response_id'].includes(key)) return 'stateful_fields';
  return 'unknown_fields';
}

function checkRequest(body, contract, add, use) {
  const messages = contract.target === 'anthropic_messages';
  const responses = contract.source === 'responses';
  const nested = (value, keys, feature = 'unknown_fields') => {
    if (!object(value)) { add(feature, 'request_shape_unverified', false); return false; }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) add(featureFor(key) === 'unknown_fields' ? feature : featureFor(key),
        key === 'refusal' ? 'refusal_loss' : /cache/.test(key) ? 'cache_controls_unverified' : 'unknown_nested_field',
        key === 'refusal');
    }
    return true;
  };
  const parts = (content, role) => {
    use('message_text');
    if (typeof content === 'string') {
      if (messages && !content) add('message_text', 'turn_boundary_loss');
      return;
    }
    if (content === null || content === undefined) {
      if (messages && role !== 'assistant') add('message_text', 'turn_boundary_loss');
      return;
    }
    if (!Array.isArray(content)) { add('message_text', 'request_shape_unverified', false); return; }
    if (messages && !content.length) add('message_text', 'turn_boundary_loss');
    for (const part of content) {
      if (!object(part)) { add('message_text', 'request_shape_unverified', false); continue; }
      const texts = responses ? ['input_text', 'output_text'] : messages
        ? ['text', 'input_text', 'output_text'] : ['text'];
      if (texts.includes(part.type)) {
        nested(part, ['type', 'text'], 'message_text');
        if (typeof part.text !== 'string') add('message_text', 'request_shape_unverified', false);
        if (messages && !part.text) add('message_text', 'content_loss');
      } else if (part.type === (responses ? 'input_image' : 'image_url')) {
        use('image_input');
        nested(part, responses ? ['type', 'image_url', 'detail'] : ['type', 'image_url'], 'image_input');
        const image = part.image_url;
        if (!responses && object(image)) nested(image, ['url', 'detail'], 'image_input');
        const url = typeof image === 'string' ? image : responses ? undefined : image?.url;
        if (!nonempty(url)) add('image_input', 'request_shape_unverified', false);
        const detail = responses ? part.detail : image?.detail;
        if (detail !== undefined && !['auto', 'low', 'high'].includes(detail)) {
          add('image_input', 'condition_unverified', false);
        }
        if (messages && detail !== undefined) add('image_input', 'image_fields_lost');
        if (messages && !(typeof url === 'string' &&
            (/^https:\/\//i.test(url) || /^data:[^;,]+;base64,.+$/s.test(url)))) {
          add('image_input', 'condition_unverified', false);
        }
      } else {
        const feature = /audio/.test(part.type || '') ? 'audio'
          : /reasoning|thinking/.test(part.type || '') ? 'reasoning_content' : 'other_modalities';
        add(feature, 'modality_unsupported');
      }
    }
  };
  const toolCall = (call, responseItem = false) => {
    use('function_tools');
    if (!nested(call, responseItem ? ['type', 'id', 'status', 'call_id', 'name', 'arguments']
      : ['type', 'id', 'function'], 'function_tools')) return;
    const fn = responseItem ? call : call.function;
    if (!responseItem) nested(fn, ['name', 'arguments'], 'function_tools');
    if ((!responseItem && call.type !== 'function') ||
        !nonempty(responseItem ? call.call_id : call.id) || !nonempty(fn?.name)) {
      add('function_tools', 'tool_shape_invalid');
    }
    // The wire adapter JSON-encodes object arguments but Responses->Chat
    // defaults empty arguments. Do not approve malformed or empty call payloads.
    if (!nonempty(fn?.arguments) && !(object(fn?.arguments) && !responseItem)) {
      add('function_tools', 'tool_shape_invalid');
    }
    if (messages && nonempty(fn?.arguments)) {
      try {
        if (!object(JSON.parse(fn.arguments))) add('function_tools', 'tool_shape_invalid');
      } catch { add('function_tools', 'tool_shape_invalid'); }
    }
  };
  use('message_roles');
  if (responses && typeof body.input === 'string') use('message_text');
  else {
    const items = responses ? body.input : body.messages;
    if (!Array.isArray(items)) add('message_roles', 'request_shape_unverified', false);
    else {
      let previousRole = null;
      let systemCount = 0;
      for (const [index, item] of items.entries()) {
        if (responses && item?.type === 'function_call') { toolCall(item, true); continue; }
        if (responses && item?.type === 'function_call_output') {
          use('function_tools');
          nested(item, ['type', 'id', 'status', 'call_id', 'output'], 'function_tools');
          if (!nonempty(item.call_id) || !jsonResult(item.output)) add('function_tools', 'tool_shape_invalid');
          continue;
        }
        if (responses && item?.type && item.type !== 'message') {
          add(/reasoning/.test(item.type) ? 'reasoning_content' : 'other_modalities', 'modality_unsupported');
          continue;
        }
        if (!nested(item, responses ? ['type', 'id', 'status', 'role', 'content']
          : ['role', 'content', 'tool_calls', 'tool_call_id'], 'message_roles')) continue;
        const role = responses ? item.role || 'user' : item.role;
        if (!['user', 'assistant', 'system', 'developer', ...(responses ? [] : ['tool'])].includes(role)) {
          add('message_roles', 'condition_unverified', false);
        }
        if (!responses && (role === 'system' || role === 'developer')) {
          if (!messages || role === 'developer' || index !== 0 || ++systemCount > 1) {
            add('message_roles', 'role_priority_loss');
          }
          if (typeof item.content !== 'string') add('message_roles', 'condition_unverified', false);
        }
        const targetRole = role === 'tool' ? 'user' : role;
        if (messages && targetRole === previousRole && !(role === 'tool' && items[index - 1]?.role === 'tool')) {
          add('message_roles', 'turn_boundary_loss');
        }
        previousRole = targetRole;
        if (role === 'tool') {
          use('function_tools');
          if (!nonempty(item.tool_call_id) || (messages ? typeof item.content !== 'string' : !jsonResult(item.content))) {
            add('function_tools', 'tool_shape_invalid');
          }
        } else if (!(messages && role === 'assistant' && Array.isArray(item.tool_calls) &&
            item.tool_calls.length > 0 &&
            (item.content === '' || Array.isArray(item.content) && item.content.length === 0))) {
          parts(item.content, role);
        }
        if (present(item, 'tool_call_id') && role !== 'tool') add('function_tools', 'tool_shape_invalid');
        if (present(item, 'tool_calls')) {
          if (role !== 'assistant' || !Array.isArray(item.tool_calls)) add('function_tools', 'tool_shape_invalid');
          else item.tool_calls.forEach(call => toolCall(call));
          if (!responses && !messages && role === 'assistant' && !item.content && !item.tool_calls?.length) {
            add('message_roles', 'turn_boundary_loss');
          }
        }
        if (messages && role === 'assistant' && !item.content && !item.tool_calls?.length) {
          add('message_text', 'turn_boundary_loss');
        }
      }
    }
  }

  if (present(body, 'tools')) {
    use('function_tools');
    if (!Array.isArray(body.tools)) add('function_tools', 'tool_shape_invalid');
    else for (const tool of body.tools) {
      if (tool?.type !== 'function') { add('hosted_tools', 'translator_rejected'); continue; }
      nested(tool, responses ? ['type', 'name', 'description', 'parameters', 'strict']
        : ['type', 'function'], 'function_tools');
      const fn = responses ? tool : tool.function;
      if (!responses) nested(fn, ['name', 'description', 'parameters', 'strict'], 'function_tools');
      if (!nonempty(fn?.name) || (fn.description !== undefined && typeof fn.description !== 'string') ||
          (fn.strict !== undefined && typeof fn.strict !== 'boolean') ||
          (fn.parameters !== undefined && !object(fn.parameters))) add('function_tools', 'tool_shape_invalid');
      if (messages && fn?.parameters === undefined) add('function_tools', 'condition_unverified', false);
    }
  }
  if (present(body, 'tool_choice')) {
    use('tool_choice');
    const choice = body.tool_choice;
    const valid = ['auto', 'none', 'required'].includes(choice) ||
      (responses ? only(choice, ['type', 'name']) && choice.type === 'function' && nonempty(choice.name)
        : only(choice, ['type', 'function']) && choice.type === 'function' &&
          only(choice.function, ['name']) && nonempty(choice.function.name));
    if (!valid || (messages && !body.tools?.length && !['auto', 'none'].includes(choice))) {
      add('tool_choice', 'tool_choice_invalid');
    }
  }
  if (present(body, 'parallel_tool_calls')) {
    use('parallel_tool_calls');
    if (typeof body.parallel_tool_calls !== 'boolean') add('parallel_tool_calls', 'condition_unverified', false);
    if (messages && (body.parallel_tool_calls === true ||
        (body.parallel_tool_calls === false && (!body.tools?.length || body.tool_choice === 'none')))) {
      add('parallel_tool_calls', 'parallel_enablement_unverified', false);
    }
  }
  const format = responses ? body.text?.format : body.response_format;
  if (responses && present(body, 'text')) nested(body.text, ['format'], 'structured_output');
  if (format !== undefined && format !== null) {
    use('structured_output');
    if (messages && only(format, ['type']) && format.type === 'text') {
      // Existing transport no-op, not JSON enforcement.
    } else if (messages) add('structured_output', 'translator_rejected');
    else if (format.type === 'json_object') {
      if (!only(format, ['type'])) add('structured_output', 'structured_output_invalid');
    } else if (format.type === 'json_schema') {
      const spec = responses ? format : format.json_schema;
      if ((!responses && !only(format, ['type', 'json_schema'])) ||
          !only(spec, responses ? ['type', 'name', 'schema', 'strict'] : ['name', 'schema', 'strict']) ||
          !nonempty(spec?.name) || !object(spec?.schema) ||
          (spec.strict !== undefined && typeof spec.strict !== 'boolean')) {
        add('structured_output', 'structured_output_invalid');
      }
    } else add('structured_output', 'structured_output_invalid');
  }
  const limitKeys = responses ? ['max_output_tokens'] : ['max_tokens', 'max_completion_tokens'];
  use('token_limits');
  for (const key of limitKeys) if (present(body, key) && !positive(body[key])) add('token_limits', 'token_limit_invalid');
  if (messages) {
    if (present(body, 'temperature') && (typeof body.temperature !== 'number' ||
        body.temperature < 0 || body.temperature > 1)) add('unknown_fields', 'sampling_altered');
    if (present(body, 'stop') && !(typeof body.stop === 'string' ||
        Array.isArray(body.stop) && body.stop.every(value => typeof value === 'string'))) {
      add('unknown_fields', 'sampling_altered');
    }
    if (present(body, 'user') && !nonempty(body.user)) add('unknown_fields', 'condition_unverified', false);
  }
  for (const key of ['temperature', 'top_p']) {
    if (present(body, key) && (typeof body[key] !== 'number' || !Number.isFinite(body[key]))) {
      add('unknown_fields', 'condition_unverified', false);
    }
  }
  if (present(body, 'stream')) {
    use('streaming');
    if (typeof body.stream !== 'boolean') add('streaming', 'condition_unverified', false);
  }
  if (present(body, 'stream_options')) {
    use('transport_fields');
    if (!only(body.stream_options, ['include_usage']) ||
        (present(body.stream_options || {}, 'include_usage') && typeof body.stream_options.include_usage !== 'boolean')) {
      add('transport_fields', 'stream_options_invalid');
    }
  }
  if (responses && present(body, 'reasoning')) {
    use('reasoning_fields');
    if (!only(body.reasoning, ['effort']) ||
        (body.reasoning.effort !== undefined && typeof body.reasoning.effort !== 'string')) {
      add('reasoning_fields', 'reasoning_unsupported');
    }
  }
  if (!responses && present(body, 'reasoning_effort')) {
    use('reasoning_fields');
    if (messages || typeof body.reasoning_effort !== 'string') add('reasoning_fields', 'reasoning_unsupported');
  }
  const topKeys = responses
    ? ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning',
      'max_output_tokens', 'stream', 'temperature', 'top_p', 'text', 'service_tier', 'store',
      'metadata', 'truncation', 'previous_response_id', 'include', 'prompt_cache_key']
    : ['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort',
      'max_tokens', 'max_completion_tokens', 'stream', 'stream_options', 'temperature', 'top_p',
      'response_format', 'service_tier', 'n', ...(messages ? ['stop', 'user', 'logprobs'] : [])];
  for (const key of Object.keys(body)) {
    if (!topKeys.includes(key)) {
      const ignoredNull = messages && (body[key] === null || body[key] === undefined);
      add(featureFor(key), ignoredNull ? 'condition_unverified' : 'translator_rejected', !ignoredNull);
    }
  }
  if (responses) {
    if (body.instructions !== undefined && typeof body.instructions !== 'string') add('message_roles', 'condition_unverified', false);
    for (const key of ['metadata', 'truncation', 'previous_response_id', 'include', 'prompt_cache_key']) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== false) {
        add(featureFor(key), 'stateful_unsupported');
      }
    }
    if (present(body, 'store') && body.store !== false) add('stateful_fields', 'stateful_unsupported');
  }
  if (present(body, 'n') && body.n !== 1) add('transport_fields', 'translator_rejected');
  if (messages && present(body, 'logprobs') && body.logprobs !== false) add('transport_fields', 'translator_rejected');
}

/**
 * Assess only automatic attempts. Native capability/availability is not proven
 * by passthrough, and unknown future return payloads remain unobserved.
 * No request content, arbitrary field names or deployment URLs leave this call.
 */
function assessRequestCompatibility({ body, source, target, candidate = {}, pins = {}, reasoning = null,
  requiredResponseFeatures = [], nativePassthrough = false } = {}) {
  const reasons = [];
  const features = new Set();
  const contracts = [];
  let status = 'compatible';
  const add = (feature, code, incompatible = true) => {
    features.add(feature);
    if (reasons.length < FEATURES.length && !reasons.some(reason => reason.feature === feature && reason.code === code)) {
      reasons.push({ feature, code });
    }
    if (incompatible) status = 'incompatible';
    else if (status === 'compatible') status = 'unverified';
  };
  const use = feature => features.add(feature);
  let parsed = body;
  if (Buffer.isBuffer(body)) {
    if (body.length > 10 * 1024 * 1024) {
      parsed = null;
      add('unknown_fields', 'assessment_limit', false);
    }
    else {
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { parsed = null; }
    }
  }
  const inspectable = object(parsed) && bounded(parsed);
  if (!object(parsed)) add('unknown_fields', 'request_shape_unverified', false);
  else if (!inspectable) add('unknown_fields', 'assessment_limit', false);
  if (!Array.isArray(requiredResponseFeatures) || requiredResponseFeatures.length > FEATURES.length) {
    add('unknown_fields', 'assessment_limit', false);
    requiredResponseFeatures = [];
  }
  if (requiredResponseFeatures.some(feature => !FEATURES.includes(feature))) {
    add('unknown_fields', 'unknown_required_feature', false);
  }
  let reasoningSummary = null;
  if (inspectable && reasoning) {
    const effort = source === 'responses' ? parsed.reasoning?.effort : source === 'anthropic_messages'
      ? parsed.output_config?.effort : parsed.reasoning_effort;
    const assessed = assessReasoningEffort(reasoning, effort, { automatic: effort !== undefined });
    const code = assessed.reasons[0].code;
    reasoningSummary = { support: reasoning.support, mode: reasoning.mode, code };
    if (!assessed.admitted) add('reasoning_fields', code,
      !['reasoning_automatic_requires_known_support', 'reasoning_future_effort_not_selectable'].includes(code));
  } else if (inspectable && (parsed.reasoning_effort !== undefined ||
      parsed.reasoning?.effort !== undefined || parsed.output_config?.effort !== undefined)) {
    add('reasoning_fields', 'reasoning_automatic_requires_known_support', false);
  }
  const passthrough = nativePassthrough === true && source === null && target === null;
  if ((!PROTOCOLS.has(source) || !PROTOCOLS.has(target)) && !passthrough) {
    add('unknown_fields', 'direction_unimplemented', false);
  }
  else if (source !== target && inspectable) {
    const steps = source === 'responses' && target === 'anthropic_messages'
      ? [['responses', 'chat_completions'], ['chat_completions', 'anthropic_messages']]
      : [[source, target]];
    let current = parsed;
    for (const [from, to] of steps) {
      const request = CONTRACTS.find(contract => contract.source === from && contract.target === to && contract.direction === 'request');
      const response = CONTRACTS.find(contract => contract.source === to && contract.target === from && contract.direction === 'return_response');
      if (!request || !response) { add('unknown_fields', 'direction_unimplemented'); break; }
      contracts.push(request, response);
      if (!implementationsMatch) { add('unknown_fields', 'implementation_drift', false); break; }
      checkRequest(current, request, add, use);
      try { current = TRANSLATORS[request.id](current); }
      catch { add('unknown_fields', 'translator_rejected'); break; }
      // Evaluate only pre-dispatch return requirements; event shape, terminal
      // content and counters cannot be verified until the provider responds.
      const required = ['message_text', 'finish_reasons', ...requiredResponseFeatures,
        ...(current.stream === true ? ['streaming'] : [])];
      for (const feature of required) {
        if (!FEATURES.includes(feature)) { add('unknown_fields', 'unknown_required_feature', false); continue; }
        const row = response.features.find(row => row.feature === feature);
        if (!row || ['unknown', 'rejected'].includes(row.status)) add(feature, 'response_requirement_unverified', false);
      }
      if (requiredResponseFeatures.includes('usage') && current.stream === true &&
          from === 'chat_completions' && to === 'responses' && parsed.stream_options?.include_usage !== true) {
        add('usage', 'response_usage_unavailable');
      }
    }
  }
  return freeze({
    status, reasons, features: [...features],
    source: PROTOCOLS.has(source) ? source : null, target: PROTOCOLS.has(target) ? target : null,
    revision: REVISION, assessmentRevision: ASSESSMENT_REVISION,
    contracts: contracts.map(({ id, revision, implementation }) => ({ id, revision, implementation: { ...implementation } })),
    candidate: { provider: candidate.provider, model: candidate.model },
    pins: { eligibilityRevision: pins.eligibilityRevision ?? null, catalogueRevision: pins.catalogueRevision ?? null },
    reasoning: reasoningSummary, returnConditions: source === target ? 'not_applicable' : 'provider_response_unobserved',
  });
}

module.exports = { ASSESSMENT_REVISION, REASON_CODES, assessRequestCompatibility };
