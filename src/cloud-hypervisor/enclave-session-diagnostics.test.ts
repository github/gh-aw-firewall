import { promises as fs } from 'fs';
import * as path from 'path';
import { readEnclaveSessionDiagnostics } from './enclave-session-diagnostics';

describe('bounded guest session evidence', () => {
  let directory: string;
  let runtime: string;
  let file: string;
  const uid = process.getuid!();
  const gid = process.getgid!();
  const read = () => readEnclaveSessionDiagnostics(directory, uid, gid);
  const write = (events: unknown[]) => fs.writeFile(file,
    events.map((event) => JSON.stringify(event)).join('\n'), { mode: 0o600 });

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), '.guest-session-')));
    runtime = path.join(directory, 'runtime');
    file = path.join(runtime, 'session.jsonl');
    await fs.mkdir(runtime, { mode: 0o700 });
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('retains fixed milestones, failures and resources without any raw guest strings', async () => {
    await write([
      { event: 'progress', stage: 'engine-started', attempt: 1, env: 'PRIVATE_ENV', task: 'PRIVATE_TASK' },
      { event: 'engine-result', exitCode: 24, stdout: 'PRIVATE_OUTPUT', stderr: { sha256: 'PRIVATE_HASH' } },
      { event: 'operation-error', operation: 'output-write', category: 'read-only-filesystem',
        errno: 30, strerror: 'PRIVATE_ERROR', exception: 'PRIVATE_EXCEPTION' },
      { event: 'resource-snapshot', stage: 'after-engine',
        memory: { peakBytes: 1234, events: { oom_kill: 1, PRIVATE_KEY: 'PRIVATE_VALUE' } },
        filesystems: [{ path: 'shared-memory', capacityBytes: 2048, availableBytes: 0, extra: 'PRIVATE_PATH' }],
        directories: [{ path: 'PRIVATE_REPOSITORY' }] },
      { event: 'failure', category: 'engine-failed' },
      { event: 'progress', stage: 'PRIVATE_STAGE' },
      { event: 'preflight', path: 'PRIVATE_PATH', type: 'file' },
    ]);
    const result = await read();
    expect(result).toMatchObject({
      status: 'captured', rejected: 2, dropped: 0,
      events: [
        { event: 'progress', stage: 'engine-started', attempt: 1 },
        { event: 'engine-result', exitCode: 24 },
        { event: 'operation-error', operation: 'output-write', category: 'read-only-filesystem', errno: 30 },
        { event: 'failure', category: 'engine-failed' },
      ],
      failure: { event: 'operation-error', operation: 'output-write' },
      resources: { stage: 'after-engine', memory: { peakBytes: 1234, oom_kill: 1 },
        filesystems: [{ path: 'shared-memory', capacityBytes: 2048, availableBytes: 0 }] },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    await fs.rm(runtime, { recursive: true });
    expect(result.lastEvent).toEqual({ event: 'failure', category: 'engine-failed' });
  });

  it('bounds events while retaining the first failure and last milestone independently', async () => {
    await write([
      ...Array.from({ length: 200 }, () => ({ event: 'progress', stage: 'engine-launch-attempt' })),
      { event: 'failure', category: 'deadline-exceeded' },
      { event: 'progress', stage: 'engine-completed', exitCode: -9, runtimeMs: 1000 },
    ]);
    const result = await read();
    expect(result.events).toHaveLength(32);
    expect(result.dropped).toBe(170);
    expect(result.failure).toEqual({ event: 'failure', category: 'deadline-exceeded' });
    expect(result.lastEvent).toMatchObject({ stage: 'engine-completed', exitCode: -9 });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192);
  });

  it('retains exact late file failures and output metadata independently of the event cap', async () => {
    await write([
      { event: 'operation-error', operation: 'resource-memory.peak-read-open',
        category: 'not-found', errno: 2, fatal: false },
      ...Array.from({ length: 40 }, () => ({ event: 'progress', stage: 'engine-started' })),
      { event: 'output-snapshot', stage: 'after-engine', uid: 65534, gid: 65534,
        paths: [
          { path: 'output-parent', type: 'directory', uid: 0, gid: 0, mode: 0o755, writable: false },
          { path: 'output-file', type: 'file', uid: 65534, gid: 65534, mode: 0o600,
            readable: true, writable: true, size: 'empty', bytes: 123, raw: 'PRIVATE_RESULT' },
          { path: 'PRIVATE_PATH', type: 'file', uid: 123, gid: 456, mode: 0o777 },
        ] },
      { event: 'operation-error', operation: 'output-read-open', category: 'permission-denied',
        errno: 13, fatal: true, strerror: 'PRIVATE_ERROR', filename: 'PRIVATE_PATH' },
      { event: 'failure', category: 'result-read-failed' },
    ]);
    const result = await read();
    expect(result.events).toHaveLength(32);
    expect(result.failure).toEqual({
      event: 'operation-error', operation: 'output-read-open',
      category: 'permission-denied', errno: 13, fatal: true,
    });
    expect(result.operationErrors).toHaveLength(2);
    expect(result.lastEvent).toEqual({ event: 'failure', category: 'result-read-failed' });
    expect(result.output).toEqual({
      stage: 'after-engine', uid: 65534, gid: 65534,
      paths: [
        { path: 'output-parent', type: 'directory', uid: 0, gid: 0, mode: 0o755, writable: false },
        { path: 'output-file', type: 'file', uid: 65534, gid: 65534, mode: 0o600,
          readable: true, writable: true, size: 'empty' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192);
  });

  it('bounds file-error retention and rejects arbitrary operations, identities, modes and output sizes', async () => {
    await write([
      ...Array.from({ length: 40 }, () => ({
        event: 'operation-error', operation: 'output-write-close', category: 'no-space', errno: 28,
      })),
      { event: 'operation-error', operation: 'PRIVATE_PATH', category: 'no-space' },
      { event: 'output-snapshot', stage: 'after-engine', uid: 123, gid: 'PRIVATE_GID',
        paths: [{ path: 'output-file', type: 'file', uid: 123, gid: 'PRIVATE_GID',
          mode: 0o10000, size: 'PRIVATE_SIZE', raw: 'PRIVATE_RESULT' }] },
    ]);
    const result = await read();
    expect(result.operationErrors).toHaveLength(16);
    expect(result.output).toEqual({
      stage: 'after-engine', uid: 'other', gid: 'other',
      paths: [{ path: 'output-file', type: 'file', uid: 'other', gid: 'other' }],
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it('retains bounded probe and actual-read observations beyond the event cap without guest text', async () => {
    await write([
      ...Array.from({ length: 40 }, () => ({ event: 'progress', stage: 'engine-started' })),
      { event: 'storage-probe', status: 'captured', path: 'PRIVATE_PATH', milestones: [
        { stage: 'started', text: 'PRIVATE_PROBE' },
        { stage: 'storage-complete', enospcObserved: true, result: 'PRIVATE_RESULT' },
        { stage: 'cleanup-complete', probeFilesRemoved: true },
        { stage: 'output-write-complete' },
      ] },
      { event: 'output-normalization', inputState: 'empty', stdoutState: 'present',
        stdout: 'PRIVATE_STDOUT', hash: 'PRIVATE_HASH', bytes: 123 },
      { event: 'failure', category: 'result-empty' },
    ]);
    const result = await read();
    expect(result.events).toHaveLength(32);
    expect(result.storageProbe).toEqual({ status: 'captured', milestones: [
      { stage: 'started' },
      { stage: 'storage-complete', enospcObserved: true },
      { stage: 'cleanup-complete', probeFilesRemoved: true },
      { stage: 'output-write-complete' },
    ] });
    expect(result.normalization).toEqual({ inputState: 'empty', stdoutState: 'present' });
    expect(result.failure).toEqual({ event: 'failure', category: 'result-empty' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192);
  });

  it.each([
    [{ stage: 'PRIVATE_STAGE' }],
    [{ stage: 'started', enospcObserved: 'PRIVATE_FLAG' }],
    Array.from({ length: 17 }, () => ({ stage: 'started' })),
    [],
  ].map(milestones => [milestones]))('rejects invalid or excessive marker observations', async milestones => {
    await write([{ event: 'storage-probe', status: 'captured', milestones }]);
    const result = await read();
    expect(result.storageProbe).toEqual({ status: 'invalid', milestones: [] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it('drops unrecognized marker/read states and does not turn unavailable evidence into progress', async () => {
    await write([
      { event: 'storage-probe', status: 'PRIVATE_STATUS', milestones: [{ stage: 'started' }] },
      { event: 'output-normalization', inputState: 'PRIVATE_STATE', stdoutState: 'present' },
      { event: 'output-normalization', inputState: 'empty', stdoutState: 'PRIVATE_STDOUT' },
    ]);
    const result = await read();
    expect(result.storageProbe).toBeUndefined();
    expect(result.normalization).toBeUndefined();
    expect(result.rejected).toBe(3);
    await write([{ event: 'storage-probe', status: 'missing', milestones: [{ stage: 'output-write-complete' }] }]);
    expect((await read()).storageProbe).toEqual({ status: 'missing', milestones: [] });
  });

  it('retains both verification checkpoints and probe read-back evidence beyond the event cap', async () => {
    await write([
      ...Array.from({ length: 40 }, () => ({ event: 'progress', stage: 'engine-started' })),
      { event: 'output-verification', stage: 'before-engine', symlink: true, targetMatches: true,
        sameFile: true, directReadable: true, aliasReadable: true, contentsMatch: true,
        directState: 'empty', aliasState: 'empty', target: 'PRIVATE_TARGET', inode: 123 },
      { event: 'storage-probe', status: 'captured', milestones: [
        { stage: 'output-check-failed', operation: 'alias-read', errno: 5, error: 'PRIVATE_ERROR' },
        { stage: 'output-verified', symlink: true, targetMatches: true, sameFile: true,
          directReadable: true, aliasReadable: false, directMatchesExpected: true, aliasMatchesExpected: false,
          contents: 'PRIVATE_RESULT', hash: 'PRIVATE_HASH' },
      ] },
      { event: 'output-verification', stage: 'after-engine', symlink: true, targetMatches: false,
        sameFile: false, contentsMatch: false, directState: 'within-limit', aliasState: 'empty',
        directReadable: true, aliasReadable: true, bytes: 123, target: 'PRIVATE_TARGET' },
      { event: 'operation-error', operation: 'verify-output-alias-read', category: 'io-error',
        errno: 5, fatal: false, message: 'PRIVATE_ERROR' },
    ]);
    const result = await read();
    expect(result.events).toHaveLength(32);
    expect(result.outputVerification).toEqual([
      { stage: 'before-engine', symlink: true, targetMatches: true, sameFile: true,
        contentsMatch: true, directReadable: true, aliasReadable: true, directState: 'empty', aliasState: 'empty' },
      { stage: 'after-engine', symlink: true, targetMatches: false, sameFile: false,
        contentsMatch: false, directReadable: true, aliasReadable: true,
        directState: 'within-limit', aliasState: 'empty' },
    ]);
    expect(result.storageProbe).toEqual({ status: 'captured', milestones: [
      { stage: 'output-check-failed', operation: 'alias-read', errno: 5 },
      { stage: 'output-verified', symlink: true, targetMatches: true, sameFile: true,
        directReadable: true, aliasReadable: false, directMatchesExpected: true, aliasMatchesExpected: false },
    ] });
    expect(result.operationErrors).toContainEqual({
      event: 'operation-error', operation: 'verify-output-alias-read', category: 'io-error', errno: 5, fatal: false,
    });
    expect(result.failure).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  it('bounds repeated verification stages and drops malformed fields and stages', async () => {
    await write([
      ...Array.from({ length: 100 }, () => ({ event: 'output-verification', stage: 'before-engine', symlink: false })),
      { event: 'output-verification', stage: 'after-engine', symlink: 'PRIVATE_FLAG',
        targetMatches: {}, directState: 'PRIVATE_STATE', aliasState: 'unavailable' },
      { event: 'output-verification', stage: 'PRIVATE_STAGE', contentsMatch: true },
    ]);
    const result = await read();
    expect(result.outputVerification).toEqual([
      { stage: 'before-engine', symlink: false },
      { stage: 'after-engine', aliasState: 'unavailable' },
    ]);
    expect(result.rejected).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    for (const milestone of [
      { stage: 'output-check-failed', operation: {} },
      { stage: 'output-check-failed', operation: 'PRIVATE_OPERATION' },
      { stage: 'output-check-failed', errno: true },
      { stage: 'output-verified', sameFile: 'PRIVATE_FLAG' },
    ]) {
      await write([{ event: 'storage-probe', status: 'captured', milestones: [milestone] }]);
      expect((await read()).storageProbe).toEqual({ status: 'invalid', milestones: [] });
    }
  });

  it('hands stopped public-session text only to the protected sink, not the audit projection', async () => {
    await write([
      { event: 'engine-result', exitCode: 1, stderr: { raw: 'PUBLIC_ENGINE_FAILURE' } },
      { event: 'engine-diagnostics', files: [{ raw: 'PUBLIC_COPILOT_DIAGNOSTICS' }] },
      { event: 'failure', category: 'engine-failed' },
    ]);
    const retain = jest.fn().mockResolvedValue(undefined);
    const result = await readEnclaveSessionDiagnostics(directory, uid, gid, retain);
    expect(retain).toHaveBeenCalledWith(expect.stringContaining('PUBLIC_ENGINE_FAILURE'));
    expect(retain).toHaveBeenCalledWith(expect.stringContaining('PUBLIC_COPILOT_DIAGNOSTICS'));
    expect(JSON.stringify(result)).not.toMatch(/PUBLIC_/);
    expect(result.failure).toEqual({ event: 'failure', category: 'engine-failed' });
    await fs.rm(runtime, { recursive: true });
    expect(retain.mock.calls[0][0]).toContain('PUBLIC_COPILOT_DIAGNOSTICS');
  });

  it('does not send missing, oversized, or unsafe sessions to the public sink', async () => {
    const retain = jest.fn();
    const publicRead = () => readEnclaveSessionDiagnostics(directory, uid, gid, retain);
    await expect(publicRead()).resolves.toEqual({ status: 'missing' });
    await write([{ event: 'success' }]);
    await fs.truncate(file, 1024 * 1024 + 1);
    await expect(publicRead()).resolves.toEqual({ status: 'oversized' });
    await fs.chmod(file, 0o644);
    await expect(publicRead()).resolves.toEqual({ status: 'unsafe' });
    expect(retain).not.toHaveBeenCalled();
  });

  it('propagates retention failure so the executor cannot destroy the only remaining session', async () => {
    await write([{ event: 'success' }]);
    const retain = jest.fn().mockRejectedValue(new Error('protected write failed'));
    await expect(readEnclaveSessionDiagnostics(directory, uid, gid, retain))
      .rejects.toThrow('protected write failed');
    await expect(fs.stat(file)).resolves.toBeDefined();
  });

  it('distinguishes missing, empty, invalid and oversized evidence', async () => {
    await expect(read()).resolves.toEqual({ status: 'missing' });
    await fs.writeFile(file, '', { mode: 0o600 });
    await expect(read()).resolves.toEqual({ status: 'empty', bytes: 0 });
    await fs.writeFile(file, Buffer.from([0xff]));
    await expect(read()).resolves.toMatchObject({ status: 'invalid' });
    await fs.writeFile(file, '{"event":"progress","stage":"engine-started"}\nPRIVATE_INVALID\n');
    await expect(read()).resolves.toMatchObject({ status: 'captured', rejected: 1 });
    await fs.truncate(file, 1024 * 1024 + 1);
    await expect(read()).resolves.toEqual({ status: 'oversized' });
  });

  it('rejects symlinked files and runtime directories, hardlinks and unsafe modes or owners', async () => {
    await fs.writeFile(path.join(directory, 'secret'), 'PRIVATE_SECRET', { mode: 0o600 });
    await fs.symlink('../secret', file);
    await expect(read()).resolves.toEqual({ status: 'unsafe' });
    await fs.unlink(file);
    await fs.link(path.join(directory, 'secret'), file);
    await expect(read()).resolves.toEqual({ status: 'unsafe' });
    await fs.unlink(file);
    await write([{ event: 'success' }]);
    await fs.chmod(file, 0o644);
    await expect(read()).resolves.toEqual({ status: 'unsafe' });
    await fs.chmod(file, 0o600);
    await expect(readEnclaveSessionDiagnostics(directory, uid + 1, gid)).resolves.toEqual({ status: 'unsafe' });
    await fs.rename(runtime, path.join(directory, 'elsewhere'));
    await fs.symlink('elsewhere', runtime);
    await expect(read()).resolves.toEqual({ status: 'unsafe' });
  });
});
