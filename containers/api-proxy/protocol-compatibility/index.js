'use strict';

/**
 * Feature-level evidence, not a whole-request validator or model capability list.
 * Conditions must be checked by a future consumer before using conditional rows.
 * Never infer a reverse request direction from a return-response contract.
 */
const REVISION = 'awf-directed-protocol-v1';
const FEATURES = Object.freeze([
  'message_text', 'message_roles', 'function_tools', 'hosted_tools', 'tool_choice',
  'parallel_tool_calls', 'structured_output', 'image_input', 'audio',
  'other_modalities', 'streaming', 'usage', 'stateful_fields', 'reasoning_fields',
  'reasoning_content', 'cache_controls', 'token_limits', 'transport_fields',
  'finish_reasons', 'refusal', 'unknown_fields',
]);

const IMPLEMENTATIONS = Object.freeze({
  wire: Object.freeze({
    file: 'wire-api-compat.js',
    sha256: '99195a2687352cbb4c65aaa1c31b7f630f71ed1d0a3647638092e3a1e5676125',
  }),
  anthropic: Object.freeze({
    file: 'anthropic-chat-compat.js',
    sha256: '47e879c966fca727e6a483649366a60f77e354adbeeede11b3c0c8b6853c0f2b',
  }),
});

function conditional(conditions, normalizations, reason) {
  return { status: 'conditional', conditions, normalizations, reason };
}

function supported(reason) {
  return { status: 'supported', conditions: [], normalizations: [], reason };
}

function rejected(reason, rejectionCode) {
  return { status: 'rejected', conditions: [], normalizations: [], reason, rejectionCode };
}

const wireReject = reason => rejected(reason, 'unsupported_wire_api_feature');
const anthropicReject = reason => rejected(reason, 'unsupported_protocol_feature');
const wireRequests = {
  message_text: supported('String text is retained; this does not cover arbitrary content objects.'),
  function_tools: conditional(
    ['Function definitions and calls use known fields, nonempty names and call identifiers.'],
    ['Function tool nesting changes; call IDs are retained; non-string results are JSON encoded.'],
    'Function schemas and strict flags are forwarded, not validated against a backend.'),
  hosted_tools: wireReject('Non-function tool types cannot be translated.'),
  tool_choice: conditional(
    ['Choice is auto, none, required, or a named function choice without extra fields.'],
    ['Named function choice nesting changes.'],
    'Known function choices are representable; arbitrary choice objects are not characterized.'),
  parallel_tool_calls: supported('The parallel_tool_calls boolean is forwarded without changing it.'),
  structured_output: conditional(
    ['Format is json_object or json_schema with name, schema and optional strict only.'],
    ['JSON schema format nesting changes.'],
    'Schema and strict are forwarded; schema validity and model enforcement are not established.'),
  image_input: conditional(
    ['Image parts have a URL and optional detail, with no additional semantic fields.'],
    ['image_url and input_image representations change; URL and detail are retained.'],
    'Only URL image input is characterized, not image output or backend image support.'),
  audio: wireReject('Audio request fields and audio content parts have no mapping.'),
  other_modalities: wireReject('Non-text/non-image request content types have no mapping.'),
  streaming: supported('The stream boolean is forwarded; return-stream behavior has a separate contract.'),
  stateful_fields: wireReject('Stateful requests, storage and nonempty response metadata/include/truncation cannot be represented.'),
  reasoning_fields: conditional(
    ['Only the opaque effort field is present; Responses reasoning has no summary or encrypted content.'],
    ['reasoning.effort and reasoning_effort change nesting without changing the value.'],
    'No model-specific effort support, default or reasoning decision is inferred.'),
  reasoning_content: wireReject('Reasoning content items cannot be represented in translated requests.'),
  token_limits: conditional(
    ['Limits are positive integer values supplied by the caller.'],
    ['Chat max_completion_tokens takes precedence over max_tokens; wire limit names change.'],
    'Wire translation does not validate limit ranges or insert a limit.'),
  unknown_fields: wireReject('Unknown top-level request fields are rejected, including null or false values.'),
};

