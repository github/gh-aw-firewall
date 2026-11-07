import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { projectEnclaveSessionDiagnostics } from '../cloud-hypervisor/enclave-session-diagnostics';
import {
  PUBLIC_ENCLAVE_CAPTURE_BYTES, preservePublicEnclaveArtifacts, readPublicEnclaveFile,
  type PublicEnclaveStream,
} from './public-debug-artifacts';
import {
  projectPublicEnclaveEntrypointEvent, projectPublicEnclaveOperationEvent, PublicEnclaveOperationRecorder,
} from './public-debug-events';

describe('common public enclave entrypoint evidence', () => {
  let directory: string;
  const uid = process.getuid!();
  const gid = process.getgid!();
  const missing: PublicEnclaveStream = { status: 'missing' };
  const error = {
    event: 'operation-error', operation: 'preflight-session-log',
    category: 'permission-denied', errno: 13,
  };
  const failure = {
    stage: 'entrypoint-initialization', status: 'failed', category: 'permission-denied', errno: 13,
    operation: 'preflight-session-log',
  };
  const stream = (value: unknown): PublicEnclaveStream => ({
    status: 'captured', contents: Buffer.from(`${JSON.stringify(value)}\n`),
  });
  const project = (stderr: PublicEnclaveStream, sessionMetadata?: ReturnType<typeof projectEnclaveSessionDiagnostics>) =>
    projectPublicEnclaveEntrypointEvent({ stderr, session: missing, sessionMetadata, secrets: [] });

  beforeEach(async () => {
    directory = path.join(process.cwd(), `.public-enclave-events-${randomBytes(8).toString('hex')}`);
    await fs.mkdir(directory, { mode: 0o700 });
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it.each(['docker', 'cloud-hypervisor'] as const)('retains a missing transcript and redacted fallback failure for %s', async runtime => {
    const secret = 'synthetic-capability:"quoted"/value';
    const forms = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')];
    await fs.writeFile(path.join(directory, 'stderr.log'), `${JSON.stringify({
      ...error, path: '/private/repository/session.jsonl', text: forms.join('\n'),
      nested: JSON.stringify({ authorization: '******', capability: secret }),
      token: `ghs_${'b'.repeat(40)}`,
    })}\n`, { mode: 0o600 });
    const [stderr, session] = await Promise.all([
      readPublicEnclaveFile(directory, 'stderr.log', uid, gid),
      readPublicEnclaveFile(directory, 'session.jsonl', uid, gid),
    ]);
    expect(stderr.status).toBe('captured');
    expect(session).toEqual(missing);
    const sessionMetadata = { status: 'missing' as const };
    const recorder = new PublicEnclaveOperationRecorder();
    recorder.fail('workload-exit', undefined, false, 'workload-exit');
    recorder.record(projectPublicEnclaveEntrypointEvent({ stderr, session, sessionMetadata, secrets: [secret] }));
    expect(recorder.snapshot().stages).toContainEqual(failure);
    expect(recorder.primaryFailure).toEqual({
      stage: 'entrypoint-initialization', category: 'permission-denied', errno: 13, operation: 'preflight-session-log',
    });
    const destination = path.join(directory, 'retained');
    await preservePublicEnclaveArtifacts({
      directory: destination, protectedRoot: directory, owner: { uid, gid },
      dependencies: { ...fs, resolveIdentity: () => ({ uid, gid }) },
      envelope: {
        version: 1, runId: 'a'.repeat(32), invocationId: 'b'.repeat(32), entryId: 'public-agent',
        executorKind: 'agent', runtime, stage: 'execution', failure: 'workload-exit',
        workloadStopped: true, exitCode: 1, ...recorder.snapshot(),
      },
      stdout: { status: 'missing' }, stderr, session, sessionMetadata, secrets: [secret],
    });
    const diagnosticsText = await fs.readFile(path.join(destination, 'diagnostics.json'), 'utf8');
    const diagnostics = JSON.parse(diagnosticsText);
    expect(diagnostics).toMatchObject({
      exitCode: 1, failure: 'workload-exit', primaryFailure: failure,
      session: { status: 'missing' }, streams: { session: 'missing', stderr: 'captured' },
    });
    expect(diagnostics.stages).toContainEqual(failure);
    expect(diagnosticsText).not.toContain('/private/repository');
    const retained = await fs.readFile(path.join(destination, 'stderr.log'), 'utf8');
    expect(retained).toContain('[REDACTED]');
    for (const value of [...forms, 'synthetic-header-value', `ghs_${'b'.repeat(40)}`]) {
      expect(retained + diagnosticsText).not.toContain(value);
    }
    expect(await fs.readFile(path.join(destination, 'enclave-session.log'), 'utf8')).toBe('');
  });

  it('projects stderr only after redaction, without promoting credential-shaped operation fields', () => {
    expect(projectPublicEnclaveEntrypointEvent({
      session: missing, sessionMetadata: { status: 'missing' }, stderr: stream(error), secrets: ['permission-denied'],
    })).toEqual({ stage: 'entrypoint-initialization', status: 'unavailable' });
  });

  it.each(['missing', 'unsafe', 'read-failed', 'oversized'] as const)(
    'retains %s metadata without implying a captured transcript artifact', async status => {
      const destination = path.join(directory, 'retained');
      await preservePublicEnclaveArtifacts({
        directory: destination, protectedRoot: directory, owner: { uid, gid },
        dependencies: { ...fs, resolveIdentity: () => ({ uid, gid }) },
        envelope: {
          version: 1, runId: 'a'.repeat(32), invocationId: 'b'.repeat(32), entryId: 'public-agent',
          executorKind: 'agent', runtime: 'cloud-hypervisor', stage: 'execution', failure: 'workload-exit',
          workloadStopped: true, exitCode: 1,
        },
        stdout: missing, stderr: missing, session: { status }, sessionMetadata: { status }, secrets: [],
      });
      expect(await fs.readFile(path.join(destination, 'enclave-session.log'), 'utf8')).toBe('');
      expect(JSON.parse(await fs.readFile(path.join(destination, 'diagnostics.json'), 'utf8')))
        .toMatchObject({ session: { status }, streams: { session: status } });
    },
  );

  it.each(['missing', 'empty', 'unsafe', 'oversized', 'read-failed', 'invalid'] as const)(
    'does not let %s transcript metadata hide bounded fallback evidence', status => {
      expect(project(stream(error), { status })).toEqual(failure);
    },
  );

  it('uses the independent operation-error summary when the session event bound was exhausted', () => {
    const session = projectEnclaveSessionDiagnostics(Buffer.from([
      ...Array.from({ length: 40 }, () => '{"event":"progress","stage":"engine-started"}'),
      JSON.stringify(error), '',
    ].join('\n')));
    expect(session.events).toHaveLength(32);
    expect(project(missing, session)).toEqual(failure);
  });

  it.each([
    { ...error, fatal: false },
    { ...error, operation: 'output-read' },
    { ...error, operation: 'PRIVATE_OPERATION' },
    { ...error, category: 'PRIVATE_CATEGORY' },
  ])('does not turn irrelevant or rejected operation evidence into initialization failure: %j', value => {
    expect(project(stream(value))).toEqual({ stage: 'entrypoint-initialization', status: 'unavailable' });
  });

  it('marks success only from positive initialization evidence and prefers a failure to progress', () => {
    const progress = { event: 'progress', stage: 'engine-started' };
    expect(project(stream(progress))).toEqual({ stage: 'entrypoint-initialization', status: 'succeeded' });
    expect(project(missing)).toEqual({ stage: 'entrypoint-initialization', status: 'unavailable' });
    expect(project({ status: 'captured', contents: Buffer.from(`${JSON.stringify(progress)}\n${JSON.stringify(error)}\n`) }))
      .toEqual(failure);
    expect(project({ status: 'captured', contents: Buffer.alloc(0) }))
      .toEqual({ stage: 'entrypoint-initialization', status: 'unavailable' });
  });

  it.each(['missing', 'unsafe', 'oversized', 'read-failed', 'not-applicable', 'unavailable'] as const)(
    'ignores contents from a %s fallback stream', status => {
      expect(project({ status, contents: stream(error).contents }))
        .toEqual({ stage: 'entrypoint-initialization', status: 'unavailable' });
    },
  );

  it('does not project oversized or invalid UTF-8 fallback bytes, or retain an unapproved errno', () => {
    expect(project({ status: 'captured', contents: Buffer.alloc(PUBLIC_ENCLAVE_CAPTURE_BYTES + 1) }))
      .toEqual({ stage: 'entrypoint-initialization', status: 'unavailable' });
    expect(project({ status: 'captured', contents: Buffer.concat([stream(error).contents!, Buffer.from([0xff])]) }))
      .toEqual({ stage: 'entrypoint-initialization', status: 'unavailable' });
    expect(project(stream({ ...error, errno: 999 }))).toEqual({
      stage: 'entrypoint-initialization', status: 'failed', category: 'permission-denied',
      operation: 'preflight-session-log',
    });
  });

  it.each(['symlink', 'hardlink', 'wrong-mode', 'wrong-directory-mode', 'wrong-uid', 'wrong-gid', 'oversized'] as const)(
    'fails closed before projecting a %s workload stderr file', async kind => {
      const file = path.join(directory, 'stderr.log');
      await fs.writeFile(file, `${JSON.stringify(error)}\n`, { mode: 0o600 });
      if (kind === 'symlink') {
        await fs.rename(file, path.join(directory, 'target'));
        await fs.symlink(path.join(directory, 'target'), file);
      }
      if (kind === 'hardlink') await fs.link(file, path.join(directory, 'alias'));
      if (kind === 'wrong-mode') await fs.chmod(file, 0o644);
      if (kind === 'wrong-directory-mode') await fs.chmod(directory, 0o755);
      if (kind === 'oversized') await fs.truncate(file, PUBLIC_ENCLAVE_CAPTURE_BYTES + 1);
      const stderr = await readPublicEnclaveFile(directory, 'stderr.log',
        kind === 'wrong-uid' ? uid + 1 : uid, kind === 'wrong-gid' ? gid + 1 : gid);
      expect(stderr).toEqual({ status: kind === 'oversized' ? 'oversized' : 'unsafe' });
      expect(project(stderr, { status: 'missing' }))
        .toEqual({ stage: 'entrypoint-initialization', status: 'unavailable' });
    },
  );

  it('keeps a host setup exception primary while retaining the separate entrypoint failure', () => {
    const recorder = new PublicEnclaveOperationRecorder();
    recorder.fail('workload-start', Object.assign(new Error('PRIVATE_EXCEPTION'), { code: 'EPERM' }));
    recorder.record(project(stream(error)));
    expect(recorder.primaryFailure).toEqual({
      stage: 'workload-start', category: 'operation-not-permitted', errno: 1,
    });
    expect(recorder.snapshot().stages).toContainEqual(failure);
    expect(JSON.stringify(recorder.snapshot())).not.toContain('PRIVATE_EXCEPTION');
  });

  it('retains late entrypoint fallback evidence even when the host stage bound is exhausted', () => {
    const recorder = new PublicEnclaveOperationRecorder();
    for (let index = 0; index < 80; index++) recorder.event('cleanup', 'started');
    recorder.record(project(stream(error)));
    expect(recorder.snapshot().stages).toContainEqual(failure);
    expect(recorder.snapshot().stages).not.toContainEqual({
      stage: 'entrypoint-initialization', status: 'unavailable',
    });
    expect(recorder.snapshot().stages.length).toBeLessThanOrEqual(64);
  });

  it('rejects non-allowlisted operations or operations attached to unrelated stages', () => {
    expect(() => projectPublicEnclaveOperationEvent({
      stage: 'entrypoint-initialization', status: 'failed', operation: 'preflight-PRIVATE_PATH',
    })).toThrow('Invalid public enclave operation evidence');
    expect(() => projectPublicEnclaveOperationEvent({
      stage: 'cleanup', status: 'failed', operation: 'preflight-session-log',
    })).toThrow('Invalid public enclave operation evidence');
  });
});
