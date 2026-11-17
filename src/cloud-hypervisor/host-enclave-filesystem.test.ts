import { promises as fs } from 'fs';
import type { HostEnclaveExecutorDependencies } from './enclave-executor-types';
import { HostEnclaveInvocationFilesystem } from './host-enclave-filesystem';
import { staticStagingScenarios, useBackendFixture } from './host-enclave-executor.test-utils';
import { HostPreflightReporter } from './host-preflight-progress';
import { resolveCloudHypervisorManagerDependencies } from './manager';

describe('host enclave invocation filesystem', () => {
  const fixture = useBackendFixture(staticStagingScenarios[0]);
  const report = new HostPreflightReporter('host-invocation');

  function createFilesystem() {
    const { runState, plan, preflight, backendOptions, dependencies: overrides } = fixture();
    const dependencies: HostEnclaveExecutorDependencies = {
      mkdir: fs.mkdir, realpath: fs.realpath, lstat: fs.lstat, writeFile: fs.writeFile,
      chmod: fs.chmod, chown: fs.chown, rm: fs.rm,
      createCommonArtifactSnapshot: jest.fn(),
      createArtifactSnapshot: overrides.createArtifactSnapshot!,
      createResourceJournal: overrides.createResourceJournal!,
      copySparseFile: overrides.copySparseFile!,
      removeArtifactSnapshot: overrides.removeArtifactSnapshot!,
      createManager: overrides.createManager!,
      mountTmpfs: overrides.mountTmpfs!,
      unmount: overrides.unmount!,
      verifyStorage: overrides.verifyStorage!,
      resolveIdentity: overrides.resolveIdentity!,
      ...overrides,
    };
    const filesystem = new HostEnclaveInvocationFilesystem({
      runState, plan, runId: 'fixture-vm', preflight,
      enclaveArtifacts: backendOptions.enclaveArtifacts, retainPublicDebug: false,
    }, dependencies);
    return { filesystem, dependencies };
  }

  it('shares concurrent cleanup and verifies resources before unmounting and removing them', async () => {
    const { filesystem, dependencies } = createFilesystem();
    await filesystem.prepare(report, () => undefined);
    const order: string[] = [];
    jest.spyOn(filesystem.journal!, 'verifyMount').mockImplementation(async () => { order.push('verify-mount'); });
    jest.spyOn(filesystem.journal!, 'verifyDirectory').mockImplementation(async () => { order.push('verify-directory'); });
    jest.spyOn(dependencies, 'unmount').mockImplementation(async () => { order.push('unmount'); });
    const remove = jest.spyOn(dependencies, 'rm').mockImplementation(async () => { order.push('remove'); });

    const first = filesystem.cleanup();
    expect(filesystem.cleanup()).toBe(first);
    await first;
    await filesystem.cleanup();

    expect(order).toEqual(['verify-mount', 'unmount', 'verify-directory', 'remove']);
    expect(remove).toHaveBeenCalledWith(fixture().invocationHostDir, { recursive: true, force: true });
    expect(filesystem.mounted).toBe(false);
    expect(filesystem.invocationDirectoryCreated).toBe(false);
  });

  it.each(['verifyMount', 'unmount', 'verifyDirectory', 'rm'] as const)(
    'retains cleanup state after %s fails and permits a safe retry',
    async (operation) => {
      const { filesystem, dependencies } = createFilesystem();
      await filesystem.prepare(report, () => undefined);
      const unmount = jest.spyOn(dependencies, 'unmount');
      const remove = jest.spyOn(dependencies, 'rm');
      const failure = new Error('fixture cleanup failure');
      const failingOperation = operation === 'verifyMount' || operation === 'verifyDirectory'
        ? jest.spyOn(filesystem.journal!, operation)
        : operation === 'unmount' ? unmount : remove;
      failingOperation.mockRejectedValueOnce(failure);

      await expect(filesystem.cleanup()).rejects.toBe(failure);
      expect(filesystem.invocationDirectoryCreated).toBe(true);
      expect(filesystem.mounted).toBe(operation === 'verifyMount' || operation === 'unmount');
      if (operation !== 'rm') expect(remove).not.toHaveBeenCalled();

      await filesystem.cleanup();
      expect(filesystem.mounted).toBe(false);
      expect(filesystem.invocationDirectoryCreated).toBe(false);
      expect(unmount).toHaveBeenCalledTimes(operation === 'unmount' ? 2 : 1);
    },
  );

  it('drains late snapshot creation and rejected work before snapshot removal', async () => {
    const { filesystem, dependencies } = createFilesystem();
    await filesystem.prepare(report, () => undefined);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const createSnapshot = dependencies.createArtifactSnapshot;
    jest.spyOn(dependencies, 'createArtifactSnapshot').mockImplementation(async (...args) => {
      await pending;
      return createSnapshot(...args);
    });
    const snapshot = filesystem.createSnapshot(report);
    const failed = filesystem.track(Promise.reject(new Error('fixture staging failure')));
    const drained = filesystem.drain();
    expect(filesystem.snapshot).toBeUndefined();
    release();

    await expect(drained).resolves.toEqual([
      { status: 'fulfilled', value: await snapshot },
      { status: 'rejected', reason: expect.any(Error) },
    ]);
    await expect(failed).rejects.toThrow('fixture staging failure');
    expect(filesystem.snapshot).toBe(await snapshot);
    await expect(filesystem.drain()).resolves.toEqual([]);
    const verifySnapshot = jest.spyOn(filesystem.journal!, 'verifySnapshot');
    await filesystem.removeSnapshot();
    expect(verifySnapshot).toHaveBeenCalledTimes(1);
    expect(fixture().state.snapshotRemoved).toBe(true);
    await filesystem.cleanup();
  });

  it('uses invocation-specific mount and verification dependencies after storage preparation', async () => {
    const { filesystem, dependencies } = createFilesystem();
    const mountTmpfs = jest.fn().mockResolvedValue(undefined);
    const verifyStorage = jest.fn().mockResolvedValue(undefined);
    const storage = {
      dependencies: { mountTmpfs, verifyStorage },
      managerDependencies: resolveCloudHypervisorManagerDependencies(),
      workDir: fixture().root,
      close: jest.fn().mockResolvedValue(undefined),
    };
    Object.assign(dependencies, { prepareInvocationStorage: async () => storage });
    const published = jest.fn();

    await filesystem.prepare(report, published);
    expect(filesystem.storage).toBe(storage);
    expect(published).toHaveBeenCalledTimes(1);
    expect(mountTmpfs).toHaveBeenCalledTimes(1);
    expect(verifyStorage).toHaveBeenCalledTimes(1);
    await filesystem.cleanup();
    expect(verifyStorage).toHaveBeenCalledTimes(2);
  });
});
