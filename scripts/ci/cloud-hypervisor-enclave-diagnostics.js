'use strict';

const fs = require('fs');
const path = require('path');
const collector = require('./collect-enclave-smoke-debug.cjs');
const { normalizeEnclavesConfig } = require('../../dist/parsers/enclave-parser');
const { resolvePublicEnclaveDebugConfig, validatePublicEnclaveDebug } = require('../../dist/enclave/public-debug');
const { projectEnclaveSessionDiagnostics } = require('../../dist/cloud-hypervisor/enclave-session-diagnostics');
const { schema } = require('../../dist/cloud-hypervisor/host-preflight-schema');

const EXPORT_ROOT = '/var/lib/awf-enclave-conformance-export';
const ROOTS = {
  journal: '/var/lib/awf-cloud-hypervisor/host-executor-journal',
  debug: '/var/lib/awf-cloud-hypervisor/debug-artifacts/cloud-hypervisor',
};
const DIAGNOSTIC_NAME = /^([a-f0-9]{32})-([a-f0-9]{32})(?:\.proxy-debug)?\.json$/;
const UPLOAD_NAME = /^(?:acceptance|invocation-[0-9]+|session-[0-9]+|proxy-[0-9]+)\.json$/;
const MAX_RECORDS = 128;

function exportDirectory(kind, environment = process.env) {
  if (!['live', 'environment-probe'].includes(kind)
      || !/^[0-9]+$/.test(environment.GITHUB_RUN_ID || '')
      || !/^[0-9]+$/.test(environment.GITHUB_RUN_ATTEMPT || '')) {
    throw new Error('Conformance diagnostics require a fixed job and Actions run identity');
  }
  return path.join(EXPORT_ROOT, `${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`, kind);
}

function prepare(config, runDirectory, { roots = ROOTS, uid = 0, trustedRoot = '/' } = {}) {
  const resolved = resolvePublicEnclaveDebugConfig({
    cloudHypervisor: config.cloudHypervisor,
    enclaves: normalizeEnclavesConfig(config.enclaves),
  });
  if (!resolved.cloudHypervisor?.enclaveDebugPublic || validatePublicEnclaveDebug(resolved).length) {
    return undefined;
  }
  collector.directory(path.dirname(runDirectory), uid, trustedRoot);
  collector.prepare(runDirectory, roots, uid, trustedRoot);
  return { runDirectory, roots, uid, trustedRoot };
}

function prepareForJob(config, kind) {
  const target = exportDirectory(kind);
  for (const directory of [EXPORT_ROOT, path.dirname(target)]) {
    collector.directory(path.dirname(directory), 0);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    collector.directory(directory, 0);
  }
  return prepare(config, target);
}

