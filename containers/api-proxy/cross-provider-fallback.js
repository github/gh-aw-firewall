'use strict';

/**
 * Cross-provider attempts for the ordered model fallback chain.
 *
 * A provider-qualified `AWF_FALLBACK_MODELS` entry (e.g. `openai/gpt-5.4` or
 * `anthropic/claude-sonnet-4.6`) whose provider differs from the listener that
 * received the request is served by that provider's adapter: its configured
 * endpoint, credentials, request signer, and body transforms (including
 * hosted-web domain policies). The request is translated into the target
 * provider's protocol when necessary, and the response is translated back so
 * the agent keeps speaking its original protocol over its live session.
 *
 * Supported agent-facing protocols and targets:
 *
 *   agent protocol      openai    copilot                     anthropic
 *   ─────────────────   ───────   ─────────────────────────   ─────────────────────
 *   chat/completions    native    native (+ wire-API compat)  translated
 *   responses           native    native (+ wire-API compat)  translated (via chat)
 *   messages            —         native (/v1/messages)       native
 */

const { parseBodyAsObject } = require('./body-utils');
const { buildUpstreamPath } = require('./proxy-utils');
const { buildRequestHeaders } = require('./request-headers');
const {
  translateCopilotWireApi,
  translateResponsesRequest,
  transformWireApiResponseBody,
  createWireApiSseTransform,
} = require('./wire-api-compat');
const {
  chatRequestToAnthropic,
  anthropicResponseToChat,
  createAnthropicToChatSseTransform,
} = require('./anthropic-chat-compat');

const ANTHROPIC_VERSION = '2023-06-01';

/** Agent protocol → upstream endpoint per target provider. */
const TARGET_ENDPOINTS = Object.freeze({
  openai: Object.freeze({ chat: '/chat/completions', responses: '/responses' }),
  copilot: Object.freeze({ chat: '/chat/completions', responses: '/responses', messages: '/v1/messages' }),
  anthropic: Object.freeze({ chat: '/v1/messages', responses: '/v1/messages', messages: '/v1/messages' }),
});

/** Providers that can serve a cross-provider fallback attempt. */
const CROSS_PROVIDER_TARGETS = Object.freeze(Object.keys(TARGET_ENDPOINTS));

/**
 * Client headers that identify the originating provider/client integration
 * and must not leak to a different upstream provider.
 */
const PROVIDER_SPECIFIC_HEADER_PATTERN = /^(?:copilot-|editor-|openai-|x-github-|vscode-|x-vscode-)/i;
const PROVIDER_SPECIFIC_HEADERS = new Set([
  'x-initiator', 'x-interaction-id', 'x-request-id', 'api-key', 'content-length', 'transfer-encoding',
]);

/**
 * Identify the agent-facing protocol of a request path.
 *
 * @param {string} path
 * @returns {'chat'|'responses'|'messages'|null}
 */
function protocolForPath(path) {
  if (typeof path !== 'string') return null;
  const pathname = path.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  if (pathname.endsWith('/chat/completions')) return 'chat';
  if (pathname.endsWith('/responses')) return 'responses';
  if (pathname.endsWith('/messages')) return 'messages';
  return null;
}

/**
 * Explain why a cross-provider candidate cannot be routed, or return null when
 * it can.
 *
 * @param {{ protocol: string|null, targetProvider: string, adapter: object|null|undefined }} params
 * @returns {string|null}
 */
function getCrossProviderRejection({ protocol, targetProvider, adapter }) {
  const endpoints = TARGET_ENDPOINTS[targetProvider];
  if (!endpoints) return 'provider_unsupported';
  if (!protocol || !endpoints[protocol]) return 'protocol_unsupported';
  let enabled = false;
  try {
    enabled = !!adapter && adapter.isEnabled() === true;
  } catch {
    enabled = false;
  }
  return enabled ? null : 'provider_not_configured';
}

