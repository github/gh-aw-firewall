import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  PUBLIC_ENCLAVE_ARTIFACT_NAMES, PUBLIC_ENCLAVE_CAPTURE_BYTES,
  preservePublicEnclaveArtifacts, readPublicEnclaveFile, redactPublicEnclaveText,
  type PublicEnclaveArtifactEnvelope,
} from './public-debug-artifacts';
import { BoundedOutputCapture } from '../cloud-hypervisor/diagnostics';
import { PublicEnclaveOperationRecorder, projectPublicEnclaveOperationEvent } from './public-debug-events';

describe('shared public enclave diagnostic conformance', () => {
  let root: string;
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const dependencies = { ...fs.promises, resolveIdentity: () => ({ uid, gid }) };
  function readArtifact(file: string): { contents: string; metadata: fs.Stats } {
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const metadata = fs.fstatSync(descriptor);
      return { contents: fs.readFileSync(descriptor, 'utf8'), metadata };
    } finally {
      fs.closeSync(descriptor);
    }
  }
  beforeEach(() => {
    root = path.join(process.cwd(), `.public-enclave-artifacts-${randomBytes(8).toString('hex')}`);
    fs.mkdirSync(root, { mode: 0o700 });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const envelope = (runtime: 'docker' | 'cloud-hypervisor'): PublicEnclaveArtifactEnvelope => ({
    version: 1, runId: 'a'.repeat(32), invocationId: 'b'.repeat(32), entryId: 'agent',
    executorKind: 'agent', runtime, stage: 'execution', failure: 'execution-exception',
    exitCode: null, workloadStopped: true,
  });
  function options(runtime: 'docker' | 'cloud-hypervisor') {
    return {
      directory: path.join(root, 'artifacts', runtime), protectedRoot: root,
      envelope: envelope(runtime), owner: { uid, gid }, dependencies,
      stdout: { status: 'captured' as const, contents: Buffer.from('public stdout PRIVATE_SECRET\n') },
      stderr: { status: 'captured' as const, contents: Buffer.from('Authorization: ******') },
      session: { status: 'captured' as const, contents: Buffer.from(
        '{"event":"progress","stage":"engine-started","private":"PRIVATE_SECRET"}\n'
        + '{"event":"failure","category":"engine-failed","text":"PRIVATE_SECRET"}\n') },
      secrets: ['PRIVATE_SECRET'],
    };
  }
  it.each(['docker', 'cloud-hypervisor'] as const)('retains the same bounded redacted envelope for %s', async runtime => {
    const input = options(runtime);
    await preservePublicEnclaveArtifacts(input);
    expect(fs.readdirSync(input.directory).sort()).toEqual([...PUBLIC_ENCLAVE_ARTIFACT_NAMES].sort());
    for (const name of PUBLIC_ENCLAVE_ARTIFACT_NAMES) {
      const file = path.join(input.directory, name);
      const { contents, metadata } = readArtifact(file);
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(metadata.uid).toBe(uid);
      expect(contents).not.toContain('PRIVATE_SECRET');
      expect(metadata.size).toBeLessThanOrEqual(PUBLIC_ENCLAVE_CAPTURE_BYTES);
    }
    const projection = JSON.parse(fs.readFileSync(path.join(input.directory, 'diagnostics.json'), 'utf8'));
    expect(projection).toMatchObject({
      ...envelope(runtime), session: {
        status: 'captured', failure: { event: 'failure', category: 'engine-failed' },
      },
      backendEvidence: {
        dockerInspect: { status: runtime === 'docker' ? 'unavailable' : 'not-applicable' },
        vmCounters: { status: runtime === 'cloud-hypervisor' ? 'unavailable' : 'not-applicable' },
      },
    });
    expect(projection.session.events[0]).not.toHaveProperty('private');
  });
  it('supports safe retry after retention failed without treating the exception as a workload exit', async () => {
    const input = options('docker');
    const realOpen = dependencies.open;
    let fail = true;
    const failing = { ...dependencies, open: jest.fn(async (...args: Parameters<typeof realOpen>) => {
      if (fail && String(args[0]).endsWith('diagnostics.json')) throw new Error('disk-full');
      return realOpen(...args);
    }) };
    await expect(preservePublicEnclaveArtifacts({ ...input, dependencies: failing })).rejects.toThrow('disk-full');
    fail = false;
    await preservePublicEnclaveArtifacts({ ...input, dependencies: failing });
    expect(JSON.parse(fs.readFileSync(path.join(input.directory, 'diagnostics.json'), 'utf8')).exitCode).toBeNull();
  });
  it.each(['symlink', 'hardlink', 'wrong-mode', 'oversized'] as const)('rejects unsafe or bounded-out %s sources', async kind => {
    const file = path.join(root, 'stdout.log');
    fs.writeFileSync(file, 'safe', { mode: 0o600 });
    if (kind === 'symlink') {
      fs.renameSync(file, path.join(root, 'target'));
      fs.symlinkSync(path.join(root, 'target'), file);
    }
    if (kind === 'hardlink') fs.linkSync(file, path.join(root, 'alias'));
    if (kind === 'wrong-mode') fs.chmodSync(file, 0o644);
    if (kind === 'oversized') fs.truncateSync(file, PUBLIC_ENCLAVE_CAPTURE_BYTES + 1);
    expect(await readPublicEnclaveFile(root, 'stdout.log', uid, gid))
      .toEqual({ status: kind === 'oversized' ? 'oversized' : 'unsafe' });
  });
  it('rejects unsafe destination links and preserves the linked target', async () => {
    const input = options('docker');
    fs.mkdirSync(input.directory, { recursive: true, mode: 0o700 });
    const target = path.join(root, 'credential');
    fs.writeFileSync(target, 'DO_NOT_TOUCH', { mode: 0o600 });
    fs.symlinkSync(target, path.join(input.directory, 'stdout.log'));
    await expect(preservePublicEnclaveArtifacts(input)).rejects.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('DO_NOT_TOUCH');
    await expect(preservePublicEnclaveArtifacts({ ...input, directory: root })).rejects.toThrow(/below/);
  });
  it('rejects destination symlink ancestors before creating any artifact', async () => {
    const target = path.join(root, 'target');
    fs.mkdirSync(target, { mode: 0o700 });
    const alias = path.join(root, 'alias');
    fs.symlinkSync(target, alias);
    await expect(preservePublicEnclaveArtifacts({
      ...options('docker'), directory: path.join(alias, 'artifacts'),
    })).rejects.toThrow(/ancestor/);
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it('rejects non-fixed evidence and absent stop proof before writing', async () => {
    const input = options('docker');
    await expect(preservePublicEnclaveArtifacts({
      ...input, envelope: { ...input.envelope, stage: 'PRIVATE_SECRET' as never },
    })).rejects.toThrow(/identity or stop proof/);
    await expect(preservePublicEnclaveArtifacts({
      ...input, envelope: { ...input.envelope, workloadStopped: false as never },
    })).rejects.toThrow(/identity or stop proof/);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('redacts encoded credentials inside JSON session strings without invalidating records', () => {
    const secret = 'synthetic-token:"quoted"/value';
    const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')];
    const record = {
      event: 'engine-result', stdout: { raw: forms.join('\n') },
      stderr: { raw: `Authorization: ${'Bearer'} synthetic-auth-value\n` },
      nested: [{ [secret]: secret }],
    };
    const retained = redactPublicEnclaveText(Buffer.from(`${JSON.stringify(record)}\n`), [secret]);
    const decoded = JSON.parse(retained.toString());
    expect(decoded).toMatchObject({
      event: 'engine-result', stdout: { raw: '[REDACTED]\n[REDACTED]\n[REDACTED]\n[REDACTED]' },
      stderr: { raw: 'Authorization: [REDACTED]\n' },
      nested: [{ '[REDACTED]': '[REDACTED]' }],
    });
    for (const form of forms) expect(JSON.stringify(decoded)).not.toContain(form);
    expect(retained.toString()).not.toContain('synthetic-auth-value');
  });

  it('redacts nested JSON strings, quoted headers, and Authorization fields', () => {
    const secret = 'synthetic-token:"quoted"/value';
    const message = JSON.stringify(secret).slice(1, -1);
    const record = {
      raw: `${JSON.stringify({ message })}\n${JSON.stringify({ message })}`,
      pretty: JSON.stringify({ message }, null, 2),
      quoted: `Authorization: ${'Bearer'} "synthetic-auth-value"\n`,
      authorization: '"synthetic-auth-value"',
      'Proxy-Authorization': { value: 'synthetic-auth-value' },
    };
    const decoded = JSON.parse(redactPublicEnclaveText(Buffer.from(JSON.stringify(record)), [secret]).toString());
    for (const line of decoded.raw.split('\n')) {
      expect(JSON.parse(line)).toEqual({ message: '[REDACTED]' });
    }
    expect(JSON.parse(decoded.pretty)).toEqual({ message: '[REDACTED]' });
    expect(decoded.quoted).toBe('Authorization: [REDACTED]\n');
    expect(decoded.authorization).toBe('[REDACTED]');
    expect(decoded['Proxy-Authorization']).toBe('[REDACTED]');
    expect(JSON.stringify(decoded)).not.toContain('synthetic-auth-value');
    let nested: unknown = secret;
    for (let depth = 0; depth < 70; depth++) nested = { nested };
    expect(redactPublicEnclaveText(Buffer.from(JSON.stringify(nested)), [secret]).toString()).not.toContain('synthetic-token');
  });

  it('redacts credentials, escaped/encoded forms, and partial over-limit boundary lines', () => {
    const secret = 'secret"credential';
    const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')];
    const raw = forms.join('\n') + '\nghp_secretcredential\nsk-secretcredential\nBearer hidden\n';
    const redacted = redactPublicEnclaveText(Buffer.from(raw), [secret]).toString();
    for (const form of forms) expect(redacted).not.toContain(form);
    expect(redacted).not.toContain('hidden');
    expect(redactPublicEnclaveText(Buffer.from('x'.repeat(PUBLIC_ENCLAVE_CAPTURE_BYTES + 1)), [])).toHaveLength(0);
    const capture = new BoundedOutputCapture(8);
    capture.append('PRIVATE_SECRET');
    expect(capture.publicContents()).toHaveLength(0);
    capture.append('\nokay\n');
    expect(capture.publicContents().toString()).toBe('okay\n');
  });
  it('marks unavailable and not-applicable evidence explicitly without raw contents', async () => {
    const input = options('docker');
    await preservePublicEnclaveArtifacts({
      ...input, stdout: { status: 'unavailable' }, stderr: { status: 'missing' },
      session: { status: 'not-applicable' },
    });
    expect(fs.readFileSync(path.join(input.directory, 'enclave-session.log'), 'utf8')).toBe('');
    expect(JSON.parse(fs.readFileSync(path.join(input.directory, 'diagnostics.json'), 'utf8')).streams)
      .toEqual({ stdout: 'unavailable', stderr: 'missing', session: 'not-applicable' });
  });
  it('separates fixed primary and cleanup failures, projects errno, and bounds stages', async () => {
    const operations = new PublicEnclaveOperationRecorder();
    await expect(operations.check('authority-handoff', () => {
      throw Object.assign(new Error('PRIVATE_SECRET'), { code: 'EACCES' });
    })).rejects.toThrow('PRIVATE_SECRET');
    await expect(operations.check('cleanup', () => {
      throw Object.assign(new Error('PRIVATE_SECRET'), { code: 'ENOSPC' });
    }, true)).rejects.toThrow('PRIVATE_SECRET');
    for (let index = 0; index < 100; index++) operations.event('workload-start', 'started');
    const input = options('docker');
    await preservePublicEnclaveArtifacts({
      ...input, envelope: { ...input.envelope, ...operations.snapshot(),
        dockerState: { running: false, exitCode: 7, oomKilled: false } },
    });
    const evidence = JSON.parse(fs.readFileSync(path.join(input.directory, 'diagnostics.json'), 'utf8'));
    expect(evidence.primaryFailure).toMatchObject({ stage: 'authority-handoff', category: 'permission-denied', errno: 13 });
    expect(evidence.cleanupFailure).toMatchObject({ stage: 'cleanup', category: 'no-space', errno: 28 });
    expect(evidence.backendEvidence.dockerInspect).toEqual({ status: 'captured', running: false, exitCode: 7, oomKilled: false });
    expect(evidence.stages.length).toBeLessThanOrEqual(64);
    expect(() => projectPublicEnclaveOperationEvent({
      stage: 'cleanup', status: 'failed', errno: 1234,
    })).toThrow(/operation evidence/);
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_SECRET');
  });
  it.each(['docker', 'cloud-hypervisor'] as const)('uses covered %s session streams with explicit source coverage', async runtime => {
    const input = options(runtime);
    await preservePublicEnclaveArtifacts({
      ...input, stdout: { status: 'unavailable' }, stderr: { status: 'captured', contents: Buffer.alloc(0) },
      session: { status: 'captured', contents: Buffer.from(JSON.stringify({
        event: 'engine-result', exitCode: 7,
        stdout: { raw: 'covered stdout PRIVATE_SECRET' }, stderr: { raw: 'covered stderr PRIVATE_SECRET' },
      }) + '\n' + JSON.stringify({ event: 'engine-diagnostics', log: { raw: 'covered Copilot PRIVATE_SECRET' } }) + '\n') },
    });
    expect(fs.readFileSync(path.join(input.directory, 'stdout.log'), 'utf8')).toContain('covered stdout');
    expect(fs.readFileSync(path.join(input.directory, 'stderr.log'), 'utf8')).toContain('covered stderr');
    expect(fs.readFileSync(path.join(input.directory, 'enclave-session.log'), 'utf8')).not.toContain('PRIVATE_SECRET');
    const evidence = JSON.parse(fs.readFileSync(path.join(input.directory, 'diagnostics.json'), 'utf8'));
    expect(evidence.streams).toEqual({ stdout: 'captured', stderr: 'captured', session: 'captured' });
    expect(evidence.streamCoverage).toEqual({
      stdout: { artifactSource: 'agent-session', agentSession: 'captured' },
      stderr: { artifactSource: 'agent-session', agentSession: 'captured' },
      copilotDiagnostics: 'agent-session',
    });
  });
  it('keeps oversized source evidence empty while documenting bounded session coverage', async () => {
    const input = options('docker');
    await preservePublicEnclaveArtifacts({
      ...input,
      session: { status: 'captured', contents: Buffer.from(
        '{"event":"capture-bound","stream":"stdout","status":"oversized"}\n'
        + '{"event":"engine-result","stdout":{"raw":"bounded session excerpt"}}\n') },
    });
    expect(fs.readFileSync(path.join(input.directory, 'stdout.log'), 'utf8')).toBe('');
    const evidence = JSON.parse(fs.readFileSync(path.join(input.directory, 'diagnostics.json'), 'utf8'));
    expect(evidence.streams.stdout).toBe('oversized');
    expect(evidence.streamCoverage.stdout).toEqual({ artifactSource: 'unavailable', agentSession: 'captured' });
  });
  it('does not retain incomplete pipe-drain prefixes', async () => {
    const input = options('docker');
    await preservePublicEnclaveArtifacts({
      ...input, stdout: { status: 'captured', contents: Buffer.from('PRIVATE_') },
      stderr: { status: 'captured', contents: Buffer.from('{"event":"capture-drain","status":"unavailable"}\nPRIVATE_') },
    });
    const evidence = JSON.parse(fs.readFileSync(path.join(input.directory, 'diagnostics.json'), 'utf8'));
    expect(evidence.streams.stdout).toBe('unavailable');
    expect(evidence.streams.stderr).toBe('unavailable');
    expect(fs.readFileSync(path.join(input.directory, 'stdout.log'), 'utf8')).toBe('');
    expect(fs.readFileSync(path.join(input.directory, 'stderr.log'), 'utf8')).toBe('');
  });
});