function projectInvocation(value) {
  const count = n => Number.isSafeInteger(n) && n >= 0;
  if (value?.schemaVersion !== 1 || !['script', 'agent'].includes(value.executorKind)
      || !count(value.sequence) || !count(value.elapsedMs)
      || !value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)
      || !Array.isArray(value.milestones) || value.milestones.length > 32) {
    throw new Error('Invalid conformance invocation diagnostic');
  }
  const checks = {};
  for (const [id, outcome] of Object.entries(value.checks)) {
    const parts = id.split('/');
    const [scope, check] = parts;
    if (parts.length !== 2 || !Object.hasOwn(schema.scopes, scope) || !Object.hasOwn(schema.scopes[scope], check)
        || !Array.isArray(outcome) || outcome.length !== 2
        || !['not-attempted', 'not-required', 'attempted', 'passed', 'failed'].includes(outcome[0])
        || !Object.hasOwn(schema.reasons, outcome[1])) {
      throw new Error('Invalid conformance invocation check');
    }
    checks[id] = [...outcome];
  }
  const milestones = value.milestones.map(item => {
    if (!['guest-complete', 'work-complete', 'cleanup-start', 'cleanup-complete',
      'deadline-expired', 'cancellation', 'manager-stop-start', 'manager-stop-complete',
      'result-read-start', 'result-read-complete'].includes(item?.phase) || !count(item.elapsedMs)
        || (item.outcome !== undefined && !['success', 'schema-failure', 'executor-failure',
          'timeout', 'cancelled'].includes(item.outcome))) {
      throw new Error('Invalid conformance invocation milestone');
    }
    return { phase: item.phase, elapsedMs: item.elapsedMs,
      ...(item.outcome === undefined ? {} : { outcome: item.outcome }) };
  });
  // Never copy the journal's free-form fields, resource records, paths or IDs.
  const session = value.guestSession;
  let guestSession;
  if (session && ['empty', 'missing', 'unsafe', 'oversized', 'read-failed', 'invalid', 'not-stopped'].includes(session.status)) {
    guestSession = { status: session.status };
  } else if (session?.status === 'captured' && Array.isArray(session.events) && session.events.length <= 32) {
    if (!count(session.bytes) || session.bytes > 1024 * 1024
        || !count(session.rejected) || session.rejected > session.bytes
        || !count(session.dropped) || session.dropped > session.bytes) {
      throw new Error('Invalid conformance session counters');
    }
    const events = [...session.events];
    if (session.failure) events.push(session.failure);
    if (session.resources) {
      events.push({
        ...session.resources, event: 'resource-snapshot',
        memory: { ...session.resources.memory, events: session.resources.memory },
      });
    }
    const projected = projectEnclaveSessionDiagnostics(
      Buffer.from(events.map(event => JSON.stringify(event) + '\n').join('')),
    );
    const lastEvent = session.lastEvent
      ? projectEnclaveSessionDiagnostics(Buffer.from(JSON.stringify(session.lastEvent))).lastEvent : undefined;
    guestSession = { ...projected, bytes: session.bytes, rejected: session.rejected, dropped: session.dropped };
    delete guestSession.lastEvent;
    if (lastEvent) guestSession.lastEvent = lastEvent;
  } else if (session !== undefined) {
    throw new Error('Invalid conformance session diagnostic');
  }
  return { schemaVersion: 1, executorKind: value.executorKind,
    sequence: value.sequence, elapsedMs: value.elapsedMs, checks, milestones,
    ...(guestSession ? { guestSession } : {}) };
}

