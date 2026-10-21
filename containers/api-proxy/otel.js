'use strict';

/**
 * OpenTelemetry tracing for AWF API Proxy.
 *
 * Emits one CLIENT span per proxied LLM API request, decorated with GenAI
 * semantic-convention attributes and token usage data.  Spans are children of
 * the parent workflow trace identified by GITHUB_AW_OTEL_TRACE_ID /
 * GITHUB_AW_OTEL_PARENT_SPAN_ID so that end-to-end traces flow from the
 * GitHub Actions workflow through the api-proxy to the LLM provider.
 *
 * Model-router calls made while planning (capabilities, classify, route) get
 * their own CLIENT spans through `routerCallTracing`, which also supplies the
 * W3C `traceparent`/`tracestate` headers sent to the router.
 *
 * Activation (in priority order):
 *   - GH_AW_OTLP_ENDPOINTS (JSON array of {url, headers} objects): fan-out
 *     mode — spans are exported concurrently to all listed endpoints.
 *   - OTEL_EXPORTER_OTLP_ENDPOINT (single URL): legacy single-endpoint mode.
 *   - Neither set: writes span NDJSON to /var/log/api-proxy/otel.jsonl as a
 *     local fallback (mirrors the MCPG /tmp/gh-aw/otel.jsonl pattern).
 *
 * All OTLP exports route through the Squid proxy (HTTPS_PROXY / HTTP_PROXY)
 * so the domain whitelist is respected.
 *
 * Environment variables consumed:
 *   GH_AW_OTLP_ENDPOINTS          - JSON array of {url, headers} endpoint objects (fan-out)
 *   OTEL_EXPORTER_OTLP_ENDPOINT   - OTLP/HTTP collector URL (single-endpoint fallback)
 *   OTEL_EXPORTER_OTLP_HEADERS    - Comma-separated "key=value" auth headers (single-endpoint)
 *   OTEL_SERVICE_NAME              - Service name tag (default: awf-api-proxy)
 *   GITHUB_AW_OTEL_TRACE_ID       - W3C trace-id of the parent workflow trace
 *   GITHUB_AW_OTEL_PARENT_SPAN_ID - W3C span-id of the parent workflow span
 */

const { NodeTracerProvider, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const {
  ATTR_SERVICE_NAME,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_PATH,
} = require('@opentelemetry/semantic-conventions');
const {
  trace,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  context,
  INVALID_SPAN_CONTEXT,
  isSpanContextValid,
} = require('@opentelemetry/api');
const { parseOtlpHeaders, buildResourceSpans } = require('./otel-serialization');
const { ProxyAwareOtlpExporter, FileSpanExporter, FanOutSpanExporter } = require('./otel-exporters');
const { createOtlpWorkloadIdentity } = require('./otel-workload-identity');

// ── Environment variables ─────────────────────────────────────────────────────
const OTLP_ENDPOINTS_JSON = (process.env.GH_AW_OTLP_ENDPOINTS || '').trim();
const OTLP_ENDPOINT    = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT    || '').trim();
const OTLP_HEADERS_RAW = (process.env.OTEL_EXPORTER_OTLP_HEADERS     || '').trim();
const SERVICE_NAME     = (process.env.OTEL_SERVICE_NAME               || 'awf-api-proxy').trim();
const PARENT_TRACE_ID  = (process.env.GITHUB_AW_OTEL_TRACE_ID        || '').trim();
const PARENT_SPAN_ID   = (process.env.GITHUB_AW_OTEL_PARENT_SPAN_ID  || '').trim();
const HTTPS_PROXY_URL  = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const OTLP_WORKLOAD_IDENTITY = (process.env.GH_AW_OTLP_WORKLOAD_IDENTITY || '').trim();

const SCOPE_NAME     = 'awf-api-proxy';
const OTEL_LOG_FILE  = '/var/log/api-proxy/otel.jsonl';

/** Module-level state, populated by init(). */
let _provider = null;
let _tracer   = null;
let _enabled  = false;
let _workloadIdentity = null;

// ── SDK initialisation ────────────────────────────────────────────────────────

/**
 * Parse GH_AW_OTLP_ENDPOINTS JSON array into [{url, headers}] objects.
 * Returns empty array if the env var is absent/invalid.
 * Each entry: { url: string, headers: Record<string,string> }
 *
 * URLs are validated with `new URL()` up-front so that a misconfigured entry
 * does not cause ProxyAwareOtlpExporter construction to throw during module
 * init. Headers are normalized to a plain string-to-string object; arrays and
 * entries with non-string values are silently dropped.
 */
