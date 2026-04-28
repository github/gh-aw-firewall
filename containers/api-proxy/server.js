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
  'x-goog-api-key',
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
const COPILOT_INTEGRATION_ID = process.env.COPILOT_INTEGRATION_ID || 'copilot-developer-cli';
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
 * Applies provider-safe defaults and avoids duplicate prefixing when the incoming
 * path already includes the configured base path.
 *
 * Examples:
 *   buildUpstreamPath('/responses', 'api.openai.com', '')
 *     → '/v1/responses'
 *   buildUpstreamPath('/v1/chat/completions', 'host.databricks.com', '/serving-endpoints')
 *     → '/serving-endpoints/v1/chat/completions'
 *   buildUpstreamPath('/v1/messages?stream=true', 'host.com', '/anthropic')
 *     → '/anthropic/v1/messages?stream=true'
 *
 * @param {string} reqUrl - The incoming request URL (must start with '/' and not '//')
 * @param {string} targetHost - The upstream hostname (used only to parse the URL)
 * @param {string} basePath - Normalized base path prefix (e.g. '/serving-endpoints' or '')
 * @returns {string} Full upstream path including query string
 */
function buildUpstreamPath(reqUrl, targetHost, basePath) {
  if (typeof reqUrl !== 'string' || !reqUrl.startsWith('/') || reqUrl.startsWith('//')) {
    throw new Error('URL must be a relative origin-form path');
  }

  const targetUrl = new URL(reqUrl, `https://${targetHost}`);
  const pathname = targetUrl.pathname;
  let prefix = basePath === '/' ? '' : basePath;

  // OpenAI's canonical API paths are versioned under /v1, while some newer
  // clients (for example Codex CLI with OPENAI_BASE_URL pointing at the sidecar)
  // send unversioned paths like /responses. Add /v1 only for the default
  // OpenAI host when no explicit base path is configured.
  if (!prefix && targetUrl.hostname === 'api.openai.com') {
    prefix = '/v1';
  }

  if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return pathname + targetUrl.search;
  }

  return prefix + pathname + targetUrl.search;
}

/**
 * Strip all known Gemini API-key query parameters from a request URL.
 *
 * The @google/genai SDK (and older Gemini SDK versions) may append auth params
 * (`?key=`, `?apiKey=`, or `?api_key=`) to every request URL in addition to
 * setting the `x-goog-api-key` header.  The proxy injects the real key via the
 * header, so any placeholder param must be removed before forwarding to Google
 * to prevent API_KEY_INVALID errors.
 *
 * @param {string} reqUrl - The incoming request URL (must start with exactly one '/')
 * @returns {string} URL with all Gemini auth query parameters removed
 */
