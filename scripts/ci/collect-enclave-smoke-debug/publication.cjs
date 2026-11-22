/* global require, module, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  MAX_STREAM_BYTES, MAX_FILES, MAX_STATUS_BYTES, MAX_STARTUP_BYTES, MAX_PUBLISHED_FILES,
  MAX_PUBLISHED_BYTES, MAX_DIRECTORY_ENTRIES, MAX_USAGE_BYTES, ID, INVOCATION_ID, ENTRY_ID,
  LOG_NAME, ROOTS, object, check, parseRecord,
} = require('./common.cjs');
const { directory, inventory, readRegular, decodeUtf8 } = require('./safe-fs.cjs');
const { redactCredentials } = require('./redaction.cjs');
const {
  projectStartup, projectFinalization, projectDiagnostics, projectRetentionUnavailable,
  projectProxyUsage, projectProxyResponse, projectProxyEvents, projectProxyContainerLog, EXECUTOR_OUTCOMES,
} = require('./projections.cjs');

function prepare(runDirectory, roots = ROOTS, uid = 0, trustedRoot = '/', binding) {
  directory(path.dirname(runDirectory), uid, trustedRoot);
  fs.mkdirSync(runDirectory, { mode: 0o700 });
  const baseline = {
    ...(binding ? { binding } : {}),
    journals: inventory(roots.journal, uid, trustedRoot).filter(name => name.endsWith('.journal')),
    proxyDebug: inventory(path.join(roots.journal, 'diagnostics'), uid, trustedRoot)
      .filter(name => name.endsWith('.proxy-debug.json')),
    debug: inventory(roots.debug, uid, trustedRoot),
  };
  fs.writeFileSync(path.join(runDirectory, 'baseline.json'), JSON.stringify(baseline),
    { mode: 0o600, flag: 'wx' });
}

function retainStartup(runDirectory, value, uid = 0, trustedRoot = '/') {
  directory(runDirectory, uid, trustedRoot);
  const prepared = JSON.parse(readRegular(path.join(runDirectory, 'baseline.json'), MAX_STREAM_BYTES, uid));
  check(!fs.existsSync(path.join(runDirectory, 'collected')), 'prepared-scope', 'scope-already-collected');
  const bytes = projectStartup(value, prepared.binding?.backend);
  check(bytes.length <= MAX_STARTUP_BYTES, 'file-size', 'oversized');
  fs.writeFileSync(path.join(runDirectory, 'startup.json'), bytes, { mode: 0o600, flag: 'wx' });
}

function startupFiles(runDirectory, backend, uid) {
  try {
    const bytes = readRegular(path.join(runDirectory, 'startup.json'), MAX_STARTUP_BYTES, uid);
    return [['startup.json', projectStartup(parseRecord(decodeUtf8(bytes, 'startup-schema')), backend)]];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function retainFinalization(runDirectory, value, uid = 0, trustedRoot = '/') {
  directory(runDirectory, uid, trustedRoot);
  const prepared = JSON.parse(readRegular(path.join(runDirectory, 'baseline.json'), MAX_STREAM_BYTES, uid));
  check(!fs.existsSync(path.join(runDirectory, 'collected')), 'prepared-scope', 'scope-already-collected');
  const bytes = projectFinalization(value, prepared.binding?.backend);
  check(bytes.length <= MAX_STATUS_BYTES, 'file-size', 'oversized');
  fs.writeFileSync(path.join(runDirectory, 'finalization.json'), bytes, { mode: 0o600, flag: 'wx' });
}

function finalizationFiles(runDirectory, backend, uid) {
  try {
    const bytes = readRegular(path.join(runDirectory, 'finalization.json'), MAX_STATUS_BYTES, uid);
    return [['finalization.json', projectFinalization(parseRecord(decodeUtf8(bytes, 'finalization-schema')), backend)]];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function collect(runDirectory, runnerUid, runnerGid, roots = ROOTS, uid = 0, trustedRoot = '/', binding,
  privilegedUid = 0, stagingTrustedRoot = '/') {
  const stagingUid = binding ? privilegedUid : uid;
  directory(runDirectory, stagingUid, stagingTrustedRoot);
  const prepared = JSON.parse(readRegular(path.join(runDirectory, 'baseline.json'), 1024 * 1024, stagingUid));
  const baseline = prepared.sourceScopes
    ? prepared.sourceScopes.find(scope => scope.journal === roots.journal) : prepared;
  check(object(baseline) && ['journals', 'debug', 'proxyDebug'].every(key => Array.isArray(baseline[key])
    && baseline[key].length <= MAX_DIRECTORY_ENTRIES && baseline[key].every(name => typeof name === 'string')),
  'prepared-scope');
  check(!binding || JSON.stringify(binding) === JSON.stringify(prepared.binding), 'prepared-scope');
  fs.writeFileSync(path.join(runDirectory, 'collected'), '', { mode: 0o600, flag: 'wx' });
  const journals = inventory(roots.journal, uid, trustedRoot)
    .filter(name => name.endsWith('.journal') && !baseline.journals.includes(name));
  const debug = inventory(roots.debug, uid, trustedRoot).filter(name => !baseline.debug.includes(name));
  const proxyDebug = inventory(path.join(roots.journal, 'diagnostics'), uid, trustedRoot)
    .filter(name => name.endsWith('.proxy-debug.json') && !(baseline.proxyDebug ?? []).includes(name));
  if (journals.length > 1 || debug.length > 1 || proxyDebug.length > 1) {
    check(false, 'run-budget', 'concurrent-runs');
  }
  let invocation;
  let invocationEntry;
  let runId;
  let invocationStopped = false;
  let executorOutcome = 'unknown';
  let nonInvocationRecords = 0;
  let invalidIdentityRecords = 0;
  if (journals.length) {
    const journal = journals[0];
    check(/^[a-f0-9]{32}\.journal$/.test(journal), 'journal-identity');
    const records = readRegular(path.join(roots.journal, journal), 64 * 1024, uid)
      .toString('utf8').trim().split('\n').map(parseRecord);
    runId = journal.slice(0, 32);
    check(records[0]?.version === 1 && records[0]?.runId === runId && records[0]?.state === 'open', 'journal-identity');
    for (const record of records.slice(1)) {
      if (!record) {
        check(false, 'journal-schema');
      }
      check(record.runId === undefined || record.runId === runId, 'journal-identity');
      if (record.invocationId === undefined || record.invocationId === 'queue' ||
          record.invocationId === 'budget') {
        nonInvocationRecords += 1;
        continue;
      }
      if (typeof record.invocationId !== 'string' || !INVOCATION_ID.test(record.invocationId) ||
          typeof record.entryId !== 'string' || !ENTRY_ID.test(record.entryId)) {
        check(false, 'journal-identity');
      }
      const candidate = record.invocationId;
      if (invocation && (invocation !== candidate || invocationEntry !== record.entryId)) {
        check(false, 'invocation-budget', 'multiple-invocations');
      }
      invocation = candidate;
      invocationEntry = record.entryId;
      if (record.state === 'terminal') {
        invocationStopped = true;
        executorOutcome = EXECUTOR_OUTCOMES.includes(record.outcome) ? record.outcome : 'unknown';
      }
    }
  }
  if (proxyDebug.length) {
    const match = /^([a-f0-9]{32})-([a-f0-9]{32})\.proxy-debug\.json$/.exec(proxyDebug[0]);
    const expected = match && createHash('sha256').update(`awf-enclave-proxy-debug-v1:${match[1]}`)
      .digest('hex').slice(0, 32);
    if (!match || match[2] !== expected || (runId && runId !== match[1])) {
      check(false, 'proxy-run-identity');
    }
    runId = match[1];
  }
  if (debug.length && (!ID.test(debug[0]) || debug[0] !== runId || !invocation)) {
    check(false, 'artifact-run-identity');
  }
  const debugInvocations = debug.length
    ? inventory(path.join(roots.debug, runId), uid, trustedRoot) : [];
  check(debugInvocations.length <= 1, 'invocation-budget', 'multiple-invocations');
  if (debugInvocations.some(name => !INVOCATION_ID.test(name) || name !== invocation)) {
    check(false, 'artifact-invocation-identity');
  }
  const runtime = binding?.backend ?? roots.backend ?? 'cloud-hypervisor';
  check(['docker', 'cloud-hypervisor'].includes(runtime), 'prepared-scope');
  const files = [...startupFiles(runDirectory, runtime, stagingUid),
    ...finalizationFiles(runDirectory, runtime, stagingUid)].map(([name, bytes]) => {
    const value = parseRecord(decodeUtf8(bytes, 'result-failure-schema'));
    if (value.resultFailure) {
      value.resultFailure.executorOutcome = executorOutcome;
      bytes = name === 'startup.json' ? projectStartup(value, runtime) : projectFinalization(value, runtime);
    }
    return [name, bytes];
  });
  let envelope;
  let retentionUnavailable;
  if (debugInvocations.length) {
    const source = path.join(roots.debug, runId, invocation);
    directory(source, uid, trustedRoot);
    const metadata = fs.lstatSync(source);
    check(metadata.uid === uid && (metadata.mode & 0o7777) === 0o700, 'artifact-directory');
    try {
      envelope = projectDiagnostics(parseRecord(readRegular(path.join(source, 'diagnostics.json'),
        MAX_STREAM_BYTES, uid).toString('utf8')),
      { runId, invocationId: invocation, entryId: invocationEntry, runtime });
    } catch (error) {
      if (error.code === 'ENOENT' && runtime === 'cloud-hypervisor') {
        check(invocationStopped, 'stop-proof', 'not-stopped');
        // Pre-shared-envelope CH releases still retain bounded public-only
        // supplemental evidence only after the journal proves backend cleanup.
        envelope = undefined;
      } else if (error.code === 'ENOENT') {
        try {
          retentionUnavailable = projectRetentionUnavailable(parseRecord(decodeUtf8(
            readRegular(path.join(source, 'retention-unavailable.json'), MAX_STARTUP_BYTES, uid),
            'retention-unavailable-schema')),
          { runId, invocationId: invocation, entryId: invocationEntry, runtime });
        } catch (unavailableError) {
          if (unavailableError.code === 'ENOENT') check(false, 'diagnostics-envelope', 'absent-evidence');
          throw unavailableError;
        }
      }
      else throw error;
    }
  }
  // Independently closed, identity-checked run-cumulative projections can
  // diagnose early failures even when no invocation artifacts were retained.
  let usageStatus = 'missing';
  let responseStatus = 'missing';
  if (runId) {
    const id = createHash('sha256').update(`awf-enclave-proxy-usage-v1:${runId}`).digest('hex').slice(0, 32);
    const diagnostics = path.join(roots.journal, 'diagnostics');
    const source = path.join(diagnostics, `${runId}-${id}.json`);
    try {
      directory(diagnostics, uid, trustedRoot);
      const value = parseRecord(readRegular(source, MAX_USAGE_BYTES, uid).toString('utf8'));
      check(value?.schemaVersion === 1 && value.component === 'enclave-proxy-usage'
        && value.runId === runId && object(value.usage) && value.usage.scope === 'run-cumulative',
      'proxy-run-identity');
      const usage = projectProxyUsage(value.usage);
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
          || value.runId !== runId) check(false, 'proxy-run-identity');
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
          typeof value.containerLog !== 'string') check(false, 'proxy-run-identity');
      files.push(['enclave-proxy-events.jsonl', projectProxyEvents(Buffer.from(
        value.events.map(event => JSON.stringify(event) + '\n').join('')))]);
      files.push(['enclave-proxy-container.log', projectProxyContainerLog(Buffer.from(value.containerLog))]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (debugInvocations.length) {
    const source = path.join(roots.debug, runId, invocation);
    directory(source, uid, trustedRoot);
    const names = inventory(source, uid, trustedRoot);
    check(names.length <= MAX_FILES, 'artifact-count', 'oversized');
    check(!retentionUnavailable || names.every(name => name === 'retention-unavailable.json'),
      'stop-proof', 'not-stopped');
    const projected = envelope ? JSON.parse(envelope.toString('utf8')) : undefined;
    const sourceStreams = { 'stdout.log': 'stdout', 'stderr.log': 'stderr', 'enclave-session.log': 'session' };
    for (const name of names) {
      check(LOG_NAME.test(name), 'artifact-name');
      check(name !== 'retention-unavailable.json' || (runtime === 'docker' && retentionUnavailable),
        'retention-unavailable-schema');
      const bytes = readRegular(path.join(source, name), MAX_STREAM_BYTES, uid);
      check(runtime !== 'docker' || projected || !['stdout.log', 'stderr.log'].includes(name),
        'diagnostics-envelope', 'absent-evidence');
      if (sourceStreams[name] && projected && projected.streams[sourceStreams[name]] !== 'captured') {
        check(bytes.length === 0, 'stream-status');
      }
      check(runtime !== 'docker' || ['stdout.log', 'stderr.log', 'enclave-session.log', 'diagnostics.json', 'retention-unavailable.json'].includes(name),
        'artifact-name');
      files.push([name, name === 'diagnostics.json' ? envelope
        : name === 'retention-unavailable.json' ? retentionUnavailable
          : name === 'enclave-session.log' ? redactCredentials(bytes)
        : name === 'enclave-proxy-events.jsonl' ? projectProxyEvents(bytes)
            : name === 'enclave-proxy-container.log' ? projectProxyContainerLog(bytes) : redactCredentials(bytes)]);
    }
    for (const [stream, name] of projected
      ? [['stdout', 'stdout.log'], ['stderr', 'stderr.log'], ['session', 'enclave-session.log']] : []) {
      check(projected.streams[stream] !== 'captured' || names.includes(name), 'captured-stream', 'absent-evidence');
      if (projected.streams[stream] !== 'captured' && names.includes(name)) {
        check(files.find(([candidate]) => candidate === name)[1].length === 0, 'stream-status');
      }
    }
  }
  check(files.length > 0, 'run-evidence', 'absent-evidence');
  const statusContents = `Collected ${files.length} bounded public-fixture debug files.\n` +
    `Non-invocation records: ${nonInvocationRecords}; invalid identity records: ${invalidIdentityRecords}.\n` +
    'Enclave proxy projection scope: run-cumulative.\n' +
    `Shared diagnostics envelope: ${envelope ? 'validated'
      : retentionUnavailable ? 'unavailable-host-reconciliation-incomplete'
        : debugInvocations.length ? 'absent-legacy-supplemental-only' : 'absent-run-level-only'}.\n` +
    `Enclave proxy usage (requests/tokens): ${usageStatus}.\n` +
    `Enclave proxy response diagnostics: ${responseStatus}.\n`;
  assertPublicationBounds(files, statusContents);
  // Publish only after every source passes validation, outside all guest mounts.
  const upload = path.join(runDirectory, 'upload');
  const pending = path.join(runDirectory, 'pending');
  fs.mkdirSync(pending, { mode: 0o700 });
  for (const [name, bytes] of files) {
    const target = path.join(pending, name);
    fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
    fs.chownSync(target, runnerUid, runnerGid);
  }
  const status = path.join(pending, 'collection-status.txt');
  fs.writeFileSync(status, statusContents, { mode: 0o600, flag: 'wx' });
  fs.chownSync(status, runnerUid, runnerGid);
  fs.chownSync(pending, runnerUid, runnerGid);
  fs.renameSync(pending, upload);
  fs.chmodSync(runDirectory, 0o711);
  return files.length;
}

function assertPublicationBounds(files, status) {
  check(files.length + 1 <= MAX_PUBLISHED_FILES, 'publication-file-count', 'oversized');
  const statusBytes = Buffer.byteLength(status);
  check(statusBytes <= MAX_STATUS_BYTES, 'publication-status-size', 'oversized');
  check(files.reduce((total, [, bytes]) => total + bytes.length, statusBytes) <= MAX_PUBLISHED_BYTES,
    'publication-bytes', 'oversized');
  check(new Set(files.map(([name]) => name)).size === files.length, 'artifact-collision');
}

function snapshot(roots) {
  const trustedRoot = roots.trustedRoot ?? '/';
  return { journal: roots.journal,
    journals: inventory(roots.journal, roots.sourceUid, trustedRoot).filter(name => name.endsWith('.journal')),
    proxyDebug: inventory(path.join(roots.journal, 'diagnostics'), roots.sourceUid, trustedRoot)
      .filter(name => name.endsWith('.proxy-debug.json')),
    debug: inventory(roots.debug, roots.sourceUid, trustedRoot),
  };
}

function publishCollectionFailure(runDirectory, runnerUid, runnerGid, error, uid = 0, trustedRoot = '/', binding) {
  const failure = classifyFailure(error);
  directory(runDirectory, uid, trustedRoot);
  const baseline = JSON.parse(readRegular(path.join(runDirectory, 'baseline.json'), MAX_STREAM_BYTES, uid));
  check(!binding || JSON.stringify(baseline.binding) === JSON.stringify(binding), 'prepared-scope');
  if (!fs.existsSync(path.join(runDirectory, 'collected'))) {
    fs.writeFileSync(path.join(runDirectory, 'collected'), '', { mode: 0o600, flag: 'wx' });
  }
  // Never overwrite a successful export or publish partially validated data.
  if (!fs.existsSync(path.join(runDirectory, 'upload'))) {
    const pending = path.join(runDirectory, 'pending');
    if (fs.existsSync(pending)) directory(pending, uid, trustedRoot);
    fs.rmSync(pending, { recursive: true, force: true });
    const upload = path.join(runDirectory, 'upload');
    fs.mkdirSync(upload, { mode: 0o700 });
    // Each harness record survives independently of invocation collection failures.
    const harness = [];
    for (const read of [startupFiles, finalizationFiles]) {
      try { harness.push(...read(runDirectory, baseline.binding?.backend, uid)); } catch { /* Fail closed. */ }
    }
    for (const [name, bytes] of harness) {
      const target = path.join(upload, name);
      fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
      fs.chownSync(target, runnerUid, runnerGid);
    }
    const target = path.join(upload, 'collection-status.txt');
    fs.writeFileSync(target, `Collection failed: failedCheck=${failure.failedCheck} category=${failure.category}\n`,
      { mode: 0o600, flag: 'wx' });
    fs.chownSync(target, runnerUid, runnerGid);
    fs.chownSync(upload, runnerUid, runnerGid);
    fs.chmodSync(runDirectory, 0o711);
  }
}