function filterHeadersForTarget(headers, targetProtocolIsMessages) {
  const filtered = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (PROVIDER_SPECIFIC_HEADERS.has(lower) || PROVIDER_SPECIFIC_HEADER_PATTERN.test(lower)) continue;
    if (!targetProtocolIsMessages && lower.startsWith('anthropic-')) continue;
    filtered[name] = value;
  }
  return filtered;
}

async function applyTargetBodyTransform(adapter, body, transformReq) {
  const transform = typeof adapter.getBodyTransform === 'function' ? adapter.getBodyTransform() : null;
  if (typeof transform !== 'function') return body;
  const transformed = await transform(body, transformReq);
  return Buffer.isBuffer(transformed) ? transformed : body;
}

/**
 * Pin the request model to the configured fallback candidate. Target-side
 * alias resolution must never substitute an unconfigured alternative.
 *
 * @returns {{ body: Buffer, substituted: string|null }}
 */
function pinModel(body, model) {
  const parsed = parseBodyAsObject(body);
  if (!parsed) throw new Error('Fallback request body is not a JSON object');
  if (parsed.model === model) return { body, substituted: null };
  const substituted = typeof parsed.model === 'string' ? parsed.model : null;
  parsed.model = model;
  return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), substituted };
}

/**
 * Build the upstream request for a cross-provider fallback attempt.
 *
 * @param {object} params
 * @param {Buffer} params.sourceBody - Agent-facing request body (origin protocol)
 * @param {'chat'|'responses'|'messages'} params.protocol - Agent-facing protocol
 * @param {string} params.originProvider
 * @param {string} params.targetProvider
 * @param {string} params.model - Configured candidate model (provider prefix removed)
 * @param {object} params.adapter - Target provider adapter
 * @param {import('http').IncomingMessage} params.req - Agent request
 * @param {string} params.requestId
 * @param {boolean} [params.codexCompatibility] - Whether a Codex response transform will run
 * @returns {Promise<{
 *   body: Buffer, headers: object, targetHost: string, upstreamPath: string,
 *   requestSigner: Function|null, targetScheme: string,
 *   wireApiCompatibility: object|null, wireApiSourceBody: Buffer|null,
 *   protocolTranslation: object, substitutedModel: string|null,
 * }>}
 * @throws When the request cannot be translated faithfully
 */
