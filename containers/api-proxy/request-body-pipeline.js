'use strict';

/**
 * AWF API Proxy — Ordered request body transformations.
 */

const {
  sanitizeNullToolCallTypes,
  injectStreamOptions,
} = require('./body-transform');
const { logRequest } = require('./logging');
const { injectRequestSteering } = require('./steering-injection');
const { translateCodexCustomToolsForCopilot } = require('./codex-compat');
const { endpointForPath, translateCopilotWireApi } = require('./wire-api-compat');
const { stripRedundantModelPrefixInBody } = require('./model-body-rewriter');
const { parseBodyAsObject } = require('./body-utils');
const { recoverRequestModel, protocolForUrl } = require('./model-recovery');
const { getFallbackUpstreamEndpoint, getRequiredResponseFeatures } = require('./cross-provider-fallback');
const { assessRequestCompatibility } = require('./protocol-compatibility/assessment');
const { getRequestReasoning } = require('./model-reasoning');
const { evaluateModelEligibility } = require('./model-eligibility');
const { getCurrentGuardChecks } = require('./proxy-guards');

/**
 * True when the request targets an OpenAI Chat Completions route
 * (e.g. /chat/completions, /v1/chat/completions), ignoring query strings,
 * fragments, and trailing slashes.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
function isChatCompletionsRequest(url) {
  if (typeof url !== 'string') return false;
  const path = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return path.endsWith('/chat/completions');
}

function normalizeModelPrefix(context) {
  const { body, provider, req, isWritableMethod } = context;
  // Normalize redundant provider prefixes even without AWF_MODEL_ALIASES.
  // model-resolver.js also uses stripRedundantProviderPrefix from model-utils.js;
  // keep this unconditional normalization in sync with alias resolution.
  if (isWritableMethod) {
    const requestedModel = parseBodyAsObject(body)?.model;
    if (typeof requestedModel === 'string') req.awfRequestedModelSelector = requestedModel;
    const prefixStripped = stripRedundantModelPrefixInBody(body, provider);
    if (prefixStripped) context.body = prefixStripped;
  }
}

function applyCallerTransform(context) {
  const { body, provider, req, requestId, bodyTransform, isWritableMethod } = context;
  if (bodyTransform && isWritableMethod) {
    return Promise.resolve(bodyTransform(body, req)).then(transformed => {
      // Body transforms must honour the `Buffer | null` contract. A non-Buffer
      // result would otherwise yield an invalid Content-Length and an empty
      // upstream request, so ignore it and keep the untransformed body.
      if (transformed !== null) {
        if (Buffer.isBuffer(transformed)) {
          context.body = transformed;
        } else {
          logRequest('warn', 'request_transform_ignored', {
            request_id: requestId,
            provider,
            reason: 'body_transform_returned_non_buffer',
          });
        }
      }
    });
  }
}

function translateCodexTools(context) {
  const { body, provider, req, isWritableMethod } = context;
  // Codex Responses custom/freeform tools need Copilot's function-tool dialect.
  // Keep compatibility metadata explicit for retries; Chat uses another shape.
  if (provider === 'copilot' && isWritableMethod && !isChatCompletionsRequest(req.url)) {
    const translated = translateCodexCustomToolsForCopilot(body);
    if (translated) {
      context.body = translated.body;
      context.codexCompatibility = translated.compatibility;
    }
  }
}

function recoverModel(context) {
  const { body, provider, req, requestId, isWritableMethod } = context;
  if (isWritableMethod) {
    const recovered = recoverRequestModel(body, provider, req, requestId, logRequest);
    if (recovered) context.body = recovered;
  }
}

function sanitizeToolCalls(context) {
  const { body, provider, requestId, isWritableMethod } = context;
  if (isWritableMethod) {
    const sanitized = sanitizeNullToolCallTypes(body);
    if (sanitized) {
      context.body = sanitized.body;
      logRequest('info', 'request_sanitized', {
        request_id: requestId,
        provider,
        normalized_tool_calls: sanitized.normalizedCount,
        dropped_tool_calls: sanitized.droppedCount,
      });
    }
  }
}

function injectSteering(context) {
  const { body, provider, req, requestId } = context;
  const steered = injectRequestSteering(body, provider, req, requestId);
  context.body = steered.body;
  context.steering = steered.steering;
}

function addStreamOptions(context) {
  const { body, provider, req } = context;
  if (req.method === 'POST') {
    const streamOpts = injectStreamOptions(body, provider, req.url);
    if (streamOpts) context.body = streamOpts.body;
  }
}

function preserveFallbackSource(context) {
  // Preserve the agent-facing representation after explicitly authorized
  // normalization, before any wire translation. Fallback must assess this
  // request rather than a body whose translator has already discarded fields.
  if (context.isWritableMethod) context.req.awfFallbackSourceBody = Buffer.from(context.body);
}

function selectResolverFallback(context) {
  const { provider, req, isWritableMethod } = context;
  if (!isWritableMethod || req.awfResolverFallback?.provider !== provider || req.awfRecoveryAttempts) return null;
  if (getCurrentGuardChecks(null, provider).some(guard => guard.isBlocked(guard.block))) return null;
  const parsed = parseBodyAsObject(req.awfFallbackSourceBody);
  const protocol = value => {
    const name = protocolForUrl(value);
    return name === 'chat-completions' ? 'chat_completions'
      : name === 'messages' ? 'anthropic_messages' : name;
  };
  const source = protocol(req.url);
  const pins = { eligibilityRevision: req.awfEligibility?.revision, catalogueRevision: req.awfCatalogue?.revision };
  const requiredResponseFeatures = getRequiredResponseFeatures(req.awfFallbackSourceBody, protocolForUrl(req.url));
  const publish = (model, outcome, compatibility, reasoning) => {
    try {
      req.awfObserveModelDecision?.({
        provider, model: outcome === 'exhausted' ? null : model,
        endpoint: source === 'anthropic_messages' ? '/v1/messages' : endpointForPath(req.url),
        originProvider: provider, originModel: req.awfResolverFallback.fromModel,
        outcome, compatibility, reasoning, ...pins,
        reason: outcome === 'exhausted' ? 'fallback_exhausted' : `fallback_${compatibility.status}`,
      });
    } catch {
      // Optional observation must not change request admission.
    }
  };
  const ranked = req.awfModelRecoveryDisabled || req.awfScopedAuto ||
      req.awfRequestContext?.purpose === 'routing_classification' ? []
    : Array.isArray(req.awfModelCandidates) ? req.awfModelCandidates
      : req.awfResolverFallback.candidates || [];
  const candidates = [...new Set([parsed?.model, ...ranked])]
    .filter(model => typeof model === 'string' && model.length > 0);
  let lastCompatibility = null;
  let lastReasoning = null;
  for (const model of candidates) {
    let eligibility = null;
    try {
      eligibility = evaluateModelEligibility(model, provider, req, { inputMode: 'native' });
    } catch { /* fail closed */ }
    if (eligibility?.admitted !== true) {
      lastCompatibility = assessRequestCompatibility({
        body: req.awfFallbackSourceBody, source, target: null, candidate: { provider, model: null }, pins,
      });
      lastReasoning = null;
      publish(null, 'skipped', lastCompatibility, null);
      continue;
    }
    const targetUrl = provider === 'copilot' && req.method === 'POST' && endpointForPath(req.url)
      ? getFallbackUpstreamEndpoint(provider, model, req.url, false, req.awfRuntimePricing) : req.url;
    const target = protocol(targetUrl);
    const reasoning = getRequestReasoning(model, provider, req.awfRuntimePricing, req, req.awfFallbackTarget || {});
    const compatibility = assessRequestCompatibility({
      body: req.awfFallbackSourceBody, source, target, candidate: { provider, model }, pins, reasoning,
      requiredResponseFeatures, nativePassthrough: ['gemini', 'vertex'].includes(provider) &&
        source === null && target === null && targetUrl === req.url &&
        /\/models\/[^/:?]+:(?:generateContent|streamGenerateContent)(?:\?|$)/.test(req.url),
    });
    lastCompatibility = compatibility;
    lastReasoning = reasoning;
    if (compatibility.status !== 'compatible') {
      publish(model, 'skipped', compatibility, reasoning);
      continue;
    }
    if (model !== parsed.model) {
      parsed.model = model;
      context.body = Buffer.from(JSON.stringify(parsed), 'utf8');
      req.awfFallbackSourceBody = Buffer.from(context.body);
      req.awfSelectedModelEligibility = Object.freeze({ model, provider, decision: eligibility });
      if (eligibility.identity) req.awfModelIdentity = eligibility.identity;
    }
    publish(model, 'accepted', compatibility, reasoning);
    context.resolverEndpoint = targetUrl;
    return;
  }
  publish(null, 'exhausted', lastCompatibility || assessRequestCompatibility({
    body: req.awfFallbackSourceBody, source, target: source, candidate: { provider, model: null }, pins,
  }), lastReasoning);
  const error = new Error('The selected automatic fallback cannot preserve the assessed request requirements');
  error.statusCode = 400;
  error.type = 'invalid_request_error';
  error.code = 'model_recovery_exhausted';
  throw error;
}

