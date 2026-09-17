import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const { createRunnerLifecycle } = require(path.join(
  __dirname,
  '..',
  '..',
  'containers',
  'enclave',
  'script-executor',
  'runner-lifecycle.js',
));
const { createScriptRunner } = require(path.join(
  __dirname,
  '..',
  '..',
  'containers',
  'enclave',
  'script-executor',
  'script-runner.js',
));
/* eslint-enable @typescript-eslint/no-require-imports */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function adapter(overrides: Record<string, unknown> = {}) {
  return {
    assertAvailable: jest.fn(async () => undefined),
    launchInvocation: jest.fn(async (request) => ({ ...request })),
    collectResult: jest.fn(async () => ({ exitCode: 0, timedOut: false, stdout: 'private' })),
    cancelInvocation: jest.fn(async () => undefined),
    cleanupInvocation: jest.fn(async () => undefined),
    reconcileRun: jest.fn(async () => undefined),
    ...overrides,
  };
}

const request = {
  runId: 'a'.repeat(16),
  invocationId: 'b'.repeat(24),
  seedId: 'c'.repeat(32),
  deadlineMs: 2_000,
};

describe('runtime-neutral enclave runner lifecycle', () => {
  it('selects gVisor only from trusted configuration and never falls back', async () => {
    const calls: string[][] = [];
    const docker = {
      runDocker: async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'info') {
          return { exitCode: 0, timedOut: false, stdout: 'runc\nrunsc\n', stderr: '' };
        }
        return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
      },
    };
    const runner = createScriptRunner({
      executorBackend: 'gvisor',
      queryImage: 'trusted-script-image',
      hostWorkDir: '/private/work',
      queryMountDir: '/query',
      queryScriptPath: '/awf/query-script.py',
      querySeccompPath: '/opt/awf/query-seccomp.json',
      memoryLimit: '512m',
      cpuLimit: '1',
      pidsLimit: 64,
      tmpfsLimit: '64m',
      queryUid: 65534,
      queryGid: 65534,
      timeoutSeconds: 30,
    }, { docker, nowMs: () => 1_000 });
    await runner.assertAvailable();
    await runner.runInvocation(request);
    expect(calls.find((args) => args[0] === 'run')).toEqual(
      expect.arrayContaining(['--runtime', 'runsc']),
    );
    expect(() => createScriptRunner({ executorBackend: 'cloud-hypervisor' }))
      .toThrow(/Unsupported enclave-script backend/);
  });

  it('delegates availability and run reconciliation without exposing backend details', async () => {
    const runtime = adapter();
    const runner = createRunnerLifecycle(runtime, { nowMs: () => 1_000 });
    await runner.assertAvailable();
    await runner.reconcileRun(request.runId);
    expect(runtime.assertAvailable).toHaveBeenCalledTimes(1);
    expect(runtime.reconcileRun).toHaveBeenCalledWith(request.runId);
  });

  it('launches, returns only a bounded status, and cleans up once', async () => {
    const runtime = adapter();
    const runner = createRunnerLifecycle(runtime, { nowMs: () => 1_000 });
    const handle = await runner.launchInvocation(request);
    await expect(runner.collectResult(handle)).resolves.toEqual({
      status: 'completed',
      exitCode: 0,
      timedOut: false,
    });
    await runner.cleanupInvocation(handle);
    await runner.cleanupInvocation(handle);
    expect(runtime.launchInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineMs: request.deadlineMs }),
    );
    expect(runtime.cleanupInvocation).toHaveBeenCalledTimes(1);
  });

  it('cleans partial state when launch fails', async () => {
    const runtime = adapter({
      launchInvocation: jest.fn(async () => {
        throw new Error('launch failed');
      }),
    });
    const runner = createRunnerLifecycle(runtime, { nowMs: () => 1_000 });
    await expect(runner.launchInvocation(request)).rejects.toThrow('launch failed');
    expect(runtime.cleanupInvocation).toHaveBeenCalledWith({
      runId: request.runId,
      invocationId: request.invocationId,
    });
  });

  it('cleans up when result collection fails', async () => {
    const runtime = adapter({
      collectResult: jest.fn(async () => {
        throw new Error('result failed');
      }),
    });
    const runner = createRunnerLifecycle(runtime, { nowMs: () => 1_000 });
    await expect(runner.runInvocation(request)).rejects.toThrow('result failed');
    expect(runtime.cleanupInvocation).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation and reports a canonical bounded status', async () => {
    const result = deferred<{ exitCode: number; timedOut: boolean }>();
    const runtime = adapter({
      collectResult: jest.fn(() => result.promise),
      cancelInvocation: jest.fn(async () => {
        result.resolve({ exitCode: 137, timedOut: false });
      }),
    });
    const controller = new AbortController();
    const runner = createRunnerLifecycle(runtime, { nowMs: () => 1_000 });
    const running = runner.runInvocation({ ...request, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(running).resolves.toEqual({
      status: 'cancelled',
      exitCode: 124,
      timedOut: false,
    });
    expect(runtime.cancelInvocation).toHaveBeenCalledTimes(1);
    expect(runtime.cleanupInvocation).toHaveBeenCalledTimes(1);
  });

  it('rejects caller-shaped runtime controls and elapsed deadlines', async () => {
    const runtime = adapter();
    const runner = createRunnerLifecycle(runtime, { nowMs: () => 2_000 });
    await expect(runner.launchInvocation({
      ...request,
      deadlineMs: 3_000,
      image: 'attacker/image',
    })).rejects.toThrow(/forbidden runtime control: image/);
    await expect(runner.launchInvocation(request)).rejects.toThrow(/deadline elapsed/);
    expect(runtime.launchInvocation).not.toHaveBeenCalled();
  });

  it('never launches an enclave when the signal is already aborted', async () => {
    const runtime = adapter();
    const runner = createRunnerLifecycle(runtime, { nowMs: () => 1_000 });
    const controller = new AbortController();
    controller.abort();
    await expect(runner.runInvocation({ ...request, signal: controller.signal })).resolves.toEqual({
      status: 'cancelled',
      exitCode: 124,
      timedOut: false,
    });
    expect(runtime.launchInvocation).not.toHaveBeenCalled();
    expect(runtime.cleanupInvocation).not.toHaveBeenCalled();
  });

  it('reports completed status when the signal aborts only after cleanup finishes', async () => {
    const controller = new AbortController();
    const runtime = adapter({
      cleanupInvocation: jest.fn(async () => {
        // Simulate a bounded Docker cleanup call that takes a moment, during
        // which the caller's signal is aborted after the invocation already
        // completed successfully.
        controller.abort();
      }),
    });
    const runner = createRunnerLifecycle(runtime, { nowMs: () => 1_000 });
    await expect(runner.runInvocation({ ...request, signal: controller.signal })).resolves.toEqual({
      status: 'completed',
      exitCode: 0,
      timedOut: false,
    });
    expect(runtime.cancelInvocation).not.toHaveBeenCalled();
  });
});
