'use strict';
/**
 * CLI Proxy HTTP server
 *
 * Listens on port 11000 and provides two endpoints:
 *   GET  /health  - Health check (returns 200 JSON)
 *   POST /exec    - Execute a gh CLI command and return stdout/stderr/exitCode
 *
 * Security:
 *   - Args are exec'd directly via execFile (no shell, no injection)
 *   - Per-command timeout (default 30s)
 *   - Max output size limit to prevent memory exhaustion
 *   - Meta-commands (auth, config, extension) are always denied
 *
 * The gh CLI running inside this container has GH_HOST set to the DIFC proxy
 * (localhost:18443 via TCP tunnel), so it never sees GH_TOKEN directly.
 * Write control is handled by the DIFC guard policy, not by this server.
 */

const http = require('http');
const { accessLog } = require('./access-log');
const { COMMAND_TIMEOUT_MS, runGhCommand } = require('./gh-runner');
const { validateArgs, ALWAYS_DENIED_SUBCOMMANDS, PROTECTED_ENV_KEYS, buildExecEnv } = require('./security');

const CLI_PROXY_PORT = parseInt(process.env.AWF_CLI_PROXY_PORT || '11000', 10);

/**
 * Maximum size for the /exec request body (1 MB).
 * Prevents memory exhaustion from oversized POST bodies.
 */
const MAX_REQUEST_BODY_BYTES = parseInt(process.env.AWF_CLI_PROXY_MAX_REQUEST_BYTES || String(1024 * 1024), 10);

/**
 * Read the full request body as a Buffer, rejecting bodies over MAX_REQUEST_BODY_BYTES.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<Buffer|null>} Buffer on success, null if size limit exceeded (response already sent)
 */
function readBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        req.destroy();
        sendError(res, 413, `Request body exceeds maximum size of ${MAX_REQUEST_BODY_BYTES} bytes`);
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (totalBytes <= MAX_REQUEST_BODY_BYTES) {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON error response.
 *
 * @param {import('http').ServerResponse} res
 * @param {number} statusCode
 * @param {string} message
 */
function sendError(res, statusCode, message) {
  const body = JSON.stringify({ error: message });
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Handle GET /health
 */
function handleHealth(res) {
  const body = JSON.stringify({ status: 'ok', service: 'cli-proxy' });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Handle POST /exec
 *
 * Expected request body (JSON):
 * {
 *   "args": ["pr", "list", "--repo", "owner/repo", "--json", "number,title"],
 *   "cwd": "/home/runner/work/repo/repo",   // optional
 *   "stdin": null,                           // optional, base64-encoded or null
 *   "env": { "GH_REPO": "owner/repo" }      // optional extra env vars
 * }
 *
 * Response body (JSON):
 * {
 *   "stdout": "...",
 *   "stderr": "...",
 *   "exitCode": 0
 * }
 */
async function handleExec(req, res) {
  const startTime = Date.now();
  let body;
  try {
    const raw = await readBody(req, res);
    // null means readBody already sent a 413 error response
    if (raw === null) return;
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    accessLog({ event: 'exec_error', error: 'Invalid JSON body' });
    return sendError(res, 400, 'Invalid JSON body');
  }

  const { args, cwd, stdin, env: extraEnv } = body;

  // Validate args
  const validation = validateArgs(args);
  if (!validation.valid) {
    accessLog({ event: 'exec_denied', args, error: validation.error });
    return sendError(res, 403, validation.error);
  }

  accessLog({ event: 'exec_start', args, cwd: cwd || null });

  const childEnv = buildExecEnv(extraEnv);
  const { stdout, stderr, exitCode } = await runGhCommand(args, childEnv, stdin);

  const responseBody = JSON.stringify({ stdout, stderr, exitCode });

  const durationMs = Date.now() - startTime;
  accessLog({
    event: 'exec_done',
    args,
    exitCode,
    durationMs,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    // Include truncated stderr for debugging failures (redact tokens)
    ...(exitCode !== 0 && stderr ? { stderrPreview: stderr.slice(0, 500) } : {}),
  });

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(responseBody),
  });
  res.end(responseBody);
}

/**
 * Main HTTP request handler.
 */
async function requestHandler(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    return handleHealth(res);
  }

  if (req.method === 'POST' && req.url === '/exec') {
    return handleExec(req, res);
  }

  return sendError(res, 404, `Not found: ${req.method} ${req.url}`);
}

// Only start the server when run directly (not when imported for testing)
if (require.main === module) {
  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch(err => {
      accessLog({ event: 'unhandled_error', error: err.message });
      if (!res.headersSent) {
        sendError(res, 500, 'Internal server error');
      }
    });
  });

  // Bind on '::' to accept both IPv4 and IPv6 connections (dual-stack).
  // On Linux the default net.ipv6only=0 means '::' also accepts IPv4 traffic,
  // so this is equivalent to 0.0.0.0 + [::] in one bind call.  This prevents
  // health-check failures on dual-stack hosts where Docker resolves `localhost`
  // to [::1] but a server listening only on 0.0.0.0 would reject that connection.
  server.listen(CLI_PROXY_PORT, '::', () => {
    accessLog({
      event: 'server_start',
      port: CLI_PROXY_PORT,
      timeoutMs: COMMAND_TIMEOUT_MS,
      ghHost: process.env.GH_HOST || '(not set)',
      caCert: process.env.NODE_EXTRA_CA_CERTS || '(not set)',
      hasGhToken: !!process.env.GH_TOKEN,
    });
    console.log(`[cli-proxy] HTTP server listening on port ${CLI_PROXY_PORT}`);
  });

  server.on('error', err => {
    accessLog({ event: 'server_error', error: err.message });
    console.error('[cli-proxy] Server error:', err);
    process.exit(1);
  });
}

module.exports = { validateArgs, ALWAYS_DENIED_SUBCOMMANDS, PROTECTED_ENV_KEYS, buildExecEnv, runGhCommand };
