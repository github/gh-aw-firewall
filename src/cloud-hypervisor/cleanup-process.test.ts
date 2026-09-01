import type { PathLike } from 'fs';
import { promises as fs } from 'fs';
import { DurableCloudHypervisorCleanupRegistry } from './cleanup-registry';
import { createCleanupRegistryTestHarness } from './cleanup-registry.test-utils';

describe('cleanup process recovery', () => {
  let harness: Awaited<ReturnType<typeof createCleanupRegistryTestHarness>>;

  beforeEach(async () => {
    harness = await createCleanupRegistryTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('signal escalation and PID validation', () => {
    it('escalates an identity-validated live process to SIGKILL', async () => {
      const paths = harness.runPaths('kill-escalation');
      const kill = jest.fn((_pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 'SIGKILL') harness.state.daemonAlive = false;
        return true as const;
      });
      const now = jest.spyOn(Date, 'now');
      let currentTime = 0;
      now.mockImplementation(() => {
        currentTime += 1_000;
        return currentTime;
      });
      try {
        const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ kill }));
        const handle = await registry.create(
          paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
        );
        await handle.prepareProcess('worker', process.execPath, '/sock');
        await handle.captureProcess('worker', 5000);
        harness.state.ownerStartTime = '2000';

        await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

        expect(kill).toHaveBeenNthCalledWith(1, 5000, 'SIGTERM');
        expect(kill).toHaveBeenNthCalledWith(2, 5000, 'SIGKILL');
      } finally {
        now.mockRestore();
      }
    });

    it('does not kill a PID whose committed command arguments no longer match', async () => {
      const paths = harness.runPaths('changed-process-args');
      const deps = harness.dependencies();
      const registry = new DurableCloudHypervisorCleanupRegistry(deps);
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.prepareProcess('worker', process.execPath, '/sock', '/source');
      await handle.captureProcess('worker', 5000);
      harness.state.daemonCmdline = `${process.execPath}\0--socket-path=/different\0`;
      harness.state.ownerStartTime = '2000';

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

      expect(deps.kill).not.toHaveBeenCalled();
    });

    it('fails visibly when an identity-validated process survives SIGKILL', async () => {
      const paths = harness.runPaths('unkillable-process');
      const kill = jest.fn(() => true as const);
      const now = jest.spyOn(Date, 'now');
      let currentTime = 0;
      now.mockImplementation(() => {
        currentTime += 1_000;
        return currentTime;
      });
      try {
        const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ kill }));
        const handle = await registry.create(
          paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
        );
        await handle.prepareProcess('worker', process.execPath, '/sock');
        await handle.captureProcess('worker', 5000);
        harness.state.ownerStartTime = '2000';

        await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
          /identity-validated process 5000 did not exit/,
        );
        expect(kill).toHaveBeenCalledWith(5000, 'SIGKILL');
      } finally {
        now.mockRestore();
      }
    });

    it('accepts an ESRCH race only after the recorded process disappears', async () => {
      const paths = harness.runPaths('esrch-exited');
      const kill = jest.fn(() => {
        harness.state.daemonAlive = false;
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      });
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ kill }));
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.prepareProcess('worker', process.execPath, '/sock');
      await handle.captureProcess('worker', 5000);
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).resolves.toBeUndefined();
    });

    it('rejects ESRCH and other kill errors while process identity still matches', async () => {
      for (const [runId, code, expected] of [
        ['esrch-live', 'ESRCH', /still matches after kill reported ESRCH/],
        ['kill-denied', 'EPERM', /operation denied/],
      ] as const) {
        const kill = jest.fn(() => {
          throw Object.assign(new Error('operation denied'), { code });
        });
        const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ kill }));
        const paths = harness.runPaths(runId);
        const handle = await registry.create(
          paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
        );
        await handle.prepareProcess('worker', process.execPath, '/sock');
        await handle.captureProcess('worker', 5000);
        harness.state.ownerStartTime = '2000';
        await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(expected);
        harness.state.ownerStartTime = '1000';
      }
    });

    it('accepts an ESRCH race after SIGTERM timeout only when SIGKILL sees process exit', async () => {
      const paths = harness.runPaths('sigkill-esrch');
      const kill = jest.fn((_pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 'SIGKILL') {
          harness.state.daemonAlive = false;
          throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        }
        return true as const;
      });
      const now = jest.spyOn(Date, 'now');
      let currentTime = 0;
      now.mockImplementation(() => {
        currentTime += 1_000;
        return currentTime;
      });
      try {
        const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ kill }));
        const handle = await registry.create(
          paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
        );
        await handle.prepareProcess('worker', process.execPath, '/sock');
        await handle.captureProcess('worker', 5000);
        harness.state.ownerStartTime = '2000';

        await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).resolves.toBeUndefined();
        expect(kill).toHaveBeenCalledWith(5000, 'SIGKILL');
      } finally {
        now.mockRestore();
      }
    });

    it('rejects SIGKILL ESRCH while the recorded process still matches', async () => {
      const paths = harness.runPaths('sigkill-esrch-live');
      const kill = jest.fn((_pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 'SIGKILL') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        return true as const;
      });
      const now = jest.spyOn(Date, 'now');
      let currentTime = 0;
      now.mockImplementation(() => {
        currentTime += 1_000;
        return currentTime;
      });
      try {
        const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ kill }));
        const handle = await registry.create(
          paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
        );
        await handle.prepareProcess('worker', process.execPath, '/sock');
        await handle.captureProcess('worker', 5000);
        harness.state.ownerStartTime = '2000';

        await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
          /still matches after kill reported ESRCH/,
        );
      } finally {
        now.mockRestore();
      }
    });
  });

  describe('identity read failures', () => {
    it('fails closed when process or resource identity cannot be read', async () => {
      const paths = harness.runPaths('identity-unreadable');
      const plan = harness.networkPlan(paths.runId);
      const base = harness.dependencies();
      const baseReadFile = base.readFile as typeof fs.readFile;
      const readFile: typeof fs.readFile = (async (filePath: PathLike, options?: unknown) => {
        if (String(filePath) === '/proc/4242/stat' && harness.state.ownerStartTime === '2000') {
          throw Object.assign(new Error('proc denied'), { code: 'EACCES' });
        }
        return baseReadFile(filePath, options as never);
      }) as typeof fs.readFile;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ readFile }));
      await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
      harness.state.ownerStartTime = '2000';
      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /proc denied/,
      );

      harness.state.ownerStartTime = '1000';
      const secondPaths = harness.runPaths('resource-unreadable');
      const resourcePlan = harness.networkPlan(secondPaths.runId);
      const inaccessibleLstat: typeof fs.lstat = (async (
        filePath: PathLike,
        options?: unknown,
      ) => {
        if (String(filePath) === resourcePlan.netnsPath) {
          throw Object.assign(new Error('netns denied'), { code: 'EACCES' });
        }
        return (base.lstat as typeof fs.lstat)(filePath, options as never);
      }) as typeof fs.lstat;
      const second = new DurableCloudHypervisorCleanupRegistry(
        harness.dependencies({ lstat: inaccessibleLstat }),
      );
      await second.create(secondPaths, resourcePlan, process.execPath, '/usr/bin/ip');
      harness.state.ownerStartTime = '2000';
      await expect(second.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /netns denied/,
      );
    });
  });
});
