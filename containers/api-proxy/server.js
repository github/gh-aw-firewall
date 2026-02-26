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
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { generateRequestId, sanitizeForLog, logRequest } = require('./logging');
const metrics = require('./metrics');
const rateLimiter = require('./rate-limiter');

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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const COPILOT_GITHUB_TOKEN = process.env.COPILOT_GITHUB_TOKEN;

// Configurable Copilot API target host (supports GHES/GHEC / custom endpoints)
// Priority: COPILOT_API_TARGET env var > auto-derive from GITHUB_SERVER_URL > default
function deriveCopilotApiTarget() {
  if (process.env.COPILOT_API_TARGET) {
    return process.env.COPILOT_API_TARGET;
  }
  // For GitHub Enterprise Cloud (*.ghe.com) or GitHub Enterprise Server
  // (any GITHUB_SERVER_URL that isn't https://github.com), route to the
  // enterprise Copilot API endpoint instead of the individual one.
  const serverUrl = process.env.GITHUB_SERVER_URL;
  if (serverUrl) {
    try {
      const hostname = new URL(serverUrl).hostname;
      if (hostname !== 'github.com') {
        return 'api.enterprise.githubcopilot.com';
      }
    } catch {
      // Invalid URL — fall through to default
    }
  }
  return 'api.githubcopilot.com';
}
const COPILOT_API_TARGET = deriveCopilotApiTarget();

// Squid proxy configuration (set via HTTP_PROXY/HTTPS_PROXY in docker-compose)
const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

logRequest('info', 'startup', {
  message: 'Starting AWF API proxy sidecar',
  squid_proxy: HTTPS_PROXY || 'not configured',
  copilot_api_target: COPILOT_API_TARGET,
  providers: {
    openai: !!OPENAI_API_KEY,
    anthropic: !!ANTHROPIC_API_KEY,
    copilot: !!COPILOT_GITHUB_TOKEN,
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

function proxyRequest(req, res, targetHost, injectHeaders, provider) {
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
  const targetUrl = new URL(req.url, `https://${targetHost}`);

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

    const options = {
      hostname: targetHost,
      port: 443,
      path: targetUrl.pathname + targetUrl.search,
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
      res.writeHead(proxyRes.statusCode, resHeaders);
      proxyRes.pipe(res);
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
      copilot: !!COPILOT_GITHUB_TOKEN,
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

// Health port is always 10000 — this is what Docker healthcheck hits
const HEALTH_PORT = 10000;

// OpenAI API proxy (port 10000)
if (OPENAI_API_KEY) {
  const server = http.createServer((req, res) => {
    if (handleManagementEndpoint(req, res)) return;
    const contentLength = parseInt(req.headers['content-length'], 10) || 0;
    if (checkRateLimit(req, res, 'openai', contentLength)) return;

    proxyRequest(req, res, 'api.openai.com', {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    }, 'openai');
  });

  server.listen(HEALTH_PORT, '0.0.0.0', () => {
    logRequest('info', 'server_start', { message: `OpenAI proxy listening on port ${HEALTH_PORT}` });
  });
} else {
  // No OpenAI key — still need a health endpoint on port 10000 for Docker healthcheck
  const server = http.createServer((req, res) => {
    if (handleManagementEndpoint(req, res)) return;

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'OpenAI proxy not configured (no OPENAI_API_KEY)' }));
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
    proxyRequest(req, res, 'api.anthropic.com', anthropicHeaders, 'anthropic');
  });

  server.listen(10001, '0.0.0.0', () => {
    logRequest('info', 'server_start', { message: 'Anthropic proxy listening on port 10001' });
  });
}


// GitHub Copilot API proxy (port 10002)
if (COPILOT_GITHUB_TOKEN) {
  const copilotServer = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', service: 'copilot-proxy' }));
      return;
    }

    const contentLength = parseInt(req.headers['content-length'], 10) || 0;
    if (checkRateLimit(req, res, 'copilot', contentLength)) return;

    proxyRequest(req, res, COPILOT_API_TARGET, {
      'Authorization': `Bearer ${COPILOT_GITHUB_TOKEN}`,
    }, 'copilot');
  });

  copilotServer.listen(10002, '0.0.0.0', () => {
    logRequest('info', 'server_start', { message: 'GitHub Copilot proxy listening on port 10002' });
  });
}

// OpenCode API proxy (port 10004) — routes to Anthropic (default BYOK provider)
// OpenCode gets a separate port from Claude (10001) for per-engine rate limiting,
// metrics isolation, and future provider routing (OpenCode is BYOK and may route
// to different providers in the future based on model prefix).
if (ANTHROPIC_API_KEY) {
  const opencodeServer = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', service: 'opencode-proxy' }));
      return;
    }

    const logMethod = sanitizeForLog(req.method);
    const logUrl = sanitizeForLog(req.url);
    console.log(`[OpenCode Proxy] ${logMethod} ${logUrl}`);
    console.log('[OpenCode Proxy] Injecting x-api-key header with ANTHROPIC_API_KEY');
    const anthropicHeaders = { 'x-api-key': ANTHROPIC_API_KEY };
    if (!req.headers['anthropic-version']) {
      anthropicHeaders['anthropic-version'] = '2023-06-01';
    }
    proxyRequest(req, res, 'api.anthropic.com', anthropicHeaders);
  });

  opencodeServer.listen(10004, '0.0.0.0', () => {
    console.log('[API Proxy] OpenCode proxy listening on port 10004 (-> Anthropic)');
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logRequest('info', 'shutdown', { message: 'Received SIGTERM, shutting down gracefully' });
  process.exit(0);
});

process.on('SIGINT', () => {
  logRequest('info', 'shutdown', { message: 'Received SIGINT, shutting down gracefully' });
  process.exit(0);
});
