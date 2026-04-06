'use strict';
/**
 * CLI Proxy HTTP server
 *
 * Listens on port 11000 and provides two endpoints:
 *   GET  /health  - Health check (returns 200 JSON)
 *   POST /exec    - Execute a gh CLI command and return stdout/stderr/exitCode
 *
 * Security:
 *   - Subcommand allowlist enforced (read-only mode by default)
 *   - Args are exec'd directly via execFile (no shell, no injection)
 *   - Per-command timeout (default 30s)
 *   - Max output size limit to prevent memory exhaustion
 *
 * The gh CLI running inside this container has GH_HOST set to the mcpg proxy
 * (localhost:18443), so it never sees GH_TOKEN directly.
 */

const http = require('http');
const { execFile } = require('child_process');

const CLI_PROXY_PORT = parseInt(process.env.AWF_CLI_PROXY_PORT || '11000', 10);
const COMMAND_TIMEOUT_MS = parseInt(process.env.AWF_CLI_PROXY_TIMEOUT_MS || '30000', 10);
const MAX_OUTPUT_BYTES = parseInt(process.env.AWF_CLI_PROXY_MAX_OUTPUT_BYTES || String(10 * 1024 * 1024), 10);

// When AWF_CLI_PROXY_WRITABLE=true, allow write operations
const WRITABLE_MODE = process.env.AWF_CLI_PROXY_WRITABLE === 'true';

/**
 * Subcommands allowed in read-only mode.
 * These commands only retrieve data and do not modify any GitHub resources.
 */
const ALLOWED_SUBCOMMANDS_READONLY = new Set([
  'api',
  'browse',
  'cache',
  'codespace',
  'gist',
  'issue',
  'label',
  'org',
  'pr',
  'release',
  'repo',
  'run',
  'search',
  'secret',
  'variable',
  'workflow',
]);

/**
 * Actions that are blocked within their parent subcommand in read-only mode.
 * Maps subcommand -> Set of blocked action verbs.
 */
const BLOCKED_ACTIONS_READONLY = new Map([
  ['gist', new Set(['create', 'delete', 'edit'])],
  ['issue', new Set(['create', 'close', 'delete', 'edit', 'lock', 'pin', 'reopen', 'transfer', 'unpin'])],
  ['label', new Set(['create', 'delete', 'edit'])],
  ['pr', new Set(['checkout', 'close', 'create', 'edit', 'lock', 'merge', 'ready', 'reopen', 'review', 'update-branch'])],
  ['release', new Set(['create', 'delete', 'delete-asset', 'edit', 'upload'])],
  ['repo', new Set(['archive', 'create', 'delete', 'edit', 'fork', 'rename', 'set-default', 'sync', 'unarchive'])],
  ['run', new Set(['cancel', 'delete', 'download', 'rerun'])],
  ['secret', new Set(['delete', 'set'])],
  ['variable', new Set(['delete', 'set'])],
  ['workflow', new Set(['disable', 'enable', 'run'])],
]);

/**
 * Meta-commands that are always denied, even in write mode.
 * These modify gh itself rather than GitHub resources.
 */
const ALWAYS_DENIED_SUBCOMMANDS = new Set([
  'auth',
  'config',
  'extension',
]);

/**
 * Validates the gh CLI arguments against the subcommand allowlist.
 *
 * @param {string[]} args - The argument array (excluding 'gh' itself)
 * @param {boolean} writable - Whether write operations are permitted
 * @returns {{ valid: boolean, error?: string }}
 */
function validateArgs(args, writable) {
  if (!Array.isArray(args)) {
    return { valid: false, error: 'args must be an array' };
  }

  for (const arg of args) {
    if (typeof arg !== 'string') {
      return { valid: false, error: 'All args must be strings' };
    }
  }

  // Find the subcommand by scanning through args, skipping flags and their values.
  // Handles patterns like: gh --repo owner/repo pr list
  // Strategy: when we see --flag (without =), assume the next non-flag-like arg is its value.
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

  if (!writable) {
    // Read-only mode: check allowlist
    if (!ALLOWED_SUBCOMMANDS_READONLY.has(subcommand)) {
      return { valid: false, error: `Subcommand '${subcommand}' is not allowed in read-only mode. Enable write mode with --cli-proxy-writable.` };
    }

    // Check action-level blocklist
    const blockedActions = BLOCKED_ACTIONS_READONLY.get(subcommand);
    if (blockedActions) {
      // The action is the first non-flag argument after the subcommand
      const subcommandIndex = args.indexOf(subcommand);
      const action = args.slice(subcommandIndex + 1).find(a => !a.startsWith('-'));
      if (action && blockedActions.has(action)) {
        return {
          valid: false,
          error: `Action '${subcommand} ${action}' is not allowed in read-only mode. Enable write mode with --cli-proxy-writable.`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Read the full request body as a Buffer.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
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
  const body = JSON.stringify({ status: 'ok', service: 'cli-proxy', writable: WRITABLE_MODE });
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
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendError(res, 400, 'Invalid JSON body');
  }

  const { args, cwd, stdin, env: extraEnv } = body;

  // Validate args
  const validation = validateArgs(args, WRITABLE_MODE);
  if (!validation.valid) {
    return sendError(res, 403, validation.error);
  }

  // Build environment for the subprocess
  // Inherit server environment (includes GH_HOST, NODE_EXTRA_CA_CERTS, GH_REPO, etc.)
  const childEnv = Object.assign({}, process.env);
  if (extraEnv && typeof extraEnv === 'object') {
    // Only allow safe string env overrides; never allow overriding GH_HOST or GH_TOKEN
    const PROTECTED_KEYS = new Set(['GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_EXTRA_CA_CERTS']);
    for (const [key, value] of Object.entries(extraEnv)) {
      if (typeof key === 'string' && typeof value === 'string' && !PROTECTED_KEYS.has(key)) {
        childEnv[key] = value;
      }
    }
  }

  // Execute gh directly (no shell — prevents injection attacks)
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = await new Promise((resolve, reject) => {
      const child = execFile('gh', args, {
        cwd: cwd || process.cwd(),
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
    stderr = err.message || String(err);
    exitCode = 1;
  }

  const responseBody = JSON.stringify({ stdout, stderr, exitCode });
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
      console.error('[cli-proxy] Unhandled request error:', err);
      if (!res.headersSent) {
        sendError(res, 500, 'Internal server error');
      }
    });
  });

  server.listen(CLI_PROXY_PORT, '0.0.0.0', () => {
    console.log(`[cli-proxy] HTTP server listening on port ${CLI_PROXY_PORT} (writable=${WRITABLE_MODE})`);
  });

  server.on('error', err => {
    console.error('[cli-proxy] Server error:', err);
    process.exit(1);
  });
}

module.exports = { validateArgs, ALLOWED_SUBCOMMANDS_READONLY, BLOCKED_ACTIONS_READONLY, ALWAYS_DENIED_SUBCOMMANDS };
