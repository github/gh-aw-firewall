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

/** Sanitize a string for safe logging (strip control chars, limit length). */
function sanitizeForLog(str) {
  if (typeof str !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
}

// Read API keys from environment (set by docker-compose)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const COPILOT_GITHUB_TOKEN = process.env.COPILOT_GITHUB_TOKEN;

// Squid proxy configuration (set via HTTP_PROXY/HTTPS_PROXY in docker-compose)
const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

console.log('[API Proxy] Starting AWF API proxy sidecar...');
console.log(`[API Proxy] HTTPS_PROXY: ${HTTPS_PROXY}`);
if (OPENAI_API_KEY) {
  console.log('[API Proxy] OpenAI API key configured');
}
if (ANTHROPIC_API_KEY) {
  console.log('[API Proxy] Anthropic API key configured');
}
if (COPILOT_GITHUB_TOKEN) {
  console.log('[API Proxy] GitHub Copilot token configured');
}

// Create proxy agent for routing through Squid
const proxyAgent = HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined;
if (!proxyAgent) {
  console.warn('[API Proxy] WARNING: No HTTPS_PROXY configured, requests will go direct');
}

/**
 * Forward a request to the target API, injecting auth headers and routing through Squid.
 */
function proxyRequest(req, res, targetHost, injectHeaders) {
  // Validate that req.url is a relative path (prevent open-redirect / SSRF)
  if (!req.url || !req.url.startsWith('/')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Request', message: 'URL must be a relative path' }));
    return;
  }

  // Build target URL
  const targetUrl = new URL(req.url, `https://${targetHost}`);

  // Handle client-side errors (e.g. aborted connections)
  req.on('error', (err) => {
    console.error(`[API Proxy] Client request error: ${sanitizeForLog(err.message)}`);
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Client error', message: err.message }));
  });

  // Read the request body with size limit
  const chunks = [];
  let totalBytes = 0;
  let rejected = false;

  req.on('data', chunk => {
    if (rejected) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_SIZE) {
      rejected = true;
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Payload Too Large', message: 'Request body exceeds 10 MB limit' }));
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (rejected) return;
    const body = Buffer.concat(chunks);

    // Copy incoming headers, stripping sensitive/proxy headers, then inject auth
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!shouldStripHeader(name)) {
        headers[name] = value;
      }
    }
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
      // Handle response stream errors
      proxyRes.on('error', (err) => {
        console.error(`[API Proxy] Response stream error from ${targetHost}: ${sanitizeForLog(err.message)}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Response stream error', message: err.message }));
      });

      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`[API Proxy] Error proxying to ${targetHost}: ${sanitizeForLog(err.message)}`);
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

// Health port is always 10000 — this is what Docker healthcheck hits
const HEALTH_PORT = 10000;

// OpenAI API proxy (port 10000)
if (OPENAI_API_KEY) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'awf-api-proxy',
        squid_proxy: HTTPS_PROXY || 'not configured',
        providers: { openai: true, anthropic: !!ANTHROPIC_API_KEY, copilot: !!COPILOT_GITHUB_TOKEN },
      }));
      return;
    }

    console.log(`[OpenAI Proxy] ${sanitizeForLog(req.method)} ${sanitizeForLog(req.url)}`);
    console.log(`[OpenAI Proxy] Injecting Authorization header with OPENAI_API_KEY`);
    proxyRequest(req, res, 'api.openai.com', {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    });
  });

  server.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[API Proxy] OpenAI proxy listening on port ${HEALTH_PORT}`);
  });
} else {
  // No OpenAI key — still need a health endpoint on port 10000 for Docker healthcheck
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'awf-api-proxy',
        squid_proxy: HTTPS_PROXY || 'not configured',
        providers: { openai: false, anthropic: !!ANTHROPIC_API_KEY, copilot: !!COPILOT_GITHUB_TOKEN },
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'OpenAI proxy not configured (no OPENAI_API_KEY)' }));
  });

  server.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[API Proxy] Health endpoint listening on port ${HEALTH_PORT} (OpenAI not configured)`);
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

    console.log(`[Anthropic Proxy] ${sanitizeForLog(req.method)} ${sanitizeForLog(req.url)}`);
    console.log(`[Anthropic Proxy] Injecting x-api-key header with ANTHROPIC_API_KEY`);
    // Only set anthropic-version as default; preserve agent-provided version
    const anthropicHeaders = { 'x-api-key': ANTHROPIC_API_KEY };
    if (!req.headers['anthropic-version']) {
      anthropicHeaders['anthropic-version'] = '2023-06-01';
    }
    proxyRequest(req, res, 'api.anthropic.com', anthropicHeaders);
  });

  server.listen(10001, '0.0.0.0', () => {
    console.log('[API Proxy] Anthropic proxy listening on port 10001');
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

    // Log and proxy the request
    console.log(`[Copilot Proxy] ${sanitizeForLog(req.method)} ${sanitizeForLog(req.url)}`);
    console.log(`[Copilot Proxy] Injecting Authorization header with COPILOT_GITHUB_TOKEN`);
    proxyRequest(req, res, 'api.githubcopilot.com', {
      'Authorization': `Bearer ${COPILOT_GITHUB_TOKEN}`,
    });
  });

  copilotServer.listen(10002, '0.0.0.0', () => {
    console.log('[API Proxy] GitHub Copilot proxy listening on port 10002');
  });
}
// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[API Proxy] Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[API Proxy] Received SIGINT, shutting down gracefully...');
  process.exit(0);
});
