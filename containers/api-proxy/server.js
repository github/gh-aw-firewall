#!/usr/bin/env node

/**
 * AWF API Proxy Sidecar
 *
 * Node.js-based proxy that:
 * 1. Keeps LLM API credentials isolated from agent container
 * 2. Routes all traffic through Squid via HTTP_PROXY/HTTPS_PROXY
 * 3. Injects authentication headers (Authorization, x-api-key)
 * 4. Respects domain whitelisting enforced by Squid
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { generateRequestId, sanitizeForLog, logRequest } = require('./logging');
const metrics = require('./metrics');
const rateLimiter = require('./rate-limiter');
let trackTokenUsage;
let trackWebSocketTokenUsage;
let closeLogStream;
try {
  ({ trackTokenUsage, trackWebSocketTokenUsage, closeLogStream } = require('./token-tracker'));
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    trackTokenUsage = () => {};
    trackWebSocketTokenUsage = () => {};
    closeLogStream = () => {};
  } else {
    throw err;
  }
}

// Create rate limiter from environment variables
const limiter = rateLimiter.create();

// Max request body size (10 MB) to prevent DoS via large payloads
const MAX_BODY_SIZE = 10 * 1024 * 1024;

// Headers that must never be forwarded from the client.
// The proxy controls authentication — client-supplied auth/proxy headers are stripped.
const STRIPPED_HEADERS = new Set([
  'host',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'forwarded',
  'via',
]);

/** Returns true if the header name should be stripped (case-insensitive). */
function shouldStripHeader(name) {
  const lower = name.toLowerCase();
  return STRIPPED_HEADERS.has(lower) || lower.startsWith('x-forwarded-');
}

// Read API keys from environment (set by docker-compose)
// Trim whitespace/newlines to prevent malformed HTTP headers — env vars from
// CI secrets or docker-compose YAML may include trailing whitespace.
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim() || undefined;
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim() || undefined;
const COPILOT_GITHUB_TOKEN = (process.env.COPILOT_GITHUB_TOKEN || '').trim() || undefined;
const COPILOT_API_KEY = (process.env.COPILOT_API_KEY || '').trim() || undefined;

/**
 * Resolves the Copilot auth token from environment variables.
 * COPILOT_GITHUB_TOKEN (GitHub OAuth) takes precedence over COPILOT_API_KEY (direct key).
 * @param {Record<string, string|undefined>} env - Environment variables to inspect
 * @returns {string|undefined} The resolved auth token, or undefined if neither is set
 */
function resolveCopilotAuthToken(env = process.env) {
  const githubToken = (env.COPILOT_GITHUB_TOKEN || '').trim() || undefined;
  const apiKey = (env.COPILOT_API_KEY || '').trim() || undefined;
  return githubToken || apiKey;
}

const COPILOT_AUTH_TOKEN = resolveCopilotAuthToken(process.env);
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim() || undefined;

/**
 * Normalizes an API target value to a bare hostname.
 * Accepts either a hostname or a full URL and extracts only the hostname,
 * discarding any scheme, path, query, fragment, credentials, or port.
 * Path configuration must be provided separately via the existing
 * *_API_BASE_PATH environment variables.
 *
 * @param {string|undefined} value - Raw env var value
 * @returns {string|undefined} Bare hostname, or undefined if input is falsy
 */
function normalizeApiTarget(value) {
  if (!value) return value;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);

    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) {
      console.warn(
        `Ignoring unsupported API target URL components in ${sanitizeForLog(trimmed)}; ` +
        'configure path prefixes via the corresponding *_API_BASE_PATH environment variable.'
      );
    }

    return parsed.hostname || undefined;
  } catch (err) {
    console.warn(`Invalid API target ${sanitizeForLog(trimmed)}; expected a hostname (e.g. 'api.example.com') or URL`);
    return undefined;
  }
}

// Configurable API target hosts (supports custom endpoints / internal LLM routers)
// Values are normalized to bare hostnames — buildUpstreamPath() prepends https://
const OPENAI_API_TARGET = normalizeApiTarget(process.env.OPENAI_API_TARGET) || 'api.openai.com';
const ANTHROPIC_API_TARGET = normalizeApiTarget(process.env.ANTHROPIC_API_TARGET) || 'api.anthropic.com';
const GEMINI_API_TARGET = normalizeApiTarget(process.env.GEMINI_API_TARGET) || 'generativelanguage.googleapis.com';

/**
 * Normalizes a base path for use as a URL path prefix.
 * Ensures the path starts with '/' (if non-empty) and has no trailing '/'.
 * Returns '' for empty, null, or undefined inputs.
 *
 * @param {string|undefined|null} rawPath - The raw path value from env or config
 * @returns {string} Normalized path prefix (e.g. '/serving-endpoints') or ''
 */