function _parseEndpoints() {
  if (!OTLP_ENDPOINTS_JSON) return [];
  try {
    const parsed = JSON.parse(OTLP_ENDPOINTS_JSON);
    if (!Array.isArray(parsed)) return [];
    const results = [];
    for (const ep of parsed) {
      if (!ep || typeof ep.url !== 'string') continue;
      const urlStr = ep.url.trim();
      if (!urlStr) continue;
      try { new URL(urlStr); } catch { continue; }
      const rawHeaders = ep.headers;
      const headers = {};
      if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (typeof v === 'string') headers[k] = v;
        }
      }
      results.push({ url: urlStr, headers });
    }
    return results;
  } catch {
    return [];
  }
}

function _init() {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME });
  _workloadIdentity = createOtlpWorkloadIdentity(OTLP_WORKLOAD_IDENTITY);

  let exporter;
  const endpoints = _parseEndpoints();
  const configuredEndpointUrls = endpoints.length > 0
    ? endpoints.map(endpoint => endpoint.url)
    : (OTLP_ENDPOINT ? [OTLP_ENDPOINT] : []);
  if (_workloadIdentity
    && !configuredEndpointUrls.some(endpoint => _workloadIdentity.matchesEndpoint(endpoint))) {
    throw new Error('OTLP workload identity endpoint does not match any configured OTLP endpoint');
  }
  const headerProviderFor = endpoint => (
    _workloadIdentity?.matchesEndpoint(endpoint) ? _workloadIdentity : null
  );

  if (endpoints.length > 1) {
    // Fan-out: send spans to all configured endpoints concurrently
    const exporters = endpoints.map(ep => new ProxyAwareOtlpExporter({
      url: ep.url,
      headers: ep.headers || {},
      httpsProxy: HTTPS_PROXY_URL || null,
      resource,
      headerProvider: headerProviderFor(ep.url),
    }));
    exporter = new FanOutSpanExporter(exporters);
  } else if (endpoints.length === 1) {
    exporter = new ProxyAwareOtlpExporter({
      url: endpoints[0].url,
      headers: endpoints[0].headers || {},
      httpsProxy: HTTPS_PROXY_URL || null,
      resource,
      headerProvider: headerProviderFor(endpoints[0].url),
    });
  } else if (OTLP_ENDPOINT) {
    // Legacy single-endpoint fallback
    exporter = new ProxyAwareOtlpExporter({
      url:        OTLP_ENDPOINT,
      headers:    parseOtlpHeaders(OTLP_HEADERS_RAW),
      httpsProxy: HTTPS_PROXY_URL || null,
      resource,
      headerProvider: headerProviderFor(OTLP_ENDPOINT),
    });
  } else {
    exporter = new FileSpanExporter(OTEL_LOG_FILE);
  }

  _provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  _provider.register();
  // Use _provider.getTracer() directly (not the global trace API) so that
  // spans are always routed through the provider's active span processor. This
  // avoids a subtle issue where a second call to _provider.register() is
  // silently rejected (duplicate global registration) and the global
  // trace.getTracer() would return a tracer bound to a stale provider.
  _tracer  = _provider.getTracer(SCOPE_NAME);
  _enabled = true;
}

/** Validate that a value is a lower-case hex string of the expected length. */
function _isValidHex(val, len) {
  return typeof val === 'string' && val.length === len && /^[0-9a-f]+$/.test(val);
}

/**
 * Build an OTel context that carries the workflow parent span as the remote
 * parent, so all api-proxy spans are correctly nested in the workflow trace.
 * Returns the active context unchanged when no valid parent IDs are present.
 */
function _buildParentContext() {
  if (!_isValidHex(PARENT_TRACE_ID, 32) || !_isValidHex(PARENT_SPAN_ID, 16)) {
    return context.active();
  }
  const spanCtx = {
    traceId:    PARENT_TRACE_ID,
    spanId:     PARENT_SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote:   true,
  };
  return trace.setSpanContext(context.active(), spanCtx);
}

// Initialise on module load.
_init();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start a CLIENT span for a proxied LLM API request.
 *
 * When OTEL is not enabled this returns a no-op span — all subsequent calls
 * on the returned value are safe no-ops, so callers need no guard checks.
 *
 * @param {object} opts
 * @param {string} opts.provider  - LLM provider (openai, anthropic, copilot, …)
 * @param {string} opts.method    - HTTP method (GET, POST, …)
 * @param {string} opts.path      - Sanitised request path
 * @param {string} opts.requestId - Internal AWF request ID
 * @returns {import('@opentelemetry/api').Span}
 */
function startRequestSpan({ provider, method, path, requestId }) {
  if (!_enabled) return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

  const parentCtx = _buildParentContext();
  return _tracer.startSpan(
    `api_proxy.${provider}.request`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: method,
        [ATTR_URL_PATH]:            path,
        'gen_ai.provider.name':     provider,
        'gen_ai.operation.name':    'chat',
        'gen_ai.request.stream':    true,
        'awf.request_id':           requestId,
      },
    },
    parentCtx,
  );
}

