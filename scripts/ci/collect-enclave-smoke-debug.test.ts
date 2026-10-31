import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { preservePublicEnclaveProxyDiagnostics } from '../../src/enclave/proxy-debug-retention';
import { isSafeCopilotAuthLogFields, projectCopilotAuthLogFields } from '../../src/enclave/proxy-auth-diagnostics';
import { preservePublicEnclaveArtifacts } from '../../src/enclave/public-debug-artifacts';
import {
  HostExecutorJournal, persistHostExecutorProxyUsage, persistHostExecutorProxyResponseDiagnostics,
} from '../../src/enclave/host-executor-journal';
import { resolveDockerEnclavePaths } from '../../src/enclave/docker-lifecycle';
import { resolveDockerPublicEnclaveDebugPaths } from '../../src/enclave/public-debug';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const collector = require('./collect-enclave-smoke-debug.cjs');
const { prepare, collect, MAX_STREAM_BYTES, MAX_FILES, projectDiagnostics, cliRoots } = collector;

describe('host-only public enclave debug collector', () => {
  let temp: string;
  let run: string;
  let roots: { journal: string; debug: string };
  const uid = process.getuid!();
  const gid = process.getgid!();
  const runId = 'a'.repeat(32);
  const invocationId = 'b'.repeat(24);
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(process.cwd(), '.enclave-debug-test-'));
    run = path.join(temp, 'run');
    roots = { journal: path.join(temp, 'journal'), debug: path.join(temp, 'debug') };
    for (const directory of Object.values(roots)) fs.mkdirSync(directory, { mode: 0o700 });
  });
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));
  const prepareRun = () => prepare(run, roots, uid, temp);
  function invocation() {
    const journal = new HostExecutorJournal({
      runId, journalDir: roots.journal, seedsDir: path.join(temp, 'seeds'),
      invocationsDir: path.join(temp, 'invocations'), entries: [],
    });
    journal.record({ invocationId, entryId: 'script', state: 'cleanup-pending' });
    const source = path.join(roots.debug, runId, invocationId);
    fs.mkdirSync(source, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(source, 'guest-stderr.raw.log'), 'failed guest evidence', { mode: 0o600 });
    return source;
  }
  const collectRun = () => collect(run, uid, gid, roots, uid, temp);
  function absentEvidence() {
    let error: unknown;
    try { collectRun(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ category: 'absent-evidence' });
    collector.publishCollectionFailure(run, uid, gid, error, uid, temp);
  }
  function commonEnvelope() {
    return {
      version: 1, runId, invocationId, entryId: 'script', runtime: 'cloud-hypervisor', executorKind: 'script',
      stage: 'execution', failure: 'workload-exit', exitCode: 1, workloadStopped: true,
      workloadLaunched: true, stopProof: 'verified', stages: [{ stage: 'workload-exit', status: 'succeeded' }],
      streams: { stdout: 'captured', stderr: 'captured', session: 'captured' },
      streamCoverage: {
        stdout: { artifactSource: 'backend-stream', agentSession: 'unavailable' },
        stderr: { artifactSource: 'backend-stream', agentSession: 'unavailable' }, copilotDiagnostics: 'unavailable',
      },
      session: { status: 'empty', bytes: 0 },
      backendEvidence: { dockerInspect: { status: 'not-applicable' }, vmCounters: { status: 'unavailable' },
        network: { status: 'unavailable' } },
    };
  }

  it('collects a failed invocation but excludes stale directories and journals', () => {
    fs.mkdirSync(path.join(roots.debug, 'c'.repeat(32)), { mode: 0o700 });
    fs.writeFileSync(path.join(roots.journal, `${'d'.repeat(32)}.journal`), 'stale', { mode: 0o600 });
    prepareRun();
    invocation();
    for (const suffix of ['resources.json', 'diagnostics.json']) {
      fs.writeFileSync(path.join(roots.journal, `${runId}-${invocationId}.${suffix}`), 'not uploaded', { mode: 0o600 });
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
    absentEvidence();
    expect(fs.readFileSync(path.join(run, 'upload/collection-status.txt'), 'utf8'))
      .toContain('category=absent-evidence');
  });
  it('collects the common public artifacts from the run and broker invocation layout', () => {
    prepareRun();
    const source = invocation();
    const names = ['stdout.log', 'stderr.log', 'enclave-session.log', 'diagnostics.json'];
    for (const name of names) fs.writeFileSync(path.join(source, name),
      name === 'diagnostics.json' ? JSON.stringify(commonEnvelope()) + '\n' : '',
      { mode: 0o600 });
    expect(collectRun()).toBe(5);
    expect(fs.readdirSync(path.join(run, 'upload')).sort())
      .toEqual(['collection-status.txt', 'guest-stderr.raw.log', ...names].sort());
  });
  it('tolerates an empty run directory before public artifacts have been published', () => {
    prepareRun();
    const source = invocation();
    fs.rmSync(source, { recursive: true });
    absentEvidence();
  });
  it('rejects reuse of the same invocation identity by another entry', () => {
    prepareRun();
    invocation();
    fs.appendFileSync(path.join(roots.journal, `${runId}.journal`),
      JSON.stringify({ invocationId, entryId: 'other', state: 'cleanup-pending' }) + '\n');
    expect(collectRun).toThrow(/invocation-budget/);
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
  });
  it.each(['wrong-invocation', 'multiple-invocations', 'run-symlink', 'run-permissions'])(
    'rejects unsafe nested debug identity %s before publishing', kind => {
      prepareRun();
      const source = invocation();
      const runSource = path.join(roots.debug, runId);
      if (kind === 'wrong-invocation') fs.renameSync(source, path.join(runSource, 'c'.repeat(24)));
      else if (kind === 'multiple-invocations') fs.mkdirSync(path.join(runSource, 'c'.repeat(24)), { mode: 0o700 });
      else if (kind === 'run-symlink') {
        fs.renameSync(runSource, path.join(temp, 'moved-run'));
        fs.symlinkSync(path.join(temp, 'moved-run'), runSource);
      } else fs.chmodSync(runSource, 0o777);
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
    });
  it.each(['stdout.log', 'stderr.log', 'enclave-session.log', 'diagnostics.json'])(
    'retains existing safety controls for common artifact %s', name => {
      prepareRun();
      const file = path.join(invocation(), name);
      fs.writeFileSync(file, '{}', { mode: 0o600 });
      fs.linkSync(file, path.join(temp, 'linked'));
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
    });
  it.each([false, true])('collects run-cumulative proxy logs without invocation storage (invoked=%s)', async invoked => {
    prepareRun();
    if (invoked) {
      invocation();
      fs.rmSync(path.join(roots.debug, runId), { recursive: true });
    }
    await preservePublicEnclaveProxyDiagnostics({ runId, journalDir: roots.journal }, {
      scope: 'run-cumulative', status: 'captured', records: 1, local: { '403': 1 }, upstream: {},
    }, [{ schemaVersion: 1, origin: 'local', status: 403 }],
    'source=stderr level=warn event=enclave_model_budget_rejected\ncapture_status=captured dropped=0\n');
    expect(collectRun()).toBe(2);
    expect(fs.readFileSync(path.join(run, 'upload/enclave-proxy-events.jsonl'), 'utf8'))
      .toBe('{"schemaVersion":1,"origin":"local","status":403}\n');
    expect(fs.readFileSync(path.join(run, 'upload/enclave-proxy-container.log'), 'utf8'))
      .toContain('event=enclave_model_budget_rejected');
  });
  it('excludes stale run projections', async () => {
    await preservePublicEnclaveProxyDiagnostics({ runId, journalDir: roots.journal },
      { scope: 'run-cumulative', status: 'empty' }, [], 'capture_status=empty\n');
    prepareRun();
    absentEvidence();
  });
  it('rejects run projections belonging to a different current journal', async () => {
    prepareRun();
    invocation();
    await preservePublicEnclaveProxyDiagnostics({ runId: 'c'.repeat(32), journalDir: roots.journal },
      { scope: 'run-cumulative', status: 'empty' }, [], 'capture_status=empty\n');
    expect(collectRun).toThrow(/proxy-run-identity/);
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
  });
  it.each(['symlink', 'hardlink', 'permissions', 'oversized', 'run-id', 'scope', 'log'])(
    'rejects unsafe run-level proxy debug %s before staging', async kind => {
      prepareRun();
      invocation();
      await preservePublicEnclaveProxyDiagnostics({ runId, journalDir: roots.journal },
        { scope: 'run-cumulative', status: 'empty' }, [], 'capture_status=empty\n');
      const id = createHash('sha256').update(`awf-enclave-proxy-debug-v1:${runId}`).digest('hex').slice(0, 32);
      const source = path.join(roots.journal, 'diagnostics', `${runId}-${id}.proxy-debug.json`);
      if (kind === 'symlink') {
        fs.unlinkSync(source);
        fs.symlinkSync(path.join(run, 'baseline.json'), source);
      } else if (kind === 'hardlink') fs.linkSync(source, path.join(temp, 'duplicate'));
      else if (kind === 'permissions') fs.chmodSync(source, 0o644);
      else if (kind === 'oversized') fs.writeFileSync(source, Buffer.alloc(320 * 1024 + 1));
      else {
        const value = JSON.parse(fs.readFileSync(source, 'utf8'));
        if (kind === 'run-id') value.runId = 'c'.repeat(32);
        else if (kind === 'scope') value.scope = 'invocation';
        else value.containerLog = 'PRIVATE_LOG\n';
        fs.writeFileSync(source, JSON.stringify(value));
      }
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
    });
  it('loads as a relocated standalone collector and matches the auth-fields validator', () => {
    const stagedPath = path.join(temp, 'collector.cjs');
    fs.copyFileSync(path.join(__dirname, 'collect-enclave-smoke-debug.cjs'), stagedPath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const staged = require(stagedPath);
    const canonical = projectCopilotAuthLogFields({});
    const cases = [
      canonical, `${canonical} extra=field`,
      canonical.replace('credential_source=none', 'credential_source=PRIVATE_TOKEN'),
      canonical.replace('challenge=not_required', 'challenge=none'), '',
    ];
    for (const value of cases) expect(staged.isSafeCopilotAuthLogFields(value)).toBe(isSafeCopilotAuthLogFields(value));
  });
  it.each(['rate_limited', 'request_validation_failed', 'model_fallback_exhausted',
    'enclave_model_capability_missing', 'enclave_model_capability_scheme', 'enclave_model_capability_format',
    'enclave_model_capability_signature', 'enclave_model_capability_claims', 'enclave_model_capability_claims_changed',
    'enclave_model_token_limit', 'enclave_model_token_body_missing', 'enclave_model_token_input_reservation',
    'enclave_model_token_request_json', 'enclave_model_token_request_shape',
    'enclave_model_token_output_conflict', 'enclave_model_token_output_shape',
    'enclave_model_token_stream_options', 'enclave_model_token_budget_exhausted'])(
    'collects the fixed %s event without free-form data', async event => {
      prepareRun();
      invocation();
      fs.rmSync(path.join(roots.debug, runId), { recursive: true });
      await preservePublicEnclaveProxyDiagnostics({ runId, journalDir: roots.journal },
        { scope: 'run-cumulative', status: 'empty' }, [],
        `source=stderr level=warn event=${event}\ncapture_status=captured dropped=0\n`);
      expect(collectRun()).toBe(2);
      expect(fs.readFileSync(path.join(run, 'upload/enclave-proxy-container.log'), 'utf8')).toContain(`event=${event}\n`);
    });
  function proxySummary(value: unknown) {
    const diagnostics = path.join(roots.journal, 'diagnostics');
    fs.mkdirSync(diagnostics, { mode: 0o700 });
    const id = createHash('sha256').update(`awf-enclave-proxy-usage-v1:${runId}`).digest('hex').slice(0, 32);
    const target = path.join(diagnostics, `${runId}-${id}.json`);
    fs.writeFileSync(target, JSON.stringify({
      schemaVersion: 1, component: 'enclave-proxy-usage', runId,
      usage: { ...(value as Record<string, unknown>), scope: 'run-cumulative' },
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
    fs.rmSync(path.join(roots.debug, runId), { recursive: true });
    proxyResponse({ scope: 'run-cumulative', status: 'not-drained', payload: 'PRIVATE_PAYLOAD' });
    expect(collectRun()).toBe(1);
    const value = fs.readFileSync(path.join(run, 'upload/enclave-proxy-response.json'), 'utf8');
    expect(JSON.parse(value)).toEqual({
      schemaVersion: 1, component: 'enclave-proxy-response', scope: 'run-cumulative', status: 'not-drained',
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
    fs.rmSync(path.join(roots.debug, runId), { recursive: true });
    proxySummary({
      requests: {
        status: 'captured', records: 4, trackedResponses: 2, websocketSessions: 0,
        statuses: { '200': 1, '401': 1, PRIVATE_STATUS: 1 },
        results: { ok: 1, skip_status: 1, PRIVATE_ERROR: 1 }, path: '/PRIVATE_PATH',
      },
      tokens: {
        status: 'captured', records: 1, usageRecords: 1,
        totals: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4,
          PRIVATE_FIELD: 'PRIVATE_SECRET' }, model: 'PRIVATE_MODEL',
      },
    });
    expect(collectRun()).toBe(1);
    const target = path.join(run, 'upload/enclave-proxy-usage.json');
    const text = fs.readFileSync(target, 'utf8');
    expect(JSON.parse(text).usage).toEqual({
      scope: 'run-cumulative',
      requests: { status: 'captured', records: 4, trackedResponses: 2, websocketSessions: 0,
        statuses: { '200': 1, '401': 1 }, results: { ok: 1, skip_status: 1 } },
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
      '{"schemaVersion":1,"origin":"local","status":403,"credential":"PRIVATE_SECRET"}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(source, 'enclave-proxy-container.log'),
      'source=stderr level=warn event=upstream_auth_error status=403\ncapture_status=captured dropped=0\n', { mode: 0o600 });
    expect(collectRun()).toBe(3);
    expect(fs.readdirSync(path.join(run, 'upload')).sort()).toEqual([
      'collection-status.txt', 'enclave-proxy-container.log', 'enclave-proxy-events.jsonl', 'guest-stderr.raw.log',
    ]);
    expect(fs.readFileSync(path.join(run, 'upload/enclave-proxy-events.jsonl'), 'utf8'))
      .toBe('{"schemaVersion":1,"origin":"local","status":403}\n');
    fs.writeFileSync(path.join(source, 'api-proxy-logs.jsonl'), 'primary proxy', { mode: 0o600 });
    expect(collectRun).toThrow();
  });
  it('rejects arbitrary proxy stdout and stderr despite a trusted filename', () => {
    prepareRun();
    const source = invocation();
    fs.writeFileSync(path.join(source, 'enclave-proxy-container.log'),
      'source=stderr credential=PRIVATE_SECRET\ncapture_status=captured dropped=0\n', { mode: 0o600 });
    expect(collectRun).toThrow(/proxy-container-schema/);
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
  });
  it.each(['{"schemaVersion":1,"origin":"unknown","status":403}\n',
    '{"schemaVersion":1,"origin":"local","status":403}',
    '{"schemaVersion":1,"component":"enclave-proxy-response","scope":"run-cumulative","status":"missing"}\n',
    '{"status":403}\n'])('rejects invalid dedicated proxy event schema', value => {
    prepareRun();
    const source = invocation();
    fs.writeFileSync(path.join(source, 'enclave-proxy-events.jsonl'), value, { mode: 0o600 });
    expect(collectRun).toThrow();
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
  });
  it.each(['symlink', 'hardlink', 'oversized', 'permissions'])('rejects unsafe dedicated proxy %s', kind => {
    prepareRun();
    const source = invocation();
    const file = path.join(source, 'enclave-proxy-events.jsonl');
    if (kind === 'symlink') fs.symlinkSync(path.join(run, 'baseline.json'), file);
    else {
      fs.writeFileSync(file, '{"schemaVersion":1,"origin":"upstream","status":503}\n', { mode: 0o600 });
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
      local: { '403': 1 }, upstream: { '502': 1 }, errors: { secret: 'PRIVATE_CREDENTIAL' }, payload: 'PRIVATE_PAYLOAD' });
    expect(collectRun()).toBe(2);
    const events = fs.readFileSync(path.join(run, 'upload/enclave-proxy-response.json'), 'utf8');
    expect(JSON.parse(events)).toEqual({
      schemaVersion: 1, component: 'enclave-proxy-response', scope: 'run-cumulative',
      status: 'captured', records: 2, local: { '403': 1 }, upstream: { '502': 1 },
    });
    expect(events).not.toContain('PRIVATE');
  });
  it('rejects malformed identities alongside eligible evidence without using them as paths', () => {
    prepareRun();
    invocation();
    fs.appendFileSync(path.join(roots.journal, `${runId}.journal`), [
      { invocationId: 'queue' }, { invocationId: 'budget' }, { state: 'closed' },
      { invocationId: '../../PRIVATE_PATH', entryId: 'script' },
      { invocationId, entryId: '../../PRIVATE_ENTRY' },
    ].map(record => JSON.stringify(record)).join('\n') + '\nnull\nPRIVATE_INVALID_JSON');
    expect(collectRun).toThrow(/journal-identity/);
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
  });
  it('accepts exactly the stream size limit and rejects oversized streams without staging', () => {
    prepareRun();
    const log = path.join(invocation(), 'guest-stderr.raw.log');
    fs.writeFileSync(log, Buffer.alloc(MAX_STREAM_BYTES + 1));
    expect(collectRun).toThrow(/file-size/);
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
    fs.rmSync(path.join(roots.debug, runId), { recursive: true });
    fs.unlinkSync(path.join(roots.journal, `${runId}.journal`));
    run = path.join(temp, 'second-scope');
    prepareRun();
    const bounded = path.join(invocation(), 'guest-stderr.raw.log');
    fs.writeFileSync(bounded, Buffer.alloc(MAX_STREAM_BYTES));
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
      for (const name of logNames.slice(0, MAX_FILES)) fs.writeFileSync(path.join(source, name), '', { mode: 0o600 });
    } else if (kind === 'wrong-run') fs.renameSync(path.join(roots.debug, runId), path.join(roots.debug, 'e'.repeat(32)));
    else if (kind === 'traversal') {
      fs.writeFileSync(path.join(roots.journal, `${runId}.journal`), [
        JSON.stringify({ version: 1, runId, state: 'open' }),
        JSON.stringify({ invocationId: '../../escape', entryId: 'script' }),
      ].join('\n'));
    } else if (kind === 'permissions') fs.chmodSync(log, 0o644);
    else if (kind === 'journal-symlink') {
      const journal = path.join(roots.journal, `${runId}.journal`);
      fs.unlinkSync(journal);
      fs.symlinkSync(path.join(run, 'baseline.json'), journal);
    }
    if (kind === 'count') expect(collectRun).toThrow(/artifact-count/);
    else expect(collectRun).toThrow();
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
  });
  it('fails closed on overlapping runs and reusing the snapshot identity', () => {
    prepareRun();
    expect(prepareRun).toThrow();
    invocation();
    fs.mkdirSync(path.join(roots.debug, 'f'.repeat(32)), { mode: 0o700 });
    expect(collectRun).toThrow(/run-budget/);
  });
});

describe('standalone public enclave diagnostics collector', () => {
  let root: string;
  let scope: string;
  let roots: { journal: string; debug: string; backend: string };
  const uid = process.getuid!();
  const gid = process.getgid!();
  const runId = 'a'.repeat(32);
  const invocationId = 'b'.repeat(24);
  const identity = (runtime = roots.backend) => ({ runId, invocationId, entryId: 'script', runtime });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.enclave-debug-test-'));
    scope = path.join(root, 'scope');
    roots = { journal: path.join(root, 'journal'), debug: path.join(root, 'debug'), backend: 'cloud-hypervisor' };
    for (const directory of [roots.journal, roots.debug]) fs.mkdirSync(directory, { mode: 0o700 });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepareRun = () => prepare(scope, roots, uid, root);
  const collectRun = () => collect(scope, uid, gid, roots, uid, root);
  const write = (target: string, value: string | Buffer) => fs.writeFileSync(target, value, { mode: 0o600 });

  function envelope(overrides: Record<string, unknown> = {}) {
    return {
      version: 1, ...identity(), executorKind: 'script', stage: 'complete', failure: 'none', exitCode: 0,
      workloadStopped: true, workloadLaunched: true, stopProof: 'verified',
      stages: [{ stage: 'workload-exit', status: 'succeeded' }],
      streams: { stdout: 'captured', stderr: 'captured', session: 'not-applicable' },
      streamCoverage: {
        stdout: { artifactSource: roots.backend === 'docker' ? 'workload-file' : 'backend-stream', agentSession: 'unavailable' },
        stderr: { artifactSource: roots.backend === 'docker' ? 'workload-file' : 'backend-stream', agentSession: 'unavailable' },
        copilotDiagnostics: 'unavailable',
      },
      session: { status: 'not-applicable' },
      backendEvidence: {
        dockerInspect: roots.backend === 'docker'
          ? { status: 'captured', running: false, exitCode: 0, oomKilled: false } : { status: 'not-applicable' },
        vmCounters: { status: roots.backend === 'docker' ? 'not-applicable' : 'unavailable' },
        network: { status: 'unavailable' },
      },
      ...overrides,
    };
  }

  function invocation(value = envelope()) {
    const journal = new HostExecutorJournal({
      runId, journalDir: roots.journal, seedsDir: path.join(root, 'seeds'),
      invocationsDir: path.join(root, 'invocations'), entries: [],
    });
    journal.record({ invocationId, entryId: 'script', state: 'running' });
    journal.record({ invocationId, entryId: 'script', state: 'cleanup-pending' });
    journal.record({ invocationId, entryId: 'script', state: 'terminal', outcome: 'script-ok' });
    journal.record({ state: 'closed' });
    const source = path.join(roots.debug, runId, invocationId);
    fs.mkdirSync(source, { mode: 0o700, recursive: true });
    write(path.join(source, 'diagnostics.json'), JSON.stringify(value) + '\n');
    write(path.join(source, 'stdout.log'), value.streams.stdout === 'captured' ? 'public output\n' : '');
    write(path.join(source, 'stderr.log'), value.streams.stderr === 'captured' ? 'public error\n' : '');
    write(path.join(source, 'enclave-session.log'), '');
    return source;
  }

  it.each(['docker', 'cloud-hypervisor'])('exports complete shared %s success evidence with runner-owned artifacts', backend => {
    roots.backend = backend;
    fs.mkdirSync(path.join(roots.debug, 'c'.repeat(32)), { mode: 0o700 });
    write(path.join(roots.journal, `${'d'.repeat(32)}.journal`), 'stale');
    prepareRun();
    invocation();
    expect(collectRun()).toBe(4);
    const upload = path.join(scope, 'upload');
    expect(fs.readdirSync(upload).sort()).toEqual([
      'collection-status.txt', 'diagnostics.json', 'enclave-session.log', 'stderr.log', 'stdout.log',
    ]);
    for (const name of fs.readdirSync(upload)) {
      const stat = fs.statSync(path.join(upload, name));
      expect(stat.uid).toBe(uid);
      expect(stat.gid).toBe(gid);
      expect(stat.mode & 0o7777).toBe(0o600);
    }
    expect(fs.statSync(upload).mode & 0o7777).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(path.join(upload, 'diagnostics.json'), 'utf8'))).toEqual(envelope());
    expect(collectRun).toThrow();
  });

  it('discovers Docker from the persistent host-executor journal after resource recovery records are removed', () => {
    roots.backend = 'docker';
    prepareRun();
    invocation();
    const recovery = path.join(roots.journal, 'docker');
    fs.mkdirSync(recovery, { mode: 0o700 });
    const record = path.join(recovery, `${runId}-script-${invocationId}.json`);
    write(record, '{"privateRecoveryState":"PRIVATE"}');
    fs.unlinkSync(record);
    expect(collectRun()).toBe(4);
    expect(fs.readFileSync(path.join(scope, 'upload/collection-status.txt'), 'utf8')).not.toContain('PRIVATE');
    expect(fs.existsSync(path.join(roots.journal, `${runId}.journal`))).toBe(true);
  });

  it.each(['docker', 'cloud-hypervisor'])('preserves %s nonzero workload and setup outcomes without synthetic exit codes', backend => {
    roots.backend = backend;
    const nonzero = envelope({ stage: 'execution', failure: 'workload-exit', exitCode: 17 });
    if (backend === 'docker') nonzero.backendEvidence.dockerInspect = {
      status: 'captured', running: false, exitCode: 17, oomKilled: false,
    };
    expect(JSON.parse(projectDiagnostics(nonzero, identity()).toString()).exitCode).toBe(17);
    const setup = envelope({
      stage: 'setup', failure: 'setup-failed', exitCode: null, workloadLaunched: false, stopProof: 'not-launched',
      streams: { stdout: 'unavailable', stderr: 'missing', session: 'not-applicable' },
      streamCoverage: {
        stdout: { artifactSource: 'unavailable', agentSession: 'unavailable' },
        stderr: { artifactSource: 'unavailable', agentSession: 'unavailable' }, copilotDiagnostics: 'unavailable',
      },
      backendEvidence: {
        dockerInspect: { status: backend === 'docker' ? 'unavailable' : 'not-applicable' },
        vmCounters: { status: backend === 'docker' ? 'not-applicable' : 'unavailable' },
        network: { status: 'unavailable' },
      },
      primaryFailure: { stage: 'workload-create', status: 'failed', category: 'permission-denied', errno: 13 },
    });
    prepareRun();
    invocation(setup);
    expect(collectRun()).toBe(4);
    const result = JSON.parse(fs.readFileSync(path.join(scope, 'upload/diagnostics.json'), 'utf8'));
    expect(result.exitCode).toBeNull();
    expect(result.failure).toBe('setup-failed');
    expect(result.streams).toEqual(setup.streams);
    expect(result.primaryFailure.errno).toBe(13);
  });

  it.each(['missing', 'unsafe', 'oversized', 'read-failed', 'unavailable', 'not-applicable'])(
    'keeps explicit %s capture status instead of zero/success evidence', status => {
      prepareRun();
      invocation(envelope({
        streams: { stdout: status, stderr: status, session: status },
        session: { status },
        streamCoverage: {
          stdout: { artifactSource: 'unavailable', agentSession: 'unavailable' },
          stderr: { artifactSource: 'unavailable', agentSession: 'unavailable' }, copilotDiagnostics: 'unavailable',
        },
      }));
      expect(collectRun()).toBe(4);
      expect(JSON.parse(fs.readFileSync(path.join(scope, 'upload/diagnostics.json'), 'utf8')).streams.stdout).toBe(status);
    });

  it.each(['docker', 'cloud-hypervisor'])('exports truthful not-launched %s retention failure evidence', backend => {
    roots.backend = backend;
    prepareRun();
    invocation(envelope({
      stage: 'retention', failure: 'retention-failed', exitCode: null, workloadLaunched: false, stopProof: 'not-launched',
      streams: { stdout: 'unavailable', stderr: 'unavailable', session: 'not-applicable' },
      streamCoverage: {
        stdout: { artifactSource: 'unavailable', agentSession: 'unavailable' },
        stderr: { artifactSource: 'unavailable', agentSession: 'unavailable' }, copilotDiagnostics: 'unavailable',
      },
      backendEvidence: {
        dockerInspect: { status: backend === 'docker' ? 'unavailable' : 'not-applicable' },
        vmCounters: { status: backend === 'docker' ? 'not-applicable' : 'unavailable' },
        network: { status: 'unavailable' },
      },
    }));
    expect(collectRun()).toBe(4);
    expect(JSON.parse(fs.readFileSync(path.join(scope, 'upload/diagnostics.json'), 'utf8'))).toMatchObject({
      stage: 'retention', failure: 'retention-failed', workloadLaunched: false, stopProof: 'not-launched', exitCode: null,
    });
  });

  it.each(['no-run', 'no-invocation', 'no-envelope', 'captured-stream-missing'])(
    'classifies absent evidence: %s', kind => {
      if (kind === 'no-envelope') roots.backend = 'docker';
      prepareRun();
      if (kind !== 'no-run') {
        const source = invocation();
        if (kind === 'no-invocation') fs.rmSync(source, { recursive: true });
        if (kind === 'no-envelope') fs.unlinkSync(path.join(source, 'diagnostics.json'));
        if (kind === 'captured-stream-missing') fs.unlinkSync(path.join(source, 'stdout.log'));
      }
      try { collectRun(); throw new Error('expected rejection'); }
      catch (error) { expect(error).toMatchObject({ category: 'absent-evidence' }); }
      expect(fs.existsSync(path.join(scope, 'upload'))).toBe(false);
      expect(collectRun).toThrow();
    });

  it.each(['legacy-empty', 'eligibility-incomplete', 'eligibility-unknown', 'disabled', 'private', 'run', 'invocation', 'entry', 'runtime',
    'stop', 'launched', 'proof', 'exit', 'stage', 'failure', 'streams', 'coverage', 'session', 'operation',
    'primary', 'cleanup', 'backend'])('rejects invalid shared envelope %s before staging', kind => {
      prepareRun();
      const value = JSON.parse(JSON.stringify(envelope()));
      if (kind === 'legacy-empty') Object.keys(value).forEach(key => delete value[key]);
      if (kind === 'eligibility-incomplete') value.retentionEligibility = { publicDebug: true };
      if (kind === 'eligibility-unknown') value.retentionEligibility = {
        publicDebug: true, repositoryVisibility: 'all-public-verified', privateRepo: true,
      };
      if (kind === 'disabled') value.retentionEligibility = {
        publicDebug: false, repositoryVisibility: 'all-public-verified',
      };
      if (kind === 'private') value.retentionEligibility = {
        publicDebug: true, repositoryVisibility: 'private',
      };
      if (kind === 'run') value.runId = 'c'.repeat(32);
      if (kind === 'invocation') value.invocationId = 'c'.repeat(24);
      if (kind === 'entry') value.entryId = 'other';
      if (kind === 'runtime') value.runtime = 'docker';
      if (kind === 'stop') value.workloadStopped = false;
      if (kind === 'launched') value.workloadLaunched = false;
      if (kind === 'proof') value.stopProof = 'asserted';
      if (kind === 'exit') value.exitCode = 999;
      if (kind === 'stage') value.stage = 'PRIVATE_STAGE';
      if (kind === 'failure') value.failure = 'PRIVATE_ERROR';
      if (kind === 'streams') value.streams.stdout = 'complete';
      if (kind === 'coverage') value.streamCoverage.stderr.agentSession = 'PRIVATE_PATH';
      if (kind === 'session') value.session.status = 'PRIVATE_STATUS';
      if (kind === 'operation') value.stages = [{ stage: 'PRIVATE_STAGE', status: 'failed' }];
      if (kind === 'primary') value.primaryFailure = { stage: 'cleanup', status: 'failed', category: 'PRIVATE_ERROR' };
      if (kind === 'cleanup') value.cleanupFailure = { stage: 'cleanup', status: 'succeeded', category: 'cleanup-failed' };
      if (kind === 'backend') value.backendEvidence.vmCounters = { status: 'supplemental', artifact: '../../PRIVATE_PATH' };
      // Keep workload stream fixtures realistic even for malformed schema cases.
      const source = invocation();
      write(path.join(source, 'diagnostics.json'), JSON.stringify(value));
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(scope, 'upload'))).toBe(false);
    });

  it('rejects contradictory captured Docker stop evidence', () => {
    roots.backend = 'docker';
    for (const patch of [{ running: true }, { exitCode: 999 }, { oomKilled: 'PRIVATE' }]) {
      const value = envelope();
      Object.assign(value.backendEvidence.dockerInspect, patch);
      expect(() => projectDiagnostics(value, identity())).toThrow();
    }
  });

  it('accepts the optional closed eligibility marker without requiring it from older producers', () => {
    const eligibility = { publicDebug: true, repositoryVisibility: 'all-public-verified' };
    expect(JSON.parse(projectDiagnostics(envelope({ retentionEligibility: eligibility }), identity()).toString())
      .retentionEligibility).toEqual(eligibility);
    expect(JSON.parse(projectDiagnostics(envelope(), identity()).toString())).not.toHaveProperty('retentionEligibility');
  });

  it.each(['docker', 'cloud-hypervisor'] as const)('accepts the actual protected shared retention projection for %s', async backend => {
    roots.backend = backend;
    prepareRun();
    const source = invocation();
    await preservePublicEnclaveArtifacts({
      directory: source, protectedRoot: root,
      envelope: {
        version: 1, ...identity(backend), runtime: backend, executorKind: 'agent', stage: 'execution',
        failure: 'execution-exception', exitCode: null, workloadStopped: true,
      },
      stdout: { status: 'captured', contents: Buffer.from('retained public output\n') },
      stderr: { status: 'unavailable' },
      session: { status: 'captured', contents: Buffer.from(
        '{"event":"progress","stage":"engine-started","private":"PRIVATE_SECRET"}\n'
        + '{"event":"failure","category":"engine-failed","text":"PRIVATE_SECRET"}\n') },
      secrets: ['PRIVATE_SECRET'], owner: { uid, gid },
      dependencies: { ...fs.promises, resolveIdentity: () => ({ uid, gid }) },
    });
    expect(collectRun()).toBe(4);
    const result = JSON.parse(fs.readFileSync(path.join(scope, 'upload/diagnostics.json'), 'utf8'));
    expect(result).not.toHaveProperty('retentionEligibility');
    expect(result.session.failure).toEqual({ event: 'failure', category: 'engine-failed' });
  });

  it.each(['absence', 'invalid', 'unsafe'])('publishes only fixed safe failure status for %s', kind => {
    prepareRun();
    if (kind !== 'absence') {
      const source = invocation();
      if (kind === 'invalid') write(path.join(source, 'diagnostics.json'), '{"PRIVATE_SECRET":"PRIVATE_ERROR"}');
      else fs.chmodSync(path.join(source, 'stdout.log'), 0o644);
    }
    let failure: unknown;
    try { collectRun(); } catch (error) { failure = error; }
    expect(failure).toBeDefined();
    collector.publishCollectionFailure(scope, uid, gid, failure, uid, root);
    expect(fs.readdirSync(path.join(scope, 'upload'))).toEqual(['collection-status.txt']);
    const text = fs.readFileSync(path.join(scope, 'upload/collection-status.txt'), 'utf8');
    expect(text).toMatch(/^Collection failed: failedCheck=[a-z-]+ category=[a-z-]+\n$/);
    expect(text).not.toMatch(/PRIVATE|path|Error:|stack/);
    if (kind === 'absence') expect(text).toContain('category=absent-evidence');
    expect(collectRun).toThrow();
  });

  it.each([
    ['permissions', 'file-permissions', 'unsafe-permissions'],
    ['oversized', 'file-size', 'oversized'],
    ['hardlink', 'file-links', 'unsafe-file'],
    ['concurrent', 'run-budget', 'concurrent-runs'],
  ])('reports the specific fixed %s failure check', (kind, failedCheck, category) => {
    prepareRun();
    const source = invocation();
    const target = path.join(source, 'stdout.log');
    if (kind === 'permissions') fs.chmodSync(target, 0o644);
    if (kind === 'oversized') write(target, Buffer.alloc(MAX_STREAM_BYTES + 1));
    if (kind === 'hardlink') fs.linkSync(target, path.join(root, 'linked'));
    if (kind === 'concurrent') write(path.join(roots.journal, `${'c'.repeat(32)}.journal`), 'concurrent');
    let failure: unknown;
    try { collectRun(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ failedCheck, category });
    collector.publishCollectionFailure(scope, uid, gid, failure, uid, root);
    expect(fs.readFileSync(path.join(scope, 'upload/collection-status.txt'), 'utf8'))
      .toBe(`Collection failed: failedCheck=${failedCheck} category=${category}\n`);
  });

  it.each(['symlink', 'hardlink', 'permissions', 'oversized'])(
    'rejects unsafe common file %s', kind => {
      prepareRun();
      const file = path.join(invocation(), 'stdout.log');
      if (kind === 'symlink') {
        fs.unlinkSync(file);
        fs.symlinkSync(path.join(scope, 'baseline.json'), file);
      } else if (kind === 'hardlink') fs.linkSync(file, path.join(root, 'linked'));
      else if (kind === 'permissions') fs.chmodSync(file, 0o644);
      else write(file, Buffer.alloc(MAX_STREAM_BYTES + 1));
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(scope, 'upload'))).toBe(false);
    });

  it.each(['directory-symlink', 'directory-mode', 'journal-symlink', 'wrong-invocation',
    'another-entry', 'multiple-invocations', 'multiple-runs', 'malformed-journal', 'unknown-file'])(
    'rejects unsafe scope %s', kind => {
      prepareRun();
      const source = invocation();
      const journal = path.join(roots.journal, `${runId}.journal`);
      if (kind === 'directory-symlink') {
        fs.renameSync(source, path.join(root, 'moved'));
        fs.symlinkSync(path.join(root, 'moved'), source);
      } else if (kind === 'directory-mode') fs.chmodSync(source, 0o777);
      else if (kind === 'journal-symlink') {
        fs.unlinkSync(journal); fs.symlinkSync(path.join(scope, 'baseline.json'), journal);
      } else if (kind === 'wrong-invocation') fs.renameSync(source, path.join(path.dirname(source), 'c'.repeat(24)));
      else if (kind === 'multiple-invocations') fs.mkdirSync(path.join(path.dirname(source), 'c'.repeat(24)), { mode: 0o700 });
      else if (kind === 'another-entry') fs.appendFileSync(journal,
        JSON.stringify({ invocationId, entryId: 'other', state: 'cleanup-pending' }) + '\n');
      else if (kind === 'multiple-runs') write(path.join(roots.journal, `${'c'.repeat(32)}.journal`), 'other');
      else if (kind === 'malformed-journal') fs.appendFileSync(journal, '{"invocationId":"../../escape"}\n');
      else write(path.join(source, 'environment.txt'), 'PRIVATE');
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(scope, 'upload'))).toBe(false);
    });

  it('redacts credential patterns, preserves approved retained session streams and closes envelope diagnostics', () => {
    prepareRun();
    const value = envelope({
      executorKind: 'agent', payload: 'PRIVATE_PAYLOAD', authorization: 'PRIVATE_CREDENTIAL',
      streams: { stdout: 'captured', stderr: 'captured', session: 'captured' },
      session: {
        status: 'captured', bytes: 256, events: [{ event: 'success', secret: 'PRIVATE_SECRET' }],
        lastEvent: { event: 'success', path: '/PRIVATE_PATH' }, arbitrary: 'PRIVATE',
      },
    });
    const source = invocation(value);
    write(path.join(source, 'stdout.log'), 'github_pat_FAKE_TEST_VALUE ghp_FAKE_TEST_VALUE sk-FAKE_TEST_VALUE\n');
    write(path.join(source, 'stderr.log'), 'Authorization: token PRIVATE_CREDENTIAL\nBearer PRIVATE_TOKEN\n');
    write(path.join(source, 'enclave-session.log'), [
      { event: 'engine-result', exitCode: 0,
        stdout: { raw: 'approved retained engine output', sensitivity: 'raw-debug' },
        stderr: { raw: 'approved retained engine error ghp_FAKE_TEST_VALUE', sensitivity: 'raw-debug', private: '[REDACTED]' },
        secret: '[REDACTED]' },
      { event: 'engine-diagnostics',
        log: { raw: 'approved retained Copilot diagnostics', sensitivity: 'raw-debug', private: '[REDACTED]' },
        private: '[REDACTED]' },
      { event: 'progress', stage: 'engine-completed', runtimeMs: 13, payload: '[REDACTED]' },
      { event: 'retained-extension', message: '[REDACTED]' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n');
    expect(collectRun()).toBe(4);
    for (const name of fs.readdirSync(path.join(scope, 'upload'))) {
      expect(fs.readFileSync(path.join(scope, 'upload', name), 'utf8')).not.toMatch(/PRIVATE|FAKE_TEST_VALUE/);
    }
    expect(fs.readFileSync(path.join(scope, 'upload/enclave-session.log'), 'utf8')).toContain('"exitCode":0');
    expect(fs.readFileSync(path.join(scope, 'upload/enclave-session.log'), 'utf8')).toContain('approved retained engine error');
    expect(fs.readFileSync(path.join(scope, 'upload/enclave-session.log'), 'utf8')).toContain('approved retained Copilot diagnostics');
    expect(fs.readFileSync(path.join(scope, 'upload/enclave-session.log'), 'utf8')).toContain('approved retained engine output');
    expect(fs.readFileSync(path.join(scope, 'upload/enclave-session.log'), 'utf8')).toContain('retained-extension');
  });

  it('does not reproject or truncate already-redacted retained session records', () => {
    const record = {
      event: 'engine-diagnostics',
      log: { raw: 'Authorization: [REDACTED]\nretained engine detail\n', sensitivity: 'raw-debug' },
      approvedRetainedField: '[REDACTED]',
    };
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    expect(collector.redactCredentials(bytes)).toEqual(bytes);
    expect(JSON.parse(collector.redactCredentials(Buffer.from(JSON.stringify({
      ...record, log: { raw: 'Authorization: ******\nretained engine detail\n' },
    }) + '\n')).toString())).toMatchObject({
      event: 'engine-diagnostics', log: { raw: 'Authorization: [REDACTED]\nretained engine detail\n' },
      approvedRetainedField: '[REDACTED]',
    });
  });

  it('retains Cloud Hypervisor supplemental and closed proxy evidence only after eligibility validation', async () => {
    prepareRun();
    const source = invocation();
    write(path.join(source, 'guest-stderr.raw.log'), 'retained public guest output\n');
    write(path.join(source, 'counters.json'), '{"boot_time_ms":1}\n');
    await preservePublicEnclaveProxyDiagnostics({ runId, journalDir: roots.journal },
      { scope: 'run-cumulative', status: 'captured', records: 1, local: { '403': 1 }, upstream: {} },
      [{ schemaVersion: 1, origin: 'local', status: 403 }],
      'source=stderr level=warn event=enclave_model_budget_rejected\ncapture_status=captured dropped=0\n');
    expect(collectRun()).toBe(8);
    expect(fs.readFileSync(path.join(scope, 'upload/enclave-proxy-events.jsonl'), 'utf8'))
      .toBe('{"schemaVersion":1,"origin":"local","status":403}\n');
  });

  it.each(['docker', 'cloud-hypervisor'])('exports identity-checked %s run-level early-failure projections without invocation storage', async backend => {
    roots.backend = backend;
    prepareRun();
    new HostExecutorJournal({
      runId, journalDir: roots.journal, seedsDir: path.join(root, 'seeds'),
      invocationsDir: path.join(root, 'invocations'), entries: [],
    });
    const run = { runId, journalDir: roots.journal };
    persistHostExecutorProxyUsage(run, {
      scope: 'run-cumulative', requests: { status: 'not-drained' }, tokens: { status: 'not-drained' },
    });
    persistHostExecutorProxyResponseDiagnostics(run, { scope: 'run-cumulative', status: 'not-drained' });
    await preservePublicEnclaveProxyDiagnostics(run,
      { scope: 'run-cumulative', status: 'not-drained' }, [], 'capture_status=unavailable\n');
    expect(collectRun()).toBe(4);
    expect(fs.readdirSync(path.join(scope, 'upload')).sort()).toEqual([
      'collection-status.txt', 'enclave-proxy-container.log', 'enclave-proxy-events.jsonl',
      'enclave-proxy-response.json', 'enclave-proxy-usage.json',
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(scope, 'upload/enclave-proxy-usage.json'), 'utf8')).usage)
      .toEqual({ scope: 'run-cumulative', requests: { status: 'not-drained' }, tokens: { status: 'not-drained' } });
    expect(fs.readFileSync(path.join(scope, 'upload/collection-status.txt'), 'utf8'))
      .toContain('Shared diagnostics envelope: absent-run-level-only.');
  });

  it('preserves pre-shared-envelope CH supplemental evidence through the producer-gated namespace', () => {
    prepareRun();
    const source = invocation();
    for (const name of ['diagnostics.json', 'stdout.log', 'stderr.log', 'enclave-session.log']) {
      fs.unlinkSync(path.join(source, name));
    }
    write(path.join(source, 'guest-stderr.raw.log'), 'retained public legacy guest error\n');
    write(path.join(source, 'launcher-stderr.log'), 'retained public launcher evidence\n');
    write(path.join(source, 'counters.json'), '{"boot_time_ms":1}\n');
    expect(collectRun()).toBe(3);
    expect(fs.readdirSync(path.join(scope, 'upload')).sort()).toEqual([
      'collection-status.txt', 'counters.json', 'guest-stderr.raw.log', 'launcher-stderr.log',
    ]);
    expect(fs.readFileSync(path.join(scope, 'upload/collection-status.txt'), 'utf8'))
      .toContain('Shared diagnostics envelope: absent-legacy-supplemental-only.');
  });

  it('retains protected legacy CH streams without synthesizing a shared envelope or stop proof', () => {
    prepareRun();
    const source = invocation();
    fs.unlinkSync(path.join(source, 'diagnostics.json'));
    expect(collectRun()).toBe(3);
    expect(fs.readFileSync(path.join(scope, 'upload/stdout.log'), 'utf8')).toBe('public output\n');
    expect(fs.existsSync(path.join(scope, 'upload/diagnostics.json'))).toBe(false);
    expect(fs.readFileSync(path.join(scope, 'upload/collection-status.txt'), 'utf8'))
      .toContain('Shared diagnostics envelope: absent-legacy-supplemental-only.');
  });

  it('does not downgrade malformed shared CH diagnostics to legacy supplemental-only export', () => {
    prepareRun();
    const source = invocation();
    write(path.join(source, 'diagnostics.json'), '{}');
    write(path.join(source, 'guest-stderr.raw.log'), 'legacy-looking error\n');
    expect(collectRun).toThrow();
    expect(fs.existsSync(path.join(scope, 'upload'))).toBe(false);
  });

  it('preserves bounded proxy accounting without sensitive fields or fabricated totals', () => {
    const usage = collector.projectProxyUsage({
      requests: {
        status: 'captured', records: 4, trackedResponses: 2, websocketSessions: 0,
        statuses: { '200': 1, '401': 1, PRIVATE_STATUS: 1 },
        results: { ok: 1, skip_status: 1, PRIVATE_ERROR: 1 }, path: '/PRIVATE_PATH',
      },
      tokens: {
        status: 'captured', records: 1, usageRecords: 1,
        totals: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4,
          PRIVATE_FIELD: 'PRIVATE_SECRET' }, model: 'PRIVATE_MODEL',
      },
    });
    expect(usage).toEqual({
      scope: 'run-cumulative',
      requests: { status: 'captured', records: 4, trackedResponses: 2, websocketSessions: 0,
        statuses: { '200': 1, '401': 1 }, results: { ok: 1, skip_status: 1 } },
      tokens: { status: 'captured', records: 1, usageRecords: 1,
        totals: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 } },
    });
    expect(JSON.stringify(usage)).not.toMatch(/PRIVATE|path|model|payload/);
    expect(collector.projectProxyUsage({
      requests: { status: 'oversized' }, tokens: { status: 'captured', records: 5000, usageRecords: 0, totals: {} },
    })).toEqual({ scope: 'run-cumulative', requests: { status: 'oversized' }, tokens: { status: 'malformed' } });
  });

  it.each(['not-drained', 'unavailable', 'malformed'])('keeps closed proxy response status %s', status => {
    if (status === 'unavailable') {
      expect(() => collector.projectProxyResponse({ schemaVersion: 1, component: 'enclave-proxy-response',
        scope: 'run-cumulative', status, secret: 'PRIVATE' })).toThrow();
    } else {
      expect(collector.projectProxyResponse({ schemaVersion: 1, component: 'enclave-proxy-response',
        scope: 'run-cumulative', status, secret: 'PRIVATE' })).toEqual({
        schemaVersion: 1, component: 'enclave-proxy-response', scope: 'run-cumulative', status,
      });
    }
  });

  it.each(['{"schemaVersion":1,"origin":"unknown","status":403}\n',
    '{"schemaVersion":1,"origin":"local","status":403}', '{"status":403}\n'])(
    'rejects malformed dedicated proxy events', value => {
      expect(() => collector.projectProxyEvents(Buffer.from(value))).toThrow();
    });

  it('accepts the stream bound exactly without allowing retry after a failed collection', () => {
    prepareRun();
    const source = invocation();
    write(path.join(source, 'stdout.log'), Buffer.alloc(MAX_STREAM_BYTES, 120));
    expect(collectRun()).toBe(4);
    expect(fs.statSync(path.join(scope, 'upload/stdout.log')).size).toBe(MAX_STREAM_BYTES);
  });

  it('bounds all published files and bytes including the fixed run projection reserve and status', () => {
    expect(collector.MAX_PUBLISHED_FILES).toBe(MAX_FILES + 4 + 1);
    expect(collector.MAX_PUBLISHED_BYTES).toBe((MAX_FILES + 4) * MAX_STREAM_BYTES + collector.MAX_STATUS_BYTES);
    const bytes = Buffer.alloc(MAX_STREAM_BYTES);
    const files = Array.from({ length: MAX_FILES + 4 }, (_, index) => [`file-${index}`, bytes]);
    const status = 'x'.repeat(collector.MAX_STATUS_BYTES);
    expect(() => collector.assertPublicationBounds(files, status)).not.toThrow();
    expect(() => collector.assertPublicationBounds([...files, ['extra', Buffer.alloc(0)]], status))
      .toThrow(/publication-file-count/);
    expect(() => collector.assertPublicationBounds(files, status + 'x')).toThrow(/publication-status-size/);
    const oversized = Buffer.alloc(MAX_STREAM_BYTES + 1);
    expect(() => collector.assertPublicationBounds(
      files.map(([name]) => [name, oversized]), status)).toThrow(/publication-bytes/);
    expect(() => collector.assertPublicationBounds([['same', bytes], ['same', bytes]], 'status'))
      .toThrow(/artifact-collision/);
  });

  it('rejects excessive artifact count and prepared scope reuse', () => {
    prepareRun();
    expect(prepareRun).toThrow();
    const source = invocation();
    for (let index = 0; index < collector.MAX_FILES; index++) write(path.join(source, `unknown-${index}.log`), '');
    expect(collectRun).toThrow(/count/);
    expect(fs.existsSync(path.join(scope, 'upload'))).toBe(false);
  });

  it.each(['symlink', 'hardlink', 'permissions', 'oversized', 'run', 'scope', 'raw-log'])(
    'retains proxy safeguards for %s', async kind => {
      prepareRun();
      invocation();
      await preservePublicEnclaveProxyDiagnostics({ runId, journalDir: roots.journal },
        { scope: 'run-cumulative', status: 'empty' }, [], 'capture_status=empty\n');
      const id = createHash('sha256').update(`awf-enclave-proxy-debug-v1:${runId}`).digest('hex').slice(0, 32);
      const file = path.join(roots.journal, 'diagnostics', `${runId}-${id}.proxy-debug.json`);
      if (kind === 'symlink') { fs.unlinkSync(file); fs.symlinkSync(path.join(scope, 'baseline.json'), file); }
      else if (kind === 'hardlink') fs.linkSync(file, path.join(root, 'linked'));
      else if (kind === 'permissions') fs.chmodSync(file, 0o644);
      else if (kind === 'oversized') write(file, Buffer.alloc(320 * 1024 + 1));
      else {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (kind === 'run') value.runId = 'c'.repeat(32);
        if (kind === 'scope') value.scope = 'invocation';
        if (kind === 'raw-log') value.containerLog = 'PRIVATE_LOG\n';
        write(file, JSON.stringify(value));
      }
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(scope, 'upload'))).toBe(false);
    });

  it('has fixed backend roots and loads without the AWF package', () => {
    expect(cliRoots('docker', 1001).journal).toBe('/var/lib/awf/enclave-storage/1001/host-state/host-executor-journal');
    expect(collector.cliCandidates('docker', 1001)).toEqual([
      { backend: 'docker', sourceUid: 1001,
        journal: '/var/lib/awf/enclave-storage/1001/host-state/host-executor-journal',
        debug: '/var/lib/awf/enclave-storage/1001/host-state/debug-artifacts/docker' },
      { backend: 'docker', sourceUid: 0, journal: '/var/lib/awf-cloud-hypervisor/host-executor-journal',
        debug: '/var/lib/awf-cloud-hypervisor/debug-artifacts/docker' },
    ]);
    const producerPaths = resolveDockerEnclavePaths(path.join(root, 'work'));
    const producerDebug = resolveDockerPublicEnclaveDebugPaths();
    expect(collector.cliCandidates('docker', uid)).toEqual(expect.arrayContaining([
      expect.objectContaining({ journal: producerPaths.hostExecutorJournalDir, debug: producerDebug.root }),
    ]));
    expect(cliRoots('cloud-hypervisor', 1001).debug).toBe('/var/lib/awf-cloud-hypervisor/debug-artifacts/cloud-hypervisor');
    const stagedPath = path.join(root, 'collector.cjs');
    fs.copyFileSync(path.join(__dirname, 'collect-enclave-smoke-debug.cjs'), stagedPath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const staged = require(stagedPath);
    for (const value of [projectCopilotAuthLogFields({}), '', 'credential_source=PRIVATE']) {
      expect(staged.isSafeCopilotAuthLogFields(value)).toBe(isSafeCopilotAuthLogFields(value));
    }
  });

  it('supports historical CH-only CLI callers without weakening the explicit backend/runner interface', () => {
    expect(collector.parseArguments(['prepare', '123-1'])).toEqual({
      operation: 'prepare', backend: 'cloud-hypervisor', key: '123-1',
      runnerUid: 0, runnerGid: 0, binding: { backend: 'cloud-hypervisor', legacy: true },
    });
    expect(collector.parseArguments(['collect', '123-1', '1001', '1002'])).toEqual({
      operation: 'collect', backend: 'cloud-hypervisor', key: '123-1',
      runnerUid: 1001, runnerGid: 1002, binding: { backend: 'cloud-hypervisor', legacy: true },
    });
    expect(collector.parseArguments(['prepare', 'docker', '123-1', '1001', '1002'])).toEqual({
      operation: 'prepare', backend: 'docker', key: '123-1', runnerUid: 1001, runnerGid: 1002,
      binding: { backend: 'docker', runnerUid: 1001, runnerGid: 1002 },
    });
  });

  it.each([
    ['prepare', 'docker'],
    ['collect', 'docker', '1001', '1002'],
    ['prepare', 'docker', '123-1'],
    ['prepare', 'other', '123-1', '1001', '1002'],
    ['prepare', 'docker', '../../escape', '1001', '1002'],
    ['collect', '123-1', '-1', '1002'],
    ['collect', '123-1', '4294967295', '1002'],
    ['collect', 'cloud-hypervisor', '123-1', '1001', '1002', '/caller/root'],
  ])('rejects unsupported or unsafe CLI arguments %j', (...args: string[]) => {
    expect(() => collector.parseArguments(args)).toThrow(/cli-arguments/);
  });
});