function normalizeBasePath(rawPath) {
  if (!rawPath) return '';
  let path = rawPath.trim();
  if (!path) return '';
  // Ensure leading slash
  if (!path.startsWith('/')) {
    path = '/' + path;
  }
  // Strip trailing slash (but preserve a bare '/')
  if (path !== '/' && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path;
}

/**
 * Build the full upstream path by joining basePath, reqUrl's pathname, and query string.
 *
 * Examples:
 *   buildUpstreamPath('/v1/chat/completions', 'api.openai.com', '')
 *     → '/v1/chat/completions'
 *   buildUpstreamPath('/v1/chat/completions', 'host.databricks.com', '/serving-endpoints')
 *     → '/serving-endpoints/v1/chat/completions'
 *   buildUpstreamPath('/v1/messages?stream=true', 'host.com', '/anthropic')
 *     → '/anthropic/v1/messages?stream=true'
 *
 * @param {string} reqUrl - The incoming request URL (must start with '/')
 * @param {string} targetHost - The upstream hostname (used only to parse the URL)
 * @param {string} basePath - Normalized base path prefix (e.g. '/serving-endpoints' or '')
 * @returns {string} Full upstream path including query string
 */
function buildUpstreamPath(reqUrl, targetHost, basePath) {
  const targetUrl = new URL(reqUrl, `https://${targetHost}`);
  const prefix = basePath === '/' ? '' : basePath;
  return prefix + targetUrl.pathname + targetUrl.search;
}

// Optional base path prefixes for API targets (e.g. /serving-endpoints for Databricks)
const OPENAI_API_BASE_PATH = normalizeBasePath(process.env.OPENAI_API_BASE_PATH);
const ANTHROPIC_API_BASE_PATH = normalizeBasePath(process.env.ANTHROPIC_API_BASE_PATH);
const GEMINI_API_BASE_PATH = normalizeBasePath(process.env.GEMINI_API_BASE_PATH);

// Configurable Copilot API target host (supports GHES/GHEC / custom endpoints)
// Priority: COPILOT_API_TARGET env var > auto-derive from GITHUB_SERVER_URL > default
function deriveCopilotApiTarget() {
  if (process.env.COPILOT_API_TARGET) {
    return normalizeApiTarget(process.env.COPILOT_API_TARGET);
  }
  // Auto-derive from GITHUB_SERVER_URL:
  // - GitHub Enterprise Cloud (*.ghe.com): Copilot inference/models/MCP are served at
  //   copilot-api.<subdomain>.ghe.com (separate from the GitHub REST API at api.*)
  // - GitHub Enterprise Server (non-github.com, non-ghe.com) → api.enterprise.githubcopilot.com
  // - github.com → api.githubcopilot.com
  const serverUrl = process.env.GITHUB_SERVER_URL;
  if (serverUrl) {
    try {
      const hostname = new URL(serverUrl).hostname;
      if (hostname !== 'github.com') {
        // Check if this is a GHEC tenant (*.ghe.com)
        if (hostname.endsWith('.ghe.com')) {
          // Extract subdomain: mycompany.ghe.com → mycompany
          const subdomain = hostname.slice(0, -8); // Remove '.ghe.com'
          // GHEC routes Copilot inference to copilot-api.<subdomain>.ghe.com,
          // not to api.<subdomain>.ghe.com (which is the GitHub REST API)
          return `copilot-api.${subdomain}.ghe.com`;
        }
        // GHES (any other non-github.com hostname)
        return 'api.enterprise.githubcopilot.com';
      }
    } catch {
      // Invalid URL — fall through to default
    }
  }
  return 'api.githubcopilot.com';
}
const COPILOT_API_TARGET = deriveCopilotApiTarget();

// GitHub REST API target host for endpoints that need the GitHub REST API
// (e.g., enterprise-specific endpoints). Currently unused — /models is served
// by the Copilot API, not the REST API — but kept for future GHES/GHEC needs.
// Priority: GITHUB_API_URL env var (hostname extracted) > auto-derive from GITHUB_SERVER_URL > default
function deriveGitHubApiTarget() {
  // Explicit GITHUB_API_URL takes priority — this is the canonical source for enterprise deployments
  if (process.env.GITHUB_API_URL) {
    const target = normalizeApiTarget(process.env.GITHUB_API_URL);
    if (target) return target;
  }
  // Auto-derive from GITHUB_SERVER_URL for GHEC tenants (*.ghe.com)
  const serverUrl = process.env.GITHUB_SERVER_URL;
  if (serverUrl) {
    try {
      const hostname = new URL(serverUrl).hostname;
      if (hostname !== 'github.com' && hostname.endsWith('.ghe.com')) {
        // GHEC: GitHub REST API lives at api.<subdomain>.ghe.com
        const subdomain = hostname.slice(0, -8); // Remove '.ghe.com'
        return `api.${subdomain}.ghe.com`;
      }
    } catch {
      // Invalid URL — fall through to default
    }
  }
  return 'api.github.com';
}

/**
 * Extract the base path from GITHUB_API_URL for GHES deployments
 * (e.g. https://ghes.example.com/api/v3 → '/api/v3').
 * Returns '' for github.com or when no path component is present.
 */
function deriveGitHubApiBasePath() {
  const raw = process.env.GITHUB_API_URL;
  if (!raw) return '';
  try {
    const parsed = new URL(raw.trim().startsWith('http') ? raw.trim() : `https://${raw.trim()}`);
    const p = parsed.pathname.replace(/\/+$/, '');
    return p === '/' ? '' : p;
  } catch {
    return '';
  }
}

const GITHUB_API_TARGET = deriveGitHubApiTarget();
const GITHUB_API_BASE_PATH = deriveGitHubApiBasePath();

// Squid proxy configuration (set via HTTP_PROXY/HTTPS_PROXY in docker-compose)
const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

logRequest('info', 'startup', {
  message: 'Starting AWF API proxy sidecar',
  squid_proxy: HTTPS_PROXY || 'not configured',
  api_targets: {
    openai: OPENAI_API_TARGET,
    anthropic: ANTHROPIC_API_TARGET,
    gemini: GEMINI_API_TARGET,
    copilot: COPILOT_API_TARGET,
    github: GITHUB_API_TARGET,
  },
  api_base_paths: {
    openai: OPENAI_API_BASE_PATH || '(none)',
    anthropic: ANTHROPIC_API_BASE_PATH || '(none)',
    gemini: GEMINI_API_BASE_PATH || '(none)',
  },
  providers: {
    openai: !!OPENAI_API_KEY,
    anthropic: !!ANTHROPIC_API_KEY,
    gemini: !!GEMINI_API_KEY,
    copilot: !!COPILOT_AUTH_TOKEN,
    copilot_github_token: !!COPILOT_GITHUB_TOKEN,
    copilot_api_key: !!COPILOT_API_KEY,
  },
});

// Create proxy agent for routing through Squid
const proxyAgent = HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined;
if (!proxyAgent) {
  logRequest('warn', 'startup', { message: 'No HTTPS_PROXY configured, requests will go direct' });
}

/**
 * Check rate limit and send 429 if exceeded.
 * Returns true if request was rate-limited (caller should return early).
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

/**
 * Forward a request to the target API, injecting auth headers and routing through Squid.
 */
/** Validate that a request ID is safe (alphanumeric, dashes, dots, max 128 chars). */
function isValidRequestId(id) {
  return typeof id === 'string' && id.length <= 128 && /^[\w\-\.]+$/.test(id);
}

function proxyRequest(req, res, targetHost, injectHeaders, provider, basePath = '') {
  const clientRequestId = req.headers['x-request-id'];
  const requestId = isValidRequestId(clientRequestId) ? clientRequestId : generateRequestId();
  const startTime = Date.now();

  // Propagate request ID back to the client and forward to upstream
  res.setHeader('X-Request-ID', requestId);

  // Track active requests
  metrics.gaugeInc('active_requests', { provider });

  logRequest('info', 'request_start', {
    request_id: requestId,
    provider,
    method: req.method,
    path: sanitizeForLog(req.url),
    upstream_host: targetHost,
  });

  // Validate that req.url is a relative path (prevent open-redirect / SSRF)
  if (!req.url || !req.url.startsWith('/')) {
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

  // Build target URL
  const upstreamPath = buildUpstreamPath(req.url, targetHost, basePath);

  // Handle client-side errors (e.g. aborted connections)
  req.on('error', (err) => {
    if (errored) return; // Prevent double handling
    errored = true;
    const duration = Date.now() - startTime;
    metrics.gaugeDec('active_requests', { provider });
    metrics.increment('requests_errors_total', { provider });
    logRequest('error', 'request_error', {
      request_id: requestId,
      provider,
      method: req.method,
      path: sanitizeForLog(req.url),
      duration_ms: duration,
      error: sanitizeForLog(err.message),
      upstream_host: targetHost,
    });
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Client error', message: err.message }));
  });

  // Read the request body with size limit
  const chunks = [];
  let totalBytes = 0;
  let rejected = false;
  let errored = false;

  req.on('data', chunk => {
    if (rejected || errored) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_SIZE) {
      rejected = true;
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
      logRequest('warn', 'request_complete', {
        request_id: requestId,
        provider,
        method: req.method,
        path: sanitizeForLog(req.url),
        status: 413,
        duration_ms: duration,
        request_bytes: totalBytes,
        upstream_host: targetHost,
      });
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Payload Too Large', message: 'Request body exceeds 10 MB limit' }));
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (rejected || errored) return;
    const body = Buffer.concat(chunks);
    const requestBytes = body.length;

    metrics.increment('request_bytes_total', { provider }, requestBytes);

    // Copy incoming headers, stripping sensitive/proxy headers, then inject auth
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!shouldStripHeader(name)) {
        headers[name] = value;
      }
    }
    // Ensure X-Request-ID is forwarded to upstream
    headers['x-request-id'] = requestId;
    Object.assign(headers, injectHeaders);

    // Log auth header injection for debugging credential-isolation issues
    const injectedKey = injectHeaders['x-api-key'] || injectHeaders['authorization'];
    if (injectedKey) {
      const keyPreview = injectedKey.length > 8
        ? `${injectedKey.substring(0, 8)}...${injectedKey.substring(injectedKey.length - 4)}`
        : '(short)';
      logRequest('debug', 'auth_inject', {
        request_id: requestId,
        provider,
        key_length: injectedKey.length,
        key_preview: keyPreview,
        has_anthropic_version: !!headers['anthropic-version'],
      });
    }

    const options = {
      hostname: targetHost,
      port: 443,
      path: upstreamPath,
      method: req.method,
      headers,
      agent: proxyAgent, // Route through Squid
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let responseBytes = 0;

      proxyRes.on('data', (chunk) => {
        responseBytes += chunk.length;
      });

      // Handle response stream errors
      proxyRes.on('error', (err) => {
        const duration = Date.now() - startTime;
        metrics.gaugeDec('active_requests', { provider });
        metrics.increment('requests_errors_total', { provider });
        logRequest('error', 'request_error', {
          request_id: requestId,
          provider,
          method: req.method,
          path: sanitizeForLog(req.url),
          duration_ms: duration,
          error: sanitizeForLog(err.message),
          upstream_host: targetHost,
        });
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Response stream error', message: err.message }));
      });

      proxyRes.on('end', () => {
        const duration = Date.now() - startTime;
        const sc = metrics.statusClass(proxyRes.statusCode);
        metrics.gaugeDec('active_requests', { provider });
        metrics.increment('requests_total', { provider, method: req.method, status_class: sc });
        metrics.increment('response_bytes_total', { provider }, responseBytes);
        metrics.observe('request_duration_ms', duration, { provider });

        logRequest('info', 'request_complete', {
          request_id: requestId,
          provider,
          method: req.method,
          path: sanitizeForLog(req.url),
          status: proxyRes.statusCode,
          duration_ms: duration,
          request_bytes: requestBytes,
          response_bytes: responseBytes,
          upstream_host: targetHost,
        });
      });

      // Copy response headers and add X-Request-ID
      const resHeaders = { ...proxyRes.headers, 'x-request-id': requestId };

      // Log upstream auth failures prominently for debugging
      if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
        logRequest('warn', 'upstream_auth_error', {
          request_id: requestId,
          provider,
          status: proxyRes.statusCode,
          upstream_host: targetHost,
          path: sanitizeForLog(req.url),
          message: `Upstream returned ${proxyRes.statusCode} — check that the API key is valid and has not expired`,
        });
      }

      res.writeHead(proxyRes.statusCode, resHeaders);
      proxyRes.pipe(res);

      // Attach token usage tracking (non-blocking, listens on same data/end events)
      trackTokenUsage(proxyRes, {
        requestId,
        provider,
        path: sanitizeForLog(req.url),
        startTime,
        metrics,
      });
    });

    proxyReq.on('error', (err) => {
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_errors_total', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '5xx' });
      metrics.observe('request_duration_ms', duration, { provider });

      logRequest('error', 'request_error', {
        request_id: requestId,
        provider,
        method: req.method,
        path: sanitizeForLog(req.url),
        duration_ms: duration,
        error: sanitizeForLog(err.message),
        upstream_host: targetHost,
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
    });

    if (body.length > 0) {
      proxyReq.write(body);
    }
    proxyReq.end();
  });
}