/**
 * Attach token-usage attributes and emit the `gen_ai.usage` span event.
 *
 * Called from the proxy-request.js `onUsage` callback so that token data
 * arrives on the span before it is ended.
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {object} opts
 * @param {string}  opts.provider
 * @param {string}  opts.model           - Model name from the response
 * @param {object}  opts.normalizedUsage - { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }
 * @param {boolean} opts.streaming
 */
function setTokenAttributes(span, { provider, model, normalizedUsage, streaming }) {
  if (!_enabled || !span) return;
  try {
    if (model && model !== 'unknown') {
      span.setAttribute('gen_ai.response.model', model);
    }
    span.setAttributes({
      // Standard GenAI semconv (Sentry recognizes these as numeric)
      'gen_ai.usage.input_tokens':      normalizedUsage.input_tokens,
      'gen_ai.usage.output_tokens':     normalizedUsage.output_tokens,
      'gen_ai.request.stream':          streaming,
      // Cache and reasoning as strings — avoid "token" in name (Sentry PII scrubber redacts it)
      'awf.cached_read':                String(normalizedUsage.cache_read_tokens),
      'awf.cached_write':               String(normalizedUsage.cache_write_tokens),
      'awf.reasoning':                  String(normalizedUsage.reasoning_tokens || 0),
    });
    span.addEvent('gen_ai.usage', {
      'gen_ai.usage.input_tokens':      normalizedUsage.input_tokens,
      'gen_ai.usage.output_tokens':     normalizedUsage.output_tokens,
      'awf.cached_read':                String(normalizedUsage.cache_read_tokens),
      'awf.cached_write':               String(normalizedUsage.cache_write_tokens),
      'awf.reasoning':                  String(normalizedUsage.reasoning_tokens || 0),
    });
  } catch { /* best-effort */ }
}

/**
 * Attach AI-credit budget attributes to the span.
 *
 * Called from the onUsage callback after computeTokenBudgetUsage returns,
 * so that per-request AI credits are queryable in Sentry/Grafana.
 *
 * All values are emitted as strings following the awf.* convention
 * (Sentry drops unknown numeric attributes; see docs/otel-sentry.md).
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {object|undefined} budgetResult - Output from computeTokenBudgetUsage
 */
function setBudgetAttributes(span, budgetResult) {
  if (!_enabled || !span || !budgetResult) return;
  try {
    const attrs = {};
    if (budgetResult.ai_credits_this_response != null) {
      attrs['awf.ai_credits'] = String(budgetResult.ai_credits_this_response);
    }
    if (budgetResult.ai_credits_total != null) {
      attrs['awf.ai_credits_total'] = String(budgetResult.ai_credits_total);
    }
    if (Object.keys(attrs).length > 0) {
      span.setAttributes(attrs);
    }
  } catch { /* best-effort */ }
}

/**
 * End a span successfully with the upstream HTTP status code.
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {number} statusCode - Upstream HTTP response status
 */
function endSpan(span, statusCode) {
  if (!_enabled || !span) return;
  try {
    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
    if (statusCode >= 200 && statusCode < 300) {
      span.setStatus({ code: SpanStatusCode.OK });
    } else if (statusCode >= 400) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${statusCode}` });
    }
    span.end();
  } catch { /* best-effort */ }
}

/**
 * End a span with an error (network failure, timeout, etc.).
 *
 * @param {import('@opentelemetry/api').Span} span
 * @param {Error|unknown} err
 * @param {number} [statusCode]
 */
function endSpanError(span, err, statusCode) {
  if (!_enabled || !span) return;
  try {
    if (statusCode !== undefined) {
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
    }
    const msg = err && err.message ? err.message : String(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
    if (err instanceof Error) span.recordException(err);
    span.end();
  } catch { /* best-effort */ }
}

// ── Model-router calls ────────────────────────────────────────────────────────

const ROUTER_OPERATIONS = new Set(['capabilities', 'classify', 'route']);
const ROUTER_METHODS = new Set(['GET', 'POST']);
// Fixed codes raised by the router client or Node's socket layer. Anything else
// is reported as _OTHER so raw error text never reaches a span.
const ROUTER_ERROR_TYPES = new Set([
  'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT',
  'routing_cancelled', 'routing_contract_error',
]);
const ROUTER_OUTCOME_ATTRIBUTES = new Map([
  ['gh_aw_router.goal', 'string'],
  ['gh_aw_router.mode', 'string'],
  ['gh_aw_router.classification.present', 'boolean'],
  ['gh_aw_router.selected.model', 'string'],
  ['gh_aw_router.selected.effort', 'string'],
]);
const MAX_ROUTER_ATTRIBUTE_LENGTH = 256;

function _routerOutcomeAttributes(attributes) {
  const allowed = {};
  if (!attributes || typeof attributes !== 'object') return allowed;
  for (const [key, type] of ROUTER_OUTCOME_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value !== type) continue;
    if (type === 'string' && (value.length === 0 || value.length > MAX_ROUTER_ATTRIBUTE_LENGTH)) continue;
    allowed[key] = value;
  }
  return allowed;
}

function _routerErrorType(error, statusCode) {
  if (Number.isInteger(statusCode) && statusCode >= 400) return String(statusCode);
  const code = error?.code;
  return typeof code === 'string' && ROUTER_ERROR_TYPES.has(code) ? code : '_OTHER';
}

function _traceHeaders(spanContext) {
  if (!isSpanContextValid(spanContext)) return {};
  const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, '0');
  const headers = { traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}` };
  const traceState = spanContext.traceState?.serialize();
  if (traceState) headers.tracestate = traceState;
  return headers;
}