async function buildCrossProviderRequest({
  sourceBody, protocol, originProvider, targetProvider, model, adapter, req, requestId,
  codexCompatibility = false,
}) {
  const endpoint = TARGET_ENDPOINTS[targetProvider]?.[protocol];
  if (!endpoint) throw new Error(`Provider ${targetProvider} cannot serve ${protocol} requests`);
  const parsed = parseBodyAsObject(sourceBody);
  if (!parsed) throw new Error('Request body is not a JSON object');
  parsed.model = model;

  const transformReq = {
    method: req.method,
    url: endpoint,
    headers: req.headers,
    awfRequestContext: req.awfRequestContext,
  };

  let body;
  let upstreamEndpoint = endpoint;
  let kind = 'passthrough';
  let includeUsage = false;
  let wireApiCompatibility = null;
  let wireApiSourceBody = null;
  let substitutedModel = null;

  if (targetProvider === 'anthropic' && protocol !== 'messages') {
    const chat = protocol === 'responses' ? translateResponsesRequest(parsed) : parsed;
    includeUsage = protocol === 'responses' || chat.stream_options?.include_usage === true;
    kind = protocol === 'responses' ? 'anthropic_to_responses' : 'anthropic_to_chat';
    body = Buffer.from(JSON.stringify(chatRequestToAnthropic(chat)), 'utf8');
    body = await applyTargetBodyTransform(adapter, body, transformReq);
    ({ body, substituted: substitutedModel } = pinModel(body, model));
  } else {
    body = Buffer.from(JSON.stringify(parsed), 'utf8');
    body = await applyTargetBodyTransform(adapter, body, transformReq);
    ({ body, substituted: substitutedModel } = pinModel(body, model));
    if (targetProvider === 'copilot' && protocol !== 'messages') {
      wireApiSourceBody = body;
      const translated = translateCopilotWireApi(body, endpoint);
      if (translated) {
        body = translated.body;
        wireApiCompatibility = translated.compatibility;
        upstreamEndpoint = translated.compatibility.upstreamEndpoint;
      }
    }
  }

  const targetHost = adapter.getTargetHost(req);
  const upstreamPath = buildUpstreamPath(upstreamEndpoint, targetHost, adapter.getBasePath(req) || '');
  const protocolTranslation = {
    kind,
    originProvider,
    targetProvider,
    protocol,
    includeUsage,
  };
  const needsIdentityEncoding = kind !== 'passthrough' || !!codexCompatibility ||
    (wireApiCompatibility && !wireApiCompatibility.passthrough);

  const filteredReq = { headers: filterHeadersForTarget(req.headers, endpoint.endsWith('/messages')) };
  const headers = buildRequestHeaders(body, -1, filteredReq, {
    injectHeaders: adapter.getAuthHeaders(req) || {},
    provider: targetProvider,
    targetHost,
    requestId,
    wireApiCompatibility: needsIdentityEncoding ? { passthrough: false } : null,
  });
  headers['content-type'] = 'application/json';
  if (targetProvider === 'anthropic' && !Object.keys(headers).some(h => h.toLowerCase() === 'anthropic-version')) {
    headers['anthropic-version'] = ANTHROPIC_VERSION;
  }

  return {
    body,
    headers,
    targetHost,
    upstreamPath,
    requestSigner: typeof adapter.getRequestSigner === 'function' ? adapter.getRequestSigner() : null,
    targetScheme: typeof adapter.getTargetScheme === 'function' ? adapter.getTargetScheme(req) : 'https',
    wireApiCompatibility,
    wireApiSourceBody,
    protocolTranslation,
    substitutedModel,
  };
}

/**
 * Whether a cross-provider attempt needs its 2xx response rewritten.
 *
 * @param {object|null} protocolTranslation
 * @returns {boolean}
 */
function needsResponseTranslation(protocolTranslation) {
  return !!protocolTranslation && protocolTranslation.kind !== 'passthrough';
}

/**
 * Translate a non-streaming 2xx response back into the agent-facing protocol.
 *
 * @param {Buffer} body
 * @param {object|null} protocolTranslation
 * @returns {Buffer|null}
 */
function transformProtocolResponseBody(body, protocolTranslation) {
  if (!needsResponseTranslation(protocolTranslation)) return null;
  const chat = anthropicResponseToChat(body);
  if (!chat || protocolTranslation.kind === 'anthropic_to_chat') return chat;
  return transformWireApiResponseBody(chat, { direction: 'responses_to_chat' });
}

/**
 * Create the SSE transforms that translate a streaming 2xx response back into
 * the agent-facing protocol (applied in order).
 *
 * @param {object|null} protocolTranslation
 * @returns {import('stream').Transform[]}
 */
function createProtocolSseTransforms(protocolTranslation) {
  if (!needsResponseTranslation(protocolTranslation)) return [];
  const transforms = [createAnthropicToChatSseTransform({ includeUsage: protocolTranslation.includeUsage })];
  if (protocolTranslation.kind === 'anthropic_to_responses') {
    transforms.push(createWireApiSseTransform({ direction: 'responses_to_chat' }));
  }
  return transforms;
}

module.exports = {
  ANTHROPIC_VERSION,
  CROSS_PROVIDER_TARGETS,
  TARGET_ENDPOINTS,
  protocolForPath,
  getCrossProviderRejection,
  buildCrossProviderRequest,
  needsResponseTranslation,
  transformProtocolResponseBody,
  createProtocolSseTransforms,
  _testing: { filterHeadersForTarget, pinModel },
};