function stripGeminiKeyParam(reqUrl) {
  // Only operate on relative request paths that begin with exactly one slash.
  // Returning other inputs unchanged lets proxyRequest's relative-URL check reject them.
  // The guard prevents absolute URLs (e.g. 'http://evil.com/path?key=…') and
  // protocol-relative URLs ('//host/path') from being normalized into a relative path.
  if (typeof reqUrl !== 'string' || !reqUrl.startsWith('/') || reqUrl.startsWith('//')) {
    return reqUrl;
  }
  const parsed = new URL(reqUrl, 'http://localhost');
  parsed.searchParams.delete('key');
  parsed.searchParams.delete('apiKey');
  parsed.searchParams.delete('api_key');
  // Reconstruct relative path only — never emit the scheme/host from the dummy base.
  return parsed.pathname + parsed.search;
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
 * Resolves the OpenCode routing configuration based on available credentials.
 * Priority: OPENAI_API_KEY > ANTHROPIC_API_KEY > copilotToken (COPILOT_GITHUB_TOKEN / COPILOT_API_KEY)
 *
 * @param {string|undefined} openaiKey
 * @param {string|undefined} anthropicKey
 * @param {string|undefined} copilotToken
 * @param {string} openaiTarget
 * @param {string} anthropicTarget
 * @param {string} copilotTarget
 * @param {string} [openaiBasePath]
 * @param {string} [anthropicBasePath]
 * @returns {{ target: string, headers: Record<string,string>, basePath: string|undefined, needsAnthropicVersion: boolean } | null}
 */
function resolveOpenCodeRoute(openaiKey, anthropicKey, copilotToken, openaiTarget, anthropicTarget, copilotTarget, openaiBasePath, anthropicBasePath) {
  if (openaiKey) {
    return { target: openaiTarget, headers: { 'Authorization': `Bearer ${openaiKey}` }, basePath: openaiBasePath, needsAnthropicVersion: false };
  }
  if (anthropicKey) {
    return { target: anthropicTarget, headers: { 'x-api-key': anthropicKey }, basePath: anthropicBasePath, needsAnthropicVersion: true };
  }
  if (copilotToken) {
    return { target: copilotTarget, headers: { 'Authorization': `Bearer ${copilotToken}`, 'Copilot-Integration-Id': COPILOT_INTEGRATION_ID }, basePath: undefined, needsAnthropicVersion: false };
  }
  return null;
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
    // Use case-insensitive lookup since providers use mixed casing (e.g. 'Authorization' vs 'authorization')
    const injectedKey = Object.entries(injectHeaders).find(([k]) => ['x-api-key', 'authorization', 'x-goog-api-key'].includes(k.toLowerCase()))?.[1];
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
  if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//')) {
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
// ---------------------------------------------------------------------------
// Startup key validation
// ---------------------------------------------------------------------------

/**
 * Validation result for a single provider's API key.
 * @typedef {'pending'|'valid'|'auth_rejected'|'network_error'|'inconclusive'|'skipped'} ValidationStatus
 * @typedef {{ status: ValidationStatus, message: string }} ValidationResult
 */

/** @type {Record<string, ValidationResult>} */
const keyValidationResults = {};

/** Set to true once validateApiKeys() has finished (regardless of outcome). */
let keyValidationComplete = false;

/** Reset validation state (used in tests). */
function resetKeyValidationState() {
  for (const key of Object.keys(keyValidationResults)) {
    delete keyValidationResults[key];
  }
  keyValidationComplete = false;
}

/**
 * Perform a lightweight probe against the provider's API to check if the
 * configured key is still accepted.  Results are logged and stored in
 * `keyValidationResults` — the health endpoint exposes them.
 *
 * Validation is **non-blocking by default**: the proxy still serves traffic
 * even if a key is rejected.  Set AWF_VALIDATE_KEYS=strict to exit(1) on
 * any auth rejection.
 *
 * Only validates against known default targets.  Custom/enterprise targets
 * are skipped because we don't know what probe endpoints they expose.
 *
 * @param {object} [overrides={}] - Optional key/target overrides (used in tests)
 * @param {string} [overrides.openaiKey] - Override OPENAI_API_KEY
 * @param {string} [overrides.openaiTarget] - Override OPENAI_API_TARGET
 * @param {string} [overrides.anthropicKey] - Override ANTHROPIC_API_KEY
 * @param {string} [overrides.anthropicTarget] - Override ANTHROPIC_API_TARGET
 * @param {string} [overrides.copilotGithubToken] - Override COPILOT_GITHUB_TOKEN
 * @param {string} [overrides.copilotApiKey] - Override COPILOT_API_KEY
 * @param {string} [overrides.copilotAuthToken] - Override COPILOT_AUTH_TOKEN
 * @param {string} [overrides.copilotTarget] - Override COPILOT_API_TARGET
 * @param {string} [overrides.copilotIntegrationId] - Override COPILOT_INTEGRATION_ID
 * @param {string} [overrides.geminiKey] - Override GEMINI_API_KEY
 * @param {string} [overrides.geminiTarget] - Override GEMINI_API_TARGET
 * @param {number} [overrides.timeoutMs] - Override probe timeout
 */
async function validateApiKeys(overrides = {}) {
  const mode = (process.env.AWF_VALIDATE_KEYS || 'warn').toLowerCase(); // off | warn | strict
  if (mode === 'off') {
    logRequest('info', 'key_validation', { message: 'Key validation disabled (AWF_VALIDATE_KEYS=off)' });
    keyValidationComplete = true;
    return;
  }

  const ov = (key, fallback) => key in overrides ? overrides[key] : fallback;
  const openaiKey = ov('openaiKey', OPENAI_API_KEY);
  const openaiTarget = ov('openaiTarget', OPENAI_API_TARGET);
  const anthropicKey = ov('anthropicKey', ANTHROPIC_API_KEY);
  const anthropicTarget = ov('anthropicTarget', ANTHROPIC_API_TARGET);
  const copilotGithubToken = ov('copilotGithubToken', COPILOT_GITHUB_TOKEN);
  const copilotApiKey = ov('copilotApiKey', COPILOT_API_KEY);
  const copilotAuthToken = ov('copilotAuthToken', COPILOT_AUTH_TOKEN);
  const copilotTarget = ov('copilotTarget', COPILOT_API_TARGET);
  const copilotIntegrationId = ov('copilotIntegrationId', COPILOT_INTEGRATION_ID);
  const geminiKey = ov('geminiKey', GEMINI_API_KEY);
  const geminiTarget = ov('geminiTarget', GEMINI_API_TARGET);
  const TIMEOUT_MS = ov('timeoutMs', 10_000);

  const probes = [];

  // --- Copilot (COPILOT_GITHUB_TOKEN only — COPILOT_API_KEY has no probe endpoint) ---
  if (copilotGithubToken) {
    if (copilotTarget !== 'api.githubcopilot.com') {
      keyValidationResults.copilot = { status: 'skipped', message: `Custom target ${copilotTarget}; validation skipped` };
      logRequest('info', 'key_validation', { provider: 'copilot', ...keyValidationResults.copilot });
    } else {
      probes.push(probeProvider('copilot', `https://${copilotTarget}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${copilotGithubToken}`,
          'Copilot-Integration-Id': copilotIntegrationId,
        },
      }, TIMEOUT_MS));
    }
  } else if (copilotApiKey && !copilotGithubToken) {
    keyValidationResults.copilot = { status: 'skipped', message: 'COPILOT_API_KEY configured but startup validation is not supported for this auth mode' };
    logRequest('info', 'key_validation', { provider: 'copilot', ...keyValidationResults.copilot });
  }

  // --- OpenAI ---
  if (openaiKey) {
    if (openaiTarget !== 'api.openai.com') {
      keyValidationResults.openai = { status: 'skipped', message: `Custom target ${openaiTarget}; validation skipped` };
      logRequest('info', 'key_validation', { provider: 'openai', ...keyValidationResults.openai });
    } else {
      probes.push(probeProvider('openai', `https://${openaiTarget}/v1/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${openaiKey}` },
      }, TIMEOUT_MS));
    }
  }

  // --- Anthropic ---
  if (anthropicKey) {
    if (anthropicTarget !== 'api.anthropic.com') {
      keyValidationResults.anthropic = { status: 'skipped', message: `Custom target ${anthropicTarget}; validation skipped` };
      logRequest('info', 'key_validation', { provider: 'anthropic', ...keyValidationResults.anthropic });
    } else {
      // POST /v1/messages with an empty body — 400 = key valid (bad body), 401 = key invalid
      probes.push(probeProvider('anthropic', `https://${anthropicTarget}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: '{}',
      }, TIMEOUT_MS));
    }
  }

  // --- Gemini ---
  if (geminiKey) {
    if (geminiTarget !== 'generativelanguage.googleapis.com') {
      keyValidationResults.gemini = { status: 'skipped', message: `Custom target ${geminiTarget}; validation skipped` };
      logRequest('info', 'key_validation', { provider: 'gemini', ...keyValidationResults.gemini });
    } else {
      probes.push(probeProvider('gemini', `https://${geminiTarget}/v1beta/models`, {
        method: 'GET',
        headers: { 'x-goog-api-key': geminiKey },
      }, TIMEOUT_MS));
    }
  }

  if (probes.length === 0) {
    logRequest('info', 'key_validation', { message: 'No providers to validate' });
    keyValidationComplete = true;
    return;
  }

  await Promise.allSettled(probes);
  keyValidationComplete = true;

  // Summarize
  const failures = Object.entries(keyValidationResults)
    .filter(([, r]) => r.status === 'auth_rejected');

  if (failures.length > 0) {
    for (const [provider, result] of failures) {
      logRequest('error', 'key_validation_failed', {
        provider,
        message: `${provider.toUpperCase()} API key validation failed — ${result.message}. Rotate the secret and re-run.`,
      });
    }
    if (mode === 'strict') {
      logRequest('error', 'key_validation_strict_exit', {
        message: `AWF_VALIDATE_KEYS=strict: exiting due to ${failures.length} auth failure(s)`,
        providers: failures.map(([p]) => p),
      });
      process.exit(1);
    }
  } else {
    logRequest('info', 'key_validation', { message: 'All configured API keys validated successfully' });
  }
}