function translateWireApi(context) {
  const { body, provider, req, resolverEndpoint } = context;
  if (provider === 'copilot' && req.method === 'POST' && endpointForPath(req.url) &&
      !req.awfRecoveryAttempts) {
    context.wireApiSourceBody = Buffer.from(body);
    const translated = resolverEndpoint && endpointForPath(resolverEndpoint) === endpointForPath(req.url)
      ? null : translateCopilotWireApi(body, req.url, resolverEndpoint ? { upstreamEndpoint: endpointForPath(resolverEndpoint) } : {});
    if (translated) {
      context.body = translated.body;
      context.wireApiCompatibility = translated.compatibility;
      req.awfRouting?.onEndpointTranslation?.(context.wireApiCompatibility);
    }
  }
}

// Order is behavior: snapshots and compatibility checks must precede wire
// translation, and every transform must see the preceding transform's bytes.
const REQUEST_BODY_TRANSFORMS = Object.freeze([
  normalizeModelPrefix,
  applyCallerTransform,
  translateCodexTools,
  recoverModel,
  sanitizeToolCalls,
  injectSteering,
  addStreamOptions,
  preserveFallbackSource,
  selectResolverFallback,
  translateWireApi,
]);

/**
 * Apply the fixed transform pipeline to the raw inbound body.
 *
 * @param {Buffer} body
 * @param {string} provider
 * @param {import('http').IncomingMessage} req
 * @param {string} requestId
 * @param {((body: Buffer, req: object) => (Buffer | null | Promise<Buffer | null>)) | null} bodyTransform
 * @returns {Promise<{ body: Buffer, codexCompatibility: object|null, wireApiCompatibility: object|null, wireApiSourceBody: Buffer|null, steering: object|null }>}
 */
async function transformRequestBody(body, provider, req, requestId, bodyTransform) {
  const context = {
    body, provider, req, requestId, bodyTransform,
    isWritableMethod: req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH',
    codexCompatibility: null,
    wireApiCompatibility: null,
    wireApiSourceBody: null,
    steering: null,
    resolverEndpoint: null,
  };
  for (const transform of REQUEST_BODY_TRANSFORMS) {
    const pending = transform(context);
    // Only the caller transform is asynchronous; keep the other steps together.
    if (pending) await pending;
  }
  return {
    body: context.body,
    codexCompatibility: context.codexCompatibility,
    wireApiCompatibility: context.wireApiCompatibility,
    wireApiSourceBody: context.wireApiSourceBody,
    steering: context.steering,
  };
}

module.exports = { transformRequestBody };
