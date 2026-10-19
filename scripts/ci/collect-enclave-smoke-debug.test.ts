import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { prepare, collect, MAX_STREAM_BYTES, MAX_FILES } = require('./collect-enclave-smoke-debug.cjs');

describe('host-only public enclave debug collector', () => {
  let temp: string;
  let run: string;
  let roots: { journal: string; debug: string };
  const uid = process.getuid!();
  const gid = process.getgid!();
  const runId = 'a'.repeat(32);
  // The broker uses randomBytes(12), not the VM's 32-hex identity.
  const invocationId = 'b'.repeat(24);
  const vmId = createHash('sha256').update(JSON.stringify([
    'awf-host-enclave-v1', runId, 'script', invocationId,
  ])).digest('hex').slice(0, 32);

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(process.cwd(), '.enclave-debug-test-'));
    run = path.join(temp, 'run');
    roots = { journal: path.join(temp, 'journal'), debug: path.join(temp, 'debug') };
    for (const directory of Object.values(roots)) fs.mkdirSync(directory, { mode: 0o700 });
  });
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

  const prepareRun = () => prepare(run, roots, uid, temp);
  function invocation() {
    fs.writeFileSync(path.join(roots.journal, `${runId}.journal`), [
      JSON.stringify({ runId, state: 'open' }),
      JSON.stringify({ invocationId, entryId: 'script', state: 'cleanup-pending' }),
    ].join('\n'), { mode: 0o600 });
    const source = path.join(roots.debug, vmId);
    fs.mkdirSync(source, { mode: 0o700 });
    fs.writeFileSync(path.join(source, 'guest-stderr.raw.log'), 'failed guest evidence', { mode: 0o600 });
    return source;
  }
  const collectRun = () => collect(run, uid, gid, roots, uid, temp);

  it('collects a failed invocation but excludes stale directories and journals', () => {
    fs.mkdirSync(path.join(roots.debug, 'c'.repeat(32)), { mode: 0o700 });
    fs.writeFileSync(path.join(roots.journal, `${'d'.repeat(32)}.journal`), 'stale', { mode: 0o600 });
    prepareRun();
    invocation();
    for (const suffix of ['resources.json', 'diagnostics.json']) {
      fs.writeFileSync(path.join(roots.journal, `${runId}-${invocationId}.${suffix}`),
        'not uploaded', { mode: 0o600 });
    }
    expect(collectRun()).toBe(1);
    const upload = path.join(run, 'upload');
    expect(fs.readdirSync(upload).sort()).toEqual(['collection-status.txt', 'guest-stderr.raw.log']);
    const stat = fs.statSync(path.join(upload, 'guest-stderr.raw.log'));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.uid).toBe(uid);
    expect(fs.statSync(upload).mode & 0o777).toBe(0o700);
  });

  it('explicitly records an early failure with no debug logs', () => {
    prepareRun();
    expect(collectRun()).toBe(0);
    expect(fs.readFileSync(path.join(run, 'upload/collection-status.txt'), 'utf8'))
      .toContain('No public-fixture debug logs were produced');
    expect(fs.readFileSync(path.join(run, 'upload/collection-status.txt'), 'utf8'))
      .toContain('Enclave proxy usage (requests/tokens): missing');
  });

  function proxySummary(value: unknown) {
    const diagnostics = path.join(roots.journal, 'diagnostics');
    fs.mkdirSync(diagnostics, { mode: 0o700 });
    const id = createHash('sha256').update(`awf-enclave-proxy-usage-v1:${runId}`).digest('hex').slice(0, 32);
    const target = path.join(diagnostics, `${runId}-${id}.json`);
    fs.writeFileSync(target, JSON.stringify({
      schemaVersion: 1, component: 'enclave-proxy-usage', runId, usage: value,
      payload: 'PRIVATE_PAYLOAD', credential: 'PRIVATE_CREDENTIAL',
    }), { mode: 0o600 });
    return target;
  }

  function proxyResponse(value: unknown) {
    const diagnostics = path.join(roots.journal, 'diagnostics');
    fs.mkdirSync(diagnostics, { mode: 0o700 });
    const id = createHash('sha256').update(`awf-enclave-proxy-response-v1:${runId}`).digest('hex').slice(0, 32);
    const target = path.join(diagnostics, `${runId}-${id}.json`);
    fs.writeFileSync(target, JSON.stringify({
      schemaVersion: 1, component: 'enclave-proxy-response', runId, diagnostics: value,
    }), { mode: 0o600 });
    return target;
  }

  it('exports explicit unavailable response evidence even without an invocation debug directory', () => {
    prepareRun();
    invocation();
    fs.rmSync(path.join(roots.debug, vmId), { recursive: true });
    proxyResponse({ scope: 'run-cumulative', status: 'not-drained',
      payload: 'PRIVATE_PAYLOAD' });
    expect(collectRun()).toBe(1);
    const value = fs.readFileSync(path.join(run, 'upload/enclave-proxy-response.json'), 'utf8');
    expect(JSON.parse(value)).toEqual({
      schemaVersion: 1, component: 'enclave-proxy-response',
      scope: 'run-cumulative', status: 'not-drained',
    });
    expect(value).not.toContain('PRIVATE');
    expect(fs.readFileSync(path.join(run, 'upload/collection-status.txt'), 'utf8'))
      .toContain('Enclave proxy response diagnostics: not-drained.');
  });

  it.each(['symlink', 'hardlink', 'oversized', 'permissions'])(
    'rejects unsafe run-level proxy response %s before staging', kind => {
      prepareRun();
      invocation();
      const source = proxyResponse({ scope: 'run-cumulative', status: 'empty' });
      if (kind === 'symlink') {
        fs.unlinkSync(source);
        fs.symlinkSync(path.join(run, 'baseline.json'), source);
      } else if (kind === 'hardlink') fs.linkSync(source, path.join(temp, 'duplicate'));
      else if (kind === 'oversized') fs.writeFileSync(source, Buffer.alloc(16 * 1024 + 1));
      else fs.chmodSync(source, 0o644);
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
    });

  it('publishes only allowlisted usage accounting from protected run evidence, independently of raw logs', () => {
    prepareRun();
    invocation();
    fs.rmSync(path.join(roots.debug, vmId), { recursive: true });
    proxySummary({
      requests: {
        status: 'captured', records: 4, trackedResponses: 2, websocketSessions: 0,
        statuses: { '200': 1, '401': 1, PRIVATE_STATUS: 1 },
        results: { ok: 1, skip_status: 1, PRIVATE_ERROR: 1 }, path: '/PRIVATE_PATH',
      },
      tokens: {
        status: 'captured', records: 1, usageRecords: 1,
        totals: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4,
          PRIVATE_FIELD: 'PRIVATE_SECRET' },
        model: 'PRIVATE_MODEL',
      },
    });
    expect(collectRun()).toBe(1);
    const target = path.join(run, 'upload/enclave-proxy-usage.json');
    const text = fs.readFileSync(target, 'utf8');
    expect(JSON.parse(text).usage).toEqual({
      scope: 'run-cumulative',
      requests: {
        status: 'captured', records: 4, trackedResponses: 2, websocketSessions: 0,
        statuses: { '200': 1, '401': 1 }, results: { ok: 1, skip_status: 1 },
      },
      tokens: { status: 'captured', records: 1, usageRecords: 1,
        totals: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 } },
    });
    expect(text).not.toMatch(/PRIVATE|credential|model|payload|path|runId/);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(run, 'upload/collection-status.txt'), 'utf8'))
      .toContain('Enclave proxy usage (requests/tokens): captured/captured');
  });

  it('exports malformed/unavailable classifications without fabricating zero token totals', () => {
    prepareRun();
    invocation();
    proxySummary({
      requests: { status: 'oversized', trackedResponses: 0 },
      tokens: { status: 'captured', records: 5000, usageRecords: 0, totals: {} },
    });
    expect(collectRun()).toBe(2);
    const text = fs.readFileSync(path.join(run, 'upload/enclave-proxy-usage.json'), 'utf8');
    expect(JSON.parse(text).usage).toEqual({
      scope: 'run-cumulative', requests: { status: 'oversized' }, tokens: { status: 'malformed' },
    });
    expect(text).not.toContain('totals');
  });

  it.each(['symlink', 'mode', 'oversized', 'hardlink'])('rejects unsafe usage %s before public export', kind => {
    prepareRun();
    invocation();
    const source = proxySummary({});
    if (kind === 'symlink') {
      fs.unlinkSync(source);
      fs.symlinkSync(path.join(run, 'baseline.json'), source);
    } else if (kind === 'mode') fs.chmodSync(source, 0o644);
    else if (kind === 'oversized') fs.writeFileSync(source, Buffer.alloc(16 * 1024 + 1));
    else fs.linkSync(source, path.join(temp, 'duplicate'));
    expect(collectRun).toThrow();
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
  });

  it('collects agent session-export server diagnostics without exporting session contents', () => {
    prepareRun();
    const source = invocation();
    const names = ['virtiofs-4-enclave-session-handoff.log', 'virtiofs-4-enclave-session-handoff-confinement.json',
      'virtiofs-5-enclave-session-state.log', 'virtiofs-5-enclave-session-state-confinement.json'];
    for (const name of names) fs.writeFileSync(path.join(source, name), '{}', { mode: 0o600 });
    expect(collectRun()).toBe(5);
    expect(fs.readdirSync(path.join(run, 'upload')).sort())
      .toEqual(['collection-status.txt', 'guest-stderr.raw.log', ...names].sort());
  });

  it('includes the bounded host-retained public Copilot session in smoke debug artifacts', () => {
    prepareRun();
    const source = invocation();
    fs.writeFileSync(path.join(source, 'enclave-session.log'),
      '{"event":"engine-result","stderr":{"raw":"public engine error"}}\n', { mode: 0o600 });
    expect(collectRun()).toBe(2);
    const session = path.join(run, 'upload/enclave-session.log');
    expect(fs.readFileSync(session, 'utf8')).toContain('public engine error');
    expect(fs.statSync(session).mode & 0o777).toBe(0o600);
  });

  it('collects only projected dedicated enclave proxy evidence, never primary or raw proxy logs', () => {
    prepareRun();
    const source = invocation();
    fs.writeFileSync(path.join(source, 'enclave-proxy-events.jsonl'),
      '{"schemaVersion":1,"origin":"local","status":403,"credential":"PRIVATE_SECRET"}\n',
      { mode: 0o600 });
    fs.writeFileSync(path.join(source, 'enclave-proxy-container.log'),
      'source=stderr level=warn event=upstream_auth_error status=403\ncapture_status=captured dropped=0\n',
      { mode: 0o600 });
    expect(collectRun()).toBe(3);
    expect(fs.readdirSync(path.join(run, 'upload')).sort()).toEqual([
      'collection-status.txt', 'enclave-proxy-container.log', 'enclave-proxy-events.jsonl',
      'guest-stderr.raw.log',
    ]);
    expect(fs.readFileSync(path.join(run, 'upload/enclave-proxy-events.jsonl'), 'utf8'))
      .toBe('{"schemaVersion":1,"origin":"local","status":403}\n');
    fs.writeFileSync(path.join(source, 'api-proxy-logs.jsonl'), 'primary proxy', { mode: 0o600 });
    expect(collectRun).toThrow(/Unexpected debug artifact name/);
  });

  it('rejects arbitrary proxy stdout and stderr despite a trusted filename', () => {
    prepareRun();
    const source = invocation();
    fs.writeFileSync(path.join(source, 'enclave-proxy-container.log'),
      'source=stderr credential=PRIVATE_SECRET\ncapture_status=captured dropped=0\n', { mode: 0o600 });
    expect(collectRun).toThrow(/Unsafe enclave proxy container projection/);
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
  });

  it.each(['{"schemaVersion":1,"origin":"unknown","status":403}\n',
    '{"schemaVersion":1,"origin":"local","status":403}',
    '{"schemaVersion":1,"component":"enclave-proxy-response","scope":"run-cumulative","status":"missing"}\n',
    '{"status":403}\n'])(
    'rejects invalid dedicated proxy event schema', value => {
      prepareRun();
      const source = invocation();
      fs.writeFileSync(path.join(source, 'enclave-proxy-events.jsonl'), value, { mode: 0o600 });
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
    });

  it.each(['symlink', 'hardlink', 'oversized', 'permissions'])(
    'rejects unsafe dedicated proxy %s', kind => {
      prepareRun();
      const source = invocation();
      const file = path.join(source, 'enclave-proxy-events.jsonl');
      if (kind === 'symlink') fs.symlinkSync(path.join(run, 'baseline.json'), file);
      else {
        fs.writeFileSync(file, '{"schemaVersion":1,"origin":"upstream","status":503}\n',
          { mode: 0o600 });
        if (kind === 'hardlink') fs.linkSync(file, path.join(temp, 'duplicate'));
        if (kind === 'oversized') fs.writeFileSync(file, Buffer.alloc(MAX_STREAM_BYTES + 1));
        if (kind === 'permissions') fs.chmodSync(file, 0o644);
      }
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
    });

  it('projects the bounded run-cumulative dedicated proxy status schema', () => {
    prepareRun();
    invocation();
    proxyResponse({ scope: 'run-cumulative', status: 'captured', records: 2,
      local: { '403': 1 }, upstream: { '502': 1 },
      errors: { secret: 'PRIVATE_CREDENTIAL' }, payload: 'PRIVATE_PAYLOAD' });
    expect(collectRun()).toBe(2);
    const events = fs.readFileSync(path.join(run, 'upload/enclave-proxy-response.json'), 'utf8');
    expect(JSON.parse(events)).toEqual({
      schemaVersion: 1, component: 'enclave-proxy-response', scope: 'run-cumulative',
      status: 'captured', records: 2, local: { '403': 1 }, upstream: { '502': 1 },
    });
    expect(events).not.toContain('PRIVATE');
  });

  it('retains eligible evidence alongside global and malformed identities without using them as paths', () => {
    prepareRun();
    invocation();
    fs.appendFileSync(path.join(roots.journal, `${runId}.journal`), '\n' + [
      { invocationId: 'queue' }, { invocationId: 'budget' }, { state: 'closed' },
      { invocationId: '../../PRIVATE_PATH', entryId: 'script' },
      { invocationId, entryId: '../../PRIVATE_ENTRY' },
    ].map(record => JSON.stringify(record)).join('\n') + '\nnull\nPRIVATE_INVALID_JSON');
    expect(collectRun()).toBe(1);
    const status = fs.readFileSync(path.join(run, 'upload/collection-status.txt'), 'utf8');
    expect(status).toContain('Non-invocation records: 3; invalid identity records: 4.');
    expect(status).not.toContain('PRIVATE');
  });

  it('accepts exactly the stream size limit and rejects oversized streams without staging', () => {
    prepareRun();
    const source = invocation();
    const log = path.join(source, 'guest-stderr.raw.log');
    fs.writeFileSync(log, Buffer.alloc(MAX_STREAM_BYTES + 1));
    expect(collectRun).toThrow(/oversized/);
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
    fs.truncateSync(log, MAX_STREAM_BYTES);
    expect(collectRun()).toBe(1);
    expect(fs.statSync(path.join(run, 'upload/guest-stderr.raw.log')).size).toBe(MAX_STREAM_BYTES);
  });

  it.each(['file-symlink', 'directory-symlink', 'hardlink', 'unknown-name', 'count', 'wrong-run',
    'traversal', 'permissions', 'journal-symlink'])('rejects %s before publishing', kind => {
    prepareRun();
    const source = invocation();
    const log = path.join(source, 'guest-stderr.raw.log');
    if (kind === 'file-symlink') {
      fs.unlinkSync(log);
      fs.symlinkSync(path.join(run, 'baseline.json'), log);
    } else if (kind === 'directory-symlink') {
      fs.renameSync(source, path.join(temp, 'moved'));
      fs.symlinkSync(path.join(temp, 'moved'), source);
    } else if (kind === 'hardlink') fs.linkSync(log, path.join(temp, 'hardlink'));
    else if (kind === 'unknown-name') fs.writeFileSync(path.join(source, 'environment.txt'), 'no', { mode: 0o600 });
    else if (kind === 'count') {
      const logNames = ['launcher-stdout.log', 'launcher-stderr.log', 'guest-stdout.raw.log',
        'cloud-hypervisor.log', 'serial.log', 'network-plan.json', 'network-diagnostics.txt',
        'counters.json', 'vm-info.json', 'runtime.json', 'confinement.json'];
      for (let i = 0; i < 8; i++) {
        for (const name of ['enclave-seed', 'enclave-request', 'enclave-output', 'enclave-runtime']) {
          logNames.push(`virtiofs-${i}-${name}`);
        }
      }
      for (const name of logNames.slice(0, MAX_FILES)) {
        fs.writeFileSync(path.join(source, name), '', { mode: 0o600 });
      }
    } else if (kind === 'wrong-run') fs.renameSync(source, path.join(roots.debug, 'e'.repeat(32)));
    else if (kind === 'traversal') {
      fs.writeFileSync(path.join(roots.journal, `${runId}.journal`), [
        JSON.stringify({ runId, state: 'open' }),
        JSON.stringify({ invocationId: '../../escape', entryId: 'script' }),
      ].join('\n'));
    } else if (kind === 'permissions') fs.chmodSync(log, 0o644);
    else if (kind === 'journal-symlink') {
      const journal = path.join(roots.journal, `${runId}.journal`);
      fs.unlinkSync(journal);
      fs.symlinkSync(path.join(run, 'baseline.json'), journal);
    }
    if (kind === 'count') expect(collectRun).toThrow(/Debug file count exceeds bound/);
    else expect(collectRun).toThrow();
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
  });

  it('fails closed on overlapping runs and reusing the snapshot identity', () => {
    prepareRun();
    expect(prepareRun).toThrow();
    invocation();
    fs.mkdirSync(path.join(roots.debug, 'f'.repeat(32)), { mode: 0o700 });
    expect(collectRun).toThrow(/concurrent/);
  });
});
