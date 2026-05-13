'use strict';

/**
 * AWF API Proxy — HTTP and WebSocket Proxy Core
 *
 * Responsibilities:
 *   1. HTTP forward proxy (proxyRequest) — credential injection, header manipulation
 *   2. WebSocket proxy (proxyWebSocket) — separate protocol handler
 *   3. Rate-limit enforcement (checkRateLimit) — per-provider 429 responses
 *
 * This module is intentionally self-contained: it reads HTTPS_PROXY from the
 * environment at load time and creates its own RateLimiter instance, which is
 * exported so that management/health endpoints can read rate-limit status.
 *
 * Security note: proxyRequest is the credential injection path. Any change here
 * should be reviewed carefully for header-injection and SSRF risks.
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { generateRequestId, sanitizeForLog, logRequest } = require('./logging');
const metrics = require('./metrics');
const rateLimiter = require('./rate-limiter');
const { buildUpstreamPath, shouldStripHeader } = require('./proxy-utils');

// ── Optional token tracker (graceful degradation when not bundled) ────────────
let trackTokenUsage;
let trackWebSocketTokenUsage;
try {
  ({ trackTokenUsage, trackWebSocketTokenUsage } = require('./token-tracker'));
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    trackTokenUsage = () => {};
    trackWebSocketTokenUsage = () => {};
  } else {
    throw err;
  }
}

// ── Module-level constants (read from env at load time) ───────────────────────
const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const proxyAgent = HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined;

/** Maximum request body size: 10 MB to prevent DoS via large payloads. */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

// ── Billing header extraction ─────────────────────────────────────────────────

/**
 * Extract billing/quota information from upstream response headers.
 *
 * CAPI returns quota snapshots as `X-Quota-Snapshot-<Type>` headers with
 * URL-encoded fields: ent (entitlement), ov (overage), ovPerm (overage allowed),
 * rem (remaining %), rst (reset date).
 *
 * Also captures X-RateLimit-* headers from CAPI responses.
 *
 * @param {Record<string, string|string[]>} headers - Response headers
 * @returns {object|null} Billing info object, or null if no billing headers present
 */
function extractBillingHeaders(headers) {
  const billing = {};
  let hasBilling = false;

  // Extract all X-Quota-Snapshot-* headers
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-quota-snapshot-')) {
      const quotaType = lower.slice('x-quota-snapshot-'.length);
      try {
        const params = new URLSearchParams(String(value));
        const snapshot = {};
        for (const [k, v] of params) snapshot[k] = v;
        billing[`quota_${quotaType}`] = snapshot;
      } catch {
        billing[`quota_${quotaType}_raw`] = String(value);
      }
      hasBilling = true;
    }
  }

  // X-RateLimit headers from CAPI
  if (headers['x-ratelimit-limit']) {
    billing.rate_limit = headers['x-ratelimit-limit'];
    billing.rate_remaining = headers['x-ratelimit-remaining'];
    billing.rate_reset = headers['x-ratelimit-reset'];
    hasBilling = true;
  }

  return hasBilling ? billing : null;
}

/**
 * Sanitize OpenAI-compatible request history where tool_calls[].type is null.
 *
 * Normalizes null type to "function" when a function payload is present.
 * Otherwise, drops the malformed tool_call entry.
 *
 * @param {Buffer} body
 * @returns {{ body: Buffer, normalizedCount: number, droppedCount: number }|null}
 */
function sanitizeNullToolCallTypes(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) {
    return null;
  }

  let changed = false;
  let normalizedCount = 0;
  let droppedCount = 0;

  for (const message of parsed.messages) {
    if (!message || typeof message !== 'object' || !Array.isArray(message.tool_calls)) {
      continue;
    }

    const nextToolCalls = [];
    for (const toolCall of message.tool_calls) {
      if (
        toolCall &&
        typeof toolCall === 'object' &&
        Object.hasOwn(toolCall, 'type') &&
        toolCall.type === null
      ) {
        if (toolCall.function && typeof toolCall.function === 'object') {
          nextToolCalls.push({ ...toolCall, type: 'function' });
          normalizedCount += 1;
        } else {
          droppedCount += 1;
        }
        changed = true;
        continue;
      }
      nextToolCalls.push(toolCall);
    }

    message.tool_calls = nextToolCalls;
  }

  if (!changed) {
    return null;
  }

  return {
    body: Buffer.from(JSON.stringify(parsed)),
    normalizedCount,
    droppedCount,
  };
}

/**
 * Shared RateLimiter instance.
 * Exported so that management endpoints (healthResponse) can read getAllStatus().
 */
const limiter = rateLimiter.create();

/** When false, token-budget warnings are never injected into request bodies. */
const isSteeringEnabled = () => process.env.AWF_ENABLE_TOKEN_STEERING === 'true';