/**
 * Probe a single provider to check if the API key is accepted.
 *
 * @param {string} provider - Provider name (copilot, openai, etc.)
 * @param {string} url - Probe URL
 * @param {{ method: string, headers: Record<string,string>, body?: string }} opts
 * @param {number} timeoutMs
 */
async function probeProvider(provider, url, opts, timeoutMs) {
  keyValidationResults[provider] = { status: 'pending', message: 'Validating...' };
  try {
    const status = await httpProbe(url, opts, timeoutMs);

    if (status >= 200 && status < 300) {
      keyValidationResults[provider] = { status: 'valid', message: `HTTP ${status}` };
      logRequest('info', 'key_validation', { provider, status: 'valid', httpStatus: status });
    } else if (status === 401 || status === 403) {
      keyValidationResults[provider] = { status: 'auth_rejected', message: `HTTP ${status} — token expired or invalid` };
      logRequest('warn', 'key_validation', { provider, status: 'auth_rejected', httpStatus: status });
    } else if (status === 400) {
      // 400 for Anthropic means key is valid but request body was bad — expected
      keyValidationResults[provider] = { status: 'valid', message: `HTTP ${status} (auth accepted, probe body rejected)` };
      logRequest('info', 'key_validation', { provider, status: 'valid', httpStatus: status, note: 'probe body rejected but auth accepted' });
    } else {
      keyValidationResults[provider] = { status: 'inconclusive', message: `HTTP ${status}` };
      logRequest('warn', 'key_validation', { provider, status: 'inconclusive', httpStatus: status });
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    keyValidationResults[provider] = { status: 'network_error', message };
    logRequest('warn', 'key_validation', { provider, status: 'network_error', error: message });
  }
}

/**
 * Make an HTTPS request through the proxy and return the HTTP status code.
 *
 * @param {string} url
 * @param {{ method: string, headers: Record<string,string>, body?: string }} opts
 * @param {number} timeoutMs
 * @returns {Promise<number>} HTTP status code
 */
function httpProbe(url, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method,
      headers: { ...opts.headers },
      ...(isHttps && proxyAgent ? { agent: proxyAgent } : {}),
      timeout: timeoutMs,
    };

    let settled = false;
    const resolveOnce = (statusCode) => {
      if (settled) return;
      settled = true;
      resolve(statusCode);
    };
    const rejectOnce = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = mod.request(reqOpts, (res) => {
      // Consume body to free the socket
      res.resume();
      res.on('end', () => resolveOnce(res.statusCode));
      res.on('error', rejectOnce);
      res.on('close', () => resolveOnce(res.statusCode));
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Probe timed out after ${timeoutMs}ms`));
    });
    req.on('error', rejectOnce);

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

/**
 * Make an HTTPS/HTTP request through the proxy and return parsed JSON response.
 * Returns null on any error, non-2xx status, or parse failure.
 *
 * @param {string} url
 * @param {{ method: string, headers: Record<string,string> }} opts
 * @param {number} timeoutMs
 * @returns {Promise<object|null>}
 */
function fetchJson(url, opts, timeoutMs) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method,
      headers: { ...opts.headers },
      ...(isHttps && proxyAgent ? { agent: proxyAgent } : {}),
      timeout: timeoutMs,
    };

    let settled = false;
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = mod.request(reqOpts, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        resolveOnce(null);
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolveOnce(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          resolveOnce(null);
        }
      });
      res.on('error', (err) => {
        logRequest('debug', 'fetch_json_error', { url: sanitizeForLog(url), error: String(err && err.message ? err.message : err) });
        resolveOnce(null);
      });
      // Guard against connection drops mid-body that never emit 'end' or 'error'
      res.on('close', () => resolveOnce(null));
    });

    req.on('timeout', () => {
      const err = new Error(`fetchJson timed out after ${timeoutMs}ms`);
      logRequest('debug', 'fetch_json_timeout', { url: sanitizeForLog(url), timeout_ms: timeoutMs });
      req.destroy(err);
    });
    req.on('error', (err) => {
      logRequest('debug', 'fetch_json_error', { url: sanitizeForLog(url), error: String(err && err.message ? err.message : err) });
      resolveOnce(null);
    });
    req.end();
  });
}

/**
 * Prefix used by the Gemini models API in model name fields.
 * Example: { name: "models/gemini-1.5-pro" } → "gemini-1.5-pro"
 */
const GEMINI_MODEL_NAME_PREFIX = 'models/';

/**
 * Extract model IDs from a provider API response.
 * Handles:
 *   - OpenAI / Anthropic / Copilot format: { data: [{ id }, ...] }
 *   - Gemini format: { models: [{ name: "models/gemini-1.5-pro" }, ...] }
 *
 * @param {object|null} json - Parsed API response
 * @returns {string[]|null} Sorted array of model IDs, or null if unavailable
 */
function extractModelIds(json) {
  if (!json || typeof json !== 'object') return null;

  // OpenAI / Anthropic / Copilot format: { data: [{ id: "..." }, ...] }
  if (Array.isArray(json.data)) {
    const ids = json.data
      .map((m) => m && (m.id || m.name))
      .filter(Boolean);
    return ids.length > 0 ? ids.sort() : null;
  }

  // Gemini format: { models: [{ name: "models/gemini-1.5-pro", ... }, ...] }
  if (Array.isArray(json.models)) {
    const ids = json.models
      .map((m) => m && m.name && m.name.startsWith(GEMINI_MODEL_NAME_PREFIX)
        ? m.name.slice(GEMINI_MODEL_NAME_PREFIX.length)
        : (m && m.name) || null)
      .filter(Boolean);
    return ids.length > 0 ? ids.sort() : null;
  }

  return null;
}

/**
 * Cache for available models per provider, populated at startup by fetchStartupModels.
 * null = not yet fetched or fetch failed for this provider.
 * @type {Record<string, string[]|null>}
 */
const cachedModels = {};

/** Set to true once fetchStartupModels() has run (regardless of success). */
let modelFetchComplete = false;

/** Reset model cache state (used in tests). */
function resetModelCacheState() {
  for (const key of Object.keys(cachedModels)) {
    delete cachedModels[key];
  }
  modelFetchComplete = false;
}

/**
 * Fetch available models for each configured provider and cache them.
 * Called at startup alongside key validation.
 *
 * Accepts the same override map as validateApiKeys() so tests can inject
 * custom keys and targets without touching process.env.
 *
 * @param {object} [overrides={}] - Optional key/target overrides (used in tests)
 */
async function fetchStartupModels(overrides = {}) {
  const ov = (key, fallback) => key in overrides ? overrides[key] : fallback;
  const openaiKey = ov('openaiKey', OPENAI_API_KEY);
  const openaiTarget = ov('openaiTarget', OPENAI_API_TARGET);
  const anthropicKey = ov('anthropicKey', ANTHROPIC_API_KEY);
  const anthropicTarget = ov('anthropicTarget', ANTHROPIC_API_TARGET);
  const copilotGithubToken = ov('copilotGithubToken', COPILOT_GITHUB_TOKEN);
  const copilotAuthToken = ov('copilotAuthToken', COPILOT_AUTH_TOKEN);
  const copilotTarget = ov('copilotTarget', COPILOT_API_TARGET);
  const copilotIntegrationId = ov('copilotIntegrationId', COPILOT_INTEGRATION_ID);
  const geminiKey = ov('geminiKey', GEMINI_API_KEY);
  const geminiTarget = ov('geminiTarget', GEMINI_API_TARGET);
  const TIMEOUT_MS = ov('timeoutMs', 10_000);

  const fetches = [];

  if (openaiKey) {
    fetches.push(
      fetchJson(`https://${openaiTarget}/v1/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${openaiKey}` },
      }, TIMEOUT_MS).then((json) => {
        cachedModels.openai = extractModelIds(json);
      })
    );
  }

  if (anthropicKey) {
    fetches.push(
      fetchJson(`https://${anthropicTarget}/v1/models`, {
        method: 'GET',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      }, TIMEOUT_MS).then((json) => {
        cachedModels.anthropic = extractModelIds(json);
      })
    );
  }

  // Only use COPILOT_GITHUB_TOKEN (GitHub OAuth) for /models — COPILOT_API_KEY (BYOK) is not
  // accepted by the Copilot /models endpoint (consistent with validateApiKeys behaviour).
  if (copilotGithubToken) {
    fetches.push(
      fetchJson(`https://${copilotTarget}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${copilotGithubToken}`,
          'Copilot-Integration-Id': copilotIntegrationId,
        },
      }, TIMEOUT_MS).then((json) => {
        cachedModels.copilot = extractModelIds(json);
      })
    );
  }

  if (geminiKey) {
    fetches.push(
      fetchJson(`https://${geminiTarget}/v1beta/models`, {
        method: 'GET',
        headers: { 'x-goog-api-key': geminiKey },
      }, TIMEOUT_MS).then((json) => {
        cachedModels.gemini = extractModelIds(json);
      })
    );
  }

  await Promise.allSettled(fetches);
  modelFetchComplete = true;
}

