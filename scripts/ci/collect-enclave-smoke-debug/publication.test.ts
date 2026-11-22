import {
  fs, path, createHash, collector, mutableFs, live, prepare, collect, MAX_STREAM_BYTES, MAX_FILES,
  HostExecutorJournal, preservePublicEnclaveProxyDiagnostics, preflightSchema, projectCopilotAuthLogFields,
  isSafeCopilotAuthLogFields, stageCollector, standaloneFixture, legacyCollectorFixture, persistHostExecutorProxyUsage,
  persistHostExecutorProxyResponseDiagnostics,
} from './collector.test-utils';

describe('host-only public enclave debug publication', () => {
  let temp: string;
  let run: string;
  let roots: { journal: string; debug: string };
  const f = legacyCollectorFixture(state => {
    temp = state.temp;
    run = state.run;
    roots = state.roots;
  });
  const { prepareRun, invocation, collectRun, commonEnvelope, setRun, uid, gid, runId, invocationId } = f;
  function retainStartup(structured = false, earlyFailure?: Record<string, unknown>, startupChecks?: object) {
    const binding = { backend: 'cloud-hypervisor', runnerUid: uid, runnerGid: gid };
    prepare(run, roots, uid, temp, binding);
    const stderr = path.join(temp, 'private.stderr');
    const startup = path.join(temp, 'private-startup.json');
    fs.writeFileSync(stderr, 'PRIVATE_PROMPT_AND_CREDENTIAL_SENTINEL\n' +
      (earlyFailure ? `AWF_EARLY_STARTUP_FAILURE ${JSON.stringify(earlyFailure)}\n` : ''), { mode: 0o600 });
    if (structured) fs.writeFileSync(startup, JSON.stringify({
      phase: 'startup', message: 'Trusted enclave MCP gateway container is unavailable',
      timestamp: '2026-01-01T00:00:00Z',
      ...(startupChecks ? { enclaveStartup: {
        schemaVersion: 1, perspective: 'awf-host', stage: 'artifact-preflight',
        readiness: 'not-attempted', code: 'none', attempts: 0, httpStatus: null, startupChecks,
      } } : {}),
    }), { mode: 0o600 });
    const value = {
      agent: 'copilot', backend: binding.backend, failureStage: 'broker',
      ...live.startupSnapshot({ exitCode: 1, signalCode: null }, 'exit',
        'initial', 'agent-only', stderr, startup),
      prompt: 'PRIVATE_PROMPT_AND_CREDENTIAL_SENTINEL',
    };
    collector.retainStartup(run, value, uid, temp);
    return value;
  }
  function finalization() {
    return {
      schemaVersion: 1, backend: 'cloud-hypervisor', agent: 'copilot', resultValidated: true,
      checks: Object.fromEntries(Object.keys(collector.FINALIZATION_REASONS).map(gate =>
        [gate, [gate === 'audit-presence' ? 'failed' : 'passed', gate === 'audit-presence' ? 'missing' : 'none']])),
      primaryFailure: { gate: 'audit-presence', reason: 'missing' }, secondaryFailures: [],
      detail: 'PRIVATE_PROMPT_AND_CREDENTIAL_SENTINEL',
    };
  }
  function retainFinalization() {
    const binding = { backend: 'cloud-hypervisor', runnerUid: uid, runnerGid: gid };
    prepare(run, roots, uid, temp, binding);
    collector.retainFinalization(run, finalization(), uid, temp);
  }
  function absentEvidence() {
    let error: unknown;
    try { collectRun(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ category: 'absent-evidence' });
    collector.publishCollectionFailure(run, uid, gid, error, uid, temp);
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
  it.each([false, true])('exports pre-broker evidence without a journal (startup record=%s)', structured => {
    retainStartup(structured);
    expect(collectRun()).toBe(1);
    const upload = path.join(run, 'upload');
    expect(fs.readdirSync(upload).sort()).toEqual(['collection-status.txt', 'startup.json']);
    const text = fs.readFileSync(path.join(upload, 'startup.json'), 'utf8');
    expect(text).not.toContain('PRIVATE_');
    expect(JSON.parse(text)).toMatchObject({
      failureStage: 'broker',
      diagnostic: { reason: 'exit', exitCode: 1, category: structured ? 'broker' : 'unknown' },
      evidence: { record: { final: structured ? 'valid' : 'missing' } },
    });
    expect(fs.statSync(path.join(upload, 'startup.json')).mode & 0o777).toBe(0o600);
    expect(Buffer.byteLength(text)).toBeLessThan(collector.MAX_STATUS_BYTES);
  });
  it('retains the original startup failure separately when later collection rejects an invocation', () => {
    retainStartup(true);
    invocation(false);
    let failure: unknown;
    try { collectRun(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ failedCheck: 'stop-proof' });
    collector.publishCollectionFailure(run, uid, gid, failure, uid, temp);
    expect(fs.readdirSync(path.join(run, 'upload')).sort()).toEqual(['collection-status.txt', 'startup.json']);
    expect(JSON.parse(fs.readFileSync(path.join(run, 'upload/startup.json'), 'utf8')))
      .toMatchObject({ diagnostic: { category: 'broker', exitCode: 1 } });
    expect(fs.readFileSync(path.join(run, 'upload/collection-status.txt'), 'utf8')).toContain('failedCheck=stop-proof');
  });
  it('retains the closed copy checklist and independent bounded cleanup without an invocation', () => {
    const checks = Object.fromEntries(Object.entries(preflightSchema.scopes).flatMap(([scope, catalog]) =>
      Object.keys(catalog).map(id => [`${scope}/${id}`, ['not-attempted', 'none']])));
    checks['bounded-artifacts/rootfs-copy'] = ['failed', 'ENOSPC'];
    checks['bounded-artifacts/rootfs-trust'] = ['passed', 'none'];
    for (const id of Object.keys(preflightSchema.scopes['bounded-cleanup'])) {
      checks[`bounded-cleanup/${id}`] = ['passed', 'none'];
    }
    const value = retainStartup(true, undefined, { schemaVersion: 1, ready: false, checks });
    expect(Buffer.byteLength(JSON.stringify(checks))).toBeGreaterThan(collector.MAX_STATUS_BYTES);
    expect(collectRun()).toBe(1);
    const text = fs.readFileSync(path.join(run, 'upload/startup.json'), 'utf8');
    expect(JSON.parse(text).diagnostic.enclaveStartup.startupChecks.checks).toEqual(checks);
    expect(text).not.toContain('PRIVATE_');
    const projected = JSON.parse(text);
    projected.diagnostic.enclaveStartup.startupChecks.checks['private/SECRET'] = ['failed', 'ENOSPC'];
    expect(() => collector.projectStartup(projected, 'cloud-hypervisor')).toThrow(/startup-schema/);
    const invalid = structuredClone(value);
    invalid.diagnostic.enclaveStartup.startupChecks.checks['bounded-artifacts/rootfs-copy'] = ['failed', 'PRIVATE_REASON'];
    expect(() => collector.projectStartup(invalid, 'cloud-hypervisor')).toThrow(/startup-schema/);
  });
  it.each([
    'cloud-hypervisor-enclave-admission',
    ...['workflow-source', 'configuration-profile', 'token-acquisition', 'signature', 'claims']
      .map(reason => `cloud-hypervisor-enclave-admission-${reason}`),
  ])('exports the allowlisted early admission reason independently of invocation evidence (%s)', reason => {
    const earlyFailure = { schemaVersion: 1, phase: 'backend-selection', reason };
    retainStartup(false, earlyFailure);
    expect(collectRun()).toBe(1);
    const text = fs.readFileSync(path.join(run, 'upload/startup.json'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      diagnostic: { category: 'configuration', earlyFailure },
      evidence: { record: { final: 'missing' } },
    });
    expect(text).not.toContain('PRIVATE_');
    expect(Buffer.byteLength(text)).toBeLessThan(collector.MAX_STATUS_BYTES);
  });
  it('exports bounded post-result finalization evidence without invocation artifacts', () => {
    retainFinalization();
    expect(collectRun()).toBe(1);
    const file = path.join(run, 'upload/finalization.json');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('PRIVATE_');
    expect(Buffer.byteLength(text)).toBeLessThan(collector.MAX_STATUS_BYTES);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(text)).toMatchObject({
      resultValidated: true, primaryFailure: { gate: 'audit-presence', reason: 'missing' },
    });
  });
  it.each(['schema-failure', 'executor-failure', 'timeout', 'cancelled', 'PRIVATE_OUTCOME'])(
    'retains only allowlisted terminal result outcome %s from the identity-checked journal', outcome => {
      retainStartup();
      const resultFailure = { category: 'tool-rejected', code: 'canonical-error', executorOutcome: 'unknown',
        detail: 'PRIVATE_RESULT_AND_CREDENTIAL' };
      const value = {
        ...finalization(), resultValidated: false, resultFailure,
        primaryFailure: { gate: 'result', reason: 'tool-rejected' },
        secondaryFailures: [{ gate: 'audit-presence', reason: 'missing' }],
      };
      value.checks.result = ['failed', 'tool-rejected'];
      collector.retainFinalization(run, value, uid, temp);
      invocation();
      const journal = path.join(roots.journal, `${runId}.journal`);
      const records = fs.readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      records[records.length - 1].outcome = outcome;
      fs.writeFileSync(journal, records.map(record => JSON.stringify(record)).join('\n') + '\n');
      collect(run, uid, gid, roots, uid, temp);
      const text = fs.readFileSync(path.join(run, 'upload/finalization.json'), 'utf8');
      expect(JSON.parse(text)).toMatchObject({
        resultValidated: false, primaryFailure: { gate: 'result', reason: 'tool-rejected' },
        resultFailure: {
          category: 'tool-rejected', code: 'canonical-error',
          executorOutcome: outcome === 'PRIVATE_OUTCOME' ? 'unknown' : outcome,
        },
        secondaryFailures: [{ gate: 'audit-presence', reason: 'missing' }],
      });
      expect(text).not.toContain('PRIVATE_');
    },
  );
  it('keeps missing executor outcome unknown and projects result and audit metadata without free-form text', () => {
    retainStartup();
    const resultFailure = { category: 'schema-validation', code: 'result-shape', executorOutcome: 'unknown' };
    const startup = JSON.parse(fs.readFileSync(path.join(run, 'startup.json'), 'utf8'));
    fs.writeFileSync(path.join(run, 'startup.json'), JSON.stringify({ ...startup, failureStage: 'result', resultFailure }));
    const value = {
      ...finalization(), resultValidated: false, resultFailure,
      primaryFailure: { gate: 'result', reason: 'schema-validation' },
      auditEvidence: {
        contract: 'failure-observation', successInvocations: 'none', failureRecords: 'one',
        invocationIdentity: 'valid', repository: 'not-observed', sensitivity: 'not-observed',
        detail: 'PRIVATE_AUDIT_CONTENT',
      },
    };
    value.checks.result = ['failed', 'schema-validation'];
    collector.retainFinalization(run, value, uid, temp);
    collectRun();
    for (const name of ['startup.json', 'finalization.json']) {
      const text = fs.readFileSync(path.join(run, 'upload', name), 'utf8');
      expect(JSON.parse(text).resultFailure).toEqual(resultFailure);
      expect(text).not.toContain('PRIVATE_');
    }
    expect(JSON.parse(fs.readFileSync(path.join(run, 'upload/finalization.json'), 'utf8')).auditEvidence)
      .toEqual({
        contract: 'failure-observation', successInvocations: 'none', failureRecords: 'one',
        invocationIdentity: 'valid', repository: 'not-observed', sensitivity: 'not-observed',
      });
  });
  it.each(['category', 'code', 'executorOutcome'])('rejects unallowlisted result %s', field => {
    const value = {
      ...finalization(),
      resultFailure: { category: 'unknown', code: 'unknown', executorOutcome: 'unknown', [field]: 'PRIVATE_VALUE' },
    };
    expect(() => collector.projectFinalization(value, 'cloud-hypervisor'))
      .toThrow(expect.objectContaining({ failedCheck: 'result-failure-schema' }));
  });
  it('accepts legacy finalization without inferring a new result gate passed', () => {
    const value = finalization();
    delete value.checks.result;
    const projected = JSON.parse(collector.projectFinalization(value, 'cloud-hypervisor').toString());
    expect(projected.checks.result).toEqual(['not-attempted', 'none']);
    expect(projected).not.toHaveProperty('resultFailure');
  });
  it('retains startup and finalization independently when invocation collection fails', () => {
    retainStartup(true);
    collector.retainFinalization(run, finalization(), uid, temp);
    invocation(false);
    let failure: unknown;
    try { collectRun(); } catch (error) { failure = error; }
    collector.publishCollectionFailure(run, uid, gid, failure, uid, temp);
    expect(fs.readdirSync(path.join(run, 'upload')).sort())
      .toEqual(['collection-status.txt', 'finalization.json', 'startup.json']);
  });
  it('keeps finalization evidence even when startup validation fails', () => {
    retainStartup();
    collector.retainFinalization(run, finalization(), uid, temp);
    fs.chmodSync(path.join(run, 'startup.json'), 0o644);
    let failure: unknown;
    try { collectRun(); } catch (error) { failure = error; }
    collector.publishCollectionFailure(run, uid, gid, failure, uid, temp);
    expect(fs.readdirSync(path.join(run, 'upload')).sort())
      .toEqual(['collection-status.txt', 'finalization.json']);
  });
  it.each(['symlink', 'hardlink', 'permissions', 'oversized', 'backend', 'reason', 'inherited-gate', 'owner', 'ancestor-symlink'])(
    'rejects unsafe finalization evidence %s without disclosing input', kind => {
      retainFinalization();
      const file = path.join(run, 'finalization.json');
      if (kind === 'symlink') {
        fs.renameSync(file, path.join(temp, 'outside'));
        fs.symlinkSync(path.join(temp, 'outside'), file);
      } else if (kind === 'hardlink') fs.linkSync(file, path.join(temp, 'linked'));
      else if (kind === 'permissions') fs.chmodSync(file, 0o644);
      else if (kind === 'oversized') fs.writeFileSync(file, Buffer.alloc(collector.MAX_STATUS_BYTES + 1));
      else if (kind === 'ancestor-symlink') {
        fs.renameSync(run, path.join(temp, 'original-run'));
        fs.symlinkSync(path.join(temp, 'original-run'), run);
      } else if (kind === 'owner') {
        const fstat = mutableFs.fstatSync;
        jest.spyOn(mutableFs, 'fstatSync').mockImplementation(fd =>
          Object.assign(fstat(fd), { uid: uid + 1 }));
      } else {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (kind === 'backend') value.backend = 'docker';
        else if (kind === 'inherited-gate') value.primaryFailure = { gate: 'constructor', reason: 'invalid' };
        else value.primaryFailure.reason = 'PRIVATE_PROMPT_AND_CREDENTIAL_SENTINEL';
        fs.writeFileSync(file, JSON.stringify(value));
      }
      let failure: unknown;
      try { collectRun(); } catch (error) { failure = error; }
      expect(failure).toBeDefined();
      jest.restoreAllMocks();
      if (kind === 'ancestor-symlink') {
        fs.unlinkSync(run);
        fs.renameSync(path.join(temp, 'original-run'), run);
        fs.chmodSync(file, 0o644);
      } else if (kind === 'owner') fs.chmodSync(file, 0o644);
      collector.publishCollectionFailure(run, uid, gid, failure, uid, temp);
      expect(fs.readdirSync(path.join(run, 'upload'))).toEqual(['collection-status.txt']);
      const status = fs.readFileSync(path.join(run, 'upload/collection-status.txt'), 'utf8');
      expect(status).not.toContain('PRIVATE_');
      if (kind === 'inherited-gate') expect(status).toContain('failedCheck=finalization-schema category=invalid-evidence');
    });
  it.each(['symlink', 'hardlink', 'permissions', 'oversized', 'backend', 'category'])(
    'rejects unsafe startup evidence %s without disclosing raw input', kind => {
      retainStartup();
      const file = path.join(run, 'startup.json');
      if (kind === 'symlink') {
        fs.unlinkSync(file);
        fs.symlinkSync(path.join(temp, 'private.stderr'), file);
      } else if (kind === 'hardlink') fs.linkSync(file, path.join(temp, 'linked-startup'));
      else if (kind === 'permissions') fs.chmodSync(file, 0o644);
      else if (kind === 'oversized') fs.writeFileSync(file, Buffer.alloc(collector.MAX_STATUS_BYTES + 1));
      else {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (kind === 'backend') value.backend = 'docker';
        else value.diagnostic.category = 'PRIVATE_PROMPT_AND_CREDENTIAL_SENTINEL';
        fs.writeFileSync(file, JSON.stringify(value));
      }
      let failure: unknown;
      try { collectRun(); } catch (error) { failure = error; }
      expect(failure).toBeDefined();
      collector.publishCollectionFailure(run, uid, gid, failure, uid, temp);
      expect(fs.readdirSync(path.join(run, 'upload'))).toEqual(['collection-status.txt']);
      expect(fs.readFileSync(path.join(run, 'upload/collection-status.txt'), 'utf8')).not.toContain('PRIVATE_');
    });
  it('rejects legacy Cloud Hypervisor evidence without a correlated terminal stop record', () => {
    prepareRun();
    invocation(false);
    expect(collectRun).toThrow(/stop-proof/);
    expect(fs.existsSync(path.join(run, 'upload'))).toBe(false);
  });
  it('collects the common public artifacts from the run and broker invocation layout', () => {
    prepareRun();
    const source = invocation();
    const names = ['stdout.log', 'stderr.log', 'enclave-session.log', 'diagnostics.json'];
    for (const name of names) fs.writeFileSync(path.join(source, name),
      name === 'diagnostics.json' ? JSON.stringify(commonEnvelope()) + '\n' : '', { mode: 0o600 });
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
  it('loads standalone with synchronized startup and auth-fields validators', () => {
    const stagedPath = stageCollector(temp);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const staged = require(stagedPath);
    const checks = Object.fromEntries(Object.entries(preflightSchema.scopes).flatMap(([scope, catalog]) =>
      Object.keys(catalog).map(id => [`${scope}/${id}`, ['not-attempted', 'none']])));
    for (const id of preflightSchema.optionalChecks) checks[id] = ['not-required', 'none'];
    const checklist = { schemaVersion: 1, ready: false, checks };
    expect(staged.projectStartupChecklist(checklist)).toEqual(checklist);
    for (const reason of Object.keys(preflightSchema.reasons).filter(reason => reason !== 'none')) {
      expect(staged.projectStartupChecklist({
        ...checklist, checks: { ...checks, 'startup/configuration': ['failed', reason] },
      }).checks['startup/configuration']).toEqual(['failed', reason]);
    }
    expect(() => staged.projectStartupChecklist({
      ...checklist, checks: { ...checks, 'private/SECRET': ['failed', 'ENOSPC'] },
    })).toThrow(/startup-schema/);
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
    setRun(run);
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

describe('public enclave run-level publication', () => {
  const f = standaloneFixture();
  const { prepareRun, collectRun, invocation, write, runId } = f;

  it('retains Cloud Hypervisor supplemental and closed proxy evidence only after eligibility validation', async () => {
    prepareRun();
    const source = invocation();
    write(path.join(source, 'guest-stderr.raw.log'), 'retained public guest output\n');
    write(path.join(source, 'counters.json'), '{"boot_time_ms":1}\n');
    await preservePublicEnclaveProxyDiagnostics({ runId, journalDir: f.roots.journal },
      { scope: 'run-cumulative', status: 'captured', records: 1, local: { '403': 1 }, upstream: {} },
      [{ schemaVersion: 1, origin: 'local', status: 403 }],
      'source=stderr level=warn event=enclave_model_budget_rejected\ncapture_status=captured dropped=0\n');
    expect(collectRun()).toBe(8);
    expect(fs.readFileSync(path.join(f.scope, 'upload/enclave-proxy-events.jsonl'), 'utf8'))
      .toBe('{"schemaVersion":1,"origin":"local","status":403}\n');
  });
  it.each(['docker', 'cloud-hypervisor'])('exports identity-checked %s run-level early-failure projections without invocation storage', async backend => {
    f.roots.backend = backend;
    prepareRun();
    new HostExecutorJournal({
      runId, journalDir: f.roots.journal, seedsDir: path.join(f.root, 'seeds'),
      invocationsDir: path.join(f.root, 'invocations'), entries: [],
    });
    const run = { runId, journalDir: f.roots.journal };
    persistHostExecutorProxyUsage(run, {
      scope: 'run-cumulative', requests: { status: 'not-drained' }, tokens: { status: 'not-drained' },
    });
    persistHostExecutorProxyResponseDiagnostics(run, { scope: 'run-cumulative', status: 'not-drained' });
    await preservePublicEnclaveProxyDiagnostics(run,
      { scope: 'run-cumulative', status: 'not-drained' }, [], 'capture_status=unavailable\n');
    expect(collectRun()).toBe(4);
    expect(fs.readdirSync(path.join(f.scope, 'upload')).sort()).toEqual([
      'collection-status.txt', 'enclave-proxy-container.log', 'enclave-proxy-events.jsonl',
      'enclave-proxy-response.json', 'enclave-proxy-usage.json',
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(f.scope, 'upload/enclave-proxy-usage.json'), 'utf8')).usage)
      .toEqual({ scope: 'run-cumulative', requests: { status: 'not-drained' }, tokens: { status: 'not-drained' } });
    expect(fs.readFileSync(path.join(f.scope, 'upload/collection-status.txt'), 'utf8'))
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
    expect(fs.readdirSync(path.join(f.scope, 'upload')).sort()).toEqual([
      'collection-status.txt', 'counters.json', 'guest-stderr.raw.log', 'launcher-stderr.log',
    ]);
    expect(fs.readFileSync(path.join(f.scope, 'upload/collection-status.txt'), 'utf8'))
      .toContain('Shared diagnostics envelope: absent-legacy-supplemental-only.');
  });
  it('retains protected legacy CH streams without synthesizing a shared envelope or stop proof', () => {
    prepareRun();
    const source = invocation();
    fs.unlinkSync(path.join(source, 'diagnostics.json'));
    expect(collectRun()).toBe(3);
    expect(fs.readFileSync(path.join(f.scope, 'upload/stdout.log'), 'utf8')).toBe('public output\n');
    expect(fs.existsSync(path.join(f.scope, 'upload/diagnostics.json'))).toBe(false);
    expect(fs.readFileSync(path.join(f.scope, 'upload/collection-status.txt'), 'utf8'))
      .toContain('Shared diagnostics envelope: absent-legacy-supplemental-only.');
  });
  it('does not downgrade malformed shared CH diagnostics to legacy supplemental-only export', () => {
    prepareRun();
    const source = invocation();
    write(path.join(source, 'diagnostics.json'), '{}');
    write(path.join(source, 'guest-stderr.raw.log'), 'legacy-looking error\n');
    expect(collectRun).toThrow();
    expect(fs.existsSync(path.join(f.scope, 'upload'))).toBe(false);
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
    expect(fs.statSync(path.join(f.scope, 'upload/stdout.log')).size).toBe(MAX_STREAM_BYTES);
  });
  it('bounds all published files and bytes including the fixed run projection reserve and status', () => {
    expect(collector.MAX_PUBLISHED_FILES).toBe(MAX_FILES + 4 + 3);
    expect(collector.MAX_PUBLISHED_BYTES).toBe((MAX_FILES + 4) * MAX_STREAM_BYTES
      + 2 * collector.MAX_STATUS_BYTES + collector.MAX_STARTUP_BYTES);
    const bytes = Buffer.alloc(MAX_STREAM_BYTES);
    const files = [...Array.from({ length: MAX_FILES + 4 }, (_, index) => [`file-${index}`, bytes]),
      ['startup.json', Buffer.alloc(collector.MAX_STARTUP_BYTES)],
      ['finalization.json', Buffer.alloc(collector.MAX_STATUS_BYTES)]];
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
    expect(fs.existsSync(path.join(f.scope, 'upload'))).toBe(false);
  });
  it.each(['symlink', 'hardlink', 'permissions', 'oversized', 'run', 'scope', 'raw-log'])(
    'retains proxy safeguards for %s', async kind => {
      prepareRun();
      invocation();
      await preservePublicEnclaveProxyDiagnostics({ runId, journalDir: f.roots.journal },
        { scope: 'run-cumulative', status: 'empty' }, [], 'capture_status=empty\n');
      const id = createHash('sha256').update(`awf-enclave-proxy-debug-v1:${runId}`).digest('hex').slice(0, 32);
      const file = path.join(f.roots.journal, 'diagnostics', `${runId}-${id}.proxy-debug.json`);
      if (kind === 'symlink') { fs.unlinkSync(file); fs.symlinkSync(path.join(f.scope, 'baseline.json'), file); }
      else if (kind === 'hardlink') fs.linkSync(file, path.join(f.root, 'linked'));
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
      expect(fs.existsSync(path.join(f.scope, 'upload'))).toBe(false);
    });
});