const ET_WARNING_THRESHOLDS = [80, 90, 95, 99];
const ET_DEFAULT_WEIGHTS = Object.freeze({
  input: 1.0,
  cacheRead: 0.1,
  output: 4.0,
  reasoning: 4.0,
});
let etGuardState = {
  configKey: null,
  totalEffectiveTokens: 0,
  emittedThresholds: new Set(),
  uninjectedThresholds: new Set(),
};
const effectiveTokenConfigCache = {
  rawMax: undefined,
  rawMultipliers: undefined,
  parsed: { max: null, multipliers: {} },
};
let timeoutSteeringState = {
  configKey: null,
  startTimeMs: 0,
  emittedThresholds: new Set(),
  uninjectedThresholds: new Set(),
};
const timeoutSteeringConfigCache = {
  rawMinutes: undefined,
  parsedMinutes: null,
};

// ── Max-runs guard ────────────────────────────────────────────────────────────
let maxRunsGuardState = {
  configKey: null,
  invocationCount: 0,
};
const maxRunsConfigCache = {
  rawMax: undefined,
  parsed: null,
};

function parseMaxRuns(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function createTimeoutSteeringState(configKey = null, startTimeMs = Date.now()) {
  return {
    configKey,
    startTimeMs,
    emittedThresholds: new Set(),
    uninjectedThresholds: new Set(),
  };
}

function parseAgentTimeoutMinutes(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function getTimeoutSteeringConfig() {
  const rawMinutes = process.env.AWF_AGENT_TIMEOUT_MINUTES;
  if (timeoutSteeringConfigCache.rawMinutes === rawMinutes) {
    return timeoutSteeringConfigCache.parsedMinutes;
  }
  timeoutSteeringConfigCache.rawMinutes = rawMinutes;
  timeoutSteeringConfigCache.parsedMinutes = parseAgentTimeoutMinutes(rawMinutes);
  return timeoutSteeringConfigCache.parsedMinutes;
}

function getTimeoutSteeringState(timeoutMinutes) {
  if (!timeoutMinutes) return null;
  const configKey = String(timeoutMinutes);
  if (timeoutSteeringState.configKey !== configKey) {
    timeoutSteeringState = createTimeoutSteeringState(configKey);
  }
  return timeoutSteeringState;
}

function updateTimeoutSteeringThresholds(state, timeoutMinutes) {
  if (!state || !timeoutMinutes) return;
  const elapsedMs = Math.max(0, Date.now() - state.startTimeMs);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const percentElapsed = (elapsedMs / timeoutMs) * 100;
  for (const threshold of ET_WARNING_THRESHOLDS) {
    if (percentElapsed >= threshold && !state.emittedThresholds.has(threshold)) {
      state.emittedThresholds.add(threshold);
      state.uninjectedThresholds.add(threshold);
    }
  }
}

function getMaxRunsConfig() {
  const rawMax = process.env.AWF_MAX_RUNS;
  if (maxRunsConfigCache.rawMax === rawMax) {
    return maxRunsConfigCache.parsed;
  }
  maxRunsConfigCache.rawMax = rawMax;
  maxRunsConfigCache.parsed = parseMaxRuns(rawMax);
  return maxRunsConfigCache.parsed;
}

function getMaxRunsState(max) {
  if (!max) return null;
  const configKey = String(max);
  if (maxRunsGuardState.configKey !== configKey) {
    maxRunsGuardState = { configKey, invocationCount: 0 };
  }
  return maxRunsGuardState;
}

function applyMaxRunsInvocation() {
  const max = getMaxRunsConfig();
  const state = getMaxRunsState(max);
  if (!state) return;
  state.invocationCount += 1;
}

function getMaxRunsBlockState() {
  const max = getMaxRunsConfig();
  const state = getMaxRunsState(max);
  if (!state) return null;
  return {
    maxRuns: max,
    invocationCount: state.invocationCount,
    maxExceeded: state.invocationCount >= max,
  };
}

function getMaxRunsReflectState() {
  const max = getMaxRunsConfig();
  const state = getMaxRunsState(max);
  if (!state) {
    return {
      enabled: false,
      max_runs: null,
      invocation_count: 0,
      remaining_runs: null,
    };
  }
  return {
    enabled: true,
    max_runs: max,
    invocation_count: state.invocationCount,
    remaining_runs: Math.max(0, max - state.invocationCount),
  };
}

function resetMaxRunsGuardForTests() {
  maxRunsGuardState = { configKey: null, invocationCount: 0 };
  maxRunsConfigCache.rawMax = undefined;
  maxRunsConfigCache.parsed = null;
}

function buildMaxRunsExceededError(state) {
  return {
    error: {
      type: 'max_runs_exceeded',
      message: `Maximum LLM invocations exceeded (${state.invocationCount} / ${state.maxRuns}).`,
      invocation_count: state.invocationCount,
      max_runs: state.maxRuns,
    },
  };
}

function createEffectiveTokenState(configKey = null) {
  return {
    configKey,
    totalEffectiveTokens: 0,
    emittedThresholds: new Set(),
    uninjectedThresholds: new Set(),
  };
}

function parseMaxEffectiveTokens(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseModelMultipliers(raw) {
  if (!raw || String(raw).trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result = {};
    for (const [model, value] of Object.entries(parsed)) {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) {
        result[model] = num;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function getEffectiveTokenConfig() {
  const rawMax = process.env.AWF_MAX_EFFECTIVE_TOKENS;
  const rawMultipliers = process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
  if (effectiveTokenConfigCache.rawMax === rawMax && effectiveTokenConfigCache.rawMultipliers === rawMultipliers) {
    return effectiveTokenConfigCache.parsed;
  }

  effectiveTokenConfigCache.rawMax = rawMax;
  effectiveTokenConfigCache.rawMultipliers = rawMultipliers;
  const parsedMultipliers = Object.freeze(parseModelMultipliers(rawMultipliers));
  effectiveTokenConfigCache.parsed = {
    max: parseMaxEffectiveTokens(rawMax),
    multipliers: parsedMultipliers,
  };
  return effectiveTokenConfigCache.parsed;
}

function getEffectiveTokenState(config) {
  if (!config.max) return null;
  const configKey = `${config.max}|${JSON.stringify(config.multipliers)}`;
  if (etGuardState.configKey !== configKey) {
    etGuardState = createEffectiveTokenState(configKey);
  }
  return etGuardState;
}

function calculateEffectiveTokens(normalizedUsage, model, config) {
  const multiplier = config.multipliers[model] ?? 1;
  const baseWeightedTokens =
    (ET_DEFAULT_WEIGHTS.input * (normalizedUsage.input_tokens || 0)) +
    (ET_DEFAULT_WEIGHTS.cacheRead * (normalizedUsage.cache_read_tokens || 0)) +
    (ET_DEFAULT_WEIGHTS.output * (normalizedUsage.output_tokens || 0)) +
    (ET_DEFAULT_WEIGHTS.reasoning * (normalizedUsage.reasoning_tokens || 0));
  return {
    multiplier,
    baseWeightedTokens,
    effectiveTokens: multiplier * baseWeightedTokens,
  };
}

function applyEffectiveTokenUsage(normalizedUsage, model) {
  const config = getEffectiveTokenConfig();
  const state = getEffectiveTokenState(config);
  if (!state || !normalizedUsage) return null;

  const previousTotal = state.totalEffectiveTokens;
  const calc = calculateEffectiveTokens(normalizedUsage, model || 'unknown', config);
  state.totalEffectiveTokens += calc.effectiveTokens;
  const percentUsed = (state.totalEffectiveTokens / config.max) * 100;

  const crossedThresholds = [];
  for (const threshold of ET_WARNING_THRESHOLDS) {
    if (percentUsed >= threshold && !state.emittedThresholds.has(threshold)) {
      state.emittedThresholds.add(threshold);
      state.uninjectedThresholds.add(threshold);
      crossedThresholds.push(threshold);
    }
  }

  return {
    maxEffectiveTokens: config.max,
    previousTotalEffectiveTokens: previousTotal,
    totalEffectiveTokens: state.totalEffectiveTokens,
    effectiveTokensThisResponse: calc.effectiveTokens,
    modelMultiplier: calc.multiplier,
    crossedThresholds,
    maxExceeded: state.totalEffectiveTokens >= config.max,
  };
}

function getEffectiveTokenBlockState() {
  const config = getEffectiveTokenConfig();
  const state = getEffectiveTokenState(config);
  if (!state) return null;
  return {
    maxEffectiveTokens: config.max,
    totalEffectiveTokens: state.totalEffectiveTokens,
    maxExceeded: state.totalEffectiveTokens >= config.max,
  };
}

function getEffectiveTokenReflectState() {
  const config = getEffectiveTokenConfig();
  const state = getEffectiveTokenState(config);
  if (!state) {
    return {
      enabled: false,
      max_effective_tokens: null,
      total_effective_tokens: 0,
      remaining_effective_tokens: null,
      percent_used: 0,
      thresholds_crossed: [],
    };
  }
  return {
    enabled: true,
    max_effective_tokens: config.max,
    total_effective_tokens: state.totalEffectiveTokens,
    remaining_effective_tokens: Math.max(0, config.max - state.totalEffectiveTokens),
    percent_used: Math.round((state.totalEffectiveTokens / config.max) * 10000) / 100,
    thresholds_crossed: [...state.emittedThresholds].sort((a, b) => a - b),
  };
}

function resetEffectiveTokenGuardForTests() {
  etGuardState = createEffectiveTokenState();
  effectiveTokenConfigCache.rawMax = undefined;
  effectiveTokenConfigCache.rawMultipliers = undefined;
  effectiveTokenConfigCache.parsed = { max: null, multipliers: {} };
}

function buildEffectiveTokenLimitError(etState) {
  return {
    error: {
      type: 'effective_tokens_limit_exceeded',
      message: `Maximum effective tokens exceeded (${etState.totalEffectiveTokens.toFixed(2)} / ${etState.maxEffectiveTokens}).`,
      total_effective_tokens: etState.totalEffectiveTokens,
      max_effective_tokens: etState.maxEffectiveTokens,
    },
  };
}

// ── Token steering ────────────────────────────────────────────────────────────

/** Warning text for each threshold percentage. */
const ET_STEERING_MESSAGES = {
  80: 'You have used 80% of your effective token budget. Begin planning to wrap up your current work.',
  90: 'You have used 90% of your effective token budget. Complete your current task and prepare final output.',
  95: 'You have used 95% of your effective token budget. Finalize and submit your work now.',
  99: 'You have used 99% of your effective token budget. You are about to be cut off. Submit immediately.',
};
const TIMEOUT_STEERING_MESSAGES = {
  80: 'You have used 80% of your allotted run time. Begin planning to wrap up your current work.',
  90: 'You have used 90% of your allotted run time. Complete your current task and prepare final output.',
  95: 'You have used 95% of your allotted run time. Finalize and submit your work now.',
  99: 'You have used 99% of your allotted run time. You are about to time out. Submit immediately.',
};

/**
 * Pop the highest-priority pending steering threshold and return its warning
 * message, or return null when nothing is pending.
 *
 * Called once per incoming request so that each pending threshold is injected
 * into at most one request body.
 *
 * @returns {string|null}
 */
function getAndClearPendingSteeringMessage() {
  const config = getEffectiveTokenConfig();
  const state = getEffectiveTokenState(config);
  if (!state || state.uninjectedThresholds.size === 0) return null;

  const maxThreshold = Math.max(...state.uninjectedThresholds);
  state.uninjectedThresholds.delete(maxThreshold);
  const text = ET_STEERING_MESSAGES[maxThreshold] ||
    `You have used ${maxThreshold}% of your effective token budget.`;
  return `[AWF TOKEN WARNING] ${text}`;
}

function getAndClearPendingTimeoutSteeringMessage() {
  const timeoutMinutes = getTimeoutSteeringConfig();
  const state = getTimeoutSteeringState(timeoutMinutes);
  if (!state) return null;

  updateTimeoutSteeringThresholds(state, timeoutMinutes);
  if (state.uninjectedThresholds.size === 0) return null;

  const maxThreshold = Math.max(...state.uninjectedThresholds);
  state.uninjectedThresholds.delete(maxThreshold);
  const text = TIMEOUT_STEERING_MESSAGES[maxThreshold] ||
    `You have used ${maxThreshold}% of your allotted run time.`;
  return `[AWF TIME WARNING] ${text}`;
}

/**
 * Inject a token-budget warning message into a request body.
 *
 * Handles three JSON body formats:
 *   - Anthropic  (/v1/messages)          — appends a text block to `system`
 *   - Gemini     (/v1beta/…generateContent) — appends a part to `systemInstruction`
 *   - OpenAI     (/v1/chat/completions)  — inserts a system message after any
 *                                           existing system messages
 *
 * Returns a new Buffer containing the modified body, or null when the body
 * cannot be parsed or injection is not applicable.
 *
 * @param {Buffer} body       - Raw request body
 * @param {string} provider   - Provider name ('anthropic' | 'gemini' | 'openai' | 'copilot' | 'opencode')
 * @param {string} message    - Warning text to inject
 * @returns {Buffer|null}
 */
function injectSteeringMessage(body, provider, message) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  if (provider === 'anthropic') {
    // Anthropic /v1/messages: system can be a string or an array of content blocks
    if (typeof parsed.system === 'string') {
      parsed = { ...parsed, system: parsed.system + '\n\n' + message };
    } else if (Array.isArray(parsed.system)) {
      parsed = { ...parsed, system: [...parsed.system, { type: 'text', text: message }] };
    } else {
      // No system field yet — create one
      parsed = { ...parsed, system: message };
    }
  } else if (provider === 'gemini') {
    // Gemini generateContent: systemInstruction.parts[] or create it
    const existing = parsed.systemInstruction;
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      const parts = Array.isArray(existing.parts)
        ? [...existing.parts, { text: message }]
        : [{ text: message }];
      parsed = { ...parsed, systemInstruction: { ...existing, parts } };
    } else {
      parsed = { ...parsed, systemInstruction: { parts: [{ text: message }] } };
    }
  } else {
    // OpenAI format (openai, copilot, opencode): messages array
    if (!Array.isArray(parsed.messages)) return null;
    const systemMsg = { role: 'system', content: message };
    // Insert after the last existing system message (or at position 0)
    const lastSystemIdx = parsed.messages.reduce(
      (last, m, i) => (m && m.role === 'system' ? i : last),
      -1
    );
    const insertAt = lastSystemIdx + 1;
    const msgs = [...parsed.messages];
    msgs.splice(insertAt, 0, systemMsg);
    parsed = { ...parsed, messages: msgs };
  }

  return Buffer.from(JSON.stringify(parsed));
}

function resetTimeoutSteeringForTests() {
  timeoutSteeringState = createTimeoutSteeringState();
  timeoutSteeringConfigCache.rawMinutes = undefined;
  timeoutSteeringConfigCache.parsedMinutes = null;
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Return true if id is a safe, non-empty request-ID string.
 * Limits length and character set to prevent log injection.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidRequestId(id) {
  return typeof id === 'string' && id.length <= 128 && /^[\w\-\.]+$/.test(id);
}

// ── Rate-limit helper ─────────────────────────────────────────────────────────
/**
 * Check the rate limit for a provider and send a 429 if exceeded.
 * Returns true if the request was rate-limited (caller should return early).
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} provider
 * @param {number} requestBytes
 * @returns {boolean}
 */
function checkRateLimit(req, res, provider, requestBytes) {
  const check = limiter.check(provider, requestBytes);
  if (!check.allowed) {
    const clientRequestId = req.headers['x-request-id'];
    const requestId = (typeof clientRequestId === 'string' &&
      clientRequestId.length <= 128 &&
      /^[\w\-\.]+$/.test(clientRequestId))
      ? clientRequestId : generateRequestId();
    const limitLabels = { rpm: 'requests per minute', rph: 'requests per hour', bytes_pm: 'bytes per minute' };
    const windowLabel = limitLabels[check.limitType] || check.limitType;

    metrics.increment('rate_limit_rejected_total', { provider, limit_type: check.limitType });
    logRequest('warn', 'rate_limited', {
      request_id: requestId,
      provider,
      limit_type: check.limitType,
      limit: check.limit,
      retry_after: check.retryAfter,
    });

    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(check.retryAfter),
      'X-RateLimit-Limit': String(check.limit),
      'X-RateLimit-Remaining': String(check.remaining),
      'X-RateLimit-Reset': String(check.resetAt),
      'X-Request-ID': requestId,
    });
    res.end(JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: `Rate limit exceeded for ${provider} provider. Limit: ${check.limit} ${windowLabel}. Retry after ${check.retryAfter} seconds.`,
        provider,
        limit: check.limit,
        window: check.limitType === 'rpm' ? 'per_minute' : check.limitType === 'rph' ? 'per_hour' : 'per_minute_bytes',
        retry_after: check.retryAfter,
      },
    }));
    return true;
  }
  return false;
}

