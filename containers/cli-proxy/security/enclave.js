'use strict';

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

module.exports = {
  validateEnclaveArgs,
  summarizeEnclaveArgs,
  extractInvocationCapability,
  capabilityAuditContext,
};