/**
 * Start a CLIENT span for one model-router call and return its W3C trace
 * headers. Health checks are not traced.
 *
 * The parent is `parentContext` when the caller owns one with a valid span,
 * otherwise the workflow parent from GITHUB_AW_OTEL_*, otherwise a new root.
 * Only `traceparent` and `tracestate` are returned; baggage is never sent.
 *
 * @param {object} opts
 * @param {'capabilities'|'classify'|'route'} opts.operation
 * @param {string} opts.method
 * @param {string} opts.serverAddress - Configured router host
 * @param {number} opts.serverPort    - Configured router port
 * @param {import('@opentelemetry/api').Context} [opts.parentContext]
 * @param {Record<string, string|boolean>} [opts.attributes] - Allowlisted gh_aw_router.* attributes
 * @returns {{ headers: Record<string, string>, end: Function }|null}
 */
function startRouterCall({ operation, method, serverAddress, serverPort, parentContext, attributes } = {}) {
  if (!_enabled || !ROUTER_OPERATIONS.has(operation)) return null;
  const parent = parentContext && isSpanContextValid(trace.getSpanContext(parentContext) || INVALID_SPAN_CONTEXT)
    ? parentContext
    : _buildParentContext();
  const span = _tracer.startSpan(
    `gh_aw_router ${operation}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: ROUTER_METHODS.has(method) ? method : '_OTHER',
        [ATTR_URL_PATH]: `/${operation}`,
        ...(typeof serverAddress === 'string' && serverAddress ? { 'server.address': serverAddress } : {}),
        ...(Number.isInteger(serverPort) ? { 'server.port': serverPort } : {}),
        ..._routerOutcomeAttributes(attributes),
      },
    },
    parent,
  );

  let ended = false;
  return Object.freeze({
    headers: Object.freeze(_traceHeaders(span.spanContext())),
    /**
     * End the span once. Later calls are ignored.
     * @param {{ statusCode?: number, error?: unknown, attributes?: object }} [outcome]
     */
    end({ statusCode, error, attributes: resultAttributes } = {}) {
      if (ended) return;
      ended = true;
      try {
        if (Number.isInteger(statusCode)) span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
        if (error !== undefined) {
          const errorType = _routerErrorType(error, statusCode);
          span.setAttribute('error.type', errorType);
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorType });
        } else {
          span.setAttributes(_routerOutcomeAttributes(resultAttributes));
        }
      } catch { /* best-effort */ }
      try { span.end(); } catch { /* best-effort */ }
    },
  });
}

/** Tracing hook for createRoutingRouterClient. */
const routerCallTracing = Object.freeze({ startCall: startRouterCall });

/**
 * Flush pending spans and tear down the OTEL SDK.
 * Must be awaited during graceful shutdown to prevent span loss.
 *
 * @returns {Promise<void>}
 */
async function shutdown() {
  if (!_provider) return;
  try {
    await _provider.shutdown();
  } catch { /* best-effort */ }
  _workloadIdentity?.shutdown();
}

/**
 * @returns {boolean} true when OTEL tracing is active.
 */
function isEnabled() { return _enabled; }

module.exports = {
  startRequestSpan,
  setTokenAttributes,
  setBudgetAttributes,
  endSpan,
  endSpanError,
  routerCallTracing,
  shutdown,
  isEnabled,
  // Exported for testing
  get _provider() { return _provider; },
  _ProxyAwareOtlpExporter: ProxyAwareOtlpExporter,
  _FileSpanExporter: FileSpanExporter,
  _FanOutSpanExporter: FanOutSpanExporter,
  _parseEndpoints,
  _parseOtlpHeaders: parseOtlpHeaders,
  _buildResourceSpans: buildResourceSpans,
  _createOtlpWorkloadIdentity: createOtlpWorkloadIdentity,
};
