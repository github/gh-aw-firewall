import {
  fs, path, collector, projectDiagnostics, projectEnclaveSessionDiagnostics, standaloneFixture,
  legacyCollectorFixture,
} from './collector.test-utils';

describe('public enclave session projections', () => {
  const f = legacyCollectorFixture();
  const { prepareRun, invocation, collectRun, commonEnvelope, runId, invocationId } = f;

  it('collects a common entrypoint operation failure without a session transcript', () => {
    prepareRun();
    const source = invocation();
    const failure = {
      stage: 'entrypoint-initialization', status: 'failed', operation: 'preflight-session-log',
      category: 'permission-denied', errno: 13,
    };
    const envelope = {
      ...commonEnvelope(), executorKind: 'agent',
      streams: { stdout: 'captured', stderr: 'captured', session: 'missing' },
      session: { status: 'missing' }, stages: [failure], primaryFailure: failure,
    };
    fs.writeFileSync(path.join(source, 'diagnostics.json'), JSON.stringify(envelope), { mode: 0o600 });
    fs.writeFileSync(path.join(source, 'stdout.log'), '', { mode: 0o600 });
    fs.writeFileSync(path.join(source, 'stderr.log'), '{"event":"operation-error","operation":"preflight-session-log"}\n',
      { mode: 0o600 });
    fs.writeFileSync(path.join(source, 'enclave-session.log'), '', { mode: 0o600 });
    collectRun();
    const projected = JSON.parse(fs.readFileSync(path.join(f.run, 'upload/diagnostics.json'), 'utf8'));
    expect(projected.primaryFailure).toEqual(failure);
    expect(projected.stages).toContainEqual(failure);
    expect(projected.session).toEqual({ status: 'missing' });
    expect(fs.readFileSync(path.join(f.run, 'upload/enclave-session.log'), 'utf8')).toBe('');
  });
  it.each([
    { operation: 'PRIVATE_OPERATION' },
    { operation: 'output-read' },
    { operation: 'preflight-session-log', stage: 'workload-exit' },
    { operation: 'preflight-session-log', status: 'succeeded' },
  ])('rejects unapproved common entrypoint operation metadata %j', fields => {
    const failure = {
      stage: 'entrypoint-initialization', status: 'failed', category: 'permission-denied', errno: 13, ...fields,
    };
    expect(() => projectDiagnostics({ ...commonEnvelope(), stages: [failure] }, {
      runId, invocationId, entryId: 'script', runtime: 'cloud-hypervisor',
    })).toThrow(expect.objectContaining({ failedCheck: 'operation-schema' }));
  });

  it('preserves finite Claude lifecycle evidence without engine payloads', () => {
    const envelope = {
      ...commonEnvelope(),
      session: { status: 'captured', events: [
        { event: 'progress', stage: 'claude-initialized', permissionMode: 'default',
          shellAvailable: true, cwd: 'PRIVATE_PATH', headers: 'PRIVATE_HEADER' },
        { event: 'progress', stage: 'claude-permission-denied', input: 'PRIVATE_COMMAND' },
        { event: 'progress', stage: 'claude-api-retry', httpStatus: 403, error: 'PRIVATE_ERROR' },
        { event: 'progress', stage: 'claude-api-retry', httpStatus: 529, error: 'PRIVATE_OVERLOAD' },
        { event: 'progress', stage: 'claude-stream-summary', stdoutObserved: true,
          stderrObserved: false, captureTruncated: false, outputState: 'empty', raw: 'PRIVATE_MODEL' },
      ] },
    };
    const projected = JSON.parse(projectDiagnostics(envelope, {
      runId, invocationId, entryId: 'script', runtime: 'cloud-hypervisor',
    }).toString());
    expect(projected.session.events).toEqual([
      { event: 'progress', stage: 'claude-initialized', permissionMode: 'default', shellAvailable: true },
      { event: 'progress', stage: 'claude-permission-denied' },
      { event: 'progress', stage: 'claude-api-retry', httpStatus: 403 },
      { event: 'progress', stage: 'claude-api-retry', httpStatus: 529 },
      { event: 'progress', stage: 'claude-stream-summary', stdoutObserved: true,
        stderrObserved: false, captureTruncated: false, outputState: 'empty' },
    ]);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    envelope.session.events[0].permissionMode = 'PRIVATE_MODE';
    expect(() => projectDiagnostics(envelope, { runId, invocationId, entryId: 'script', runtime: 'cloud-hypervisor' }))
      .toThrow(/session-schema/);
  });

  it('excludes guest-controlled progress integers from exported audit artifacts', () => {
    const privateSeedChunks = [3141592653, 2718281828];
    const transcript = Buffer.from(JSON.stringify({
      event: 'progress', stage: 'engine-completed',
      attempt: privateSeedChunks[0], runtimeMs: privateSeedChunks[1],
    }));
    const session = projectEnclaveSessionDiagnostics(transcript);
    const identity = { runId, invocationId, entryId: 'script', runtime: 'cloud-hypervisor' };
    const projected = JSON.parse(projectDiagnostics({ ...commonEnvelope(), session }, identity).toString());
    expect(projected.session.events).toEqual([{ event: 'progress', stage: 'engine-completed' }]);
    for (const chunk of privateSeedChunks) {
      expect(JSON.stringify(projected)).not.toContain(String(chunk));
    }

    const direct = JSON.parse(projectDiagnostics({
      ...commonEnvelope(),
      session: { status: 'captured', events: [{
        event: 'progress', stage: 'engine-completed',
        attempt: privateSeedChunks[0], runtimeMs: privateSeedChunks[1],
      }] },
    }, identity).toString());
    expect(direct.session.events).toEqual([{ event: 'progress', stage: 'engine-completed' }]);
    for (const chunk of privateSeedChunks) {
      expect(JSON.stringify(direct)).not.toContain(String(chunk));
    }
  });

  it('preserves the successful Claude summary after two complete silent startup crash attempts', () => {
    const snapshots = (stage: string, outputState = 'empty') => [
      { event: 'resource-snapshot', stage, memory: { currentBytes: 4096, events: { oom_kill: 0 } },
        filesystems: ['agent-directory', 'temporary-directory', 'shared-memory'].map(identifier => ({
          path: identifier, capacityBytes: 8192, availableBytes: 4096,
        })) },
      { event: 'output-snapshot', stage, uid: 65534, gid: 65534,
        paths: ['output-parent', 'output-directory', 'output-link', 'output-file'].map(identifier => ({
          path: identifier, uid: 65534, gid: 65534, mode: 0o700,
          type: identifier === 'output-link' ? 'symlink' : identifier === 'output-file' ? 'file' : 'directory',
          readable: true, writable: true, executable: false,
          ...(identifier === 'output-file' ? { size: outputState } : {}),
        })) },
      { event: 'output-verification', stage, symlink: true, targetMatches: true, sameFile: true,
        directReadable: true, aliasReadable: true, contentsMatch: true,
        directState: outputState, aliasState: outputState },
    ];
    const silentCrash = (attempt: number, signal: number) => [
      { event: 'progress', stage: 'engine-launch-attempt', attempt },
      { event: 'progress', stage: 'engine-started', attempt },
      { event: 'progress', stage: 'claude-stream-summary', stdoutObserved: false,
        stderrObserved: false, captureTruncated: false, outputState: 'empty' },
      { event: 'engine-result', exitCode: -signal, signal, stdoutObserved: false, stderrObserved: false },
      ...snapshots('after-engine'),
      { event: 'storage-probe', status: 'missing', milestones: [] },
      { event: 'progress', stage: 'engine-completed', attempt, exitCode: -signal, runtimeMs: 100 },
      { event: 'engine-retry', category: 'startup-crash', signal },
    ];
    const summary = {
      event: 'progress', stage: 'claude-stream-summary', stdoutObserved: true,
      stderrObserved: false, captureTruncated: false, outputState: 'present',
    };
    const transcript = [
      { event: 'progress', stage: 'configuration-accepted', engine: 'claude' },
      { event: 'progress', stage: 'input-accepted', taskBytes: 123, schemaBytes: 456 },
      { event: 'progress', stage: 'runtime-paths-ready', paths: ['home-directory', 'claude-log-directory'] },
      { event: 'session', engine: 'claude', sensitivity: 'redacted' },
      ...['claude-executable', 'seed-directory', 'task-input', 'schema-input', 'output-file',
        'session-log', 'agent-directory', 'claude-log-directory'].map(identifier => ({
        event: 'preflight', path: identifier, exists: true,
        type: identifier.endsWith('directory') ? 'directory' : 'file', executable: true, writable: true,
      })),
      { event: 'progress', stage: 'preflight-completed', valid: true },
      ...snapshots('before-engine'),
      ...silentCrash(1, 6),
      ...silentCrash(2, 11),
      { event: 'progress', stage: 'engine-launch-attempt', attempt: 3 },
      { event: 'progress', stage: 'engine-started', attempt: 3 },
      { event: 'progress', stage: 'claude-first-byte', runtimeMs: 10 },
      { event: 'progress', stage: 'claude-initialized', permissionMode: 'default', shellAvailable: true },
      { event: 'progress', stage: 'claude-api-retry', httpStatus: 529 },
      { event: 'progress', stage: 'claude-response' },
      { event: 'progress', stage: 'claude-tool-requested' },
      { event: 'progress', stage: 'claude-tool-completed', toolError: false },
      { event: 'progress', stage: 'claude-result', resultError: false, outputState: 'present' },
      { ...summary, raw: 'PRIVATE_STREAM', message: 'PRIVATE_MODEL', sha256: 'PRIVATE_HASH' },
      { event: 'engine-result', exitCode: 0, stdout: 'PRIVATE_STDOUT' },
      ...snapshots('after-engine', 'within-limit'),
      { event: 'storage-probe', status: 'missing', milestones: [] },
      { event: 'progress', stage: 'engine-completed', attempt: 3, exitCode: 0, runtimeMs: 1000 },
      { event: 'progress', stage: 'output-normalization-started' },
      { event: 'output-normalization', inputState: 'within-limit', stdoutState: 'empty' },
      { event: 'progress', stage: 'output-normalized', outputBytes: 42 },
      { event: 'progress', stage: 'output-write-attempt' },
      { event: 'progress', stage: 'output-written', outputBytes: 42 },
      { event: 'success' },
    ];
    const session = projectEnclaveSessionDiagnostics(Buffer.from(
      transcript.map(event => JSON.stringify(event)).join('\n')));
    expect(session.events).toHaveLength(32);
    expect(session.events?.filter(event => event.event === 'engine-retry')).toEqual([
      { event: 'engine-retry', signal: 6 }, { event: 'engine-retry', signal: 11 },
    ]);
    expect(session.events?.some(event => event.httpStatus === 529)).toBe(true);
    expect(session.events?.some(event => event.stage === 'claude-stream-summary'
      && event.stdoutObserved === true)).toBe(false);
    expect(session.claudeStreamSummary).toEqual(summary);
    expect(session.lastEvent).toEqual({ event: 'success' });
    expect(session.failure).toBeUndefined();
    expect(session.dropped).toBeGreaterThan(0);
    const projected = JSON.parse(projectDiagnostics({ ...commonEnvelope(), session }, {
      runId, invocationId, entryId: 'script', runtime: 'cloud-hypervisor',
    }).toString());
    expect(projected.session).toEqual({
      ...session,
      events: session.events?.map(event => Object.fromEntries(
        Object.entries(event).filter(([key]) => !['attempt', 'runtimeMs'].includes(key)))),
    });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(8192);
  });

  it('retains the final event after the event cap without exporting progress integers', () => {
    const transcript = [
      ...Array.from({ length: 32 }, (_, index) => ({
        event: 'progress', stage: 'engine-started', attempt: index + 1,
      })),
      { event: 'progress', stage: 'engine-completed', attempt: 3, exitCode: 1, runtimeMs: 100 },
    ];
    const session = projectEnclaveSessionDiagnostics(Buffer.from(
      transcript.map(event => JSON.stringify(event)).join('\n')));
    expect(session.events).toHaveLength(32);
    expect(session.dropped).toBe(1);
    expect(session.lastEvent).toEqual({ event: 'progress', stage: 'engine-completed', exitCode: 1 });
  });

  it.each([
    'unknown-option', 'invalid-option-value', 'missing-option-value',
    'invalid-settings', 'invalid-mcp-config', 'unknown',
  ])('preserves startup classification %s through host and protected artifact projection', classification => {
    const event = { event: 'progress', stage: 'claude-startup-failure', classification,
      stderr: 'PRIVATE_STDERR', prompt: 'PRIVATE_PROMPT', exception: 'PRIVATE_EXCEPTION' };
    const session = projectEnclaveSessionDiagnostics(Buffer.from(JSON.stringify(event)));
    const identity = { runId, invocationId, entryId: 'script', runtime: 'cloud-hypervisor' };
    const projected = JSON.parse(projectDiagnostics({ ...commonEnvelope(), session }, identity).toString());
    expect(projected.session.events).toEqual([
      { event: 'progress', stage: 'claude-startup-failure', classification },
    ]);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    expect(() => projectDiagnostics({
      ...commonEnvelope(), session: { status: 'captured', events: [
        { ...event, classification: 'PRIVATE_CLASS' },
      ] },
    }, identity)).toThrow(/session-schema/);
  });

  it('projects the independent Claude summary and rejects incorrect summary schema', () => {
    const envelope = { ...commonEnvelope(), session: {
      status: 'captured', claudeStreamSummary: {
        event: 'progress', stage: 'claude-stream-summary', stdoutObserved: true,
        httpStatus: 529, raw: 'PRIVATE_STREAM',
      },
    } };
    const identity = { runId, invocationId, entryId: 'script', runtime: 'cloud-hypervisor' };
    const projected = JSON.parse(projectDiagnostics(envelope, identity).toString());
    expect(projected.session.claudeStreamSummary).toEqual({
      event: 'progress', stage: 'claude-stream-summary', stdoutObserved: true, httpStatus: 529,
    });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    for (const malformed of [
      { event: 'success' },
      { event: 'progress', stage: 'claude-response' },
      { event: 'progress', stage: 'claude-stream-summary', httpStatus: 530 },
      'PRIVATE_SUMMARY',
    ]) {
      expect(() => projectDiagnostics({
        ...envelope, session: { status: 'captured', claudeStreamSummary: malformed },
      }, identity)).toThrow(/session-schema/);
    }
  });

  it('retains finite Claude denial classes and the final result after event-cap saturation', () => {
    const denials = ['shell', 'file-read', 'file-write', 'output-write', 'search', 'unknown'].map(toolClass => ({
      event: 'progress', stage: 'claude-permission-denied', toolClass,
      input: 'PRIVATE_COMMAND', tool_name: 'PRIVATE_TOOL', prompt: 'PRIVATE_PROMPT',
    }));
    const result = { event: 'progress', stage: 'claude-result', resultError: false };
    const writeError = {
      event: 'progress', stage: 'claude-tool-completed', toolClass: 'output-write', toolError: true,
    };
    const session = projectEnclaveSessionDiagnostics(Buffer.from([
      ...Array.from({ length: 32 }, () => ({ event: 'progress', stage: 'claude-response' })),
      ...denials, ...denials, writeError, writeError, result,
    ].map(event => JSON.stringify(event)).join('\n')));
    const identity = { runId, invocationId, entryId: 'script', runtime: 'cloud-hypervisor' };
    const projected = JSON.parse(projectDiagnostics({ ...commonEnvelope(), session }, identity).toString());
    expect(projected.session.claudePermissionDenials).toEqual(denials.map(({ toolClass }) => ({
      event: 'progress', stage: 'claude-permission-denied', toolClass,
    })));
    expect(projected.session.claudeResult).toEqual(result);
    expect(projected.session.claudeToolErrors).toEqual([writeError]);
    expect(projected.session.events).toHaveLength(32);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    for (const invalid of [
      { claudeResult: { event: 'success' } },
      { claudePermissionDenials: [{ event: 'success' }] },
      { claudePermissionDenials: Array(8).fill(denials[0]) },
      { claudePermissionDenials: [{ ...denials[0], toolClass: 'PRIVATE_CLASS' }] },
      { claudeToolErrors: [{ ...writeError, toolError: false }] },
      { claudeToolErrors: Array(8).fill(writeError) },
    ]) {
      expect(() => projectDiagnostics({
        ...commonEnvelope(), session: { status: 'captured', ...invalid },
      }, identity)).toThrow(/session-schema/);
    }
  });

  it('retains the final Claude startup failure after event-cap saturation', () => {
    const startupFailure = {
      event: 'progress', stage: 'claude-startup-failure', classification: 'invalid-option-value',
      stderr: 'PRIVATE_STDERR', prompt: 'PRIVATE_PROMPT',
    };
    const transcript = [
      { event: 'engine-retry', signal: 6 },
      { event: 'engine-retry', signal: 11 },
      ...Array.from({ length: 30 }, () => ({
        event: 'operation-error', operation: 'resource-memory.events-read', category: 'os-error',
        errno: 5, fatal: false, detail: 'PRIVATE_DETAIL',
      })),
      startupFailure,
      { event: 'progress', stage: 'engine-completed', attempt: 3, exitCode: 1 },
    ];
    const session = projectEnclaveSessionDiagnostics(Buffer.from(
      transcript.map(event => JSON.stringify(event)).join('\n')));
    expect(session.events).toHaveLength(32);
    expect(session.events?.some(event => event.stage === 'claude-startup-failure')).toBe(false);
    expect(session.lastEvent).toEqual({ event: 'progress', stage: 'engine-completed', exitCode: 1 });
    expect(session.claudeStartupFailure).toEqual({
      event: 'progress', stage: 'claude-startup-failure', classification: 'invalid-option-value',
    });
    const projected = JSON.parse(projectDiagnostics({
      ...commonEnvelope(), session,
    }, { runId, invocationId, entryId: 'script', runtime: 'cloud-hypervisor' }).toString());
    expect(projected.session.claudeStartupFailure).toEqual(session.claudeStartupFailure);
    expect(projected.session.lastEvent).toEqual(session.lastEvent);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    expect(projectEnclaveSessionDiagnostics(Buffer.from(JSON.stringify({
      event: 'progress', stage: 'engine-completed', attempt: 4,
    }))).lastEvent).toEqual({ event: 'progress', stage: 'engine-completed' });
    expect(() => projectDiagnostics({
      ...commonEnvelope(), session: {
        status: 'captured', claudeStartupFailure: {
          ...session.claudeStartupFailure, classification: 'PRIVATE_CLASS',
        },
      },
    }, { runId, invocationId, entryId: 'script', runtime: 'cloud-hypervisor' })).toThrow(/session-schema/);
  });
});

