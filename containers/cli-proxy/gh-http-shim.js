'use strict';
/**
 * Local HTTP shim between the gh CLI and the external DIFC proxy.
 *
 * The cli-proxy points gh at GH_HOST=localhost:<port>. go-gh treats every host
 * that is not github.com (or a *.ghe.com tenancy) as GitHub Enterprise Server,
 * so feature detection (e.g. `gh pr list --search`, `gh search prs`) calls
 * `GET /api/v3/meta` and parses `installed_version`. The DIFC proxy forwards
 * that request to api.github.com, whose /meta response has no such field, and
 * gh fails with "malformed version: ".
 *
 * gh is configured (via `http_unix_socket` in GH_CONFIG_DIR/config.yml) to send
 * its API requests as plain HTTP over a Unix socket served by this shim. The
 * shim forwards every request unchanged over TLS to GH_HOST and, only for
 * `GET /api/v3/meta`, injects a synthetic `installed_version` when the upstream
 * response lacks one. git traffic (e.g. `gh repo clone`) does not use this
 * socket and keeps talking to GH_HOST directly.
 *
 * Usage: node gh-http-shim.js <socketPath>
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');

// The upstream behind the DIFC proxy is github.com, which is at least as new as
// any GHES release, so report a version above every gh feature-detection cutoff.
const DEFAULT_INSTALLED_VERSION = '999.0.0';
const META_PATH = '/api/v3/meta';
const MAX_META_BODY_BYTES = 5 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function sanitizeForLog(value) {
  return String(value).replace(/[\r\n]/g, '');
}

function stripHopByHopHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      result[name] = value;
    }
  }
  return result;
}

function isMetaRequest(method, url) {
  if (method !== 'GET' || typeof url !== 'string') return false;
  const queryIndex = url.indexOf('?');
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  return pathname === META_PATH;
}

/**
 * Add `installed_version` to a /meta JSON body when it is missing or empty.
 * Non-JSON or non-object bodies are returned unchanged.
 *
 * @param {Buffer} body
 * @param {string} installedVersion
 * @returns {Buffer}
 */
function patchMetaBody(body, installedVersion) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  if (typeof parsed.installed_version === 'string' && parsed.installed_version !== '') return body;
  parsed.installed_version = installedVersion;
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

/**
 * Parse GH_HOST ("host", "host:port", "[v6]:port") into an upstream target.
 *
 * @param {string} ghHost
 * @returns {{ host: string, port: number, servername?: string }}
 */
function parseGhHost(ghHost) {
  if (typeof ghHost !== 'string' || ghHost.trim() === '') {
    throw new Error('GH_HOST is not set');
  }
  const parsed = new URL(`https://${ghHost.trim()}`);
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = parsed.port ? parseInt(parsed.port, 10) : 443;
  return net.isIP(host) ? { host, port } : { host, port, servername: host };
}

function sendShimError(res, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ message });
  res.writeHead(502, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Build the request handler that forwards gh traffic to the DIFC proxy.
 *
 * @param {{ host: string, port: number, servername?: string }} upstream
 * @param {{ installedVersion?: string, requestFn?: typeof https.request }} [options]
 */
function createShimHandler(upstream, options = {}) {
  const installedVersion = options.installedVersion || DEFAULT_INSTALLED_VERSION;
  const requestFn = options.requestFn || https.request;

  return function handle(req, res) {
    const meta = isMetaRequest(req.method, req.url);
    const headers = stripHopByHopHeaders(req.headers);
    if (meta) {
      // Keep the /meta response uncompressed so it can be patched.
      headers['accept-encoding'] = 'identity';
    }

    const upstreamReq = requestFn({
      host: upstream.host,
      port: upstream.port,
      ...(upstream.servername ? { servername: upstream.servername } : {}),
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes) => {
      const responseHeaders = stripHopByHopHeaders(upstreamRes.headers);
      const status = upstreamRes.statusCode || 502;
      const encoding = String(upstreamRes.headers['content-encoding'] || 'identity').toLowerCase();

      if (!meta || status < 200 || status >= 300 || encoding !== 'identity') {
        res.writeHead(status, responseHeaders);
        upstreamRes.pipe(res);
        return;
      }

      const chunks = [];
      let total = 0;
      upstreamRes.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_META_BODY_BYTES) {
          upstreamRes.destroy();
          sendShimError(res, 'Upstream /meta response too large');
          return;
        }
        chunks.push(chunk);
      });
      upstreamRes.on('end', () => {
        if (res.headersSent) return;
        const body = patchMetaBody(Buffer.concat(chunks), installedVersion);
        responseHeaders['content-length'] = body.length;
        res.writeHead(status, responseHeaders);
        res.end(body);
      });
      upstreamRes.on('error', (err) => {
        sendShimError(res, `Upstream response error: ${err.message}`);
      });
    });

    upstreamReq.on('error', (err) => {
      console.error(`[gh-http-shim] Upstream error: ${sanitizeForLog(err.message)}`);
      sendShimError(res, `cli-proxy could not reach DIFC proxy: ${err.message}`);
    });
    req.on('error', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  };
}

function main() {
  const socketPath = process.argv[2];
  if (!socketPath) {
    console.error('[gh-http-shim] Usage: node gh-http-shim.js <socketPath>');
    process.exit(1);
  }

  let upstream;
  try {
    upstream = parseGhHost(process.env.GH_HOST);
  } catch (err) {
    console.error(`[gh-http-shim] Invalid GH_HOST: ${sanitizeForLog(err.message)}`);
    process.exit(1);
  }

  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const server = http.createServer(createShimHandler(upstream));
  server.on('error', (err) => {
    console.error(`[gh-http-shim] Server error: ${sanitizeForLog(err.message)}`);
    process.exit(1);
  });
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    console.log(`[gh-http-shim] Listening on ${sanitizeForLog(socketPath)} → ${sanitizeForLog(upstream.host)}:${upstream.port}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_INSTALLED_VERSION,
  createShimHandler,
  isMetaRequest,
  parseGhHost,
  patchMetaBody,
};
