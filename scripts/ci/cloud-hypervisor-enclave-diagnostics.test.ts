import * as fs from 'fs';
import * as path from 'path';
import { persistHostExecutorProxyDebugDiagnostics } from '../../src/enclave/host-executor-journal';
import { projectEnclaveSessionDiagnostics } from '../../src/cloud-hypervisor/enclave-session-diagnostics';

const diagnostics = require('./cloud-hypervisor-enclave-diagnostics');
const live = require('./cloud-hypervisor-enclave-live-smoke');

describe('public enclave conformance diagnostic retention', () => {
  const uid = process.getuid!();
  const gid = process.getgid!();
  const secret = 'PRIVATE_TOKEN_CAPABILITY_ENV_PAYLOAD';
  const runId = 'a'.repeat(32);
  const vmId = 'b'.repeat(32);
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
  function invocation(executorKind = 'agent', id = vmId, run = runId) {
    write(path.join(roots.journal, `${run}.journal`), { state: 'open', runId: run, secret });
    const file = path.join(roots.journal, 'diagnostics', `${run}-${id}.json`);
    write(file, {
      schemaVersion: 1, runId: run, invocationId: secret, executorKind, sequence: 3, elapsedMs: 12,
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

  it.each(['passed', 'failed'])('retains public script and agent evidence outside the deleted fixture on %s', status => {
    const context = prepare();
    invocation();
    invocation('script', 'c'.repeat(32), 'd'.repeat(32));
    const debug = path.join(roots.debug, vmId);
    fs.mkdirSync(debug, { mode: 0o700 });
    fs.writeFileSync(path.join(debug, 'enclave-session.log'), [
      JSON.stringify({ event: 'progress', stage: 'engine-started', secret }),
      JSON.stringify({ event: 'failure', category: 'engine-failed', message: secret }),
      secret,
    ].join('\n'), { mode: 0o600 });
    for (const name of ['launcher-stderr.log', 'guest-stdout.raw.log', 'runtime.json']) {
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

  it('rejects more than 128 projected files without publishing a partial artifact', () => {
    const context = prepare();
    for (let index = 0; index < 64; index++) {
      const id = index.toString(16).padStart(32, '0');
      invocation('agent', id);
      const directory = path.join(roots.debug, id);
      fs.mkdirSync(directory, { mode: 0o700 });
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
