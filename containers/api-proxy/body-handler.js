'use strict';

const crypto = require('crypto');

/**
 * AWF API Proxy — Request body I/O and transformation.
 *
 * Responsibilities:
 *   1. collectRequestBody  — stream the inbound HTTP body, enforce the 10 MB
 *                            size limit, and surface 400/413 errors inline.
 *   2. transformRequestBody — apply the sequential body-transform pipeline
 *                             (caller transform → null-tool-call sanitisation →
 *                             steering injection → stream_options injection).
 *
 * Both functions are returned by `createBodyHandler(deps)` so that callers
 * (proxy-request.js) can inject `handleRequestError` and `otel` without
 * creating a circular-module dependency.
 *
 * The `_sleep` indirection (and its test setters) lives here because it is
 * the module most tightly coupled to async timing in the request pipeline.
 * proxy-request.js imports `sleep` from this module and uses it for the
 * model-not-supported retry backoff.
 */

const {
  sanitizeNullToolCallTypes,
  injectSteeringMessage,
  describeSteeringConversation,
  injectStreamOptions,
} = require('./body-transform');
const { sanitizeForLog, logRequest } = require('./logging');
const metrics = require('./metrics');
const {
  getPendingTimeoutSteeringWarning,
  hasCrossedTimeoutSteeringThreshold,
  claimTimeoutSteeringWarning,
} = require('./guards/timeout-steering');

const LOG_PSEUDONYM_KEY = crypto.randomBytes(32);

function pseudonymizeConversationForLog(shortConversation) {
  if (!shortConversation) return null;
  return crypto
    .createHmac('sha256', LOG_PSEUDONYM_KEY)
    .update(String(shortConversation))
    .digest('hex')
    .slice(0, 16);
}
const {
  getPendingAiCreditSteeringWarning,
  hasCrossedAiCreditSteeringThreshold,
  claimAiCreditSteeringWarning,
} = require('./guards/ai-credits-guard');
const { STORED_RESPONSE_CONVERSATION } = require('./guards/steering-thresholds');
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

/** Maximum request body size: 10 MB to prevent DoS via large payloads. */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/** When false, token-budget warnings are never injected into request bodies. */
const isSteeringEnabled = () => process.env.AWF_ENABLE_TOKEN_STEERING === 'true';

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

// ── Sleep abstraction (overridable in tests to avoid real setTimeout delays) ──

/** Resolves after `ms` milliseconds (overridable in tests via module-level setter). */
let _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Thin indirection used by proxy-request.js so that replacing `_sleep` via
 * `_setSleepForTests` is reflected in all callers without them needing to
 * re-import the variable.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => _sleep(ms);

/** @internal Test-only: replace the sleep implementation so retries are instant. */
function _setSleepForTests(fn) { _sleep = fn; }
/** @internal Test-only: restore the real sleep implementation. */
function _resetSleepForTests() { _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)); }

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the body-handler functions with injected dependencies.
 *
 * @param {{ handleRequestError: Function, otel: object }} deps
 * @returns {{ collectRequestBody: Function, transformRequestBody: Function }}
 */
