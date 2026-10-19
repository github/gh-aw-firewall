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