const wireReturns = {
  message_text: supported('Known text output is retained in an assistant message.'),
  function_tools: conditional(
    ['Only function calls with names, identifiers and string arguments are present.'],
    ['Function call nesting changes; IDs and argument strings are retained.'],
    'Other output item kinds and arbitrary nested fields are not covered.'),
  streaming: conditional(
    ['Recognized SSE frames are well formed and include an explicit completion trigger.',
      'Chat uses choice deltas plus terminal usage-only/DONE; Responses uses created/in_progress, text/refusal/function deltas and completed/failed/error, not response.incomplete.'],
    ['Frames are buffered across UTF-8 chunks; tool arguments are assembled or emitted as deltas.'],
    'EOF alone does not complete a response; errors are forwarded without synthetic success.'),
  usage: conditional(
    ['Known token counters are nonnegative and total_tokens, when provided, is coherent.',
      'Responses-to-Chat SSE requires includeUsage=true; Chat-to-Responses SSE requires a terminal usage-only chunk before DONE.'],
    ['Input/output names change; cached and reasoning token details are retained.'],
    'Missing counters default to zero; this is usage adaptation, not pricing or accounting-family compatibility.'),
  finish_reasons: conditional(
    ['One choice/output sequence uses the characterized stop, tool_calls, length or content_filter outcomes.'],
    ['Length/content_filter become incomplete status; return Chat tool calls take precedence over incomplete status.'],
    'Unknown finish reasons and additional choices are not claimed faithful.'),
  refusal: conditional(
    ['JSON contains at most one refusal string/part; SSE uses recognized refusal deltas.'],
    ['Refusal changes between a Chat field and a Responses content part.'],
    'Known refusal text is retained; arbitrary refusal metadata is not covered.'),
};

const anthropicRequests = {
  message_text: conditional(
    ['Content consists of strings or known text parts; null/empty content is allowed.'],
    ['Text becomes blocks; empty messages are omitted.'],
    'Text values are retained, but turn boundaries can change.'),
  message_roles: conditional(
    ['Only system, developer, user, assistant and tool roles with known fields are used.'],
    ['System/developer text is joined with two newlines; consecutive same-role turns merge; tool results become user blocks.'],
    'Role priority and turn boundaries are not preserved losslessly.'),
  function_tools: conditional(
    ['Known function fields, IDs and object-valued JSON arguments are used; no extra semantic fields.'],
    ['Arguments are parsed as JSON objects; missing arguments become {}; missing schema becomes an empty object schema.'],
    'Strict function flags are forwarded, not a claim of native structured-output enforcement.'),
  hosted_tools: anthropicReject('Non-function tool definitions have no mapping.'),
  tool_choice: conditional(
    ['Choices are auto, none, required or a named function; required/named choices require nonempty tools.'],
    ['required becomes any; named function becomes tool; auto/none without tools are omitted.'],
    'Other choices are rejected.'),
  parallel_tool_calls: conditional(
    ['Value is boolean; false with tools and a choice other than none disables parallel tool use.'],
    ['false adds disable_parallel_tool_use; true leaves the upstream default in place.'],
    'Explicit parallel enablement is not guaranteed; none does not gain a disable flag.'),
  structured_output: anthropicReject('json_schema/json_object response_format has no request mapping; text format is a no-op.'),
  image_input: conditional(
    ['Image URL is HTTPS or a base64 data URL; no detail, cache control or additional semantic fields.'],
    ['URL images become source.url; base64 images split media type and data.'],
    'Image detail is otherwise discarded by the existing translator, not preserved.'),
  audio: anthropicReject('Audio fields and audio content parts have no mapping.'),
  other_modalities: anthropicReject('Non-text/non-image content parts have no mapping.'),
  streaming: conditional(
    ['stream is boolean.'],
    ['Only true is emitted; false is omitted.'],
    'Streaming intent is mapped; return SSE has its own contract.'),
  stateful_fields: anthropicReject('Non-null previous_response_id/store requests have no mapping.'),
  reasoning_fields: anthropicReject('Non-null reasoning_effort/reasoning request fields have no mapping.'),
  reasoning_content: anthropicReject('Reasoning content parts cannot be translated.'),
  token_limits: conditional(
    ['Caller accepts the required Messages limit and supplies a positive integer if overriding it.'],
    ['max_completion_tokens takes precedence; missing, nonpositive or noninteger limits become 8192.'],
    'Default insertion changes an unspecified/invalid Chat limit; it is not transport-only.'),
  transport_fields: conditional(
    ['Only stream_options.include_usage, n=1, logprobs=false and response_format.type=text are used.'],
    ['stream_options is dropped; n=1, logprobs=false and text format are no-ops.'],
    'Return usage must be requested separately on the SSE adapter; unknown stream options are not characterized.'),
  unknown_fields: {
    ...anthropicReject('Non-null unknown top-level fields are rejected; nested-field acceptance does not establish compatibility.'),
    conditions: ['The unmapped top-level field has a non-null value.'],
    normalizations: ['Unmapped null/undefined values are skipped, not declared supported.'],
  },
};