// ── Core proxy: HTTP ──────────────────────────────────────────────────────────
/**
 * Forward a request to the target API, injecting auth headers and routing through Squid.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} targetHost - Upstream hostname
 * @param {object} injectHeaders - Auth headers to inject
 * @param {string} provider - Provider name for logging and metrics
 * @param {string} [basePath=''] - Optional base-path prefix
 * @param {((body: Buffer) => Buffer | null) | null} [bodyTransform=null]
 */
function proxyRequest(req, res, targetHost, injectHeaders, provider, basePath = '', bodyTransform = null) {
  const clientRequestId = req.headers['x-request-id'];
  const requestId = isValidRequestId(clientRequestId) ? clientRequestId : generateRequestId();
  const startTime = Date.now();

  res.setHeader('X-Request-ID', requestId);
  metrics.gaugeInc('active_requests', { provider });

  logRequest('info', 'request_start', {
    request_id: requestId,
    provider,
    method: req.method,
    path: sanitizeForLog(req.url),
    upstream_host: targetHost,
  });

  if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//')) {
    const duration = Date.now() - startTime;
    metrics.gaugeDec('active_requests', { provider });
    metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
    logRequest('warn', 'request_complete', {
      request_id: requestId,
      provider,
      method: req.method,
      path: sanitizeForLog(req.url),
      status: 400,
      duration_ms: duration,
      upstream_host: targetHost,
    });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Request', message: 'URL must be a relative path' }));
    return;
  }

  const upstreamPath = buildUpstreamPath(req.url, targetHost, basePath);

  const chunks = [];
  let totalBytes = 0;
  let rejected = false;
  let errored = false;

  req.on('error', (err) => {
    if (errored) return;
    errored = true;
    const duration = Date.now() - startTime;
    metrics.gaugeDec('active_requests', { provider });
    metrics.increment('requests_errors_total', { provider });
    logRequest('error', 'request_error', {
      request_id: requestId, provider, method: req.method,
      path: sanitizeForLog(req.url), duration_ms: duration,
      error: sanitizeForLog(err.message), upstream_host: targetHost,
    });
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Client error', message: err.message }));
  });

  req.on('data', chunk => {
    if (rejected || errored) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_SIZE) {
      rejected = true;
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
      logRequest('warn', 'request_complete', {
        request_id: requestId, provider, method: req.method,
        path: sanitizeForLog(req.url), status: 413, duration_ms: duration,
        request_bytes: totalBytes, upstream_host: targetHost,
      });
      if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large', message: 'Request body exceeds 10 MB limit' }));
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (rejected || errored) return;
    let body = Buffer.concat(chunks);
    const inboundBytes = body.length;

    if (bodyTransform && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
      const transformed = bodyTransform(body);
      if (transformed) body = transformed;
    }

    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
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

    // Token steering: inject budget-warning messages into the request body when
    // cumulative usage has crossed a threshold since the last injection.
    // Gated by AWF_ENABLE_TOKEN_STEERING=true (opt-in).
    if (isSteeringEnabled() && (req.method === 'POST' || req.method === 'PUT')) {
      const steeringMessages = [
        { type: 'timeout', message: getAndClearPendingTimeoutSteeringMessage() },
        { type: 'token', message: getAndClearPendingSteeringMessage() },
      ];
      for (const { type, message } of steeringMessages) {
        if (!message) continue;
        const steered = injectSteeringMessage(body, provider, message);
        if (steered) {
          body = steered;
          logRequest('info', `${type}_steering`, {
            request_id: requestId,
            provider,
            message,
          });
        }
      }
    }

    const requestBytes = body.length;
    metrics.increment('request_bytes_total', { provider }, requestBytes);

    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!shouldStripHeader(name)) headers[name] = value;
    }
    headers['x-request-id'] = requestId;
    Object.assign(headers, injectHeaders);

    // Default X-Initiator to "agent" for billing purposes on Copilot-bound requests.
    // In agentic workflows, the vast majority of requests are agent-initiated.
    // If the client already set it (e.g. standard Copilot CLI), respect that value.
    // Check is on targetHost rather than provider name so that OpenCode requests
    // routed to the Copilot backend also receive the header.
    const isCopilotHost =
      targetHost === 'githubcopilot.com' ||
      targetHost.endsWith('.githubcopilot.com');
    if (isCopilotHost && !headers['x-initiator']) {
      headers['x-initiator'] = 'agent';
    }

    if (body.length !== inboundBytes) {
      headers['content-length'] = String(body.length);
      delete headers['transfer-encoding'];
    }

    const injectedKey = Object.entries(injectHeaders).find(([k]) =>
      ['x-api-key', 'authorization', 'x-goog-api-key'].includes(k.toLowerCase())
    )?.[1];
    if (injectedKey) {
      const keyPreview = injectedKey.length > 8
        ? `${injectedKey.substring(0, 8)}...${injectedKey.substring(injectedKey.length - 4)}`
        : '(short)';
      logRequest('debug', 'auth_inject', {
        request_id: requestId, provider,
        key_length: injectedKey.length, key_preview: keyPreview,
        has_anthropic_version: !!headers['anthropic-version'],
      });
    }

    const etBlock = getEffectiveTokenBlockState();
    if (etBlock && etBlock.maxExceeded) {
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
      metrics.observe('request_duration_ms', duration, { provider });
      logRequest('warn', 'effective_tokens_limit_exceeded', {
        request_id: requestId,
        provider,
        total_effective_tokens: etBlock.totalEffectiveTokens,
        max_effective_tokens: etBlock.maxEffectiveTokens,
      });
      res.writeHead(429, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
      res.end(JSON.stringify(buildEffectiveTokenLimitError(etBlock)));
      return;
    }

    const mrBlock = getMaxRunsBlockState();
    if (mrBlock && mrBlock.maxExceeded) {
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
      metrics.observe('request_duration_ms', duration, { provider });
      logRequest('warn', 'max_runs_exceeded', {
        request_id: requestId,
        provider,
        invocation_count: mrBlock.invocationCount,
        max_runs: mrBlock.maxRuns,
      });
      res.writeHead(429, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
      res.end(JSON.stringify(buildMaxRunsExceededError(mrBlock)));
      return;
    }

    const options = {
      hostname: targetHost, port: 443, path: upstreamPath,
      method: req.method, headers,
      agent: proxyAgent,
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let responseBytes = 0;
      proxyRes.on('data', (chunk) => { responseBytes += chunk.length; });

      proxyRes.on('error', (err) => {
        const duration = Date.now() - startTime;
        metrics.gaugeDec('active_requests', { provider });
        metrics.increment('requests_errors_total', { provider });
        logRequest('error', 'request_error', {
          request_id: requestId, provider, method: req.method,
          path: sanitizeForLog(req.url), duration_ms: duration,
          error: sanitizeForLog(err.message), upstream_host: targetHost,
        });
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Response stream error', message: err.message }));
      });

      // Extract billing/quota headers from upstream response
      const billingInfo = extractBillingHeaders(proxyRes.headers);
      const initiatorSent = headers['x-initiator'] || null;

      proxyRes.on('end', () => {
        const duration = Date.now() - startTime;
        const sc = metrics.statusClass(proxyRes.statusCode);
        metrics.gaugeDec('active_requests', { provider });
        metrics.increment('requests_total', { provider, method: req.method, status_class: sc });
        metrics.increment('response_bytes_total', { provider }, responseBytes);
        metrics.observe('request_duration_ms', duration, { provider });
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          applyMaxRunsInvocation();
        }
        const logFields = {
          request_id: requestId, provider, method: req.method,
          path: sanitizeForLog(req.url), status: proxyRes.statusCode,
          duration_ms: duration, request_bytes: requestBytes,
          response_bytes: responseBytes, upstream_host: targetHost,
        };
        if (initiatorSent) logFields.x_initiator = initiatorSent;
        if (billingInfo) logFields.billing = billingInfo;
        logRequest('info', 'request_complete', logFields);
      });

      const resHeaders = { ...proxyRes.headers, 'x-request-id': requestId };

      if (proxyRes.statusCode === 400 || proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
        logRequest('warn', 'upstream_auth_error', {
          request_id: requestId, provider, status: proxyRes.statusCode,
          upstream_host: targetHost, path: sanitizeForLog(req.url),
          message: `Upstream returned ${proxyRes.statusCode} — check that the API key is valid and correctly formatted`,
        });
      }

      res.writeHead(proxyRes.statusCode, resHeaders);
      proxyRes.pipe(res);
      trackTokenUsage(proxyRes, {
        requestId,
        provider,
        path: sanitizeForLog(req.url),
        startTime,
        metrics,
        billingInfo,
        initiatorSent,
        onUsage: (normalizedUsage, model) => {
          applyEffectiveTokenUsage(normalizedUsage, model);
        },
      });
    });

    proxyReq.on('error', (err) => {
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_errors_total', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '5xx' });
      metrics.observe('request_duration_ms', duration, { provider });
      logRequest('error', 'request_error', {
        request_id: requestId, provider, method: req.method,
        path: sanitizeForLog(req.url), duration_ms: duration,
        error: sanitizeForLog(err.message), upstream_host: targetHost,
      });
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
    });

    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
}