function collect(context, acceptance) {
  if (!context) return;
  const { runDirectory, roots, uid, trustedRoot } = context;
  collector.directory(runDirectory, uid, trustedRoot);
  const baseline = JSON.parse(collector.readRegular(path.join(runDirectory, 'baseline.json'), 1024 * 1024, uid));
  const journals = collector.inventory(roots.journal, uid, trustedRoot)
    .filter(name => /^[a-f0-9]{32}\.journal$/.test(name) && !baseline.journals.includes(name));
  const diagnostics = path.join(roots.journal, 'diagnostics');
  const names = collector.inventory(diagnostics, uid, trustedRoot);
  const proxyDebug = names.filter(name => DIAGNOSTIC_NAME.test(name)
    && name.endsWith('.proxy-debug.json') && !baseline.proxyDebug.includes(name));
  const runIds = new Set([...journals.map(name => name.slice(0, 32)), ...proxyDebug.map(name => name.slice(0, 32))]);
  if (runIds.size > 8) throw new Error('Conformance diagnostic run count exceeds bound');
  const files = [['acceptance.json', acceptance]];
  let invocations = 0;
  let proxies = 0;
  let sessions = 0;
  for (const name of names) {
    const match = DIAGNOSTIC_NAME.exec(name);
    if (!match || !runIds.has(match[1])) continue;
    if (files.length >= MAX_RECORDS) throw new Error('Conformance diagnostic count exceeds bound');
    const value = JSON.parse(collector.readRegular(path.join(diagnostics, name), 320 * 1024, uid));
    if (value?.schemaVersion !== 1 || value.runId !== match[1]) {
      throw new Error('Conformance diagnostic run identity mismatch');
    }
    if (value.executorKind !== undefined) {
      files.push([`invocation-${++invocations}.json`, projectInvocation(value)]);
    } else if (value.component === 'enclave-proxy-usage') {
      files.push([`proxy-${++proxies}.json`, {
        component: value.component, usage: collector.projectProxyUsage(value.usage),
      }]);
    } else if (value.component === 'enclave-proxy-response') {
      files.push([`proxy-${++proxies}.json`, collector.projectProxyResponse({
        ...value.diagnostics, schemaVersion: 1, component: value.component,
      })]);
    } else if (value.component === 'enclave-proxy-debug') {
      if (value.scope !== 'run-cumulative' || !Array.isArray(value.events)
          || value.events.length > 4096 || typeof value.containerLog !== 'string') {
        throw new Error('Invalid conformance proxy projection');
      }
      files.push([`proxy-${++proxies}.json`, {
        events: collector.projectProxyEvents(Buffer.from(value.events.map(event => JSON.stringify(event) + '\n').join(''))).toString(),
        containerLog: collector.projectProxyContainerLog(Buffer.from(value.containerLog)).toString(),
      }]);
    }
    // Only production's host-authorized public debug directory can supply a session.
    // Project it again: even credential-redacted free-form text is not upload-safe.
    const debugDirectory = path.join(roots.debug, match[2]);
    if (value.executorKind === 'agent' && !baseline.debug.includes(match[2])) {
      try {
        collector.directory(debugDirectory, uid, trustedRoot);
        const bytes = collector.readRegular(path.join(debugDirectory, 'enclave-session.log'), collector.MAX_STREAM_BYTES, uid);
        files.push([`session-${++sessions}.json`, projectEnclaveSessionDiagnostics(bytes)]);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  if (files.length > MAX_RECORDS) throw new Error('Conformance diagnostic count exceeds bound');
  // Nothing reaches the upload directory unless the complete bounded projection succeeds.
  const staging = path.join(runDirectory, 'pending-upload');
  fs.mkdirSync(staging, { mode: 0o700 });
  for (const [name, contents] of files) {
    fs.writeFileSync(path.join(staging, name), JSON.stringify(contents) + '\n', { mode: 0o600, flag: 'wx' });
  }
  fs.renameSync(staging, path.join(runDirectory, 'upload'));
}

function publish(runDirectory, runnerUid, runnerGid, uid = 0, trustedRoot = '/') {
  const upload = path.join(runDirectory, 'upload');
  const names = collector.inventory(upload, uid, trustedRoot);
  if (!names.length) {
    const ancestors = [path.dirname(path.dirname(runDirectory)), path.dirname(runDirectory), runDirectory];
    for (const directory of ancestors) {
      try {
        collector.directory(directory, uid, trustedRoot);
      } catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
      fs.chmodSync(directory, 0o711);
    }
    try {
      fs.chownSync(upload, runnerUid, runnerGid);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    console.error('No public conformance diagnostics were retained; no raw files will be uploaded.');
    return;
  }
  if (names.length > MAX_RECORDS || names.some(name => !UPLOAD_NAME.test(name))) {
    throw new Error('Unexpected conformance upload file');
  }
  for (const name of names) collector.readRegular(path.join(upload, name), 1024 * 1024, uid);
  for (const name of names) fs.chownSync(path.join(upload, name), runnerUid, runnerGid);
  fs.chownSync(upload, runnerUid, runnerGid);
  for (const directory of [runDirectory, path.dirname(runDirectory), path.dirname(path.dirname(runDirectory))]) {
    fs.chmodSync(directory, 0o711);
  }
}

module.exports = { prepare, prepareForJob, collect, publish, exportDirectory, projectInvocation };

if (require.main === module) {
  const [kind, runnerUid, runnerGid] = process.argv.slice(2);
  if (process.getuid() !== 0 || !/^[0-9]+$/.test(runnerUid || '') || !/^[0-9]+$/.test(runnerGid || '')) {
    throw new Error('Conformance diagnostic publication requires root and numeric runner ownership');
  }
  publish(exportDirectory(kind), Number(runnerUid), Number(runnerGid));
}