/**
 * Handle a WebSocket upgrade request by tunnelling through the Squid proxy.
 *
 * Flow:
 *   client --[HTTP Upgrade]--> proxy --[CONNECT]--> Squid:3128 --[TLS]--> upstream:443
 *
 * Steps:
 *   1. Validate the request (WebSocket upgrade only, relative URL)
 *   2. Apply rate limiting (counts as one request, zero body bytes)
 *   3. Open a CONNECT tunnel to targetHost:443 through Squid
 *   4. TLS-handshake the tunnel
 *   5. Replay the HTTP Upgrade request with auth headers injected
 *   6. Bidirectionally pipe the raw TCP sockets
 *
 * No additional npm dependencies are required — only Node.js built-ins.
 *
 * @param {http.IncomingMessage} req - The incoming HTTP Upgrade request
 * @param {import('net').Socket} socket - Raw TCP socket to the WebSocket client
 * @param {Buffer} head - Any bytes already buffered after the upgrade headers
 * @param {string} targetHost - Upstream hostname (e.g. 'api.openai.com')
 * @param {Object} injectHeaders - Auth headers to inject (e.g. { Authorization: 'Bearer …' })
 * @param {string} provider - Provider name for logging and metrics
 * @param {string} [basePath=''] - Optional base-path prefix for the upstream URL
 */