// ── Core proxy: WebSocket ─────────────────────────────────────────────────────
/**
 * Handle a WebSocket upgrade request by tunnelling through the Squid proxy.
 *
 * @param {import('http').IncomingMessage} req - The incoming HTTP Upgrade request
 * @param {import('net').Socket} socket - Raw TCP socket to the WebSocket client
 * @param {Buffer} head - Any bytes already buffered after the upgrade headers
 * @param {string} targetHost - Upstream hostname
 * @param {Object} injectHeaders - Auth headers to inject
 * @param {string} provider - Provider name for logging and metrics
 * @param {string} [basePath=''] - Optional base-path prefix
 */
function proxyWebSocket(req, socket, head, targetHost, injectHeaders, provider, basePath = '') {
  const startTime = Date.now();
  const clientRequestId = req.headers['x-request-id'];
  const requestId = isValidRequestId(clientRequestId) ? clientRequestId : generateRequestId();

  const upgradeType = (req.headers['upgrade'] || '').toLowerCase();
  if (upgradeType !== 'websocket') {
    logRequest('warn', 'websocket_upgrade_rejected', {
      request_id: requestId, provider, path: sanitizeForLog(req.url),
      reason: 'unsupported upgrade type',
      upgrade: sanitizeForLog(req.headers['upgrade'] || ''),
    });
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//')) {
    logRequest('warn', 'websocket_upgrade_rejected', {
      request_id: requestId, provider, path: sanitizeForLog(req.url),
      reason: 'URL must be a relative path',
    });
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const upstreamPath = buildUpstreamPath(req.url, targetHost, basePath);

  const etBlock = getEffectiveTokenBlockState();
  if (etBlock && etBlock.maxExceeded) {
    logRequest('warn', 'effective_tokens_limit_exceeded', {
      request_id: requestId,
      provider,
      total_effective_tokens: etBlock.totalEffectiveTokens,
      max_effective_tokens: etBlock.maxEffectiveTokens,
    });
    socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n');
    socket.write(JSON.stringify(buildEffectiveTokenLimitError(etBlock)));
    socket.destroy();
    return;
  }

  const mrBlock = getMaxRunsBlockState();
  if (mrBlock && mrBlock.maxExceeded) {
    logRequest('warn', 'max_runs_exceeded', {
      request_id: requestId,
      provider,
      invocation_count: mrBlock.invocationCount,
      max_runs: mrBlock.maxRuns,
    });
    socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n');
    socket.write(JSON.stringify(buildMaxRunsExceededError(mrBlock)));
    socket.destroy();
    return;
  }

  const rateCheck = limiter.check(provider, 0);
  if (!rateCheck.allowed) {
    metrics.increment('rate_limit_rejected_total', { provider, limit_type: rateCheck.limitType });
    logRequest('warn', 'rate_limited', {
      request_id: requestId, provider, limit_type: rateCheck.limitType,
      limit: rateCheck.limit, retry_after: rateCheck.retryAfter,
    });
    socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rateCheck.retryAfter}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  logRequest('info', 'websocket_upgrade_start', {
    request_id: requestId, provider, path: sanitizeForLog(req.url), upstream_host: targetHost,
  });
  metrics.gaugeInc('active_requests', { provider });

  let finalized = false;
  function finalize(isError, description) {
    if (finalized) return;
    finalized = true;
    const duration = Date.now() - startTime;
    metrics.gaugeDec('active_requests', { provider });
    if (isError) {
      metrics.increment('requests_errors_total', { provider });
      logRequest('error', 'websocket_upgrade_failed', {
        request_id: requestId, provider, path: sanitizeForLog(req.url),
        duration_ms: duration, error: sanitizeForLog(String(description || 'unknown error')),
      });
    } else {
      metrics.increment('requests_total', { provider, method: 'GET', status_class: '1xx' });
      metrics.observe('request_duration_ms', duration, { provider });
      logRequest('info', 'websocket_upgrade_complete', {
        request_id: requestId, provider, path: sanitizeForLog(req.url), duration_ms: duration,
      });
    }
  }

  function abort(reason, ...extra) {
    finalize(true, reason);
    if (!socket.destroyed && socket.writable) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
    socket.destroy();
    for (const s of extra) { if (s && !s.destroyed) s.destroy(); }
  }

  if (!HTTPS_PROXY) {
    abort('No Squid proxy configured (HTTPS_PROXY not set)');
    return;
  }

  let proxyUrl;
  try {
    proxyUrl = new URL(HTTPS_PROXY);
  } catch (err) {
    abort(`Invalid proxy URL: ${err.message}`);
    return;
  }

  const proxyHost = proxyUrl.hostname;
  const proxyPort = parseInt(proxyUrl.port, 10) || 3128;

  const connectReq = http.request({
    host: proxyHost, port: proxyPort, method: 'CONNECT',
    path: `${targetHost}:443`,
    headers: { 'Host': `${targetHost}:443` },
  });

  connectReq.once('error', (err) => abort(`CONNECT error: ${err.message}`));

  connectReq.once('connect', (connectRes, tunnel) => {
    if (connectRes.statusCode !== 200) {
      abort(`CONNECT failed: HTTP ${connectRes.statusCode}`, tunnel);
      return;
    }

    const tlsSocket = tls.connect({ socket: tunnel, servername: targetHost, rejectUnauthorized: true });
    const onTlsError = (err) => abort(`TLS handshake error: ${err.message}`, tunnel);
    tlsSocket.once('error', onTlsError);

    tlsSocket.once('secureConnect', () => {
      tlsSocket.removeListener('error', onTlsError);

      const forwardHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!shouldStripHeader(name)) forwardHeaders[name] = value;
      }
      Object.assign(forwardHeaders, injectHeaders);
      forwardHeaders['host'] = targetHost;

      let upgradeReqStr = `GET ${upstreamPath} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(forwardHeaders)) {
        upgradeReqStr += `${name}: ${value}\r\n`;
      }
      upgradeReqStr += '\r\n';
      tlsSocket.write(upgradeReqStr);

      if (head && head.length > 0) tlsSocket.write(head);

      tlsSocket.pipe(socket);
      socket.pipe(tlsSocket);

      trackWebSocketTokenUsage(tlsSocket, {
        requestId,
        provider,
        path: sanitizeForLog(req.url),
        startTime,
        metrics,
        onUsage: (normalizedUsage, model) => {
          applyEffectiveTokenUsage(normalizedUsage, model);
        },
      });

      socket.once('close', () => { finalize(false); tlsSocket.destroy(); });
      tlsSocket.once('close', () => { finalize(false); socket.destroy(); });
      socket.on('error', () => socket.destroy());
      tlsSocket.on('error', () => tlsSocket.destroy());
    });
  });

  connectReq.end();
}

module.exports = {
  isValidRequestId,
  checkRateLimit,
  proxyRequest,
  proxyWebSocket,
  extractBillingHeaders,
  // Exported for shared use by management/health endpoints
  limiter,
  proxyAgent,
  HTTPS_PROXY,
  getEffectiveTokenReflectState,
  getMaxRunsReflectState,
  // Exported for tests
  resetEffectiveTokenGuardForTests,
  resetMaxRunsGuardForTests,
  resetTimeoutSteeringForTests,
  getAndClearPendingSteeringMessage,
  getAndClearPendingTimeoutSteeringMessage,
  injectSteeringMessage,
};
