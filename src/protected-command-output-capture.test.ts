import * as fs from 'fs';
import * as path from 'path';
import type { WrapperConfig } from './types';
import {
  prepareProtectedCommandOutputCapture,
  protectedCommandOutputCaptureTestHelpers,
} from './protected-command-output-capture';
import { assertPrivateCommandOutputRootIsolated } from './enclave/mount-policy';

describe('protected command output capture', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join('/var/tmp', 'awf-output-capture-'));
  });

  it('rejects capture roots under automatically mounted container working directories', () => {
    const containerWorkDir = path.join(testRoot, 'container-work');
    fs.mkdirSync(containerWorkDir);
    expect(() => assertPrivateCommandOutputRootIsolated(
      config({ containerWorkDir }),
      path.join(containerWorkDir, 'capture'),
    )).toThrow(/container working directory/);
    expect(() => prepareProtectedCommandOutputCapture(config({
      commandOutputCaptureDir: path.join(testRoot, 'capture-workdir'),
      containerWorkDir: path.join(testRoot, 'capture-workdir'),
    }))).toThrow(/container working directory/);
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('accounts for successful short writes before a later write fails', () => {
    let capturedBytes = 0;
    let firstWrite = true;
    const writer = (_fd: number, _bytes: Buffer, _offset: number, _length: number, _position: number | null): number => {
      if (firstWrite) {
        firstWrite = false;
        return 2;
      }
      throw new Error('disk full');
    };

    expect(() => protectedCommandOutputCaptureTestHelpers.writeAll(
      1,
      Buffer.from('abcd'),
      undefined,
      written => { capturedBytes += written; },
      writer,
    )).toThrow('disk full');
    expect(capturedBytes).toBe(2);
  });

  it('hands private artifacts back to the sudo invoking identity without widening permissions', () => {
    if (process.getuid?.() !== 0) return;
    const uid = process.env.SUDO_UID;
    const gid = process.env.SUDO_GID;
    process.env.SUDO_UID = '12345';
    process.env.SUDO_GID = '12345';
    try {
      const capture = prepareProtectedCommandOutputCapture(config())!;
      capture.close();
    } finally {
      if (uid === undefined) delete process.env.SUDO_UID;
      else process.env.SUDO_UID = uid;
      if (gid === undefined) delete process.env.SUDO_GID;
      else process.env.SUDO_GID = gid;
    }

    const directory = path.join(testRoot, 'capture');
    expect(fs.statSync(directory).uid).toBe(12345);
    for (const name of ['metadata.json', 'attempt-001.stdout.bin', 'attempt-001.stderr.bin']) {
      const stat = fs.statSync(path.join(directory, name));
      expect(stat.uid).toBe(12345);
      expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
  });

  function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
    return {
      workDir: path.join(testRoot, 'work'),
      commandOutputCaptureDir: path.join(testRoot, 'capture'),
      ...overrides,
    } as WrapperConfig;
  }

  it('rejects temporary, workspace, custom-mount, and symlink aliases before creating the sink', () => {
    expect(() => prepareProtectedCommandOutputCapture(config({
      commandOutputCaptureDir: path.join('/tmp', 'awf-protected-output'),
    }))).toThrow(/temporary directory/);

    const captureRoot = path.join(testRoot, 'capture');
    expect(() => assertPrivateCommandOutputRootIsolated(
      config(),
      captureRoot,
      { GITHUB_WORKSPACE: testRoot },
      process.cwd(),
    )).toThrow(/workspace/);
    expect(() => assertPrivateCommandOutputRootIsolated(
      config({ volumeMounts: [`${testRoot}:/data:ro`] }),
      captureRoot,
    )).toThrow(/custom volume/);

    expect(() => assertPrivateCommandOutputRootIsolated(
      config(),
      path.join('/tmp', '..awf-capture'),
    )).toThrow(/temporary directory/);

    const workspace = path.join(testRoot, 'workspace');
    const external = path.join(testRoot, 'external');
    fs.mkdirSync(workspace);
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(workspace, 'alias'));
    expect(() => assertPrivateCommandOutputRootIsolated(
      config(),
      path.join(workspace, 'alias', 'capture'),
      { GITHUB_WORKSPACE: workspace },
    )).toThrow(/workspace/);

    const alias = path.join(testRoot, 'alias');
    fs.symlinkSync(testRoot, alias);
    expect(() => assertPrivateCommandOutputRootIsolated(
      config({ volumeMounts: [`${testRoot}:/data:ro`] }),
      path.join(alias, 'capture'),
    )).toThrow(/custom volume/);
  });

  it('validates split-filesystem paths as well as runner-visible mounts', () => {
    expect(() => assertPrivateCommandOutputRootIsolated(
      config({
        dockerHostPathPrefix: '/host',
        volumeMounts: ['/host/var/tmp:/data:ro'],
      }),
      path.join(testRoot, 'capture'),
    )).toThrow(/custom volume/);
  });

  it('rejects AWF-managed artifact and log directories as capture destinations', () => {
    expect(() => assertPrivateCommandOutputRootIsolated(
      config({ auditDir: testRoot }),
      path.join(testRoot, 'capture'),
    )).toThrow(/AWF-managed audit directory/);
    expect(() => assertPrivateCommandOutputRootIsolated(
      config({ proxyLogsDir: testRoot }),
      path.join(testRoot, 'capture'),
    )).toThrow(/AWF-managed proxy logs directory/);
  });

  it('pre-creates private sinks and preserves exact stream bytes with nonzero command status', () => {
    const capture = prepareProtectedCommandOutputCapture(config())!;
    expect(fs.existsSync(path.join(testRoot, 'capture', 'attempt-001.stdout.bin'))).toBe(true);
    expect(fs.statSync(path.join(testRoot, 'capture', 'attempt-001.stdout.bin')).mode & 0o777).toBe(0o600);
    capture.beginAttempt(1);
    capture.recordOutput(1, 'stdout', Buffer.from([0x00, 0xff, 0x41]));
    capture.recordOutput(1, 'stderr', Buffer.from([0x0a, 0x00, 0x42]));
    capture.finishAttempt(1, { exitCode: 9, outcome: 'exited', logsDrained: true });
    capture.finishCommand(9, 'exited');
    capture.setTeardown('complete');
    capture.close();

    expect(fs.readFileSync(path.join(testRoot, 'capture', 'attempt-001.stdout.bin')))
      .toEqual(Buffer.from([0x00, 0xff, 0x41]));
    expect(fs.readFileSync(path.join(testRoot, 'capture', 'attempt-001.stderr.bin')))
      .toEqual(Buffer.from([0x0a, 0x00, 0x42]));
    const metadata = JSON.parse(fs.readFileSync(path.join(testRoot, 'capture', 'metadata.json'), 'utf8'));
    expect(metadata).toMatchObject({
      status: 'complete',
      command: { outcome: 'exited', exitCode: 9 },
      teardown: 'complete',
      capturedBytes: 6,
      observedBytes: 6,
    });
    expect(metadata.ordering).toContain('ordering is guaranteed only within each stream');
    expect(metadata.attempts[0].attemptId).toMatch(new RegExp(`^${capture.invocationId}:1$`));
  });

  it('reports truncation and incomplete log draining rather than marking a partial capture complete', () => {
    const capture = prepareProtectedCommandOutputCapture(config({
      commandOutputCaptureMaxBytes: 4,
    }))!;
    capture.beginAttempt(1);
    capture.recordOutput(1, 'stdout', Buffer.from('abc'));
    capture.recordOutput(1, 'stderr', Buffer.from('def'));
    capture.finishAttempt(1, { exitCode: 0, outcome: 'exited', logsDrained: false });
    capture.finishCommand(0, 'exited');
    capture.setTeardown('complete');
    capture.close();

    const directory = path.join(testRoot, 'capture');
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json'), 'utf8'));
    expect(fs.readFileSync(path.join(directory, 'attempt-001.stdout.bin'), 'utf8')).toBe('abc');
    expect(fs.readFileSync(path.join(directory, 'attempt-001.stderr.bin'), 'utf8')).toBe('d');
    expect(metadata).toMatchObject({
      status: 'incomplete',
      truncated: true,
      capturedBytes: 4,
      observedBytes: 6,
      attempts: [{ logsDrained: false }],
    });
  });

  it('keeps runtime retries distinct and labels timeout/cancellation as incomplete', () => {
    const capture = prepareProtectedCommandOutputCapture(config({ containerRuntime: 'gvisor' }))!;
    capture.beginAttempt(1);
    capture.recordOutput(1, 'stdout', Buffer.from('first'));
    capture.finishAttempt(1, { exitCode: 139, outcome: 'exited', logsDrained: true });
    capture.beginAttempt(2);
    capture.recordOutput(2, 'stdout', Buffer.from('second'));
    capture.finishAttempt(2, { exitCode: 0, outcome: 'exited', logsDrained: true });
    capture.finishCommand(0, 'exited');
    capture.setTeardown('complete');
    capture.close();

    const directory = path.join(testRoot, 'capture');
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json'), 'utf8'));
    expect(metadata.status).toBe('complete');
    expect(metadata.attempts.map((attempt: { attemptId: string }) => attempt.attemptId)).toEqual([
      `${capture.invocationId}:1`,
      `${capture.invocationId}:2`,
    ]);
    expect(fs.readFileSync(path.join(directory, 'attempt-001.stdout.bin'), 'utf8')).toBe('first');
    expect(fs.readFileSync(path.join(directory, 'attempt-002.stdout.bin'), 'utf8')).toBe('second');

    for (const outcome of ['timed_out', 'cancelled'] as const) {
      const partialRoot = path.join(testRoot, `capture-${outcome}`);
      const partial = prepareProtectedCommandOutputCapture(config({
        commandOutputCaptureDir: partialRoot,
      }))!;
      partial.beginAttempt(1);
      partial.finishAttempt(1, { exitCode: outcome === 'timed_out' ? 124 : 143, outcome, logsDrained: true });
      partial.finishCommand(outcome === 'timed_out' ? 124 : 143, outcome);
      partial.setTeardown('complete');
      partial.close();
      const partialMetadata = JSON.parse(fs.readFileSync(path.join(partialRoot, 'metadata.json'), 'utf8'));
      expect(partialMetadata).toMatchObject({
        status: 'incomplete',
        command: { outcome },
      });
    }
  });

  it('records capture write failures separately from the observed command exit', () => {
    const capture = prepareProtectedCommandOutputCapture(config())!;
    const internalCapture = capture as unknown as {
      attempts: Array<{ streams: { stdout: { fd: number } } }>;
    };
    capture.beginAttempt(1);
    fs.closeSync(internalCapture.attempts[0].streams.stdout.fd);
    capture.recordOutput(1, 'stdout', Buffer.from('not written'));
    capture.finishAttempt(1, { exitCode: 0, outcome: 'exited', logsDrained: true });
    capture.finishCommand(0, 'exited');
    capture.setTeardown('complete');
    capture.close();

    const metadata = JSON.parse(fs.readFileSync(path.join(testRoot, 'capture', 'metadata.json'), 'utf8'));
    expect(metadata).toMatchObject({
      status: 'incomplete',
      command: { outcome: 'exited', exitCode: 0 },
      captureFailure: expect.stringContaining('write stdout failed'),
    });
  });

  it('waits for attempt output draining before allowing cancellation teardown', async () => {
    const capture = prepareProtectedCommandOutputCapture(config())!;
    capture.beginAttempt(1);
    let drained = false;
    const completion = capture.waitForCommandCompletion().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    capture.finishAttempt(1, { exitCode: 143, outcome: 'cancelled', logsDrained: true });
    capture.finishCommand(143, 'cancelled');
    await completion;
    expect(drained).toBe(true);
    capture.setTeardown('complete');
    capture.close();
  });

  it('bounds cancellation waiting when command collection never completes', async () => {
    jest.useFakeTimers();
    const capture = prepareProtectedCommandOutputCapture(config())!;
    capture.beginAttempt(1);

    try {
      const completion = capture.waitForCommandCompletion();
      await jest.advanceTimersByTimeAsync(2_000);
      await completion;
    } finally {
      jest.useRealTimers();
    }
    capture.setTeardown('complete');
    capture.close();

    const metadata = JSON.parse(fs.readFileSync(path.join(testRoot, 'capture', 'metadata.json'), 'utf8'));
    expect(metadata).toMatchObject({
      status: 'incomplete',
      command: { outcome: 'interrupted' },
      attempts: [{ outcome: 'interrupted', logsDrained: false }],
    });
  });

  it('records interrupted commands without claiming their output was drained', () => {
    const capture = prepareProtectedCommandOutputCapture(config())!;
    capture.beginAttempt(1);
    capture.recordOutput(1, 'stdout', Buffer.from('partial'));
    capture.finishCommand(undefined, 'interrupted');
    capture.setTeardown('complete');
    capture.close();

    const metadata = JSON.parse(fs.readFileSync(path.join(testRoot, 'capture', 'metadata.json'), 'utf8'));
    expect(metadata).toMatchObject({
      status: 'incomplete',
      command: { outcome: 'interrupted' },
      attempts: [{ outcome: 'interrupted', logsDrained: false }],
    });
  });

  it('keeps captured-byte completeness independent from console presentation failure', () => {
    const capture = prepareProtectedCommandOutputCapture(config())!;
    capture.beginAttempt(1);
    capture.recordOutput(1, 'stdout', Buffer.from('raw'));
    capture.recordPresentationFailure('stdout', 'error');
    capture.finishAttempt(1, { exitCode: 0, outcome: 'exited', logsDrained: true });
    capture.finishCommand(0, 'exited');
    capture.setTeardown('complete');
    capture.close();

    const metadata = JSON.parse(fs.readFileSync(path.join(testRoot, 'capture', 'metadata.json'), 'utf8'));
    expect(metadata).toMatchObject({
      status: 'complete',
      capturedBytes: 3,
      presentationFailures: ['stdout: error'],
    });
  });

  it('rejects TTY and external runtime capture requests explicitly', () => {
    expect(() => prepareProtectedCommandOutputCapture(config({ tty: true }))).toThrow(/does not support TTY/);
    expect(() => prepareProtectedCommandOutputCapture(config({ containerRuntime: 'sbx' })))
      .toThrow(/not supported by the "sbx" runtime/);
    expect(() => prepareProtectedCommandOutputCapture(config({ enableDind: true })))
      .toThrow(/agent can access a Docker socket/);
    expect(() => prepareProtectedCommandOutputCapture(config({
      volumeMounts: ['/var/run/docker.sock:/data/docker.sock'],
    }))).toThrow(/agent can access a Docker socket/);
    const maskedSocketMount = prepareProtectedCommandOutputCapture(config({
      volumeMounts: ['/var/run/docker.sock:/run/docker.sock'],
    }));
    expect(maskedSocketMount).toBeDefined();
    maskedSocketMount?.close();
    expect(() => prepareProtectedCommandOutputCapture(config({
      awfDockerHost: 'unix:///tmp/docker.sock',
    }))).toThrow(/agent can access a Docker socket/);
    const mountedWorkDir = path.join(testRoot, 'socket-workdir');
    fs.mkdirSync(mountedWorkDir);
    expect(() => prepareProtectedCommandOutputCapture(config({
      containerWorkDir: mountedWorkDir,
      awfDockerHost: `unix://${path.join(mountedWorkDir, 'docker.sock')}`,
    }))).toThrow(/agent can access a Docker socket/);
    expect(() => prepareProtectedCommandOutputCapture(config({ commandOutputCaptureDir: 'relative/path' })))
      .toThrow(/absolute path/);
  });
});