function proxyWebSocket(req, socket, head, targetHost, injectHeaders, provider, basePath = '') {
  const startTime = Date.now();
  const clientRequestId = req.headers['x-request-id'];
  const requestId = isValidRequestId(clientRequestId) ? clientRequestId : generateRequestId();

  // ── Validate: only forward WebSocket upgrades ──────────────────────────
  const upgradeType = (req.headers['upgrade'] || '').toLowerCase();
  if (upgradeType !== 'websocket') {
    logRequest('warn', 'websocket_upgrade_rejected', {
      request_id: requestId,
      provider,
      path: sanitizeForLog(req.url),
      reason: 'unsupported upgrade type',
      upgrade: sanitizeForLog(req.headers['upgrade'] || ''),
    });
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // ── Validate: relative path only (prevent SSRF) ────────────────────────
  if (!req.url || !req.url.startsWith('/')) {
    logRequest('warn', 'websocket_upgrade_rejected', {
      request_id: requestId,
      provider,
      path: sanitizeForLog(req.url),
      reason: 'URL must be a relative path',
    });
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const upstreamPath = buildUpstreamPath(req.url, targetHost, basePath);

  // ── Rate limit (counts as one request, frames are not tracked) ──────────
  const rateCheck = limiter.check(provider, 0);
  if (!rateCheck.allowed) {
    metrics.increment('rate_limit_rejected_total', { provider, limit_type: rateCheck.limitType });
    logRequest('warn', 'rate_limited', {
      request_id: requestId,
      provider,
      limit_type: rateCheck.limitType,
      limit: rateCheck.limit,
      retry_after: rateCheck.retryAfter,
    });
    socket.write(
      `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rateCheck.retryAfter}\r\nConnection: close\r\n\r\n`
    );
    socket.destroy();
    return;
  }

  logRequest('info', 'websocket_upgrade_start', {
    request_id: requestId,
    provider,
    path: sanitizeForLog(req.url),
    upstream_host: targetHost,
  });
  metrics.gaugeInc('active_requests', { provider });

  // finalize() must be called exactly once when the WebSocket session ends.
  let finalized = false;
  function finalize(isError, description) {
    if (finalized) return;
    finalized = true;
    const duration = Date.now() - startTime;
    metrics.gaugeDec('active_requests', { provider });
    if (isError) {
      metrics.increment('requests_errors_total', { provider });
      logRequest('error', 'websocket_upgrade_failed', {
        request_id: requestId,
        provider,
        path: sanitizeForLog(req.url),
        duration_ms: duration,
        error: sanitizeForLog(String(description || 'unknown error')),
      });
    } else {
      metrics.increment('requests_total', { provider, method: 'GET', status_class: '1xx' });
      metrics.observe('request_duration_ms', duration, { provider });
      logRequest('info', 'websocket_upgrade_complete', {
        request_id: requestId,
        provider,
        path: sanitizeForLog(req.url),
        duration_ms: duration,
      });
    }
  }

  // abort(): called before the socket pipe is established (pre-TLS errors).
  // Sends a 502 to the client and finalizes with an error.
  function abort(reason, ...extra) {
    finalize(true, reason);
    if (!socket.destroyed && socket.writable) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
    socket.destroy();
    for (const s of extra) {
      if (s && !s.destroyed) s.destroy();
    }
  }

  // ── Require Squid proxy ────────────────────────────────────────────────
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

  // ── Step 1: CONNECT tunnel through Squid to targetHost:443 ────────────
  const connectReq = http.request({
    host: proxyHost,
    port: proxyPort,
    method: 'CONNECT',
    path: `${targetHost}:443`,
    headers: { 'Host': `${targetHost}:443` },
  });

  connectReq.once('error', (err) => abort(`CONNECT error: ${err.message}`));

  connectReq.once('connect', (connectRes, tunnel) => {
    if (connectRes.statusCode !== 200) {
      abort(`CONNECT failed: HTTP ${connectRes.statusCode}`, tunnel);
      return;
    }

    // ── Step 2: TLS-upgrade the raw tunnel ──────────────────────────────
    const tlsSocket = tls.connect({ socket: tunnel, servername: targetHost, rejectUnauthorized: true });

    // Pre-TLS error handler: removed once TLS is established.
    const onTlsError = (err) => abort(`TLS handshake error: ${err.message}`, tunnel);
    tlsSocket.once('error', onTlsError);

    tlsSocket.once('secureConnect', () => {
      // TLS connected — swap to post-connection teardown error handlers.
      tlsSocket.removeListener('error', onTlsError);

      // ── Step 3: Replay the HTTP Upgrade request with auth injected ────
      const forwardHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!shouldStripHeader(name)) {
          forwardHeaders[name] = value;
        }
      }
      Object.assign(forwardHeaders, injectHeaders);
      forwardHeaders['host'] = targetHost; // Fix Host header for upstream

      let upgradeReqStr = `GET ${upstreamPath} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(forwardHeaders)) {
        upgradeReqStr += `${name}: ${value}\r\n`;
      }
      upgradeReqStr += '\r\n';
      tlsSocket.write(upgradeReqStr);

      // Forward any bytes already buffered before the pipe
      if (head && head.length > 0) {
        tlsSocket.write(head);
      }

      // ── Step 4: Bidirectional raw socket relay ─────────────────────
      tlsSocket.pipe(socket);
      socket.pipe(tlsSocket);

      // Attach WebSocket token usage tracking (non-blocking, sniffs upstream frames)
      trackWebSocketTokenUsage(tlsSocket, {
        requestId,
        provider,
        path: sanitizeForLog(req.url),
        startTime,
        metrics,
      });

      // Finalize once when either side closes; destroy the other side.
      socket.once('close', () => { finalize(false); tlsSocket.destroy(); });
      tlsSocket.once('close', () => { finalize(false); socket.destroy(); });

      // Suppress unhandled-error crashes; destroy triggers the close handler.
      socket.on('error', () => socket.destroy());
      tlsSocket.on('error', () => tlsSocket.destroy());
    });
  });

  connectReq.end();
}

/**
 * Build the enhanced health response (superset of original format).
 */
function healthResponse() {
  return {
    status: 'healthy',
    service: 'awf-api-proxy',
    squid_proxy: HTTPS_PROXY || 'not configured',
    providers: {
      openai: !!OPENAI_API_KEY,
      anthropic: !!ANTHROPIC_API_KEY,
      gemini: !!GEMINI_API_KEY,
      copilot: !!COPILOT_AUTH_TOKEN,
    },
    metrics_summary: metrics.getSummary(),
    rate_limits: limiter.getAllStatus(),
  };
}

/**
 * Handle management endpoints on port 10000 (/health, /metrics).
 * Returns true if the request was handled, false otherwise.
 */
function handleManagementEndpoint(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthResponse()));
    return true;
  }
  if (req.method === 'GET' && req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics.getMetrics()));
    return true;
  }
  return false;
}

// Only start the server if this file is run directly (not imported for testing)
if (require.main === module) {
  // Health port is always 10000 — this is what Docker healthcheck hits
  const HEALTH_PORT = 10000;

  // OpenAI API proxy (port 10000)
  if (OPENAI_API_KEY) {
    const server = http.createServer((req, res) => {
      if (handleManagementEndpoint(req, res)) return;
      const contentLength = parseInt(req.headers['content-length'], 10) || 0;
      if (checkRateLimit(req, res, 'openai', contentLength)) return;

      proxyRequest(req, res, OPENAI_API_TARGET, {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      }, 'openai', OPENAI_API_BASE_PATH);
    });

    server.on('upgrade', (req, socket, head) => {
      proxyWebSocket(req, socket, head, OPENAI_API_TARGET, {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      }, 'openai', OPENAI_API_BASE_PATH);
    });

    server.listen(HEALTH_PORT, '0.0.0.0', () => {
      logRequest('info', 'server_start', { message: `OpenAI proxy listening on port ${HEALTH_PORT}`, target: OPENAI_API_TARGET });
    });
  } else {
    // No OpenAI key — still need a health endpoint on port 10000 for Docker healthcheck
    const server = http.createServer((req, res) => {
      if (handleManagementEndpoint(req, res)) return;

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OpenAI proxy not configured (no OPENAI_API_KEY)' }));
    });

    server.on('upgrade', (req, socket) => {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });

    server.listen(HEALTH_PORT, '0.0.0.0', () => {
      logRequest('info', 'server_start', { message: `Health endpoint listening on port ${HEALTH_PORT} (OpenAI not configured)` });
    });
  }

  // Anthropic API proxy (port 10001)
  if (ANTHROPIC_API_KEY) {
    const server = http.createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', service: 'anthropic-proxy' }));
        return;
      }

      const contentLength = parseInt(req.headers['content-length'], 10) || 0;
      if (checkRateLimit(req, res, 'anthropic', contentLength)) return;

      // Only set anthropic-version as default; preserve agent-provided version
      const anthropicHeaders = { 'x-api-key': ANTHROPIC_API_KEY };
      if (!req.headers['anthropic-version']) {
        anthropicHeaders['anthropic-version'] = '2023-06-01';
      }
      proxyRequest(req, res, ANTHROPIC_API_TARGET, anthropicHeaders, 'anthropic', ANTHROPIC_API_BASE_PATH);
    });

    server.on('upgrade', (req, socket, head) => {
      const anthropicHeaders = { 'x-api-key': ANTHROPIC_API_KEY };
      if (!req.headers['anthropic-version']) {
        anthropicHeaders['anthropic-version'] = '2023-06-01';
      }
      proxyWebSocket(req, socket, head, ANTHROPIC_API_TARGET, anthropicHeaders, 'anthropic', ANTHROPIC_API_BASE_PATH);
    });

    server.listen(10001, '0.0.0.0', () => {
      logRequest('info', 'server_start', { message: 'Anthropic proxy listening on port 10001', target: ANTHROPIC_API_TARGET });
    });
  }


  // GitHub Copilot API proxy (port 10002)
  // Supports COPILOT_GITHUB_TOKEN (GitHub OAuth) and COPILOT_API_KEY (BYOK direct key).
  // COPILOT_GITHUB_TOKEN takes precedence when both are set.
  if (COPILOT_AUTH_TOKEN) {
    const copilotServer = http.createServer((req, res) => {
      // Health check endpoint
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', service: 'copilot-proxy' }));
        return;
      }

      const contentLength = parseInt(req.headers['content-length'], 10) || 0;
      if (checkRateLimit(req, res, 'copilot', contentLength)) return;

      // Copilot CLI 1.0.21+ calls GET /models at startup (to list or validate models).
      // The /models endpoint lives on the Copilot inference API (COPILOT_API_TARGET),
      // NOT on the GitHub REST API. Explicitly use COPILOT_GITHUB_TOKEN for this
      // request so the GitHub OAuth token is used even when both COPILOT_GITHUB_TOKEN
      // and COPILOT_API_KEY are configured (COPILOT_API_KEY alone is not accepted by
      // the /models endpoint).
      let reqPathname;
      try {
        reqPathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        logRequest('warn', 'copilot_proxy_malformed_url', {
          message: 'Malformed request URL in Copilot proxy — rejecting with 400',
        });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request URL' }));
        return;
      }
      const isModelsPath = reqPathname === '/models' || reqPathname.startsWith('/models/');
      if (isModelsPath && req.method === 'GET' && COPILOT_GITHUB_TOKEN) {
        proxyRequest(req, res, COPILOT_API_TARGET, {
          'Authorization': `Bearer ${COPILOT_GITHUB_TOKEN}`,
        }, 'copilot');
        return;
      }

      proxyRequest(req, res, COPILOT_API_TARGET, {
        'Authorization': `Bearer ${COPILOT_AUTH_TOKEN}`,
      }, 'copilot');
    });

    copilotServer.on('upgrade', (req, socket, head) => {
      proxyWebSocket(req, socket, head, COPILOT_API_TARGET, {
        'Authorization': `Bearer ${COPILOT_AUTH_TOKEN}`,
      }, 'copilot');
    });

    copilotServer.listen(10002, '0.0.0.0', () => {
      logRequest('info', 'server_start', { message: 'GitHub Copilot proxy listening on port 10002' });
    });
  }

  // Google Gemini API proxy (port 10003)
  if (GEMINI_API_KEY) {
    const geminiServer = http.createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', service: 'gemini-proxy' }));
        return;
      }

      const contentLength = parseInt(req.headers['content-length'], 10) || 0;
      if (checkRateLimit(req, res, 'gemini', contentLength)) return;

      proxyRequest(req, res, GEMINI_API_TARGET, {
        'x-goog-api-key': GEMINI_API_KEY,
      }, 'gemini', GEMINI_API_BASE_PATH);
    });

    geminiServer.on('upgrade', (req, socket, head) => {
      proxyWebSocket(req, socket, head, GEMINI_API_TARGET, {
        'x-goog-api-key': GEMINI_API_KEY,
      }, 'gemini', GEMINI_API_BASE_PATH);
    });

    geminiServer.listen(10003, '0.0.0.0', () => {
      logRequest('info', 'server_start', { message: 'Google Gemini proxy listening on port 10003', target: GEMINI_API_TARGET });
    });
  } else {
    // No Gemini key — listen on port 10003 and return 503 so the Gemini CLI
    // gets an actionable error instead of a silent connection-refused.
    const geminiServer = http.createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not_configured', service: 'gemini-proxy', error: 'GEMINI_API_KEY not configured in api-proxy sidecar' }));
        return;
      }

      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gemini proxy not configured (no GEMINI_API_KEY). Set GEMINI_API_KEY in the AWF runner environment to enable credential isolation.' }));
    });

    geminiServer.on('upgrade', (req, socket) => {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });

    geminiServer.listen(10003, '0.0.0.0', () => {
      logRequest('info', 'server_start', { message: 'Gemini endpoint listening on port 10003 (Gemini not configured — returning 503)' });
    });
  }

  // OpenCode API proxy (port 10004) — dynamic provider routing
  // Defaults to Copilot/OpenAI routing (OPENAI_API_KEY), with Anthropic as a BYOK fallback.
  // OpenCode gets a separate port from Claude (10001) and Codex (10000) for per-engine
  // rate limiting and metrics isolation.
  //
  // Credential priority (first available wins):
  //   1. OPENAI_API_KEY  → OpenAI/Copilot-compatible route (OPENAI_API_TARGET)
  //   2. ANTHROPIC_API_KEY → Anthropic BYOK route (ANTHROPIC_API_TARGET)
  //   3. COPILOT_GITHUB_TOKEN / COPILOT_API_KEY → Copilot route (COPILOT_API_TARGET)
  if (OPENAI_API_KEY || ANTHROPIC_API_KEY || COPILOT_AUTH_TOKEN) {
    const opencodeServer = http.createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', service: 'opencode-proxy' }));
        return;
      }

      const logMethod = sanitizeForLog(req.method);
      const logUrl = sanitizeForLog(req.url);
      logRequest('info', 'opencode_proxy_request', {
        message: '[OpenCode Proxy] Incoming request',
        method: logMethod,
        url: logUrl,
      });

      if (OPENAI_API_KEY) {
        logRequest('info', 'opencode_proxy_header_injection', {
          message: '[OpenCode Proxy] Routing to OpenAI/Copilot via OPENAI_API_KEY',
          target: OPENAI_API_TARGET,
        });
        proxyRequest(req, res, OPENAI_API_TARGET, {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        }, 'opencode', OPENAI_API_BASE_PATH);
      } else if (ANTHROPIC_API_KEY) {
        logRequest('info', 'opencode_proxy_header_injection', {
          message: '[OpenCode Proxy] Routing to Anthropic via ANTHROPIC_API_KEY',
          target: ANTHROPIC_API_TARGET,
        });
        const anthropicHeaders = { 'x-api-key': ANTHROPIC_API_KEY };
        if (!req.headers['anthropic-version']) {
          anthropicHeaders['anthropic-version'] = '2023-06-01';
        }
        proxyRequest(req, res, ANTHROPIC_API_TARGET, anthropicHeaders, 'opencode', ANTHROPIC_API_BASE_PATH);
      } else {
        // COPILOT_AUTH_TOKEN only — route to Copilot API target
        logRequest('info', 'opencode_proxy_header_injection', {
          message: '[OpenCode Proxy] Routing to Copilot via COPILOT_AUTH_TOKEN',
          target: COPILOT_API_TARGET,
        });
        proxyRequest(req, res, COPILOT_API_TARGET, {
          'Authorization': `Bearer ${COPILOT_AUTH_TOKEN}`,
        }, 'opencode');
      }
    });

    opencodeServer.on('upgrade', (req, socket, head) => {
      if (OPENAI_API_KEY) {
        proxyWebSocket(req, socket, head, OPENAI_API_TARGET, {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        }, 'opencode', OPENAI_API_BASE_PATH);
      } else if (ANTHROPIC_API_KEY) {
        const anthropicHeaders = { 'x-api-key': ANTHROPIC_API_KEY };
        if (!req.headers['anthropic-version']) {
          anthropicHeaders['anthropic-version'] = '2023-06-01';
        }
        proxyWebSocket(req, socket, head, ANTHROPIC_API_TARGET, anthropicHeaders, 'opencode', ANTHROPIC_API_BASE_PATH);
      } else {
        proxyWebSocket(req, socket, head, COPILOT_API_TARGET, {
          'Authorization': `Bearer ${COPILOT_AUTH_TOKEN}`,
        }, 'opencode');
      }
    });

    opencodeServer.listen(10004, '0.0.0.0', () => {
      const routingTarget = OPENAI_API_KEY
        ? `OpenAI/Copilot at ${OPENAI_API_TARGET}`
        : ANTHROPIC_API_KEY
          ? `Anthropic at ${ANTHROPIC_API_TARGET}`
          : `Copilot at ${COPILOT_API_TARGET}`;
      logRequest('info', 'server_start', { message: `OpenCode proxy listening on port 10004 (-> ${routingTarget})` });
    });
  }

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logRequest('info', 'shutdown', { message: 'Received SIGTERM, shutting down gracefully' });
    await closeLogStream();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logRequest('info', 'shutdown', { message: 'Received SIGINT, shutting down gracefully' });
    await closeLogStream();
    process.exit(0);
  });
}

// Export for testing
module.exports = { normalizeApiTarget, deriveCopilotApiTarget, deriveGitHubApiTarget, deriveGitHubApiBasePath, normalizeBasePath, buildUpstreamPath, proxyWebSocket, resolveCopilotAuthToken };