/**
 * Build the reflection response describing all proxy endpoints and their available models.
 *
 * The reflection endpoint allows agent harnesses to dynamically discover which
 * LLM providers are configured and what models are available, enabling intelligent
 * provider and model selection based on the task at hand.
 *
 * @returns {{ endpoints: Array<object>, models_fetch_complete: boolean }}
 */
function reflectEndpoints() {
  const opencodeConfigured = !!(OPENAI_API_KEY || ANTHROPIC_API_KEY || COPILOT_AUTH_TOKEN);
  return {
    endpoints: [
      {
        provider: 'openai',
        port: 10000,
        base_url: 'http://api-proxy:10000',
        configured: !!OPENAI_API_KEY,
        models: cachedModels.openai || null,
        models_url: 'http://api-proxy:10000/v1/models',
      },
      {
        provider: 'anthropic',
        port: 10001,
        base_url: 'http://api-proxy:10001',
        configured: !!ANTHROPIC_API_KEY,
        models: cachedModels.anthropic || null,
        models_url: 'http://api-proxy:10001/v1/models',
      },
      {
        provider: 'copilot',
        port: 10002,
        base_url: 'http://api-proxy:10002',
        configured: !!COPILOT_AUTH_TOKEN,
        models: cachedModels.copilot || null,
        models_url: 'http://api-proxy:10002/models',
      },
      {
        provider: 'gemini',
        port: 10003,
        base_url: 'http://api-proxy:10003',
        configured: !!GEMINI_API_KEY,
        models: cachedModels.gemini || null,
        models_url: 'http://api-proxy:10003/v1beta/models',
      },
      {
        provider: 'opencode',
        port: 10004,
        base_url: 'http://api-proxy:10004',
        configured: opencodeConfigured,
        // OpenCode routes to one of the above providers; query them directly for models
        models: null,
        models_url: null,
      },
    ],
    models_fetch_complete: modelFetchComplete,
  };
}

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
    key_validation: {
      complete: keyValidationComplete,
      results: keyValidationResults,
    },
    metrics_summary: metrics.getSummary(),
    rate_limits: limiter.getAllStatus(),
  };
}

