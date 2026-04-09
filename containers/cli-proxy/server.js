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
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CLI_PROXY_PORT = parseInt(process.env.AWF_CLI_PROXY_PORT || '11000', 10);
const COMMAND_TIMEOUT_MS = parseInt(process.env.AWF_CLI_PROXY_TIMEOUT_MS || '30000', 10);
const MAX_OUTPUT_BYTES = parseInt(process.env.AWF_CLI_PROXY_MAX_OUTPUT_BYTES || String(10 * 1024 * 1024), 10);

// Environment keys that agents are not allowed to override via the /exec env field.
// GH_HOST / GH_TOKEN / GITHUB_TOKEN — prevent auth/routing hijack.
// NODE_EXTRA_CA_CERTS / SSL_CERT_FILE — prevent TLS trust-store bypass.
const _PROTECTED_ENV_KEYS = new Set(['GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']);
const PROTECTED_ENV_KEYS = Object.freeze({
  has(key) { return _PROTECTED_ENV_KEYS.has(key); },
  get size() { return _PROTECTED_ENV_KEYS.size; },
  values() { return _PROTECTED_ENV_KEYS.values(); },
  keys() { return _PROTECTED_ENV_KEYS.keys(); },
  entries() { return _PROTECTED_ENV_KEYS.entries(); },
  forEach(callback, thisArg) { return _PROTECTED_ENV_KEYS.forEach(callback, thisArg); },
  [Symbol.iterator]() { return _PROTECTED_ENV_KEYS[Symbol.iterator](); },
});

// --- Structured logging to /var/log/cli-proxy/access.log ---

const LOG_DIR = process.env.AWF_CLI_PROXY_LOG_DIR || '/var/log/cli-proxy';
const LOG_FILE = path.join(LOG_DIR, 'access.log');

let logStream = null;
try {
  if (fs.existsSync(LOG_DIR)) {
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  }
} catch {
  // Non-fatal: logging to file is best-effort
}

/**
 * Write a structured JSON log entry to the access log file and stderr.
 * Each line is a self-contained JSON object for easy parsing.
 */
function accessLog(entry) {
  const record = { ts: new Date().toISOString(), ...entry };
  const line = JSON.stringify(record);
  if (logStream) {
    logStream.write(line + '\n');
  }
  // Also emit to stderr so docker logs captures it
  console.error(line);
}

/**
 * Meta-commands that are always denied.
 * These modify gh itself rather than GitHub resources.
 */
const ALWAYS_DENIED_SUBCOMMANDS = new Set([
  'alias',
  'auth',
  'config',
  'extension',
]);

/**
 * Validates the gh CLI arguments.
 * Write control is handled by the DIFC guard policy — this server only
 * blocks meta-commands that modify gh CLI itself.
 *
 * @param {string[]} args - The argument array (excluding 'gh' itself)
 * @returns {{ valid: boolean, error?: string }}
 */
function validateArgs(args) {
  if (!Array.isArray(args)) {
    return { valid: false, error: 'args must be an array' };
  }

  for (const arg of args) {
    if (typeof arg !== 'string') {
      return { valid: false, error: 'All args must be strings' };
    }
  }

  // Find the subcommand by scanning through args, skipping flags and their values.
  let subcommand = null;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        // Flag with a separate value (e.g., --repo owner/repo): skip both
        i += 2;
      } else {
        // Boolean flag or --flag=value form: skip just the flag
        i += 1;
      }
    } else {
      subcommand = arg;
      break;
    }
  }

  // No subcommand means flags-only invocation (e.g., --version, --help) — allow
  if (!subcommand) {
    return { valid: true };
  }

  // Always deny meta-commands
  if (ALWAYS_DENIED_SUBCOMMANDS.has(subcommand)) {
    return { valid: false, error: `Subcommand '${subcommand}' is not permitted` };
  }

  return { valid: true };
}

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

  // Build environment for the subprocess
  // Inherit server environment (includes GH_HOST, NODE_EXTRA_CA_CERTS, GH_REPO, etc.)
  const childEnv = Object.assign({}, process.env);
  if (extraEnv && typeof extraEnv === 'object') {
    // Only allow safe string env overrides; never allow overriding keys in PROTECTED_ENV_KEYS.
    const PROTECTED_KEYS = PROTECTED_ENV_KEYS;
    for (const [key, value] of Object.entries(extraEnv)) {
      if (typeof key === 'string' && typeof value === 'string' && !PROTECTED_KEYS.has(key)) {
        childEnv[key] = value;
      }
    }
  }

  // Execute gh directly (no shell — prevents injection attacks)
  // Always use the server's own cwd — the agent sends its container workspace
  // path which doesn't exist inside the cli-proxy container.
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = await new Promise((resolve, reject) => {
      const child = execFile('gh', args, {
        cwd: process.cwd(),
        env: childEnv,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
      }, (err, childStdout, childStderr) => {
        if (err && err.code === undefined && err.signal) {
          // Killed by timeout or signal
          reject(err);
          return;
        }
        resolve({
          stdout: childStdout || '',
          stderr: childStderr || '',
          exitCode: err ? (err.code || 1) : 0,
        });
      });

      // Feed stdin if provided (base64-encoded)
      if (stdin) {
        try {
          const stdinBuf = Buffer.from(stdin, 'base64');
          child.stdin.write(stdinBuf);
        } catch {
          // Ignore stdin errors
        }
      }
      if (child.stdin) {
        child.stdin.end();
      }
    });

    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
  } catch (err) {
    // Only expose a safe message, not a full stack trace
    const errMsg = err instanceof Error ? err.message : 'Command execution failed';
    stderr = errMsg;
    exitCode = 1;
  }

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

  server.listen(CLI_PROXY_PORT, '0.0.0.0', () => {
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

module.exports = { validateArgs, ALWAYS_DENIED_SUBCOMMANDS, PROTECTED_ENV_KEYS };