describe('public enclave shared runtime projections', () => {
  const f = standaloneFixture();
  const { prepareRun, collectRun, envelope, invocation, write, identity, uid, gid, runId, invocationId } = f;

  it('retains closed session permission metadata for successful and rejected append-open preflights', () => {
    const result = JSON.parse(projectDiagnostics(envelope({
      session: {
        status: 'captured',
        bytes: 1024,
        events: [
          {
            event: 'preflight', path: 'session-log', exists: true, type: 'file', uid: 0, gid: 0,
            mode: 0o600, links: 1, writerUid: 0, writerGid: 0, writable: true,
            parentUid: 0, parentGid: 0, parentMode: 0o700, parentTraversable: true, mountWritable: true,
            fileName: 'PRIVATE_PATH',
          },
          {
            event: 'preflight', path: 'session-log', exists: true, type: 'file', uid: 1234, gid: 1234,
            mode: 0o400, links: 1, writerUid: 0, writerGid: 0, writable: false,
            parentUid: 0, parentGid: 0, parentMode: 0o700, parentTraversable: true, mountWritable: true,
            failedCheck: 'session-log-open', failureCategory: 'permission-denied', failureErrno: 13,
            exception: 'PRIVATE_ERROR',
          },
        ],
      },
    }), identity()).toString('utf8'));
    expect(result.session.events).toEqual([
      {
        event: 'preflight', path: 'session-log', exists: true, type: 'file', writable: true,
        uid: 0, gid: 0, writerUid: 0, writerGid: 0, mode: 0o600, links: 1,
        parentUid: 0, parentGid: 0, parentMode: 0o700, parentTraversable: true, mountWritable: true,
      },
      {
        event: 'preflight', path: 'session-log', exists: true, type: 'file', writable: false,
        uid: 'other', gid: 'other', writerUid: 0, writerGid: 0, mode: 0o400, links: 1,
        parentUid: 0, parentGid: 0, parentMode: 0o700, parentTraversable: true, mountWritable: true,
        failedCheck: 'session-log-open', failureCategory: 'permission-denied', failureErrno: 13,
      },
    ]);
    expect(JSON.stringify(result.session)).not.toMatch(/PRIVATE_/);
  });

  it.each(['docker', 'cloud-hypervisor'])('exports complete shared %s success evidence with runner-owned artifacts', backend => {
    f.roots.backend = backend;
    fs.mkdirSync(path.join(f.roots.debug, 'c'.repeat(32)), { mode: 0o700 });
    write(path.join(f.roots.journal, `${'d'.repeat(32)}.journal`), 'stale');
    prepareRun();
    invocation();
    expect(collectRun()).toBe(4);
    const upload = path.join(f.scope, 'upload');
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
    f.roots.backend = 'docker';
    prepareRun();
    invocation();
    const recovery = path.join(f.roots.journal, 'docker');
    fs.mkdirSync(recovery, { mode: 0o700 });
    const record = path.join(recovery, `${runId}-script-${invocationId}.json`);
    write(record, '{"privateRecoveryState":"PRIVATE"}');
    fs.unlinkSync(record);
    expect(collectRun()).toBe(4);
    expect(fs.readFileSync(path.join(f.scope, 'upload/collection-status.txt'), 'utf8')).not.toContain('PRIVATE');
    expect(fs.existsSync(path.join(f.roots.journal, `${runId}.journal`))).toBe(true);
  });

  function unavailableInvocation() {
    f.roots.backend = 'docker';
    prepareRun();
    const source = invocation();
    for (const name of fs.readdirSync(source)) fs.unlinkSync(path.join(source, name));
    const journal = path.join(f.roots.journal, `${runId}.journal`);
    write(journal, fs.readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(record => !['terminal', 'closed'].includes(record.state)).map(record => JSON.stringify(record)).join('\n') + '\n');
    const primaryFailure = { stage: 'storage-preparation', category: 'host-exception' };
    const value = {
      version: 1, ...identity(), executorKind: 'script', stage: 'setup', status: 'unavailable',
      reason: 'host-reconciliation-incomplete',
      stages: [{ ...primaryFailure, status: 'failed' }], primaryFailure,
      message: 'PRIVATE_EXCEPTION', workloadStopped: true, workloadLaunched: true,
    };
    const file = path.join(source, 'retention-unavailable.json');
    write(file, JSON.stringify(value));
    return { source, file, value };
  }
  it('exports only closed Docker retention-unavailable evidence without claiming launch or stop', () => {
    const { file } = unavailableInvocation();
    expect(collectRun()).toBe(1);
    const upload = path.join(f.scope, 'upload');
    expect(fs.readdirSync(upload).sort()).toEqual(['collection-status.txt', 'retention-unavailable.json']);
    const text = fs.readFileSync(path.join(upload, 'retention-unavailable.json'), 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      status: 'unavailable', reason: 'host-reconciliation-incomplete',
      primaryFailure: { stage: 'storage-preparation', status: 'failed', category: 'host-exception' },
    });
    expect(text).not.toMatch(/PRIVATE|workloadStopped|workloadLaunched|stopProof|exitCode/);
    const status = fs.readFileSync(path.join(upload, 'collection-status.txt'), 'utf8');
    expect(status).toContain('Shared diagnostics envelope: unavailable-host-reconciliation-incomplete');
    expect(status).not.toContain('envelope: validated');
    expect(fs.existsSync(file)).toBe(true);
  });
  it.each(['identity', 'reason', 'operation', 'extra-stream', 'symlink', 'hardlink', 'permissions', 'oversized'])(
    'rejects unsafe or contradictory retention-unavailable evidence %s', kind => {
      const { source, file, value } = unavailableInvocation();
      if (kind === 'identity') write(file, JSON.stringify({ ...value, invocationId: 'c'.repeat(24) }));
      if (kind === 'reason') write(file, JSON.stringify({ ...value, reason: 'PRIVATE_REASON' }));
      if (kind === 'operation') write(file, JSON.stringify({
        ...value, stages: [{ stage: 'storage-preparation', status: 'failed', category: 'PRIVATE_CATEGORY' }],
      }));
      if (kind === 'extra-stream') write(path.join(source, 'stderr.log'), 'PRIVATE_UNSTOPPED_STREAM');
      if (kind === 'symlink') { fs.renameSync(file, file + '.real'); fs.symlinkSync(file + '.real', file); }
      if (kind === 'hardlink') fs.linkSync(file, path.join(f.root, 'linked'));
      if (kind === 'permissions') fs.chmodSync(file, 0o644);
      if (kind === 'oversized') fs.truncateSync(file, collector.MAX_STARTUP_BYTES + 1);
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(f.scope, 'upload'))).toBe(false);
    },
  );
  it('collects only finite Docker metadata when stop and cleanup remain uncertain', () => {
    f.roots.backend = 'docker';
    const value = envelope({
      stage: 'setup', failure: 'setup-failed', workloadStopped: false, workloadLaunched: false,
      stopProof: 'unavailable', exitCode: null,
      streams: { stdout: 'unavailable', stderr: 'unavailable', session: 'unavailable' },
      session: { status: 'unavailable' },
      streamCoverage: {
        stdout: { artifactSource: 'unavailable', agentSession: 'unavailable' },
        stderr: { artifactSource: 'unavailable', agentSession: 'unavailable' }, copilotDiagnostics: 'unavailable',
      },
      primaryFailure: { stage: 'storage-probe', status: 'failed', category: 'host-exception' },
      cleanupFailure: { stage: 'cleanup', status: 'failed', category: 'cleanup-failed' },
    });
    prepareRun();
    invocation(value);
    expect(collectRun()).toBe(4);
    expect(JSON.parse(fs.readFileSync(path.join(f.scope, 'upload/diagnostics.json'), 'utf8')))
      .toMatchObject({ workloadStopped: false, stopProof: 'unavailable',
        primaryFailure: { stage: 'storage-probe', status: 'failed', category: 'host-exception' },
        cleanupFailure: { stage: 'cleanup', status: 'failed', category: 'cleanup-failed' } });
    for (const stream of ['stdout', 'stderr', 'session']) {
      expect(() => projectDiagnostics({
        ...value, streams: { ...value.streams, [stream]: 'captured' },
      }, identity())).toThrow(/stop-proof/);
    }
    expect(() => projectDiagnostics({
      ...value, session: { status: 'unavailable', events: [{ event: 'progress', stage: 'engine-started' }] },
    }, identity())).toThrow(/stop-proof/);
    expect(() => projectDiagnostics({ ...value, cleanupFailure: undefined }, identity())).toThrow(/stop-proof/);
    for (const patch of [
      { exitCode: 17 },
      { stage: 'execution' },
      { failure: 'workload-exit' },
    ]) {
      expect(() => projectDiagnostics({ ...value, ...patch }, identity())).toThrow(/stop-proof/);
    }
  });

  it.each(['docker', 'cloud-hypervisor'])('preserves %s nonzero workload and setup outcomes without synthetic exit codes', backend => {
    f.roots.backend = backend;
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
    const result = JSON.parse(fs.readFileSync(path.join(f.scope, 'upload/diagnostics.json'), 'utf8'));
    expect(result.exitCode).toBeNull();
    expect(result.failure).toBe('setup-failed');
    expect(result.streams).toEqual(setup.streams);
    expect(result.primaryFailure.errno).toBe(13);
  });

  it.each(['docker', 'cloud-hypervisor'])('accepts cancelled and timed-out %s setup before launch', backend => {
    f.roots.backend = backend;
    for (const failure of ['cancelled', 'timeout']) {
      const setup = envelope({
        stage: 'setup', failure, exitCode: null, workloadLaunched: false, stopProof: 'not-launched',
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
      });
      expect(JSON.parse(projectDiagnostics(setup, identity()).toString())).toMatchObject({
        stage: 'setup', failure, exitCode: null, workloadLaunched: false, stopProof: 'not-launched',
      });
      expect(() => projectDiagnostics({ ...setup, exitCode: 0 }, identity())).toThrow(/stop-proof/);
      expect(() => projectDiagnostics({ ...setup, stage: 'execution' }, identity())).toThrow(/stop-proof/);
    }
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
      expect(JSON.parse(fs.readFileSync(path.join(f.scope, 'upload/diagnostics.json'), 'utf8')).streams.stdout).toBe(status);
    });

  it.each(['docker', 'cloud-hypervisor'])('exports truthful not-launched %s retention failure evidence', backend => {
    f.roots.backend = backend;
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
    expect(JSON.parse(fs.readFileSync(path.join(f.scope, 'upload/diagnostics.json'), 'utf8'))).toMatchObject({
      stage: 'retention', failure: 'retention-failed', workloadLaunched: false, stopProof: 'not-launched', exitCode: null,
    });
  });
});
