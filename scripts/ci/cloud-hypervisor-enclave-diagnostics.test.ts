import * as fs from 'fs';
import * as path from 'path';
import { persistHostExecutorProxyDebugDiagnostics } from '../../src/enclave/host-executor-journal';
import { projectEnclaveSessionDiagnostics } from '../../src/cloud-hypervisor/enclave-session-diagnostics';
import { captureEnclaveProxyContainerLog, preservePublicEnclaveProxyDiagnostics } from '../../src/enclave/proxy-debug-retention';

const diagnostics = require('./cloud-hypervisor-enclave-diagnostics');
const live = require('./cloud-hypervisor-enclave-live-smoke');
const collector = require('./collect-enclave-smoke-debug.cjs');

describe('public enclave conformance diagnostic retention', () => {
  const uid = process.getuid!();
  const gid = process.getgid!();
  const secret = 'PRIVATE_TOKEN_CAPABILITY_ENV_PAYLOAD';
  const runId = 'a'.repeat(32);
  const vmId = 'b'.repeat(32);
  const invocationId = 'b'.repeat(24);
  let temp: string;
  let output: string;
  let roots: { journal: string; debug: string };

  function config() {
    return {
      cloudHypervisor: { previewEnabled: true },
      enclaves: [{
        script: {}, runtime: 'cloud-hypervisor', repos: [{ repo: 'github/gh-aw-firewall', sensitivity: 'public' }],
      }],
    };
  }
  const prepare = (value: unknown = config()) => diagnostics.prepare(value, output, { roots, uid, trustedRoot: temp });
  const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const records = () => fs.readdirSync(path.join(output, 'upload')).map(name =>
    fs.readFileSync(path.join(output, 'upload', name), 'utf8')).join('\n');
  function invocation(executorKind = 'agent', id = vmId, run = runId, invocationIdentity = invocationId) {
    write(path.join(roots.journal, `${run}.journal`), { state: 'open', runId: run, secret });
    const file = path.join(roots.journal, 'diagnostics', `${run}-${id}.json`);
    write(file, {
      schemaVersion: 1, runId: run, invocationId: invocationIdentity, executorKind, sequence: 3, elapsedMs: 12,
      checks: { 'host-invocation-cleanup/storage-close': ['failed', 'EACCES'] },
      milestones: [{ phase: 'work-complete', elapsedMs: 10, outcome: 'executor-failure', secret }],
      guestSession: {
        status: 'captured', bytes: 100, rejected: 0, dropped: 0,
        events: [{ event: 'failure', category: 'engine-failed', secret }],
      },
      failure: { message: secret, path: secret }, secret,
    });
    return file;
  }

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(process.cwd(), '.conformance-diagnostics-test-'));
    output = path.join(temp, 'exports', 'run', 'live');
    roots = { journal: path.join(temp, 'journal'), debug: path.join(temp, 'debug') };
    for (const directory of [path.dirname(output), roots.debug, path.join(roots.journal, 'diagnostics')]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it('reprojects the failed MCP step into the uploaded acceptance summary', () => {
    const context = prepare();
    diagnostics.collect(context, { status: 'failed', check: {
      step: 'guest-failure', phase: 'result-validation', status: 'failed', reason: 'tool-is-error',
      httpStatus: 200, message: secret, response: {
        toolIsError: true, structuredStatus: 'error', contentMatches: true,
        headers: secret, content: secret, error: secret,
      },
    } });
    const summary = JSON.parse(fs.readFileSync(path.join(output, 'upload/acceptance.json'), 'utf8'));
    expect(summary.check).toEqual({
      step: 'guest-failure', phase: 'result-validation', status: 'failed', reason: 'tool-is-error',
      httpStatus: 200, response: { toolIsError: true, contentMatches: true, structuredStatus: 'error' },
    });
    expect(records()).not.toContain(secret);
  });

  it('retains the original crash-recovery failure and bounded cleanup evidence without private metadata', () => {
    const context = prepare();
    const check = {
      step: 'crash-recovery', phase: 'recovery-validation', status: 'failed',
      reason: 'recovery-validation-failed', code: 'EIO', message: secret,
      recovery: {
        uniqueRecord: true, cleaned: false, storageMountedIdentityMatches: false,
        directoryMatches: secret, directoryIdentity: secret, inode: 23456, runId: secret,
      },
    };
    diagnostics.collect(context, { status: 'failed', check, checks: [
      check,
      ...Array(20).fill({
        step: 'crash-recovery', phase: 'host-cleanup', status: 'failed', code: 'EPERM',
        reason: 'operation-failed', stack: secret,
      }),
      { step: 'crash-recovery', phase: 'compose-cleanup', status: 'passed', payload: secret },
    ] });
    const summary = JSON.parse(fs.readFileSync(path.join(output, 'upload/acceptance.json'), 'utf8'));
    expect(summary.check).toEqual({
      step: 'crash-recovery', phase: 'recovery-validation', status: 'failed',
      reason: 'recovery-validation-failed', code: 'EIO',
      recovery: { uniqueRecord: true, cleaned: false, storageMountedIdentityMatches: false },
    });
    expect(summary.checks).toHaveLength(16);
    expect(summary.checks[0]).toEqual({
      step: 'crash-recovery', phase: 'host-cleanup', status: 'failed', reason: 'operation-failed', code: 'EPERM',
    });
    expect(summary.checks.at(-1)).toEqual({ step: 'crash-recovery', phase: 'compose-cleanup', status: 'passed' });
    expect(diagnostics.projectAcceptanceCheck(summary.check)).toEqual(summary.check);
    expect(records()).not.toMatch(/PRIVATE_TOKEN|23456/);
  });

  it('rejects arbitrary crash operation, errno, invariant and response values at publication', () => {
    expect(diagnostics.projectAcceptanceCheck({ step: 'crash-recovery', phase: secret, status: 'failed' }))
      .toBeUndefined();
    expect(diagnostics.projectAcceptanceCheck({
      step: 'crash-recovery', phase: 'host-kill', status: 'failed', reason: secret, code: secret,
      interrupted: secret, recovery: { cleaned: secret, [secret]: true },
    })).toEqual({ step: 'crash-recovery', phase: 'host-kill', status: 'failed', recovery: {} });
    expect(diagnostics.projectAcceptanceCheck({
      step: 'crash-recovery', phase: 'interrupted-response', status: 'passed', interrupted: 'disconnected',
    })).toEqual({
      step: 'crash-recovery', phase: 'interrupted-response', status: 'passed', interrupted: 'disconnected',
    });
  });

  it('retains finite refreshed-baseline checks through upload without exposing the resource record', () => {
    const context = prepare();
    diagnostics.collect(context, { status: 'failed', check: {
      step: 'crash-recovery', phase: 'resource-refresh', status: 'failed', reason: 'crash-baseline-invalid',
      baseline: {
        uniqueRecord: true, pending: true, ownerMatches: false, identityMatches: true,
        mountsRetained: true, mountsCommitted: true, snapshotMounted: false,
        ownerPid: 23456, mountPoint: secret, [secret]: true,
      },
      record: { owner: secret, storage: secret },
    } });
    const summary = JSON.parse(fs.readFileSync(path.join(output, 'upload/acceptance.json'), 'utf8'));
    expect(summary.check).toEqual({
      step: 'crash-recovery', phase: 'resource-refresh', status: 'failed', reason: 'crash-baseline-invalid',
      baseline: {
        uniqueRecord: true, pending: true, ownerMatches: false, identityMatches: true,
        mountsRetained: true, mountsCommitted: true, snapshotMounted: false,
      },
    });
    expect(diagnostics.projectAcceptanceCheck(summary.check)).toEqual(summary.check);
    expect(diagnostics.projectAcceptanceCheck({
      step: 'crash-recovery', phase: 'resource-refresh', status: 'passed',
      baseline: { mountsRetained: secret, pending: 1, [secret]: true },
    })).toEqual({ step: 'crash-recovery', phase: 'resource-refresh', status: 'passed', baseline: {} });
    expect(records()).not.toMatch(/PRIVATE_TOKEN|23456/);
  });

  it.each(['script-only', 'agent-only'])(
    'retains the first %s failure and fixed tool flags through independent upload reprojection', profile => {
      const context = prepare();
      const check = {
        step: profile, phase: 'tools-validation', status: 'failed', reason: 'profile-tools-invalid', code: 'EIO',
        profile: { serverMatches: true, toolsArray: true, scriptPresent: true, agentPresent: true, toolsMatch: false,
          tools: [secret], name: secret, [secret]: true },
        response: { present: true, idMatches: true, body: secret },
        message: secret,
      };
      diagnostics.collect(context, { status: 'failed', check, checks: [
        check,
        ...Array(20).fill({ step: profile, phase: 'cleanup', status: 'passed', private: secret }),
      ] });
      const summary = JSON.parse(fs.readFileSync(path.join(output, 'upload/acceptance.json'), 'utf8'));
      expect(summary.check).toEqual({
        step: profile, phase: 'tools-validation', status: 'failed', reason: 'profile-tools-invalid', code: 'EIO',
        profile: { serverMatches: true, toolsArray: true, scriptPresent: true, agentPresent: true, toolsMatch: false },
        response: { present: true, idMatches: true },
      });
      expect(summary.checks).toHaveLength(16);
      expect(summary.checks.every((value: { phase: string; status: string }) =>
        value.phase === 'cleanup' && value.status === 'passed')).toBe(true);
      expect(diagnostics.projectAcceptanceCheck(summary.check)).toEqual(summary.check);
      expect(diagnostics.projectAcceptanceCheck({
        step: profile, phase: 'initialize-validation', status: 'failed', reason: secret, code: secret,
        profile: { serverMatches: secret, toolsArray: 1, [secret]: true },
      })).toEqual({ step: profile, phase: 'initialize-validation', status: 'failed', profile: {} });
      expect(records()).not.toContain(secret);
    },
  );

  it('retains only finite publication and discovery facts across upload reprojection', () => {
    const context = prepare();
    const file = invocation('script');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.resourcePublication = {
      status: 'published', location: 'default', operation: 'record-lstat', code: 'none',
      namespaceStatus: 'captured', recordSafe: true, runIdLength: 32, invocationIdLength: 24,
      ownerPid: 12345, directoryIdentity: { device: 23456, inode: 34567 }, mountNamespace: secret,
      path: secret, payload: secret,
    };
    write(file, value);
    diagnostics.collect(context, { status: 'failed', check: {
      step: 'guest-timeout', phase: 'resource-discovery', status: 'failed', reason: 'resource-discovery-timeout',
      inventory: {
        operation: 'complete', entries: 'many', nameMatches: 'zero', rejectedNames: 'one',
        producer: 'published', producerDirectory: 'different', producerNamespace: 'same',
        mountNamespace: 'same', producerActive: true, producerRecordSafe: true,
        ownerPid: 12345, directoryIdentity: secret, filenames: [secret], error: secret,
      },
    } });
    const summary = JSON.parse(fs.readFileSync(path.join(output, 'upload/acceptance.json'), 'utf8'));
    expect(summary.check.inventory).toEqual({
      operation: 'complete', entries: 'many', nameMatches: 'zero', rejectedNames: 'one',
      producer: 'published', producerDirectory: 'different', producerNamespace: 'same',
      mountNamespace: 'same', producerActive: true, producerRecordSafe: true,
    });
    const projected = JSON.parse(fs.readFileSync(path.join(output, 'upload/invocation-1.json'), 'utf8'));
    expect(projected.resourcePublication).toEqual({
      status: 'published', location: 'default', operation: 'record-lstat', code: 'none',
      namespaceStatus: 'captured', recordSafe: true, runIdLength: 32, invocationIdLength: 24,
    });
    expect(diagnostics.projectInvocation(projected).resourcePublication).toEqual(projected.resourcePublication);
    expect(diagnostics.projectAcceptanceCheck(summary.check)).toEqual(summary.check);
    expect(records()).not.toMatch(/PRIVATE_TOKEN|12345|23456|34567|mountNamespace.*PRIVATE/);
  });

  it('captures admission closure and broker rejections before private fixture cleanup', () => {
    const context = prepare();
    invocation();
    const audit = path.join(temp, 'broker-audit');
    fs.mkdirSync(audit, { mode: 0o700 });
    fs.writeFileSync(path.join(audit, 'enclave.jsonl'), JSON.stringify({
      kind: 'failure', invocationId: secret, reason: 'invocation-count-exhausted', detail: secret,
    }) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(audit, 'enclave-host-executor.jsonl'), [
      { kind: 'lifecycle', event: 'host-executor', detail: {
        phase: 'response', status: 'parsed', reason: 'closed', secret,
      } },
      { kind: 'lifecycle', event: 'invocation-timing', detail: {
        phase: 'admission', status: 'rejected', reason: 'admissions-closed',
        accepting: false, laneClosed: true, secret,
      } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
    write(path.join(roots.journal, 'diagnostics', `${runId}-${'c'.repeat(32)}.json`), {
      schemaVersion: 1, runId, component: 'host-executor-control', events: [],
      admissionClosure: { phase: 'admissions-closed', reason: 'closed', outcome: 'executor-failure',
        cleanupComplete: 'absent', recoverableFailure: 'absent', invocationId: secret, secret },
      failure: { phase: 'request-rejected', reason: 'closed', message: secret },
    });
    const evidence = diagnostics.captureAdmissionEvidence(context, audit);
    expect(evidence.broker.status).toBe('captured');
    expect(evidence.broker.events).toEqual(expect.arrayContaining([
      { phase: 'response', status: 'parsed', reason: 'closed' },
      { phase: 'admission', status: 'rejected', reason: 'admissions-closed', accepting: false, laneClosed: true },
    ]));
    expect(evidence.hostControl.failures).toEqual(expect.arrayContaining([
      { phase: 'admissions-closed', reason: 'closed', outcome: 'executor-failure',
        cleanupComplete: 'absent', recoverableFailure: 'absent' },
    ]));
    fs.rmSync(audit, { recursive: true });
    diagnostics.collect(context, { status: 'failed', admissionEvidence: evidence, checks: [{
      step: 'guest-cancellation', phase: 'request', status: 'passed', secret,
      response: { structuredStatus: 'error', secret },
    }] });
    expect(records()).toContain('"recoverableFailure":"absent"');
    expect(records()).toContain('"structuredStatus":"error"');
    expect(records()).not.toContain(secret);
  });

  it('bounds admission history and revalidates every field at upload', () => {
    const context = prepare();
    diagnostics.collect(context, { status: 'failed', admissionEvidence: {
      broker: { status: 'captured', secret,
        events: Array(100).fill({ phase: 'admission', reason: secret, status: 'rejected', secret }),
        failures: Array(100).fill({ phase: 'failure', reason: 'invalid-request', secret }) },
      hostControl: { status: secret, events: [{ phase: 'invoke', secret }] },
    }, checks: Array(100).fill({
      step: 'guest-cancellation', phase: 'resource-discovery', status: 'failed',
      resources: { newRecords: 'one', eligible: 'zero', ownerMatches: secret }, secret,
    }) });
    const value = JSON.parse(fs.readFileSync(path.join(output, 'upload/acceptance.json'), 'utf8'));
    expect(value.admissionEvidence.broker.events).toHaveLength(32);
    expect(value.admissionEvidence.broker.failures).toHaveLength(16);
    expect(value.admissionEvidence.hostControl).toBeUndefined();
    expect(value.checks).toHaveLength(16);
    expect(value.checks[0].resources).toEqual({ newRecords: 'one', eligible: 'zero' });
    expect(records()).not.toContain(secret);
  });

  it('publishes the bounded host-deadline drain failure without copying private details', () => {
    const context = prepare();
    const event = { phase: 'status', status: 'failed', reason: 'deadline-drain-timeout', secret };
    diagnostics.collect(context, { status: 'failed', admissionEvidence: {
      broker: { status: 'captured', events: [event], failures: [event] },
    } });
    const value = JSON.parse(fs.readFileSync(path.join(output, 'upload/acceptance.json'), 'utf8'));
    const expected = { phase: 'status', status: 'failed', reason: 'deadline-drain-timeout' };
    expect(value.admissionEvidence.broker.events).toEqual([expected]);
    expect(value.admissionEvidence.broker.failures).toEqual([expected]);
    expect(records()).not.toContain(secret);
  });

  it('reports an unsafe broker audit rather than following a symlink or copying raw text', () => {
    const context = prepare();
    const audit = path.join(temp, 'unsafe-audit');
    fs.mkdirSync(audit, { mode: 0o700 });
    const privateFile = path.join(temp, 'private-record');
    fs.writeFileSync(privateFile, secret, { mode: 0o600 });
    fs.symlinkSync(privateFile, path.join(audit, 'enclave.jsonl'));
    const evidence = diagnostics.captureAdmissionEvidence(context, audit);
    expect(evidence.broker).toEqual({ status: 'read-failed' });
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(diagnostics.captureAdmissionEvidence(undefined, audit)).toEqual({});
  });

  it('admits only the explicitly named root-owned sticky ancestor for the broker audit', () => {
    let sticky = true;
    let baseUid = 0;
    let symlink = false;
    let privateWritable = false;
    const nodeFs: typeof fs = require('node:fs');
    jest.spyOn(nodeFs, 'lstatSync').mockImplementation(target => Object.assign(fs.statSync(temp), {
      uid: String(target) === '/var/tmp' ? baseUid : uid,
      mode: String(target) === '/var/tmp' ? (sticky ? 0o41777 : 0o40777)
        : (privateWritable && String(target) === '/var/tmp/private' ? 0o40777 : 0o40700),
      isSymbolicLink: () => symlink && String(target) === '/var/tmp',
    }));
    expect(() => collector.directory('/var/tmp/private/audit', uid, '/', '/var/tmp')).not.toThrow();
    expect(() => collector.directory('/var/tmp/private/audit', uid, '/')).toThrow();
    expect(() => collector.directory('/var/tmp', uid, '/', '/var/tmp')).toThrow();
    sticky = false;
    expect(() => collector.directory('/var/tmp/private/audit', uid, '/', '/var/tmp')).toThrow();
    sticky = true;
    baseUid = uid === 0 ? 1 : uid;
    expect(() => collector.directory('/var/tmp/private/audit', uid, '/', '/var/tmp')).toThrow();
    baseUid = 0;
    symlink = true;
    expect(() => collector.directory('/var/tmp/private/audit', uid, '/', '/var/tmp')).toThrow();
    symlink = false;
    privateWritable = true;
    expect(() => collector.directory('/var/tmp/private/audit', uid, '/', '/var/tmp')).toThrow();
  });

  it('drops arbitrary check fields and rejects unknown step identities', () => {
    expect(diagnostics.projectAcceptanceCheck({
      step: secret, phase: 'request', status: 'failed',
    })).toBeUndefined();
    expect(diagnostics.projectAcceptanceCheck({
      step: 'guest-timeout', phase: 'request', status: 'failed', reason: secret,
      httpStatus: 999, response: { present: secret, structuredStatus: secret },
    })).toEqual({ step: 'guest-timeout', phase: 'request', status: 'failed', response: {} });
  });

  it.each(['agent-enospc', 'script-enospc', 'guest-oom'])(
    'retains the exact %s failure and finite reason in the uploaded artifact', step => {
      const context = prepare();
      diagnostics.collect(context, { status: 'failed', stage: 'resource-limit checks', check: {
        step, phase: 'result-validation', status: 'failed', reason: 'result-mismatch',
        httpStatus: 200, expected: secret, actual: secret, response: {
          structuredStatus: 'ok', contentMatches: true, result: secret,
        },
      } });
      const summary = JSON.parse(fs.readFileSync(path.join(output, 'upload/acceptance.json'), 'utf8'));
      expect(summary.check).toEqual({
        step, phase: 'result-validation', status: 'failed', reason: 'result-mismatch',
        httpStatus: 200, response: { structuredStatus: 'ok', contentMatches: true },
      });
      expect(records()).not.toContain(secret);
      expect(diagnostics.projectAcceptanceCheck({
        step, phase: 'result-validation', status: 'failed', reason: 'expected-ok-status',
      })).toEqual({
        step, phase: 'result-validation', status: 'failed', reason: 'expected-ok-status',
      });
    },
  );

  it.each(['passed', 'failed'])('retains public script and agent evidence outside the deleted fixture on %s', status => {
    const context = prepare();
    invocation();
    invocation('script', 'c'.repeat(32), 'd'.repeat(32));
    const debug = path.join(roots.debug, runId, invocationId);
    fs.mkdirSync(debug, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(debug, 'enclave-session.log'), [
      JSON.stringify({ event: 'progress', stage: 'engine-started', secret }),
      JSON.stringify({ event: 'failure', category: 'engine-failed', message: secret }),
      secret,
    ].join('\n'), { mode: 0o600 });
    for (const name of ['stdout.log', 'stderr.log', 'diagnostics.json',
      'launcher-stderr.log', 'guest-stdout.raw.log', 'runtime.json']) {
      fs.writeFileSync(path.join(debug, name), secret, { mode: 0o600 });
    }
    write(path.join(roots.journal, `${runId}-${vmId}.resources.json`), { secret });
    const fixture = path.join(temp, 'fixture');
    fs.mkdirSync(fixture, { mode: 0o700 });
    const raw = ['awf.stdout.log', 'awf.stderr.log', 'awf-startup-error.json'].map(name => path.join(fixture, name));
    for (const file of [...raw, path.join(fixture, 'gateway.env'), path.join(fixture, 'awf-config.json')]) {
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
    try {
      if (status === 'failed') throw new Error(secret);
    } catch {
      // The harness deliberately suppresses raw exception text.
    } finally {
      diagnostics.collect(context, { status });
      live.removePrivateAwfLogs(raw[0], raw[1], [raw[2]]);
      fs.rmSync(fixture, { recursive: true });
    }
    expect(fs.existsSync(fixture)).toBe(false);
    expect(fs.readdirSync(path.join(output, 'upload')).sort()).toEqual([
      'acceptance.json', 'invocation-1.json', 'invocation-2.json', 'session-1.json',
    ]);
    expect(records()).toContain(`"status":"${status}"`);
    expect(records()).toContain('"executorKind":"script"');
    expect(records()).toContain('"executorKind":"agent"');
    expect(records()).toContain('"category":"engine-failed"');
    expect(records()).not.toContain(secret);
    expect(records()).not.toContain(runId);
    expect(records()).not.toContain(vmId);
    diagnostics.publish(output, uid, gid, uid, temp);
    for (const name of fs.readdirSync(path.join(output, 'upload'))) {
      const stat = fs.statSync(path.join(output, 'upload', name));
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.uid).toBe(uid);
    }
    expect(fs.statSync(path.join(output, 'upload')).mode & 0o777).toBe(0o700);
  });

  it.each(['internal', 'confidential', 'trusted', undefined])('does not retain non-public/default-private scope %s', sensitivity => {
    const value = config();
    if (sensitivity === undefined) delete (value.enclaves[0].repos[0] as { sensitivity?: string }).sensitivity;
    else value.enclaves[0].repos[0].sensitivity = sensitivity;
    const context = prepare(value);
    expect(context).toBeUndefined();
    const raw = ['stdout', 'stderr', 'startup-error'].map(name => path.join(temp, name));
    for (const file of raw) fs.writeFileSync(file, secret);
    diagnostics.collect(context, { status: 'failed', secret });
    live.removePrivateAwfLogs(raw[0], raw[1], [raw[2]]);
    for (const file of raw) expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(output)).toBe(false);
  });

  it.each(['../../escape', 'queue', secret, 'g'.repeat(24), 'b'.repeat(15)])(
    'rejects invalid invocation identity without using it as a debug path: %s', id => {
      const context = prepare();
      invocation('agent', vmId, runId, id);
      expect(() => diagnostics.collect(context, { status: 'failed' }))
        .toThrow(/invocation identity mismatch/);
      expect(fs.existsSync(path.join(output, 'upload'))).toBe(false);
    });

  it('does not confuse a stale run or flat VM directory with the current public session', () => {
    const stale = path.join(roots.debug, 'c'.repeat(32), invocationId);
    fs.mkdirSync(stale, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stale, 'enclave-session.log'),
      '{"event":"failure","category":"engine-failed"}\n', { mode: 0o600 });
    const context = prepare();
    invocation();
    const flat = path.join(roots.debug, vmId);
    fs.mkdirSync(flat, { mode: 0o700 });
    fs.writeFileSync(path.join(flat, 'enclave-session.log'),
      '{"event":"failure","category":"engine-failed"}\n', { mode: 0o600 });
    diagnostics.collect(context, { status: 'failed' });
    expect(fs.readdirSync(path.join(output, 'upload')).sort())
      .toEqual(['acceptance.json', 'invocation-1.json']);
  });

  it.each(['run-symlink', 'invocation-symlink', 'file-symlink', 'hardlink', 'permissions', 'oversized'])(
    'rejects unsafe nested public session %s before publication', kind => {
      const context = prepare();
      invocation();
      const directory = path.join(roots.debug, runId, invocationId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, 'enclave-session.log');
      fs.writeFileSync(file, '{"event":"failure","category":"engine-failed"}\n', { mode: 0o600 });
      if (kind === 'run-symlink' || kind === 'invocation-symlink') {
        const source = kind === 'run-symlink' ? path.dirname(directory) : directory;
        fs.renameSync(source, path.join(temp, 'moved'));
        fs.symlinkSync(path.join(temp, 'moved'), source);
      } else if (kind === 'file-symlink') {
        fs.unlinkSync(file);
        fs.symlinkSync(path.join(output, 'baseline.json'), file);
      } else if (kind === 'hardlink') fs.linkSync(file, path.join(temp, 'linked'));
      else if (kind === 'permissions') fs.chmodSync(file, 0o644);
      else fs.writeFileSync(file, Buffer.alloc(collector.MAX_STREAM_BYTES + 1));
      expect(() => diagnostics.collect(context, { status: 'failed' })).toThrow();
      expect(fs.existsSync(path.join(output, 'upload'))).toBe(false);
    });

  it('honors the production public-debug opt-out and rejects mixed or dynamic scopes', () => {
    expect(prepare({ ...config(), cloudHypervisor: { previewEnabled: true, enclaveDebugPublic: false } })).toBeUndefined();
    const mixed = config();
    mixed.enclaves[0].repos.push({ repo: 'octo/private', sensitivity: 'internal' });
    expect(prepare(mixed)).toBeUndefined();
    const dynamic = { ...config(), enclaves: [{
      agent: { model: 'gpt-4.1' }, runtime: 'cloud-hypervisor',
      dynamic: { sensitivity: 'public' },
    }] };
    expect(prepare(dynamic)).toBeUndefined();
  });

  it('excludes stale run and invocation evidence', () => {
    invocation();
    const context = prepare();
    diagnostics.collect(context, { status: 'failed' });
    expect(fs.readdirSync(path.join(output, 'upload'))).toEqual(['acceptance.json']);
  });

  it('retains an explicit early failure without any journal or invocation', () => {
    const context = prepare();
    diagnostics.collect(context, { status: 'failed', stage: 'gateway setup' });
    expect(fs.readdirSync(path.join(output, 'upload'))).toEqual(['acceptance.json']);
    expect(records()).toContain('"stage":"gateway setup"');
  });

  it('revalidates late output metadata and exact file errors at upload, including broken-transcript fallback', () => {
    const context = prepare();
    const file = invocation();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.guestSession = projectEnclaveSessionDiagnostics(Buffer.from([
      ...Array.from({ length: 40 }, () => ({ event: 'progress', stage: 'engine-started' })),
      { event: 'output-snapshot', stage: 'after-engine', uid: 65534, gid: 65534,
        paths: [{ path: 'output-file', type: 'file', uid: 65534, gid: 65534,
          mode: 0o600, readable: true, size: 'empty', contents: secret }] },
      { event: 'operation-error', operation: 'output-read-close', category: 'io-error', errno: 5, fatal: true },
      { event: 'failure', category: 'result-read-failed' },
    ].map(event => JSON.stringify(event)).join('\n')));
    value.guestFileOperations = [{
      event: 'operation-error', operation: 'session-log-write', category: 'no-space',
      errno: 28, fatal: false, filename: secret,
    }, { event: 'operation-error', operation: secret, category: 'os-error' }];
    value.guestSession.output.paths[0].contents = secret;
    value.guestWrapperFailure = { event: 'failure', category: 'result-empty', message: secret };
    write(file, value);
    diagnostics.collect(context, { status: 'failed', stage: 'resource-limit checks' });
    const retained = JSON.parse(fs.readFileSync(path.join(output, 'upload', 'invocation-1.json'), 'utf8'));
    expect(retained.guestSession.lastEvent.category).toBe('result-read-failed');
    expect(retained.guestSession.operationErrors).toContainEqual({
      event: 'operation-error', operation: 'output-read-close', category: 'io-error', errno: 5, fatal: true,
    });
    expect(retained.guestSession.output.paths[0]).toMatchObject({
      path: 'output-file', uid: 65534, gid: 65534, mode: 0o600, size: 'empty',
    });
    expect(retained.guestFileOperations).toEqual([{
      event: 'operation-error', operation: 'session-log-write', category: 'no-space', errno: 28, fatal: false,
    }]);
    expect(retained.guestWrapperFailure).toEqual({ event: 'failure', category: 'result-empty' });
    expect(records()).not.toContain(secret);
  });

  it.each([8, 9])('enforces the exact eight-run bound (%s runs)', count => {
    const context = prepare();
    for (let index = 0; index < count; index++) {
      const id = index.toString(16).padStart(32, '0');
      write(path.join(roots.journal, `${id}.journal`), { state: 'open', runId: id });
    }
    if (count === 8) {
      expect(() => diagnostics.collect(context, { status: 'passed' })).not.toThrow();
    } else {
      expect(() => diagnostics.collect(context, { status: 'failed' })).toThrow(/run count exceeds bound/);
      expect(fs.existsSync(path.join(output, 'upload'))).toBe(false);
    }
  });

  it('reprojects probe milestones and actual-read metadata into uploaded invocation records', () => {
    const context = prepare();
    const file = invocation();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.guestSession = projectEnclaveSessionDiagnostics(Buffer.from([
      ...Array.from({ length: 40 }, () => ({ event: 'progress', stage: 'engine-started' })),
      { event: 'storage-probe', status: 'captured', milestones: [
        { stage: 'storage-complete', enospcObserved: true },
        { stage: 'output-write-complete' },
        { stage: 'output-verified', symlink: true, targetMatches: true, sameFile: true,
          directReadable: true, aliasReadable: true, directMatchesExpected: true, aliasMatchesExpected: true },
        { stage: 'output-check-failed', operation: 'alias-close', errno: 5 },
      ] },
      { event: 'output-verification', stage: 'before-engine', symlink: true, targetMatches: true,
        sameFile: true, contentsMatch: true, directState: 'empty', aliasState: 'empty' },
      { event: 'output-verification', stage: 'after-engine', symlink: true, targetMatches: true,
        sameFile: true, contentsMatch: true, directState: 'empty', aliasState: 'empty' },
      { event: 'operation-error', operation: 'verify-output-direct-close', category: 'io-error',
        errno: 5, fatal: false },
      { event: 'output-normalization', inputState: 'empty', stdoutState: 'present' },
      { event: 'failure', category: 'result-empty' },
    ].map(event => JSON.stringify(event)).join('\n')));
    value.guestSession.storageProbe.path = secret;
    value.guestSession.storageProbe.milestones[0].result = secret;
    value.guestSession.normalization.stdout = secret;
    value.guestSession.normalization.byteCount = 999;
    value.guestSession.outputVerification[0].target = secret;
    value.guestSession.outputVerification[1].contents = secret;
    write(file, value);
    diagnostics.collect(context, { status: 'failed', stage: 'resource-limit checks' });
    const retained = JSON.parse(fs.readFileSync(path.join(output, 'upload', 'invocation-1.json'), 'utf8'));
    expect(retained.guestSession.storageProbe).toEqual({ status: 'captured', milestones: [
      { stage: 'storage-complete', enospcObserved: true },
      { stage: 'output-write-complete' },
      { stage: 'output-verified', symlink: true, targetMatches: true, sameFile: true,
        directReadable: true, aliasReadable: true, directMatchesExpected: true, aliasMatchesExpected: true },
      { stage: 'output-check-failed', operation: 'alias-close', errno: 5 },
    ] });
    expect(retained.guestSession.outputVerification).toEqual([
      { stage: 'before-engine', symlink: true, targetMatches: true, sameFile: true,
        contentsMatch: true, directState: 'empty', aliasState: 'empty' },
      { stage: 'after-engine', symlink: true, targetMatches: true, sameFile: true,
        contentsMatch: true, directState: 'empty', aliasState: 'empty' },
    ]);
    expect(diagnostics.projectInvocation(retained).guestSession.outputVerification)
      .toEqual(retained.guestSession.outputVerification);
    expect(retained.guestSession.operationErrors).toContainEqual({
      event: 'operation-error', operation: 'verify-output-direct-close', category: 'io-error', errno: 5, fatal: false,
    });
    expect(retained.guestSession.normalization).toEqual({ inputState: 'empty', stdoutState: 'present' });
    expect(retained.guestSession.failure).toEqual({ event: 'failure', category: 'result-empty' });
    expect(records()).not.toContain(secret);
    expect(records()).not.toContain('byteCount');
  });

  it('rejects more than 128 projected files without publishing a partial artifact', () => {
    const context = prepare();
    for (let index = 0; index < 64; index++) {
      const id = index.toString(16).padStart(32, '0');
      invocation('agent', id, runId, id);
      const directory = path.join(roots.debug, runId, id);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(directory, 'enclave-session.log'),
        '{"event":"failure","category":"engine-failed"}\n', { mode: 0o600 });
    }
    expect(() => diagnostics.collect(context, { status: 'failed' })).toThrow(/count exceeds bound/);
    expect(fs.existsSync(path.join(output, 'upload'))).toBe(false);
  });

  it.each([false, true])('makes empty export paths runner-traversable when upload exists: %s', hasUpload => {
    prepare();
    const upload = path.join(output, 'upload');
    const pending = path.join(output, 'pending-upload');
    fs.mkdirSync(pending, { mode: 0o700 });
    if (hasUpload) fs.mkdirSync(upload, { mode: 0o700 });
    diagnostics.publish(output, uid, gid, uid, temp);
    for (const directory of [path.dirname(path.dirname(output)), path.dirname(output), output]) {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o711);
    }
    expect(fs.statSync(path.join(output, 'baseline.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(pending).mode & 0o777).toBe(0o700);
    if (hasUpload) {
      expect(fs.statSync(upload).mode & 0o777).toBe(0o700);
      expect(fs.statSync(upload).uid).toBe(uid);
    } else {
      expect(fs.existsSync(upload)).toBe(false);
    }
  });

  it('retains projected proxy evidence before the first invocation, without a run journal', () => {
    const context = prepare();
    persistHostExecutorProxyDebugDiagnostics({ runId, journalDir: roots.journal },
      [{ schemaVersion: 1, origin: 'local', status: 403 }],
      'source=stderr level=warn event=enclave_model_budget_rejected\ncapture_status=captured dropped=0\n');
    write(path.join(roots.journal, 'diagnostics', `${runId}-${'e'.repeat(32)}.json`), {
      schemaVersion: 1, component: 'enclave-proxy-response', runId,
      diagnostics: { scope: 'run-cumulative', status: 'captured', records: 1, local: { '403': 1 }, upstream: {}, secret },
    });
    diagnostics.collect(context, { status: 'failed' });
    expect(records()).toContain('enclave_model_budget_rejected');
    expect(records()).toContain('"403":1');
    expect(records()).not.toContain(secret);
  });

  it('uploads the new auth projection without copying provider text or header values', async () => {
    const context = prepare();
    const log = await captureEnclaveProxyContainerLog(async () => ({
      exitCode: 0, stderr: '',
      stdout: JSON.stringify({
        level: 'warn', event: 'copilot_auth_diagnostic', status: 401,
        credential_source: 'github_token', credential_kind: 'fine_grained_pat',
        target: 'standard', endpoint: 'models', authorization: 'bearer',
        error_class: 'invalid_credential', body_capture: 'complete',
        response_body: secret, headers: { Authorization: secret }, targetHost: secret,
      }) + '\n',
    }));
    await preservePublicEnclaveProxyDiagnostics({ runId, journalDir: roots.journal },
      { scope: 'run-cumulative', status: 'captured', records: 1, local: {}, upstream: { '401': 1 } },
      [{ schemaVersion: 1, origin: 'upstream', status: 401 }], log);
    diagnostics.collect(context, { status: 'failed' });
    expect(records()).toContain('event=copilot_auth_diagnostic status=401 credential_source=github_token');
    expect(records()).toContain('error_class=invalid_credential');
    expect(records()).toContain('endpoint=models');
    expect(records()).not.toMatch(/PRIVATE_TOKEN|response_body|Authorization|targetHost/);
  });

  it.each(['symlink', 'hardlink', 'permissions', 'oversized', 'identity', 'schema', 'check-suffix'])(
    'rejects unsafe %s sources before publishing anything', kind => {
      const context = prepare();
      const source = invocation();
      if (kind === 'symlink') { fs.unlinkSync(source); fs.symlinkSync(path.join(output, 'baseline.json'), source); }
      if (kind === 'hardlink') fs.linkSync(source, path.join(temp, 'linked'));
      if (kind === 'permissions') fs.chmodSync(source, 0o644);
      if (kind === 'oversized') fs.writeFileSync(source, Buffer.alloc(320 * 1024 + 1));
      if (kind === 'identity') write(source, { schemaVersion: 1, runId: 'f'.repeat(32) });
      if (kind === 'schema') write(source, { schemaVersion: 1, runId, executorKind: 'agent', sequence: 0, elapsedMs: 1,
        checks: { [secret]: ['passed', 'none'] } });
      if (kind === 'check-suffix') write(source, {
        schemaVersion: 1, runId, executorKind: 'agent', sequence: 0, elapsedMs: 1,
        checks: { 'host-invocation-cleanup/storage-close//PRIVATE_TOKEN': ['passed', 'none'] },
        milestones: [],
      });
      expect(() => diagnostics.collect(context, { status: 'failed' })).toThrow();
      expect(fs.existsSync(path.join(output, 'upload'))).toBe(false);
      expect(fs.existsSync(path.join(output, 'upload'))).toBe(false);
    });

    it('preserves independently retained late session failures after the event bound', () => {
      const events = Array.from({ length: 32 }, () => ({ event: 'progress', stage: 'engine-launch-attempt' }));
      const projected = diagnostics.projectInvocation({
        schemaVersion: 1, executorKind: 'agent', sequence: 40, elapsedMs: 500, checks: {}, milestones: [],
        guestSession: {
          status: 'captured', bytes: 1024, rejected: 0, dropped: 70, events,
          failure: { event: 'failure', category: 'deadline-exceeded', secret },
          lastEvent: { event: 'engine-result', exitCode: -9, secret },
          resources: { stage: 'after-engine', memory: { peakBytes: 1234, oom_kill: 1 }, filesystems: [] },
        },
      });
      expect(projected.guestSession).toMatchObject({
        failure: { event: 'failure', category: 'deadline-exceeded' },
        lastEvent: { event: 'engine-result', exitCode: -9 },
        resources: { memory: { peakBytes: 1234, oom_kill: 1 } },
      });
      expect(JSON.stringify(projected)).not.toContain(secret);
    });

    it('projects operation errors independently and remains stable when reprojected', () => {
      const fatal = {
        event: 'operation-error', operation: 'output-read-close', category: 'io-error', errno: 5, fatal: true,
      };
      const projected = diagnostics.projectInvocation({
        schemaVersion: 1, executorKind: 'agent', sequence: 42, elapsedMs: 700, checks: {}, milestones: [],
        guestSession: {
          status: 'captured', bytes: 128, rejected: 0, dropped: 0,
          events: [fatal],
          failure: fatal,
          operationErrors: [fatal],
        },
      });
      expect(projected.guestSession.operationErrors).toEqual([fatal]);
      expect(projected.guestSession.failure).toEqual(fatal);
      expect(diagnostics.projectInvocation(projected).guestSession.operationErrors).toEqual([fatal]);
    });

    it('preserves session counters and the chronological final event after truncation and malformed lines', () => {
    const first = { event: 'progress', stage: 'configuration-accepted' };
    const lines = [
      JSON.stringify(first),
      ...Array.from({ length: 31 }, () => JSON.stringify({ event: 'progress', stage: 'engine-started' })),
      ...Array.from({ length: 70 }, () => JSON.stringify({ event: 'progress', stage: 'engine-completed' })),
      '{malformed',
      JSON.stringify(first),
    ];
    const source = projectEnclaveSessionDiagnostics(Buffer.from(lines.join('\n')));
    const projected = diagnostics.projectInvocation({
      schemaVersion: 1, executorKind: 'agent', sequence: 41, elapsedMs: 600, checks: {}, milestones: [],
      guestSession: source,
    }).guestSession;
    expect(projected).toMatchObject({
      status: 'captured', bytes: source.bytes, rejected: 1, dropped: 71,
      lastEvent: { event: 'progress', stage: 'configuration-accepted' },
    });
    expect(projected?.events).toHaveLength(32);
  });

  it('fails explicitly on a projected write error without disclosing the underlying error', () => {
    const context = prepare();
    invocation();
    const nodeFs = require('fs') as typeof fs;
    const originalWrite = fs.writeFileSync;
    jest.spyOn(nodeFs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).endsWith('acceptance.json')) throw new Error(secret);
      return originalWrite(file, ...args);
    });
    expect(() => diagnostics.collect(context, { status: 'failed' })).toThrow();
    // Harnesses catch this with a constant error, then still remove private logs.
    for (const name of ['cloud-hypervisor-enclave-live-smoke.js', 'cloud-hypervisor-enclave-environment-probe.js']) {
      const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
      const retain = source.indexOf('conformanceDiagnostics.collect(');
      expect(retain).toBeGreaterThan(source.indexOf('await stopAwf(') < 0
        ? source.indexOf('await live.stopAwf(') : source.indexOf('await stopAwf('));
      expect(retain).toBeLessThan(source.indexOf('removePrivateAwfLogs(awfOut, awfErr'));
      expect(source.slice(retain)).toContain('raw files will not be uploaded.');
    }
  });

  it('uses fixed job/run destinations and exports only projected session metadata', () => {
    expect(diagnostics.exportDirectory('live', { GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '3' }))
      .toBe('/var/lib/awf-enclave-conformance-export/12-3/live');
    expect(() => diagnostics.exportDirectory('../private', { GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '3' })).toThrow();
    expect(() => diagnostics.exportDirectory('live', { GITHUB_RUN_ID: '../12', GITHUB_RUN_ATTEMPT: '3' })).toThrow();
    expect(projectEnclaveSessionDiagnostics(Buffer.from(JSON.stringify({
      event: 'failure', category: 'engine-failed', message: secret,
    })))).toMatchObject({ failure: { event: 'failure', category: 'engine-failed' } });
  });
});
