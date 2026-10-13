'use strict';

const CHILD_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'GH_HOST',
  'GH_REPO',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_SERVER_URL',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'GIT_SSL_CAINFO',
  'GH_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
]);

const FORCED_CHILD_ENV = Object.freeze({
  GH_PROMPT_DISABLED: '1',
  GH_PAGER: 'cat',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  GH_EDITOR: 'false',
  GIT_EDITOR: 'false',
  EDITOR: 'false',
  VISUAL: 'false',
  GH_BROWSER: 'false',
  BROWSER: 'false',
});

const EXEC_REQUEST_KEYS = new Set(['args', 'stdin']);
const HELPER_LAUNCH_FLAGS = new Set(['--web', '--browser', '--editor']);
const STDIN_FILE_FLAGS = new Set(['--input', '--body-file', '--notes-file']);

/**
 * Meta-commands that are always denied.
 * These modify gh itself rather than GitHub resources.
 */
const ALWAYS_DENIED_SUBCOMMANDS = new Set([
  'alias',
  'auth',
  'browse',
  'config',
  'extension',
]);
const DENIED_COMMAND_PATHS = new Set([
  'codespace',
  'gist clone',
  'pr checkout',
  'repo clone',
  'repo fork',
  'repo sync',
]);

const ENCLAVE_ISSUE_PATH = /^\/?repos\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/issues(?:\/([1-9][0-9]*)(\/comments)?)?$/;
const ENCLAVE_QUERY = /^[A-Za-z0-9_.~%=&+,:*@-]*$/;
const ENCLAVE_BOOLEAN_FLAGS = new Set(['--include', '--silent']);
const ENCLAVE_VALUE_FLAGS = new Set(['--jq', '-q', '--template', '-t']);
const CAPABILITY_AUDIENCE = 'gh-aw-enclave-github';
const CAPABILITY_OPERATIONS = [
  'issues.comments.list',
  'issues.get',
  'issues.list',
];
const CAPABILITY_FIELDS = ['v', 'aud', 'run', 'inv', 'repo', 'profile', 'ops', 'nbf', 'exp'];
const ENCLAVE_QUERY_KEYS = new Set([
  'assignee',
  'creator',
  'direction',
  'labels',
  'mentioned',
  'milestone',
  'page',
  'per_page',
  'since',
  'sort',
  'state',
]);

function validateEnclaveQuery(endpoint) {
  const queryIndex = endpoint.indexOf('?');
  if (queryIndex < 0) return true;
  const rawQuery = endpoint.slice(queryIndex + 1);
  if (
    endpoint.indexOf('?', queryIndex + 1) >= 0
    || !ENCLAVE_QUERY.test(rawQuery)
    || /%(?![0-9A-Fa-f]{2})/.test(rawQuery)
  ) {
    return false;
  }
  const params = new URLSearchParams(rawQuery);
  if ([...params].length > 11) return false;
  const seen = new Set();
  for (const [key, value] of params) {
    if (
      seen.has(key)
      || !ENCLAVE_QUERY_KEYS.has(key)
      || value.length < 1
      || value.length > 256
      || /[\u0000-\u001f\u007f]/.test(value)
    ) {
      return false;
    }
    seen.add(key);
    if (key === 'per_page' && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) return false;
    if (key === 'page' && !/^[1-9][0-9]{0,2}$/.test(value)) return false;
    if (key === 'state' && !/^(?:open|closed|all)$/.test(value)) return false;
    if (key === 'direction' && !/^(?:asc|desc)$/.test(value)) return false;
    if (key === 'sort' && !/^(?:created|updated|comments)$/.test(value)) return false;
  }
  return true;
}

function matchEnclaveEndpoint(endpoint) {
  const path = endpoint.split('?', 1)[0];
  const match = ENCLAVE_ISSUE_PATH.exec(path);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    return undefined;
  }
  return match;
}

function validateEnclaveArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    return { valid: false, error: 'args must be an array of strings' };
  }
  if (args.length > 16 || args.some((arg) => arg.length > 4096)) {
    return { valid: false, error: 'issues-read-v1 arguments exceed their bound' };
  }
  if (args[0] !== 'api') {
    return { valid: false, error: 'issues-read-v1 permits only gh api' };
  }

  let endpoint;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--method' || arg === '-X') {
      if (args[index + 1] !== 'GET') {
        return { valid: false, error: 'issues-read-v1 permits only GET' };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--method=')) {
      if (arg !== '--method=GET') {
        return { valid: false, error: 'issues-read-v1 permits only GET' };
      }
      continue;
    }
    if (ENCLAVE_BOOLEAN_FLAGS.has(arg)) continue;
    if (ENCLAVE_VALUE_FLAGS.has(arg)) {
      if (index + 1 >= args.length || args[index + 1].startsWith('-')) {
        return { valid: false, error: `${arg} requires a bounded value` };
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      return { valid: false, error: `flag '${arg}' is not permitted` };
    }
    if (endpoint !== undefined) {
      return { valid: false, error: 'issues-read-v1 accepts exactly one endpoint' };
    }
    endpoint = arg;
  }

  if (
    !endpoint
    || endpoint.length > 512
    || !matchEnclaveEndpoint(endpoint)
    || !validateEnclaveQuery(endpoint)
  ) {
    return { valid: false, error: 'endpoint is outside issues-read-v1' };
  }
  return { valid: true };
}

