'use strict';

const { CHILD_ENV_KEYS, FORCED_CHILD_ENV, buildExecEnv } = require('./security/env');
const {
  ALWAYS_DENIED_SUBCOMMANDS,
  DENIED_COMMAND_PATHS,
  resolveCommandPath,
} = require('./security/command-policy');
const {
  validateEnclaveArgs,
  summarizeEnclaveArgs,
  extractInvocationCapability,
  capabilityAuditContext,
} = require('./security/enclave');
const { validateFileInputArgs } = require('./security/file-inputs');

const EXEC_REQUEST_KEYS = new Set(['args', 'stdin']);
const HELPER_LAUNCH_FLAGS = new Set(['--web', '--browser', '--editor']);

function validateExecRequest(body, enclaveMode) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'Request body must be a JSON object' };
  }
  if (Object.keys(body).some((key) => !EXEC_REQUEST_KEYS.has(key))) {
    return { valid: false, error: 'Request contains an unsupported field' };
  }
  if (
    body.stdin !== undefined
    && body.stdin !== null
    && typeof body.stdin !== 'string'
  ) {
    return { valid: false, error: 'stdin must be a base64 string or null' };
  }
  if (enclaveMode && body.stdin !== undefined && body.stdin !== null) {
    return { valid: false, error: 'Enclave request contains an unsupported field' };
  }
  return { valid: true };
}

/**
 * Validates the gh CLI arguments.
 * Write control is handled by the DIFC guard policy — this server only
 * blocks local helpers, meta-commands, and shim-bypassing commands.
 *
 * @param {string[]} args - The argument array (excluding 'gh' itself)
 * @returns {{ valid: boolean, error?: string }}
 */
function validateArgs(args) {
  if (process.env.AWF_CLI_PROXY_MODE === 'enclave') {
    return validateEnclaveArgs(args);
  }
  if (!Array.isArray(args)) {
    return { valid: false, error: 'args must be an array' };
  }

  for (const arg of args) {
    if (typeof arg !== 'string') {
      return { valid: false, error: 'All args must be strings' };
    }
  }
  if (args.length > 256 || args.some((arg) => arg.length > 256 * 1024)) {
    return { valid: false, error: 'Arguments exceed their bound' };
  }
  if (
    args.some((arg) => (
      HELPER_LAUNCH_FLAGS.has(arg)
      || [...HELPER_LAUNCH_FLAGS].some((flag) => arg.startsWith(`${flag}=`))
      || arg.startsWith('--hostname=')
    ))
  ) {
    return { valid: false, error: 'Helper-launching and host-selection flags are not permitted' };
  }
  if (args.includes('--hostname')) {
    return { valid: false, error: 'Host-selection flags are not permitted' };
  }
  const fileInputValidation = validateFileInputArgs(args);
  if (!fileInputValidation.valid) return fileInputValidation;

  const [subcommand, command] = resolveCommandPath(args);

  // No subcommand means flags-only invocation (e.g., --version, --help) — allow
  if (!subcommand) {
    return { valid: true };
  }

  // Always deny meta-commands
  if (ALWAYS_DENIED_SUBCOMMANDS.has(subcommand)) {
    return { valid: false, error: `Subcommand '${subcommand}' is not permitted` };
  }
  const commandPath = [subcommand, command].filter(Boolean).join(' ');
  if (DENIED_COMMAND_PATHS.has(commandPath) || DENIED_COMMAND_PATHS.has(subcommand)) {
    return { valid: false, error: `Command '${commandPath}' is not permitted` };
  }
  if (
    subcommand === 'api'
    && args.some((arg) => arg.startsWith('@') || arg.startsWith('//') || /^[a-z][a-z0-9+.-]*:\/\//i.test(arg))
  ) {
    return { valid: false, error: 'API endpoints must be relative paths' };
  }

  return { valid: true };
}

module.exports = {
  ALWAYS_DENIED_SUBCOMMANDS,
  DENIED_COMMAND_PATHS,
  CHILD_ENV_KEYS,
  FORCED_CHILD_ENV,
  validateExecRequest,
  validateArgs,
  validateEnclaveArgs,
  summarizeEnclaveArgs,
  extractInvocationCapability,
  capabilityAuditContext,
  buildExecEnv,
};
