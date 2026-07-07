'use strict';

// Environment keys that agents are not allowed to override via the /exec env field.
// GH_HOST / GH_TOKEN / GITHUB_TOKEN — prevent auth/routing hijack.
// NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / GIT_SSL_CAINFO — prevent TLS trust-store bypass.
const _PROTECTED_ENV_KEYS = new Set(['GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO']);
const PROTECTED_ENV_KEYS = Object.freeze({
  has(key) { return _PROTECTED_ENV_KEYS.has(key); },
  get size() { return _PROTECTED_ENV_KEYS.size; },
  values() { return _PROTECTED_ENV_KEYS.values(); },
  keys() { return _PROTECTED_ENV_KEYS.keys(); },
  entries() { return _PROTECTED_ENV_KEYS.entries(); },
  forEach(callback, thisArg) { return _PROTECTED_ENV_KEYS.forEach(callback, thisArg); },
  [Symbol.iterator]() { return _PROTECTED_ENV_KEYS[Symbol.iterator](); },
});

const UNSAFE_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
 * Build the environment object for a subprocess by inheriting the server's environment
 * and applying caller-supplied overrides, excluding any PROTECTED_ENV_KEYS.
 *
 * Security-critical: ensures agents cannot override auth or TLS trust-store variables.
 *
 * @param {Record<string, string>|null|undefined} extraEnv - Optional caller-supplied env overrides
 * @returns {NodeJS.ProcessEnv} The merged environment for the child process
 */
function buildExecEnv(extraEnv) {
  // Inherit server environment (includes GH_HOST, NODE_EXTRA_CA_CERTS, GH_REPO, etc.)
  const childEnv = Object.assign({}, process.env);
  if (extraEnv && typeof extraEnv === 'object') {
    // Only allow safe string env overrides; never allow overriding keys in PROTECTED_ENV_KEYS.
    for (const [key, value] of Object.entries(extraEnv)) {
      if (
        typeof key === 'string'
        && typeof value === 'string'
        && !PROTECTED_ENV_KEYS.has(key)
        && !UNSAFE_ENV_KEYS.has(key)
      ) {
        childEnv[key] = value;
      }
    }
  }
  return childEnv;
}

module.exports = {
  ALWAYS_DENIED_SUBCOMMANDS,
  PROTECTED_ENV_KEYS,
  UNSAFE_ENV_KEYS,
  validateArgs,
  buildExecEnv,
};