function classifyFailure(error) {
  const checks = ['startup-schema', 'finalization-schema', 'result-failure-schema', 'retention-unavailable-schema',
    'operation-schema', 'session-schema', 'session-bound', 'stream-bound',
    'diagnostics-schema', 'diagnostics-identity',
    'retention-eligibility', 'stop-proof', 'stream-schema', 'coverage-schema', 'backend-schema', 'docker-stop-proof',
    'prepared-scope', 'run-budget', 'journal-schema', 'journal-identity', 'invocation-budget', 'proxy-run-identity',
    'artifact-run-identity', 'artifact-invocation-identity', 'artifact-directory', 'diagnostics-envelope',
    'run-evidence', 'artifact-name', 'captured-stream', 'stream-status', 'artifact-collision', 'cli-arguments',
    'path-containment', 'directory-metadata', 'inventory-count', 'file-type', 'file-links', 'file-owner',
    'file-permissions', 'file-size', 'file-device', 'file-growth', 'proxy-event-completeness', 'proxy-event-count',
    'proxy-event-schema', 'proxy-response-schema', 'proxy-container-size', 'proxy-container-schema', 'artifact-count',
    'proxy-event-encoding', 'proxy-container-encoding',
    'publication-file-count', 'publication-status-size', 'publication-bytes', 'credential-redaction-bound'];
  if (checks.includes(error.failedCheck) && ['invalid-evidence', 'ineligible', 'not-stopped',
    'absent-evidence', 'scope-already-collected', 'unsafe-directory', 'unsafe-file', 'unsafe-permissions',
    'oversized', 'concurrent-runs', 'multiple-invocations'].includes(error.category)) {
    return { failedCheck: error.failedCheck, category: error.category };
  }
  const filesystem = {
    ENOENT: { failedCheck: 'source-presence', category: 'absent-evidence' },
    EEXIST: { failedCheck: 'prepared-scope', category: 'scope-already-collected' },
    ELOOP: { failedCheck: 'source-link', category: 'unsafe-file' },
    EACCES: { failedCheck: 'filesystem-permissions', category: 'unsafe-permissions' },
    EPERM: { failedCheck: 'filesystem-permissions', category: 'unsafe-permissions' },
    EFBIG: { failedCheck: 'file-size', category: 'oversized' },
  };
  return filesystem[error.code] ?? { failedCheck: 'source-io', category: 'read-failed' };
}

module.exports = {
  prepare, collect, retainStartup, retainFinalization, assertPublicationBounds,
  publishCollectionFailure, classifyFailure, snapshot,
};
