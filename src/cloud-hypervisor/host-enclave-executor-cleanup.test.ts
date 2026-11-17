import type { HostExecutorInvocationPlan } from '../enclave/host-executor-server';
import type { HostEnclaveExecutorDependencies, HostEnclaveExecutorManager } from './enclave-executor-types';
import { HostEnclaveInvocationResources, type InvocationCheck } from './host-enclave-executor-cleanup';
import type { CloudHypervisorHostToolPaths } from './preflight';

function fixture() {
  const events: string[] = [];
  const operation = (name: string) => jest.fn(async () => { events.push(name); });
  const dependencies = {
    removeArtifactSnapshot: operation('snapshot-remove'),
    verifyStorage: operation('verify-storage'),
    unmount: operation('unmount'),
    rm: operation('directory-remove'),
  } as unknown as HostEnclaveExecutorDependencies;
  const resources = new HostEnclaveInvocationResources(
    { invocationHostDir: '/invocation', executorKind: 'script' } as HostExecutorInvocationPlan,
    dependencies, {} as CloudHypervisorHostToolPaths, { milestone: jest.fn() },
  );
  const manager: HostEnclaveExecutorManager = {
    start: jest.fn(), startInstance: jest.fn(), execute: jest.fn(), cancel: jest.fn(),
    stop: operation('stop'), completeCleanupRecord: operation('record'),
  };
  const check: InvocationCheck = (_id, run) => run();
  return { resources, dependencies, manager, events, operation, check };
}

describe('HostEnclaveInvocationResources', () => {
  it('deduplicates in-flight and completed stops, while allowing retry after rejection', async () => {
    const { resources, manager } = fixture();
    resources.manager = manager;
    let release!: () => void;
    const stop = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    manager.stop = stop;
    const first = resources.stopManager();
    const second = resources.stopManager();
    expect(stop).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    await resources.stopManager();
    expect(stop).toHaveBeenCalledTimes(1);

    const retry = fixture();
    retry.resources.manager = retry.manager;
    const failure = new Error('stop failed');
    const stopRetry = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    retry.manager.stop = stopRetry;
    await expect(retry.resources.stopManager()).rejects.toBe(failure);
    await expect(retry.resources.stopManager()).resolves.toBeUndefined();
    expect(stopRetry).toHaveBeenCalledTimes(2);
  });

  it('drains late startup resource publication, including rejected work, before stopping and recording', async () => {
    const { resources, manager, events, check } = fixture();
    let release!: () => void;
    const work = resources.track(new Promise<void>((resolve) => { release = resolve; }).then(() => {
      events.push('startup-complete');
      resources.manager = manager;
      throw new Error('startup failed after publishing');
    }));
    void work.catch(() => undefined);
    const cleanup = resources.drainAndStop(check);
    await Promise.resolve();
    expect(events).toEqual([]);
    release();
    await expect(cleanup).resolves.toBeUndefined();
    expect(events).toEqual(['startup-complete', 'stop', 'record']);
    expect(resources.managerStopped).toBe(true);
  });

  it('retries an earlier abort stop after draining and preserves final stop failures', async () => {
    const { resources, manager, check } = fixture();
    resources.manager = manager;
    const failure = new Error('stop failed');
    manager.stop = jest.fn().mockRejectedValue(failure);
    await expect(resources.stopManager()).rejects.toBe(failure);
    expect(await resources.drainAndStop(check)).toBe(failure);
    expect(manager.stop).toHaveBeenCalledTimes(2);
    expect(manager.completeCleanupRecord).not.toHaveBeenCalled();
    expect(resources.managerStopped).toBe(false);
  });

  it('waits for an in-flight abort stop before retrying terminal stop', async () => {
    const { resources, manager, events, check } = fixture();
    resources.manager = manager;
    let release!: () => void;
    manager.stop = jest.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockImplementationOnce(async () => { events.push('terminal-stop'); });
    const abortStop = resources.stopManager();
    const cleanup = resources.drainAndStop(check);
    await Promise.resolve();
    expect(manager.stop).toHaveBeenCalledTimes(1);
    release();
    await abortStop;
    expect(await cleanup).toBeUndefined();
    expect(events).toEqual(['terminal-stop', 'record']);
    expect(manager.stop).toHaveBeenCalledTimes(2);
  });

  it('verifies and removes snapshots, mounts and directories before closing storage and completing the journal', async () => {
    const { resources, manager, dependencies, events, operation, check } = fixture();
    resources.manager = manager;
    resources.snapshot = { directory: '/snapshot' } as NonNullable<typeof resources.snapshot>;
    resources.mounted = true;
    resources.invocationDirectoryCreated = true;
    resources.storage = {
      dependencies: {}, managerDependencies: {} as NonNullable<typeof resources.storage>['managerDependencies'],
      workDir: '/storage', close: operation('storage-close'),
    };
    resources.journal = {
      captureDirectory: operation('capture-directory'), captureMount: operation('capture-mount'),
      prepareSnapshot: operation('prepare-snapshot'), captureSnapshot: operation('capture-snapshot'),
      verifySnapshot: operation('verify-snapshot'), verifyMount: operation('verify-mount'),
      verifyDirectory: operation('verify-directory'), complete: operation('journal-complete'),
    };
    const error = await resources.drainAndStop(check);
    expect(await resources.removeResources(check, error, dependencies)).toBeUndefined();
    expect(events).toEqual([
      'stop', 'record', 'verify-snapshot', 'snapshot-remove', 'verify-storage',
      'verify-mount', 'unmount', 'verify-directory', 'directory-remove', 'storage-close', 'journal-complete',
    ]);
    expect(resources.mounted).toBe(false);
    expect(resources.invocationDirectoryCreated).toBe(false);
  });

  it('retains source resources on prior retention failure or failed snapshot verification', async () => {
    const { resources, dependencies, events, operation, check } = fixture();
    resources.snapshot = { directory: '/snapshot' } as NonNullable<typeof resources.snapshot>;
    resources.invocationDirectoryCreated = true;
    const retentionFailure = new Error('retention failed');
    expect(await resources.removeResources(check, retentionFailure, dependencies)).toBe(retentionFailure);
    expect(events).toEqual([]);
    const verificationFailure = new Error('snapshot identity changed');
    resources.journal = {
      captureDirectory: operation('capture-directory'), captureMount: operation('capture-mount'),
      prepareSnapshot: operation('prepare-snapshot'), captureSnapshot: operation('capture-snapshot'),
      verifySnapshot: jest.fn().mockRejectedValue(verificationFailure), verifyMount: operation('verify-mount'),
      verifyDirectory: operation('verify-directory'), complete: operation('journal-complete'),
    };
    expect(await resources.removeResources(check, undefined, dependencies)).toBe(verificationFailure);
    expect(events).toEqual([]);
    expect(resources.invocationDirectoryCreated).toBe(true);
  });

  it('does not delete a failed unmount and permits filesystem cleanup to retry', async () => {
    const { resources, dependencies, check } = fixture();
    resources.mounted = true;
    resources.invocationDirectoryCreated = true;
    const failure = new Error('unmount failed');
    const unmount = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    resources.dependencies = { ...dependencies, unmount };
    expect(await resources.removeResources(check, undefined, dependencies)).toBe(failure);
    expect(dependencies.rm).not.toHaveBeenCalled();
    expect(resources.mounted).toBe(true);
    expect(await resources.removeResources(check, undefined, dependencies)).toBeUndefined();
    expect(unmount).toHaveBeenCalledTimes(2);
    expect(dependencies.rm).toHaveBeenCalledTimes(1);
    expect(resources.mounted).toBe(false);
  });
});
