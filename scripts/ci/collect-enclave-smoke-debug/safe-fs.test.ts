import {
  fs, path, collector, MAX_STREAM_BYTES, projectDiagnostics, preservePublicEnclaveArtifacts, standaloneFixture,
} from './collector.test-utils';

describe('public enclave filesystem validation', () => {
  const f = standaloneFixture();
  const { prepareRun, collectRun, envelope, invocation, write, identity, uid, gid, runId } = f;

  it.each(['no-run', 'no-invocation', 'no-envelope', 'captured-stream-missing'])(
    'classifies absent evidence: %s', kind => {
      if (kind === 'no-envelope') f.roots.backend = 'docker';
      prepareRun();
      if (kind !== 'no-run') {
        const source = invocation();
        if (kind === 'no-invocation') fs.rmSync(source, { recursive: true });
        if (kind === 'no-envelope') fs.unlinkSync(path.join(source, 'diagnostics.json'));
        if (kind === 'captured-stream-missing') fs.unlinkSync(path.join(source, 'stdout.log'));
      }
      try { collectRun(); throw new Error('expected rejection'); }
      catch (error) { expect(error).toMatchObject({ category: 'absent-evidence' }); }
      expect(fs.existsSync(path.join(f.scope, 'upload'))).toBe(false);
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
      expect(fs.existsSync(path.join(f.scope, 'upload'))).toBe(false);
    });

  it('rejects contradictory captured Docker stop evidence', () => {
    f.roots.backend = 'docker';
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
    f.roots.backend = backend;
    prepareRun();
    const source = invocation();
    await preservePublicEnclaveArtifacts({
      directory: source, protectedRoot: f.root,
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
    const result = JSON.parse(fs.readFileSync(path.join(f.scope, 'upload/diagnostics.json'), 'utf8'));
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
    collector.publishCollectionFailure(f.scope, uid, gid, failure, uid, f.root);
    expect(fs.readdirSync(path.join(f.scope, 'upload'))).toEqual(['collection-status.txt']);
    const text = fs.readFileSync(path.join(f.scope, 'upload/collection-status.txt'), 'utf8');
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
    if (kind === 'hardlink') fs.linkSync(target, path.join(f.root, 'linked'));
    if (kind === 'concurrent') write(path.join(f.roots.journal, `${'c'.repeat(32)}.journal`), 'concurrent');
    let failure: unknown;
    try { collectRun(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ failedCheck, category });
    collector.publishCollectionFailure(f.scope, uid, gid, failure, uid, f.root);
    expect(fs.readFileSync(path.join(f.scope, 'upload/collection-status.txt'), 'utf8'))
      .toBe(`Collection failed: failedCheck=${failedCheck} category=${category}\n`);
  });

  it.each(['symlink', 'hardlink', 'permissions', 'oversized'])(
    'rejects unsafe common file %s', kind => {
      prepareRun();
      const file = path.join(invocation(), 'stdout.log');
      if (kind === 'symlink') {
        fs.unlinkSync(file);
        fs.symlinkSync(path.join(f.scope, 'baseline.json'), file);
      } else if (kind === 'hardlink') fs.linkSync(file, path.join(f.root, 'linked'));
      else if (kind === 'permissions') fs.chmodSync(file, 0o644);
      else write(file, Buffer.alloc(MAX_STREAM_BYTES + 1));
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(f.scope, 'upload'))).toBe(false);
    });

  it.each(['directory-symlink', 'directory-mode', 'journal-symlink', 'wrong-invocation',
    'another-entry', 'multiple-invocations', 'multiple-runs', 'malformed-journal', 'unknown-file'])(
    'rejects unsafe scope %s', kind => {
      prepareRun();
      const source = invocation();
      const journal = path.join(f.roots.journal, `${runId}.journal`);
      if (kind === 'directory-symlink') {
        fs.renameSync(source, path.join(f.root, 'moved'));
        fs.symlinkSync(path.join(f.root, 'moved'), source);
      } else if (kind === 'directory-mode') fs.chmodSync(source, 0o777);
      else if (kind === 'journal-symlink') {
        fs.unlinkSync(journal); fs.symlinkSync(path.join(f.scope, 'baseline.json'), journal);
      } else if (kind === 'wrong-invocation') fs.renameSync(source, path.join(path.dirname(source), 'c'.repeat(24)));
      else if (kind === 'multiple-invocations') fs.mkdirSync(path.join(path.dirname(source), 'c'.repeat(24)), { mode: 0o700 });
      else if (kind === 'another-entry') fs.appendFileSync(journal,
        JSON.stringify({ invocationId: f.invocationId, entryId: 'other', state: 'cleanup-pending' }) + '\n');
      else if (kind === 'multiple-runs') write(path.join(f.roots.journal, `${'c'.repeat(32)}.journal`), 'other');
      else if (kind === 'malformed-journal') fs.appendFileSync(journal, '{"invocationId":"../../escape"}\n');
      else write(path.join(source, 'environment.txt'), 'PRIVATE');
      expect(collectRun).toThrow();
      expect(fs.existsSync(path.join(f.scope, 'upload'))).toBe(false);
    });

  it('rejects invalid UTF-8 at the shared decoding boundary without leaking bytes', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decodeUtf8 } = require('./safe-fs.cjs');
    expect(decodeUtf8(Buffer.from('public ☃'), 'proxy-event-encoding')).toBe('public ☃');
    expect(() => decodeUtf8(Buffer.from([0xc3, 0x28]), 'proxy-event-encoding')).toThrow(
      expect.objectContaining({ failedCheck: 'proxy-event-encoding', category: 'invalid-evidence' }));
    expect(() => collector.projectProxyEvents(Buffer.from([0xff, 0x0a]))).toThrow(
      expect.objectContaining({ failedCheck: 'proxy-event-encoding', category: 'invalid-evidence' }));
    expect(() => collector.projectProxyContainerLog(Buffer.from([0xff, 0x0a]))).toThrow(
      expect.objectContaining({ failedCheck: 'proxy-container-encoding', category: 'invalid-evidence' }));
  });
});