const anthropicReturns = {
  message_text: supported('Known text blocks concatenate into assistant text.'),
  function_tools: conditional(
    ['Output contains known tool_use blocks with IDs, names and object inputs.',
      'SSE initial tool_use.input is empty; arguments are supplied through subsequent input_json_delta frames.'],
    ['Tool input objects become JSON argument strings; SSE arguments arrive as partial_json deltas.'],
    'Initial SSE tool_use.input is not emitted; nonempty initial input is an uncharacterized gap.'),
  streaming: conditional(
    ['Recognized frames include message_stop; tool starts precede argument deltas.'],
    ['UTF-8 frames are buffered; message_stop emits finish and DONE; errors do not emit success.'],
    'EOF does not synthesize completion; unknown or malformed JSON frames are ignored.'),
  usage: conditional(
    ['Known counters are nonnegative; SSE includeUsage is explicitly enabled when needed.'],
    ['Cache reads and writes join input_tokens in prompt_tokens; cached_tokens reports reads only.'],
    'Missing counters default to zero; cache-write detail is not separately representable in Chat usage.'),
  finish_reasons: conditional(
    ['Stop reason is end_turn, stop_sequence, tool_use, max_tokens, model_context_window_exceeded or refusal.'],
    ['tool_use becomes tool_calls; token/context limits become length; refusal becomes content_filter; other known stops become stop.'],
    'Unknown stop reasons default to stop and are not claimed faithful.'),
};

function contract(id, source, target, direction, implementation, entryPoints, specifications) {
  const features = FEATURES.map(feature => {
    const spec = specifications[feature] || {
      status: 'unknown', conditions: [], normalizations: [],
      reason: 'This feature has not been characterized for this direction.',
    };
    return Object.freeze({
      feature, ...spec,
      conditions: Object.freeze(spec.conditions),
      normalizations: Object.freeze(spec.normalizations),
    });
  });
  return Object.freeze({
    id, source, target, direction, revision: REVISION, implementation,
    entryPoints: Object.freeze(entryPoints), features: Object.freeze(features),
  });
}

const CONTRACTS = Object.freeze([
  contract('chat-to-responses-request', 'chat_completions', 'responses', 'request',
    IMPLEMENTATIONS.wire, ['translateChatRequest'], {
      ...wireRequests,
      message_roles: conditional(
        ['Known Chat roles; system/developer content is string-only.'],
        ['System/developer messages become joined instructions; priority and placement are collapsed.'],
        'Role collapse is a semantic alteration, not lossless transport normalization.'),
      transport_fields: conditional(
        ['n is omitted or 1; stream_options contains only boolean include_usage.'],
        ['n=1 and stream_options are omitted from the translated request.'],
        'The outer wire adapter retains include_usage for the return path.'),
    }),
  contract('responses-to-chat-request', 'responses', 'chat_completions', 'request',
    IMPLEMENTATIONS.wire, ['translateResponsesRequest'], {
      ...wireRequests,
      message_roles: conditional(
        ['Known Responses message roles; instructions is a string.'],
        ['Instructions prepend a system message; missing role defaults to user; item id/status are omitted.'],
        'Item IDs/status are transport metadata; function call_id remains semantic and is retained.'),
      transport_fields: conditional(
        ['store is false/absent; stateful metadata/include/truncation/cache key are absent, null or false.'],
        ['No-op fields are omitted; stream=true inserts stream_options.include_usage=true.'],
        'Nonempty stateful fields and store=true are rejected.'),
    }),
  contract('chat-to-messages-request', 'chat_completions', 'anthropic_messages', 'request',
    IMPLEMENTATIONS.anthropic, ['chatRequestToAnthropic'], anthropicRequests),
  contract('chat-to-responses-return', 'chat_completions', 'responses', 'return_response',
    IMPLEMENTATIONS.wire, ['transformWireApiResponseBody', 'createWireApiSseTransform'], wireReturns),
  contract('responses-to-chat-return', 'responses', 'chat_completions', 'return_response',
    IMPLEMENTATIONS.wire, ['transformWireApiResponseBody', 'createWireApiSseTransform'], wireReturns),
  contract('messages-to-chat-return', 'anthropic_messages', 'chat_completions', 'return_response',
    IMPLEMENTATIONS.anthropic,
    ['anthropicResponseToChat', 'anthropicUsageToChat', 'createAnthropicToChatSseTransform'], anthropicReturns),
]);

function assessFeature(query = {}) {
  const { source, target, direction, feature } = query || {};
  const match = CONTRACTS.find(candidate =>
    candidate.source === source && candidate.target === target && candidate.direction === direction);
  const evidence = match?.features.find(candidate => candidate.feature === feature);
  return Object.freeze({
    revision: REVISION,
    status: evidence?.status || 'unknown',
    reason: evidence?.reason || (match
      ? 'This feature has not been characterized.'
      : 'No directed translation contract is implemented for this pair.'),
    contract: evidence ? match : null,
    evidence: evidence || null,
  });
}

module.exports = { REVISION, FEATURES, CONTRACTS, assessFeature };