function summarizeEnclaveArgs(args) {
  let endpoint;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (
      arg === '--method'
      || arg === '-X'
      || ENCLAVE_VALUE_FLAGS.has(arg)
    ) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    endpoint = arg;
    break;
  }
  const match = typeof endpoint === 'string' ? matchEnclaveEndpoint(endpoint) : undefined;
  if (!match) return { profile: 'issues-read-v1', pathClass: 'invalid' };
  return {
    profile: 'issues-read-v1',
    repository: `${match[1]}/${match[2]}`,
    pathClass: match[4]
      ? 'issues.comments.list'
      : match[3]
        ? 'issues.get'
        : 'issues.list',
  };
}

function extractInvocationCapability(authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length);
  const parts = token.split('.');
  if (
    parts.length !== 3
    || parts[0] !== 'awf-egh1'
    || parts[1].length < 1
    || parts[1].length > 2048
    || parts[2].length !== 43
    || !parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  ) {
    return undefined;
  }
  try {
    const payloadBytes = Buffer.from(parts[1], 'base64url');
    if (payloadBytes.toString('base64url') !== parts[1]) return undefined;
    const payloadText = payloadBytes.toString('utf8');
    if (!Buffer.from(payloadText, 'utf8').equals(payloadBytes)) return undefined;
    const payload = JSON.parse(payloadText);
    if (
      !payload
      || typeof payload !== 'object'
      || JSON.stringify(payload) !== payloadText
      || JSON.stringify(Object.keys(payload)) !== JSON.stringify(CAPABILITY_FIELDS)
      || payload.v !== 1
      || payload.aud !== CAPABILITY_AUDIENCE
      || payload.profile !== 'issues-read-v1'
      || JSON.stringify(payload.ops) !== JSON.stringify(CAPABILITY_OPERATIONS)
      || typeof payload.run !== 'string'
      || typeof payload.inv !== 'string'
      || typeof payload.repo !== 'string'
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(payload.run)
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(payload.inv)
      || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(payload.repo)
      || !Number.isSafeInteger(payload.nbf)
      || !Number.isSafeInteger(payload.exp)
      || payload.nbf < 0
      || payload.exp <= payload.nbf
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return token;
}

function capabilityAuditContext(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    );
    return {
      assertedRun: payload.run,
      assertedInvocation: payload.inv,
      assertedRepository: payload.repo,
    };
  } catch {
    return {};
  }
}

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

function validateFileInputArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (STDIN_FILE_FLAGS.has(arg)) {
      if (args[index + 1] !== '-') {
        return { valid: false, error: `${arg} permits only stdin` };
      }
      index += 1;
      continue;
    }
    const fileFlag = [...STDIN_FILE_FLAGS].find((flag) => arg.startsWith(`${flag}=`));
    if (fileFlag && arg !== `${fileFlag}=-`) {
      return { valid: false, error: `${fileFlag} permits only stdin` };
    }
    if (arg === '-F' || arg === '--field') {
      const value = args[index + 1];
      if (typeof value === 'string' && value.includes('=@') && !value.endsWith('=@-')) {
        return { valid: false, error: `${arg} file values permit only stdin` };
      }
      index += 1;
      continue;
    }
    if (
      (arg.startsWith('-F') || arg.startsWith('--field='))
      && arg.includes('=@')
      && !arg.endsWith('=@-')
    ) {
      return { valid: false, error: 'Field file values permit only stdin' };
    }
  }
  return { valid: true };
}

/**
 * Validates the gh CLI arguments.
 * Write control is handled by the DIFC guard policy — this server only
 * blocks meta-commands that modify gh CLI itself.
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
  const commandPath = [subcommand, args[i + 1]].filter(Boolean).join(' ');
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

/**
 * Build the environment object for a subprocess from server-owned values only.
 *
 * @param {string|undefined} capability - Enclave invocation capability
 * @returns {NodeJS.ProcessEnv} The merged environment for the child process
 */
function buildExecEnv(capability) {
  const childEnv = { ...FORCED_CHILD_ENV };
  for (const key of CHILD_ENV_KEYS) {
    if (typeof process.env[key] === 'string') childEnv[key] = process.env[key];
  }
  if (process.env.AWF_CLI_PROXY_MODE === 'enclave') {
    for (const key of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'GH_ENTERPRISE_TOKEN',
    ]) delete childEnv[key];
    if (typeof capability !== 'string') {
      throw new Error('missing enclave invocation capability');
    }
    // GH_HOST is a private alias, so gh classifies it as an enterprise host and
    // reads GH_ENTERPRISE_TOKEN rather than GH_TOKEN.
    childEnv.GH_ENTERPRISE_TOKEN = capability;
  }
  return childEnv;
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