/**
 * Handle management endpoints on port 10000 (/health, /metrics, /reflect).
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
  if (req.method === 'GET' && req.url === '/reflect') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reflectEndpoints()));
    return true;
  }
  return false;
}

// Only start the server if this file is run directly (not imported for testing)
if (require.main === module) {
  // Health port is always 10000 — this is what Docker healthcheck hits
  const HEALTH_PORT = 10000;

  // Startup latch: count listeners that participate in key validation.
  // The no-key Gemini 503 handler binds port 10003 but doesn't participate
  // in validation, so it's intentionally excluded from the count.
  let expectedListeners = 1; // port 10000 (always)
  if (ANTHROPIC_API_KEY) expectedListeners++;
  if (COPILOT_AUTH_TOKEN) expectedListeners++;
  if (GEMINI_API_KEY) expectedListeners++;
  if (OPENAI_API_KEY || ANTHROPIC_API_KEY || COPILOT_AUTH_TOKEN) expectedListeners++; // OpenCode (10004)
  let readyListeners = 0;
  function onListenerReady() {
    readyListeners++;
    if (readyListeners === expectedListeners) {
      logRequest('info', 'startup_complete', { message: `All ${expectedListeners} validation-participating listeners ready, starting key validation` });
      validateApiKeys().catch((err) => {
        logRequest('error', 'key_validation_error', { message: 'Unexpected error during key validation', error: String(err) });
        keyValidationComplete = true;
      });
      fetchStartupModels().catch((err) => {
        logRequest('error', 'model_fetch_error', { message: 'Unexpected error fetching startup models', error: String(err) });
        modelFetchComplete = true;
      });
    }
  }

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
      onListenerReady();
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
      onListenerReady();
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
      onListenerReady();
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
          'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
        }, 'copilot');
        return;
      }

      proxyRequest(req, res, COPILOT_API_TARGET, {
        'Authorization': `Bearer ${COPILOT_AUTH_TOKEN}`,
        'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
      }, 'copilot');
    });

    copilotServer.on('upgrade', (req, socket, head) => {
      proxyWebSocket(req, socket, head, COPILOT_API_TARGET, {
        'Authorization': `Bearer ${COPILOT_AUTH_TOKEN}`,
        'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
      }, 'copilot');
    });

    copilotServer.listen(10002, '0.0.0.0', () => {
      logRequest('info', 'server_start', { message: 'GitHub Copilot proxy listening on port 10002' });
      onListenerReady();
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

      // Strip any auth query params (?key=, ?apiKey=, ?api_key=) — the SDK may append them.
      // The proxy injects the real key via x-goog-api-key header instead.
      req.url = stripGeminiKeyParam(req.url);

      proxyRequest(req, res, GEMINI_API_TARGET, {
        'x-goog-api-key': GEMINI_API_KEY,
      }, 'gemini', GEMINI_API_BASE_PATH);
    });

    geminiServer.on('upgrade', (req, socket, head) => {
      // Strip any auth query params (?key=, ?apiKey=, ?api_key=) — the SDK may append them.
      req.url = stripGeminiKeyParam(req.url);
      proxyWebSocket(req, socket, head, GEMINI_API_TARGET, {
        'x-goog-api-key': GEMINI_API_KEY,
      }, 'gemini', GEMINI_API_BASE_PATH);
    });

    logRequest('info', 'server_start', { message: `GEMINI_API_KEY configured (length=${GEMINI_API_KEY.length})` });
    geminiServer.listen(10003, '0.0.0.0', () => {
      logRequest('info', 'server_start', { message: 'Google Gemini proxy listening on port 10003', target: GEMINI_API_TARGET });
      onListenerReady();
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

    logRequest('warn', 'server_start', { message: 'GEMINI_API_KEY not set — Gemini proxy will return 503' });
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
  //   1. OPENAI_API_KEY                  → OpenAI/Copilot-compatible route (OPENAI_API_TARGET)
  //   2. ANTHROPIC_API_KEY               → Anthropic BYOK route (ANTHROPIC_API_TARGET)
  //   3. COPILOT_GITHUB_TOKEN/API_KEY    → Copilot route (COPILOT_API_TARGET),
  //                                        resolved internally to COPILOT_AUTH_TOKEN
  const opencodeStartupRoute = resolveOpenCodeRoute(
    OPENAI_API_KEY, ANTHROPIC_API_KEY, COPILOT_AUTH_TOKEN,
    OPENAI_API_TARGET, ANTHROPIC_API_TARGET, COPILOT_API_TARGET,
    OPENAI_API_BASE_PATH, ANTHROPIC_API_BASE_PATH
  );
  if (opencodeStartupRoute) {
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

      const parsedContentLength = Number(req.headers['content-length']);
      const contentLength = Number.isFinite(parsedContentLength) && parsedContentLength > 0 ? parsedContentLength : 0;
      if (checkRateLimit(req, res, 'opencode', contentLength)) {
        return;
      }

      const route = resolveOpenCodeRoute(
        OPENAI_API_KEY, ANTHROPIC_API_KEY, COPILOT_AUTH_TOKEN,
        OPENAI_API_TARGET, ANTHROPIC_API_TARGET, COPILOT_API_TARGET,
        OPENAI_API_BASE_PATH, ANTHROPIC_API_BASE_PATH
      );
      if (!route) {
        logRequest('error', 'opencode_no_credentials', { message: '[OpenCode Proxy] No credentials available; cannot route request' });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'OpenCode proxy has no credentials configured' }));
        return;
      }

      logRequest('info', 'opencode_proxy_routing_target', {
        message: `[OpenCode Proxy] Routing to ${route.target}`,
        target: route.target,
      });

      const headers = Object.assign({}, route.headers);
      if (route.needsAnthropicVersion && !req.headers['anthropic-version']) {
        headers['anthropic-version'] = '2023-06-01';
      }
      proxyRequest(req, res, route.target, headers, 'opencode', route.basePath);
    });

    opencodeServer.on('upgrade', (req, socket, head) => {
      const route = resolveOpenCodeRoute(
        OPENAI_API_KEY, ANTHROPIC_API_KEY, COPILOT_AUTH_TOKEN,
        OPENAI_API_TARGET, ANTHROPIC_API_TARGET, COPILOT_API_TARGET,
        OPENAI_API_BASE_PATH, ANTHROPIC_API_BASE_PATH
      );
      if (!route) {
        logRequest('error', 'opencode_no_credentials', { message: '[OpenCode Proxy] No credentials available; cannot upgrade WebSocket' });
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const headers = Object.assign({}, route.headers);
      if (route.needsAnthropicVersion && !req.headers['anthropic-version']) {
        headers['anthropic-version'] = '2023-06-01';
      }
      proxyWebSocket(req, socket, head, route.target, headers, 'opencode', route.basePath);
    });

    opencodeServer.listen(10004, '0.0.0.0', () => {
      logRequest('info', 'server_start', { message: `OpenCode proxy listening on port 10004 (-> ${opencodeStartupRoute.target})` });
      onListenerReady();
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
module.exports = { normalizeApiTarget, deriveCopilotApiTarget, deriveGitHubApiTarget, deriveGitHubApiBasePath, normalizeBasePath, buildUpstreamPath, proxyWebSocket, resolveCopilotAuthToken, resolveOpenCodeRoute, shouldStripHeader, stripGeminiKeyParam, validateApiKeys, probeProvider, httpProbe, keyValidationResults, resetKeyValidationState, fetchJson, extractModelIds, fetchStartupModels, reflectEndpoints, cachedModels, resetModelCacheState };
