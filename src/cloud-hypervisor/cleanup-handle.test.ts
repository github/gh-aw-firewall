import { promises as fs } from 'fs';
import * as path from 'path';
import { DurableCloudHypervisorCleanupRegistry } from './cleanup-registry';
import { createCleanupRegistryTestHarness } from './cleanup-registry.test-support';

describe('cleanup handle integration', () => {
  let harness: Awaited<ReturnType<typeof createCleanupRegistryTestHarness>>;

  beforeEach(async () => {
    harness = await createCleanupRegistryTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('VMM account and process capture', () => {
    it('removes revoked device ACLs from durable cleanup intent', async () => {
      const paths = harness.runPaths('released-vmm-acl');
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const handle = await registry.createPending(paths, process.execPath, '/usr/bin/ip');
      const account = 'awfvmm-0123456789abcdef0123';
      await handle.prepareVmmAccount(account);
      await handle.captureVmmIdentity({ name: account, uid: 23001, gid: 23002 });
      await handle.prepareVmmAcl('/dev/kvm');
      await handle.releaseVmmAcl('/dev/kvm');

      const record = JSON.parse(await fs.readFile(
        path.join(harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`),
        'utf8',
      )) as { vmmIdentity: { aclPaths: string[] } };
      expect(record.vmmIdentity.aclPaths).toEqual([]);
      await expect(handle.releaseVmmAcl('/dev/kvm')).rejects.toThrow(/intent is missing/);
    });

    it('validates process registration and completes idempotently', async () => {
      const paths = harness.runPaths('process-registration');
      const handle = await new DurableCloudHypervisorCleanupRegistry(harness.dependencies()).create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );

      await expect(handle.prepareProcess('__proto__', process.execPath, '/sock')).rejects.toThrow(
        /Unsafe cleanup process key/,
      );
      await expect(handle.captureProcess('missing', 5000)).rejects.toThrow(
        /identity was not prepared/,
      );
      await handle.complete();
      await expect(handle.complete()).resolves.toBeUndefined();
    });

    it('times out instead of committing a process whose executable never matches', async () => {
      const now = jest.spyOn(Date, 'now')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(2_001);
      try {
        const paths = harness.runPaths('process-mismatch');
        const handle = await new DurableCloudHypervisorCleanupRegistry(harness.dependencies()).create(
          paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
        );
        await handle.prepareProcess('worker', process.execPath, '/sock');
        harness.state.daemonExecutableLink = '/usr/bin/not-the-prepared-binary';

        await expect(handle.captureProcess('worker', 5000)).rejects.toThrow(
          /did not match its prepared cleanup identity/,
        );
      } finally {
        now.mockRestore();
      }
    });

    it('waits for the trusted exec chain to settle before committing process identity', async () => {
      const paths = harness.runPaths('process-settles');
      const sleep = jest.fn(async () => {
        harness.state.daemonExecutableLink = process.execPath;
      });
      const handle = await new DurableCloudHypervisorCleanupRegistry(
        harness.dependencies({ sleep }),
      ).create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      await handle.prepareProcess('worker', process.execPath, '/sock');
      harness.state.daemonExecutableLink = '/usr/bin/setpriv';

      await expect(handle.captureProcess('worker', 5000)).resolves.toBeUndefined();
      expect(sleep).toHaveBeenCalled();
    });

    it('records the settled private network namespace of sandboxed virtiofsd', async () => {
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const paths = harness.runPaths('virtiofsd-netns');
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );

      await handle.prepareProcess('virtiofsd-0', process.execPath, '/sock', '/source');
      await handle.captureProcess('virtiofsd-0', 5000);

      const record = JSON.parse(await fs.readFile(
        path.join(harness.temporaryRoot, 'pending-cleanup', 'virtiofsd-netns.json'),
        'utf8',
      )) as { processes: Record<string, { identity: { networkNamespace: string } }> };
      expect(record.processes['virtiofsd-0'].identity.networkNamespace).toBe('net:[5000]');
    });
  });

  describe('network and mount capture', () => {
    it.each([
      ['non-array output', '{}', /Unexpected interface inspection/],
      ['wrong interface', '[{"ifname":"other","ifindex":12}]', /Invalid interface inspection/],
      ['non-integer index', '[{"ifname":"host","ifindex":"12"}]', /Invalid interface inspection/],
    ])('rejects %s from kernel interface inspection', async (_label, stdout, expected) => {
      const paths = harness.runPaths('bad-interface');
      const plan = harness.networkPlan(paths.runId);
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({
        run: jest.fn(async () => ({ exitCode: 0, stdout, stderr: '' })),
      }));
      const handle = await registry.create(paths, plan, process.execPath, '/usr/bin/ip');

      await expect(handle.captureNetworkResource('hostVeth')).rejects.toThrow(expected);
    });

    it('propagates kernel interface inspection failures', async () => {
      const paths = harness.runPaths('interface-inspection-error');
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({
        run: jest.fn(async () => ({ exitCode: 2, stdout: '', stderr: 'netlink denied' })),
      }));
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );

      await expect(handle.captureNetworkResource('hostVeth')).rejects.toThrow(/netlink denied/);
    });

    it('rejects malformed mountinfo and decodes valid escaped mount paths', async () => {
      const basePaths = harness.runPaths('mount-parser');
      const paths = {
        ...basePaths,
        virtiofsdShareDirectory: path.join(
          harness.temporaryRoot,
          'virtiofsd with space',
          basePaths.runId,
        ),
      };
      await fs.mkdir(paths.virtiofsdShareDirectory, { recursive: true });
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      harness.state.mountInfo = 'not mountinfo\n';
      await expect(handle.captureVirtiofsdResources()).rejects.toThrow(
        /Malformed \/proc\/self\/mountinfo entry/,
      );

      const escaped = paths.virtiofsdShareDirectory.replace(/ /g, '\\040');
      harness.state.mountInfo = `123 1 8:1 /source ${escaped} rw - ext4 /dev/sda1 rw\n`;
      await expect(handle.captureVirtiofsdResources()).resolves.toBeUndefined();
    });
  });
});
