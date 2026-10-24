/* global require, module, Buffer, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const AUTH_FIELDS = {
  credential_source: ['github_token', 'provider_api_key', 'none'],
  credential_kind: ['none', 'placeholder', 'fine_grained_pat', 'classic_pat', 'oauth', 'user_token', 'installation_token', 'other'],
  credential_shape: ['missing', 'placeholder', 'embedded_whitespace', 'prefixed', 'whitespace', 'clean'],
  target_source: ['explicit', 'server', 'default'],
  server_kind: ['missing', 'invalid', 'github', 'ghec', 'ghes'],
  base_path: ['configured', 'none'],
  integration_source: ['copilot_integration_id', 'github_copilot_integration_id', 'default'],
  authorization_match: ['yes', 'no'],
  integration_match: ['yes', 'no'],
  target: ['standard', 'enterprise', 'business', 'ghec', 'custom'],
  target_match: ['yes', 'no'],
  method: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'other'],
  endpoint: ['models', 'models_session', 'auto', 'chat_completions', 'responses', 'other'],
  authorization: ['missing', 'multiple', 'malformed', 'bearer', 'token', 'other'],
  integration: ['missing', 'multiple', 'workflows', 'cli', 'custom'],
  error_class: ['none', 'expired', 'invalid_credential', 'insufficient_scope', 'entitlement', 'integration', 'malformed_auth', 'unclassified', 'uninspectable'],
  body_capture: ['complete', 'omitted', 'truncated', 'not_required'],
  challenge: ['missing', 'invalid_token', 'insufficient_scope', 'other', 'not_required'],
};

function isSafeCopilotAuthLogFields(value) {
  if (!value || value.length > 1024) return false;
  const entries = value.split(' ').map(field => field.split('='));
  if (entries.some(pair => pair.length !== 2)) return false;
  return Object.entries(AUTH_FIELDS).map(([name, allowed]) => {
    const pair = entries.find(([key]) => key === name);
    const candidate = pair?.[1];
    const safe = typeof candidate === 'string' && allowed.includes(candidate) ? candidate : 'unknown';
    return `${name}=${safe}`;
  }).join(' ') === value;
}

const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_FILES = 32;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_USAGE_BYTES = 16 * 1024;
const ID = /^[a-f0-9]{32}$/;
const INVOCATION_ID = /^[a-f0-9]{16,64}$/;
const ENTRY_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const LOG_NAME = /^(?:enclave-session\.log|enclave-proxy-events\.jsonl|enclave-proxy-container\.log|launcher-(?:stdout|stderr)\.log|guest-(?:stdout|stderr)\.raw\.log|cloud-hypervisor\.log|serial\.log|network-plan\.json|network-diagnostics\.txt|counters\.json|vm-info\.json|runtime\.json|confinement\.json|virtiofs-[0-9]-enclave-(?:seed|request|output|runtime|session-handoff|session-state)(?:\.log|-confinement\.json))$/;
const ROOTS = {
  journal: '/var/lib/awf-cloud-hypervisor/host-executor-journal',
  debug: '/var/lib/awf-cloud-hypervisor/debug-artifacts/cloud-hypervisor',
};

function directory(target, uid, trustedRoot = '/', stickyAncestor) {
  const root = path.resolve(trustedRoot);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(root, resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Debug collection path escapes trusted root');
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      (rootStat.uid !== uid && rootStat.uid !== 0) || (rootStat.mode & 0o022) !== 0) {
    throw new Error('Unsafe debug collection directory');
  }
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    const protectedStickyAncestor = current === stickyAncestor && current !== resolvedTarget
      && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && !protectedStickyAncestor)) {
      throw new Error('Unsafe debug collection directory');
    }
  }
}

function inventory(target, uid, trustedRoot) {
  try {
    directory(target, uid, trustedRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const names = fs.readdirSync(target);
  if (names.length > MAX_DIRECTORY_ENTRIES) throw new Error('Debug inventory exceeds bound');
  return names;
}

function readRegular(target, limit, uid, observe) {
  observe?.('open');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW |
    fs.constants.O_NONBLOCK);
  let failed = false;
  try {
    observe?.('fstat');
    const stat = fs.fstatSync(fd);
    observe?.('validate');
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid ||
        (stat.mode & 0o077) !== 0 || stat.size > limit) {
      throw new Error('Unsafe or oversized debug collection file');
    }
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      observe?.('read');
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) throw new Error('Debug collection file grew beyond bound');
    return bytes.subarray(0, size);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      if (!failed) observe?.('close');
      fs.closeSync(fd);
    } catch (error) {
      observe?.('close');
      throw error;
    }
  }
}

function parseRecord(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === 'object' && !Array.isArray(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

// Independent closed projection: even a compromised host diagnostic cannot
// turn this public-fixture collector into a path/message/payload export.
function projectProxyUsage(value) {
  const usage = { scope: 'run-cumulative', requests: { status: 'malformed' }, tokens: { status: 'malformed' } };
  const count = n => Number.isSafeInteger(n) && n >= 0;
  const record = n => n && typeof n === 'object' && !Array.isArray(n);
  for (const kind of ['requests', 'tokens']) {
    const source = value?.[kind];
    if (!record(source)) continue;
    if (['empty', 'missing', 'unsafe', 'oversized', 'record-limit', 'malformed', 'read-failed',
      'not-drained', 'not-applicable'].includes(source.status)) {
      usage[kind] = { status: source.status };
      continue;
    }
    if (source.status !== 'captured' || !count(source.records) || source.records < 1 || source.records > 4096) continue;
    if (kind === 'tokens') {
      const keys = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
      if (!record(source.totals) || !keys.every(key => count(source.totals[key])) ||
          source.usageRecords !== source.records) continue;
      usage.tokens = {
        status: 'captured', records: source.records, usageRecords: source.usageRecords,
        totals: Object.fromEntries(keys.map(key => [key, source.totals[key]])),
      };
    } else {
      if (!count(source.trackedResponses) || source.trackedResponses > source.records ||
          !count(source.websocketSessions) || source.websocketSessions > source.records - source.trackedResponses ||
          !record(source.statuses) || !record(source.results)) continue;
      const statuses = {};
      const results = {};
      for (let status = 100; status <= 599; status++) {
        const n = source.statuses[String(status)];
        if (count(n) && n <= source.records) statuses[String(status)] = n;
      }
      for (const key of ['ok', 'no_usage', 'skip_status', 'unsupported_accounting', 'skip_encoding']) {
        const n = source.results[key];
        if (count(n) && n <= source.records) results[key] = n;
      }
      if (Object.values(statuses).reduce((sum, n) => sum + n, 0) !== source.trackedResponses ||
          Object.values(results).reduce((sum, n) => sum + n, 0) > source.records) continue;
      usage.requests = {
        status: 'captured', records: source.records, trackedResponses: source.trackedResponses,
        websocketSessions: source.websocketSessions, statuses, results,
      };
    }
  }
  return usage;
}

function projectProxyEvents(bytes) {
  if (!bytes.length) return bytes;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n')) throw new Error('Incomplete enclave proxy event log');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > 4096) throw new Error('Enclave proxy event count exceeds bound');
  return Buffer.from(lines.map(line => {
    const event = parseRecord(line);
    if (event?.schemaVersion !== 1 || !Number.isInteger(event.status) ||
        event.status < 100 || event.status > 599 ||
        !['local', 'upstream'].includes(event.origin)) {
      throw new Error('Invalid enclave proxy event schema');
    }
    return JSON.stringify({ schemaVersion: 1, origin: event.origin, status: event.status });
  }).join('\n') + '\n');
}

function projectProxyResponse(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  if (source?.schemaVersion !== 1 || source.component !== 'enclave-proxy-response' ||
      source.scope !== 'run-cumulative') throw new Error('Invalid enclave proxy response schema');
  const states = ['empty', 'missing', 'unsafe', 'oversized', 'record-limit', 'malformed',
    'read-failed', 'not-drained', 'not-applicable'];
  if (states.includes(source.status)) return {
    schemaVersion: 1, component: 'enclave-proxy-response',
    scope: 'run-cumulative', status: source.status,
  };
  const counts = [];
  const projection = {};
  for (const origin of ['local', 'upstream']) {
    const bucket = source[origin];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
      throw new Error('Invalid enclave proxy response schema');
    }
    projection[origin] = {};
    for (const [status, count] of Object.entries(bucket)) {
      if (!/^[1-5][0-9]{2}$/.test(status) || !Number.isSafeInteger(count) || count < 1) {
        throw new Error('Invalid enclave proxy response schema');
      }
      projection[origin][status] = count;
      counts.push(count);
    }
  }
  if (source.status !== 'captured' || !Number.isSafeInteger(source.records) ||
      source.records < 1 || source.records > 4096 ||
      counts.reduce((sum, count) => sum + count, 0) !== source.records) {
    throw new Error('Invalid enclave proxy response schema');
  }
  return { schemaVersion: 1, component: 'enclave-proxy-response',
    scope: 'run-cumulative', status: 'captured', records: source.records, ...projection };
}

function projectProxyContainerLog(bytes) {
  if (bytes.length > 32 * 1024) throw new Error('Oversized enclave proxy container projection');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const lines = text.split('\n');
  const trailer = lines.at(-2);
  const events = new Set([
    'startup', 'startup_complete', 'server_start', 'shutdown', 'request_start',
    'request_complete', 'request_error', 'upstream_error_response', 'upstream_auth_error',
    'copilot_auth_diagnostic',
    'request_transform_failed', 'key_validation_error', 'oidc_startup_failed',
    'model_fetch_error', 'model_routing_bootstrap_error',
    'enclave_model_budget_rejected', 'rate_limited', 'request_validation_failed', 'model_fallback_exhausted',
    'enclave_model_capability_missing', 'enclave_model_capability_scheme', 'enclave_model_capability_format',
    'enclave_model_capability_signature', 'enclave_model_capability_claims', 'enclave_model_capability_claims_changed',
    'enclave_model_token_limit',
    'enclave_model_token_body_missing', 'enclave_model_token_input_reservation',
    'enclave_model_token_request_json', 'enclave_model_token_request_shape',
    'enclave_model_token_output_conflict', 'enclave_model_token_output_shape',
    'enclave_model_token_stream_options', 'enclave_model_token_budget_exhausted',
  ]);
  if (lines.at(-1) !== '' ||
      !/^capture_status=(?:captured dropped=(?:[0-9]{1,5})|empty|unavailable)$/.test(trailer ?? '') ||
      !lines.slice(0, -2).every(line => {
        const match = /^source=(stdout|stderr) level=(info|warn|error) event=([a-z_]+)(?: status=([1-5]\d\d))?(?: (.+))?$/.exec(line);
        return match && events.has(match[3])
          && (match[3] === 'copilot_auth_diagnostic' ? isSafeCopilotAuthLogFields(match[5]) : !match[5]);
      })) throw new Error('Unsafe enclave proxy container projection');
  return bytes;
}

function prepare(runDirectory, roots = ROOTS, uid = 0, trustedRoot = '/') {
  directory(path.dirname(runDirectory), uid, trustedRoot);
  fs.mkdirSync(runDirectory, { mode: 0o700 });
  const baseline = {
    journals: inventory(roots.journal, uid, trustedRoot).filter(name => name.endsWith('.journal')),
    proxyDebug: inventory(path.join(roots.journal, 'diagnostics'), uid, trustedRoot)
      .filter(name => name.endsWith('.proxy-debug.json')),
    debug: inventory(roots.debug, uid, trustedRoot),
  };
  fs.writeFileSync(path.join(runDirectory, 'baseline.json'), JSON.stringify(baseline),
    { mode: 0o600, flag: 'wx' });
}

function collect(runDirectory, runnerUid, runnerGid, roots = ROOTS, uid = 0, trustedRoot = '/') {
  directory(runDirectory, uid, trustedRoot);
  const baseline = JSON.parse(readRegular(path.join(runDirectory, 'baseline.json'), 1024 * 1024, uid));
  const journals = inventory(roots.journal, uid, trustedRoot)
    .filter(name => name.endsWith('.journal') && !baseline.journals.includes(name));
  const debug = inventory(roots.debug, uid, trustedRoot).filter(name => !baseline.debug.includes(name));
  const proxyDebug = inventory(path.join(roots.journal, 'diagnostics'), uid, trustedRoot)
    .filter(name => name.endsWith('.proxy-debug.json') && !(baseline.proxyDebug ?? []).includes(name));
  if (journals.length > 1 || debug.length > 1 || proxyDebug.length > 1) {
    throw new Error('Unexpected concurrent enclave runs');
  }
  let invocation;
  let runId;
  let nonInvocationRecords = 0;
  let invalidIdentityRecords = 0;
  if (journals.length) {
    const journal = journals[0];
    if (!/^[a-f0-9]{32}\.journal$/.test(journal)) throw new Error('Invalid journal identity');
    const records = readRegular(path.join(roots.journal, journal), 64 * 1024, uid)
      .toString('utf8').trim().split('\n').map(parseRecord);
    runId = journal.slice(0, 32);
    if (records[0]?.runId !== runId || records[0]?.state !== 'open') {
      throw new Error('Journal run identity mismatch');
    }
    for (const record of records.slice(1)) {
      if (!record) {
        invalidIdentityRecords += 1;
        continue;
      }
      if (record.invocationId === undefined || record.invocationId === 'queue' ||
          record.invocationId === 'budget') {
        nonInvocationRecords += 1;
        continue;
      }
      if (typeof record.invocationId !== 'string' || !INVOCATION_ID.test(record.invocationId) ||
          typeof record.entryId !== 'string' || !ENTRY_ID.test(record.entryId)) {
        invalidIdentityRecords += 1;
        continue;
      }
      const candidate = createHash('sha256').update(JSON.stringify([
        'awf-host-enclave-v1', runId, record.entryId, record.invocationId,
      ])).digest('hex').slice(0, 32);
      if (invocation && invocation !== candidate) throw new Error('Invocation budget exceeded');
      invocation = candidate;
    }
  }
  if (proxyDebug.length) {
    const match = /^([a-f0-9]{32})-([a-f0-9]{32})\.proxy-debug\.json$/.exec(proxyDebug[0]);
    const expected = match && createHash('sha256').update(`awf-enclave-proxy-debug-v1:${match[1]}`)
      .digest('hex').slice(0, 32);
    if (!match || match[2] !== expected || (runId && runId !== match[1])) {
      throw new Error('Proxy debug artifacts do not belong to this run');
    }
    runId = match[1];
  }
  if (debug.length && (!ID.test(debug[0]) || debug[0] !== invocation)) {
    throw new Error('Debug artifacts do not belong to this run');
  }
  const files = [];
  let usageStatus = 'missing';
  let responseStatus = 'missing';
  if (runId) {
    const id = createHash('sha256').update(`awf-enclave-proxy-usage-v1:${runId}`).digest('hex').slice(0, 32);
    const diagnostics = path.join(roots.journal, 'diagnostics');
    const source = path.join(diagnostics, `${runId}-${id}.json`);
    try {
      directory(diagnostics, uid, trustedRoot);
      const value = parseRecord(readRegular(source, MAX_USAGE_BYTES, uid).toString('utf8'));
      const usage = value?.schemaVersion === 1 && value?.component === 'enclave-proxy-usage' &&
        value?.runId === runId ? projectProxyUsage(value.usage) : projectProxyUsage(undefined);
      usageStatus = `${usage.requests.status}/${usage.tokens.status}`;
      files.push(['enclave-proxy-usage.json', Buffer.from(JSON.stringify({
        schemaVersion: 1, component: 'enclave-proxy-usage', usage,
      }) + '\n')]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const responseId = createHash('sha256').update(`awf-enclave-proxy-response-v1:${runId}`)
      .digest('hex').slice(0, 32);
    try {
      directory(diagnostics, uid, trustedRoot);
      const value = parseRecord(readRegular(
        path.join(diagnostics, `${runId}-${responseId}.json`), MAX_USAGE_BYTES, uid).toString('utf8'));
      if (value?.schemaVersion !== 1 || value.component !== 'enclave-proxy-response'
          || value.runId !== runId) throw new Error('Invalid enclave proxy response identity');
      const projected = Buffer.from(JSON.stringify(projectProxyResponse({
        schemaVersion: 1, component: 'enclave-proxy-response', ...value.diagnostics,
      })) + '\n');
      responseStatus = JSON.parse(projected.toString('utf8')).status;
      files.push(['enclave-proxy-response.json', projected]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const debugId = createHash('sha256').update(`awf-enclave-proxy-debug-v1:${runId}`)
      .digest('hex').slice(0, 32);
    try {
      directory(diagnostics, uid, trustedRoot);
      const value = parseRecord(readRegular(
        path.join(diagnostics, `${runId}-${debugId}.proxy-debug.json`), 320 * 1024, uid).toString('utf8'));
      if (value?.schemaVersion !== 1 || value.component !== 'enclave-proxy-debug' ||
          value.scope !== 'run-cumulative' || value.runId !== runId ||
          !Array.isArray(value.events) || value.events.length > 4096 ||
          typeof value.containerLog !== 'string') throw new Error('Invalid enclave proxy debug identity');
      files.push(['enclave-proxy-events.jsonl', projectProxyEvents(Buffer.from(
        value.events.map(event => JSON.stringify(event) + '\n').join('')))]);
      files.push(['enclave-proxy-container.log', projectProxyContainerLog(Buffer.from(value.containerLog))]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (debug.length) {
    const source = path.join(roots.debug, invocation);
    directory(source, uid, trustedRoot);
    const names = inventory(source, uid, trustedRoot);
    if (names.length > MAX_FILES) throw new Error('Debug file count exceeds bound');
    for (const name of names) {
      if (!LOG_NAME.test(name)) throw new Error('Unexpected debug artifact name');
      const bytes = readRegular(path.join(source, name), MAX_STREAM_BYTES, uid);
      files.push([name, name === 'enclave-proxy-events.jsonl' ? projectProxyEvents(bytes)
        : name === 'enclave-proxy-container.log' ? projectProxyContainerLog(bytes) : bytes]);
    }
  }
  // Publish only after every source passes validation, outside all guest mounts.
  const upload = path.join(runDirectory, 'upload');
  fs.mkdirSync(upload, { mode: 0o700 });
  for (const [name, bytes] of files) {
    const target = path.join(upload, name);
    fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
    fs.chownSync(target, runnerUid, runnerGid);
  }
  const status = path.join(upload, 'collection-status.txt');
  fs.writeFileSync(status, (files.length
    ? `Collected ${files.length} bounded public-fixture debug files.\n`
    : 'No public-fixture debug logs were produced for this run.\n') +
    `Non-invocation records: ${nonInvocationRecords}; invalid identity records: ${invalidIdentityRecords}.\n` +
    'Enclave proxy projection scope: run-cumulative.\n' +
    `Enclave proxy usage (requests/tokens): ${usageStatus}.\n` +
    `Enclave proxy response diagnostics: ${responseStatus}.\n`,
  { mode: 0o600, flag: 'wx' });
  fs.chownSync(status, runnerUid, runnerGid);
  fs.chownSync(upload, runnerUid, runnerGid);
  fs.chmodSync(runDirectory, 0o711);
  return files.length;
}

module.exports = {
  prepare, collect, MAX_STREAM_BYTES, MAX_FILES,
  directory, inventory, readRegular, projectProxyUsage, projectProxyResponse,
  projectProxyEvents, projectProxyContainerLog, isSafeCopilotAuthLogFields,
};

if (require.main === module) {
  const [operation, key, runnerUid, runnerGid] = process.argv.slice(2);
  if (process.getuid() !== 0 || !/^[0-9]+-[0-9]+$/.test(key ?? '')) {
    throw new Error('Debug collector requires root and an Actions run/attempt identity');
  }
  const runDirectory = path.join('/var/lib/awf-enclave-smoke-export', key);
  if (operation === 'prepare') prepare(runDirectory);
  else if (operation === 'collect' && /^[0-9]+$/.test(runnerUid ?? '') &&
      /^[0-9]+$/.test(runnerGid ?? '')) {
    collect(runDirectory, Number(runnerUid), Number(runnerGid));
  } else throw new Error('Invalid debug collector operation');
}
