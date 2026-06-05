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
 * Activation:
 *   - When OTEL_EXPORTER_OTLP_ENDPOINT is set: exports via OTLP/HTTP routed
 *     through the Squid proxy (HTTPS_PROXY / HTTP_PROXY env vars) so the
 *     domain whitelist is respected.
 *   - Otherwise: writes span NDJSON to /var/log/api-proxy/otel.jsonl as a
 *     local fallback (mirrors the MCPG /tmp/gh-aw/otel.jsonl pattern).
 *   - Network export remains opt-in. When OTLP is unset, only best-effort
 *     local file writes are attempted (no outbound network traffic).
 *
 * Environment variables consumed:
 *   OTEL_EXPORTER_OTLP_ENDPOINT   - OTLP/HTTP collector URL (e.g. https://otel.example.com:4318)
 *   OTEL_EXPORTER_OTLP_HEADERS    - Comma-separated "key=value" auth headers
 *   OTEL_SERVICE_NAME              - Service name tag (default: awf-api-proxy)
 *   GITHUB_AW_OTEL_TRACE_ID       - W3C trace-id of the parent workflow trace
 *   GITHUB_AW_OTEL_PARENT_SPAN_ID - W3C span-id of the parent workflow span
 */

const { NodeTracerProvider, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');
const { Resource } = require('@opentelemetry/resources');
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
} = require('@opentelemetry/api');
const { parseOtlpHeaders, buildResourceSpans } = require('./otel-serialization');
const { ProxyAwareOtlpExporter, FileSpanExporter } = require('./otel-exporters');

// ── Environment variables ─────────────────────────────────────────────────────
const OTLP_ENDPOINT    = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT    || '').trim();
const OTLP_HEADERS_RAW = (process.env.OTEL_EXPORTER_OTLP_HEADERS     || '').trim();
const SERVICE_NAME     = (process.env.OTEL_SERVICE_NAME               || 'awf-api-proxy').trim();
const PARENT_TRACE_ID  = (process.env.GITHUB_AW_OTEL_TRACE_ID        || '').trim();
const PARENT_SPAN_ID   = (process.env.GITHUB_AW_OTEL_PARENT_SPAN_ID  || '').trim();
const HTTPS_PROXY_URL  = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

const SCOPE_NAME     = 'awf-api-proxy';
const OTEL_LOG_FILE  = '/var/log/api-proxy/otel.jsonl';

/** Module-level state, populated by init(). */
let _provider = null;
let _tracer   = null;
let _enabled  = false;

// ── SDK initialisation ────────────────────────────────────────────────────────

function _init() {
  const resource = new Resource({ [ATTR_SERVICE_NAME]: SERVICE_NAME });

  let exporter;
  if (OTLP_ENDPOINT) {
    exporter = new ProxyAwareOtlpExporter({
      url:        OTLP_ENDPOINT,
      headers:    parseOtlpHeaders(OTLP_HEADERS_RAW),
      httpsProxy: HTTPS_PROXY_URL || null,
      resource,
    });
  } else {
    exporter = new FileSpanExporter(OTEL_LOG_FILE);
  }

  _provider = new NodeTracerProvider({ resource });
  _provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  _provider.register();
  // Use _provider.getTracer() directly (not the global trace API) so that
  // spans are always routed through _provider.activeSpanProcessor.  This
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
}

/**
 * @returns {boolean} true when OTEL tracing is active.
 */
function isEnabled() { return _enabled; }

module.exports = {
  startRequestSpan,
  setTokenAttributes,
  endSpan,
  endSpanError,
  shutdown,
  isEnabled,
  // Exported for testing
  get _provider() { return _provider; },
  _ProxyAwareOtlpExporter: ProxyAwareOtlpExporter,
  _FileSpanExporter: FileSpanExporter,
  _parseOtlpHeaders: parseOtlpHeaders,
  _buildResourceSpans: buildResourceSpans,
};