function createBodyHandler({ handleRequestError, otel }) {
  /**
   * Collect the full request body from the inbound stream, enforcing the 10 MB
   * size limit. Sends a 413 response inline when the limit is exceeded, and
   * handles client stream errors with a 400 response.
   *
   * @param {import('http').IncomingMessage} req
   * @param {string} provider
   * @param {string} requestId
   * @param {import('http').ServerResponse} res
   * @param {object} span - OTEL span (or no-op shim)
   * @param {number} startTime - Request start timestamp (ms)
   * @param {string} targetHost - Upstream hostname (used in log fields)
   * @returns {Promise<Buffer|null>} Collected body, or null if the request was
   *   already rejected (413) or errored before the body was fully received.
   */
  function collectRequestBody(req, provider, requestId, res, span, startTime, targetHost) {
    return new Promise((resolve) => {
      const chunks = [];
      let totalBytes = 0;
      let settled = false;

      function settle(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }

      req.on('close', () => {
        if (settled || req.complete) return;
        const duration = Date.now() - startTime;
        metrics.gaugeDec('active_requests', { provider });
        logRequest('warn', 'request_aborted', {
          request_id: requestId, provider, method: req.method,
          path: sanitizeForLog(req.url), duration_ms: duration,
          upstream_host: targetHost,
        });
        otel.endSpan(span, 0);
        settle(null);
      });

      req.on('error', (err) => {
        if (settled) return;
        otel.endSpanError(span, err, 400);
        handleRequestError(err, {
          res, requestId, provider, req, targetHost,
          startTime, statusCode: 400, clientMessage: 'Client error',
        });
        settle(null);
      });

      req.on('data', (chunk) => {
        if (settled) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_SIZE) {
          const duration = Date.now() - startTime;
          metrics.gaugeDec('active_requests', { provider });
          metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
          logRequest('warn', 'request_complete', {
            request_id: requestId, provider, method: req.method,
            path: sanitizeForLog(req.url), status: 413, duration_ms: duration,
            request_bytes: totalBytes, upstream_host: targetHost,
          });
          otel.endSpan(span, 413);
          if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload Too Large', message: 'Request body exceeds 10 MB limit' }));
          settle(null);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        settle(Buffer.concat(chunks));
      });
    });
  }

  /**
   * Apply the sequential body-transform pipeline to the raw inbound body.
   *
   * Transforms applied in order:
   *   1. `bodyTransform` — optional caller-supplied transform
   *   2. `sanitizeNullToolCallTypes` — strips/normalizes null tool-call types
   *   3. `injectSteeringMessage` — timeout + token/credit steering (when enabled)
   *   4. `injectStreamOptions` — adds `stream_options.include_usage`
   *
   * @param {Buffer} body
   * @param {string} provider
   * @param {import('http').IncomingMessage} req
   * @param {string} requestId
   * @param {((body: Buffer) => (Buffer | null | Promise<Buffer | null>)) | null} bodyTransform
   * @returns {Promise<{ body: Buffer, codexCompatibility: { customTools: Set<string> } | null, wireApiCompatibility: object | null, wireApiSourceBody: Buffer | null }>}
   */
  async function transformRequestBody(body, provider, req, requestId, bodyTransform) {
    let codexCompatibility = null;
    let wireApiCompatibility = null;
    let wireApiSourceBody = null;
    let steering = null;
    const isWritableMethod = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';

    // Normalize a redundant "<provider>/" prefix (e.g. "openai/gpt-6-sol", used by
    // harnesses such as Pi and Codex) unconditionally — independent of whether
    // AWF_MODEL_ALIASES is configured — so the literal prefixed model string
    // never reaches the upstream API, which would otherwise reject it as
    // unrecognized. NOTE: when AWF_MODEL_ALIASES *is* configured, the
    // `bodyTransform` step below (backed by model-resolver.js's `resolveModel`)
    // independently strips the same redundant prefix as part of its own
    // resolution logic (see `stripRedundantProviderPrefix` usage in
    // model-resolver.js). Both call sites share the `stripRedundantProviderPrefix`
    // helper in model-utils.js; keep them in sync if that normalization changes.
    if (isWritableMethod) {
      const requestedModel = parseBodyAsObject(body)?.model;
      if (typeof requestedModel === 'string') req.awfRequestedModelSelector = requestedModel;
      const prefixStripped = stripRedundantModelPrefixInBody(body, provider);
      if (prefixStripped) body = prefixStripped;
    }

    if (bodyTransform && isWritableMethod) {
      const transformed = await bodyTransform(body, req);
      // Body transforms must honour the `Buffer | null` contract. A non-Buffer
      // result would otherwise flow through as the request body, yielding an
      // invalid `Content-Length` and an empty upstream request (rejected with
      // an opaque upstream 400), so ignore it and keep the untransformed body.
      if (transformed !== null) {
        if (Buffer.isBuffer(transformed)) {
          body = transformed;
        } else {
          logRequest('warn', 'request_transform_ignored', {
            request_id: requestId,
            provider,
            reason: 'body_transform_returned_non_buffer',
          });
        }
      }
    }

    // Adapt Codex's Responses `custom`/freeform tool dialect (e.g.
    // `apply_patch`) into the function-tool dialect Copilot accepts. The
    // resulting compatibility metadata must be threaded explicitly through
    // the request/retry context by the caller (see proxy-request.js and
    // upstream-http.js) rather than recovered from the body later. Chat
    // Completions requests use a different custom-tool shape and must pass
    // through unchanged.
    if (provider === 'copilot' && isWritableMethod && !isChatCompletionsRequest(req.url)) {
      const translated = translateCodexCustomToolsForCopilot(body);
      if (translated) {
        body = translated.body;
        codexCompatibility = translated.compatibility;
      }
    }

    if (isWritableMethod) {
      const recovered = recoverRequestModel(body, provider, req, requestId, logRequest);
      if (recovered) body = recovered;
    }

    if (isWritableMethod) {
      const sanitized = sanitizeNullToolCallTypes(body);
      if (sanitized) {
        body = sanitized.body;
        logRequest('info', 'request_sanitized', {
          request_id: requestId,
          provider,
          normalized_tool_calls: sanitized.normalizedCount,
          dropped_tool_calls: sanitized.droppedCount,
        });
      }
    }

    const allowSteering = req.awfRequestContext?.purpose !== 'routing_classification';
    // A notice goes only on a request that ends with tool results, the kind a
    // working agent makes, so harness housekeeping requests (e.g. a request to
    // summarize the conversation) are skipped. Every conversation hears each
    // notice once, on its own next such request. Until a threshold of either
    // kind is crossed no notice can be selected, so the body is not inspected;
    // both guards are asked so each updates its crossed thresholds.
    const target = allowSteering && isSteeringEnabled() && (req.method === 'POST' || req.method === 'PUT') &&
      [hasCrossedTimeoutSteeringThreshold(), hasCrossedAiCreditSteeringThreshold()].includes(true)
      ? describeSteeringConversation(body, provider, req.url)
      : null;
    if (target?.endsWithToolResult) {
      const { conversation } = target;
      const steeringMessages = [
        {
          type: 'timeout',
          priority: 3,
          warning: getPendingTimeoutSteeringWarning(conversation),
          claim: claimTimeoutSteeringWarning,
        },
        {
          type: 'ai_credit',
          priority: 2,
          warning: getPendingAiCreditSteeringWarning(conversation),
          claim: claimAiCreditSteeringWarning,
        },
      ];
      const nextWarning = steeringMessages
        .filter(candidate => candidate.warning)
        .sort((a, b) =>
          b.warning.threshold - a.warning.threshold || b.priority - a.priority
        )[0];
      if (nextWarning) {
        const steered = injectSteeringMessage(body, provider, nextWarning.warning.message, req.url);
        if (steered) {
          body = steered;
          // Records carry a 12-hex-character prefix of the opaque per-run
          // conversation key, or null for a request continuing a stored
          // response, which has no opening to key.
          const shortConversation = conversation && conversation !== STORED_RESPONSE_CONVERSATION
            ? conversation.slice(0, 12)
            : null;
          // `first` is set when this turns out to be the run's first delivery
          // of the threshold; only that record carries the `steering` field.
          steering = {
            type: nextWarning.type,
            threshold: nextWarning.warning.threshold,
            conversation: shortConversation,
            first: false,
          };
          // The notice stays pending until the request carrying it succeeds:
          // the upstream response handler acknowledges it on a 2xx response
          // and proxy-request releases it when the request fails. The
          // conversation is recorded as having heard it only on acknowledge.
          const delivery = nextWarning.claim(nextWarning.warning.threshold, conversation);
          const steeringRecord = steering;
          req.awfSteeringDelivery = Object.freeze({
            acknowledge: () => {
              if (delivery.acknowledge()) steeringRecord.first = true;
            },
            release: delivery.release,
          });
          logRequest('info', `${nextWarning.type}_steering`, {
            request_id: requestId,
            provider,
            threshold: nextWarning.warning.threshold,
            conversation: pseudonymizeConversationForLog(shortConversation),
            message: nextWarning.warning.message,
          });
        }
      }
    }

    // Inject stream_options.include_usage so streaming responses include token data
    if (req.method === 'POST') {
      const streamOpts = injectStreamOptions(body, provider, req.url);
      if (streamOpts) {
        body = streamOpts.body;
      }
    }

    // Preserve the agent-facing representation after explicitly authorized
    // normalization, before any wire translation. Fallback must assess this
    // request rather than a body whose translator has already discarded fields.
    if (isWritableMethod) req.awfFallbackSourceBody = Buffer.from(body);

    const selectResolverFallback = () => {
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
          body = Buffer.from(JSON.stringify(parsed), 'utf8');
          req.awfFallbackSourceBody = Buffer.from(body);
          req.awfSelectedModelEligibility = Object.freeze({ model, provider, decision: eligibility });
          if (eligibility.identity) req.awfModelIdentity = eligibility.identity;
        }
        publish(model, 'accepted', compatibility, reasoning);
        return targetUrl;
      }
      publish(null, 'exhausted', lastCompatibility || assessRequestCompatibility({
        body: req.awfFallbackSourceBody, source, target: source, candidate: { provider, model: null }, pins,
      }), lastReasoning);
      const error = new Error('The selected automatic fallback cannot preserve the assessed request requirements');
      error.statusCode = 400;
      error.type = 'invalid_request_error';
      error.code = 'model_recovery_exhausted';
      throw error;
    };
    const resolverEndpoint = selectResolverFallback();

    if (provider === 'copilot' && req.method === 'POST' && endpointForPath(req.url) &&
        !req.awfRecoveryAttempts) {
      wireApiSourceBody = Buffer.from(body);
      const translated = resolverEndpoint && endpointForPath(resolverEndpoint) === endpointForPath(req.url)
        ? null : translateCopilotWireApi(body, req.url, resolverEndpoint ? { upstreamEndpoint: endpointForPath(resolverEndpoint) } : {});
      if (translated) {
        body = translated.body;
        wireApiCompatibility = translated.compatibility;
        req.awfRouting?.onEndpointTranslation?.(wireApiCompatibility);
      }
    }

    return { body, codexCompatibility, wireApiCompatibility, wireApiSourceBody, steering };
  }

  return { collectRequestBody, transformRequestBody };
}

module.exports = { createBodyHandler, sleep, _setSleepForTests, _resetSleepForTests };
