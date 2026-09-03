import type { MicrovmNetworkPlan } from '../microvm/network';
import { cloudHypervisorManagerTestHelpers } from './manager';
import { createCloudHypervisorRunPaths } from './manager';

import {
  hostTools, cgroupMock,
} from './manager.test-utils';

  describe('construction', () => {
  it('constructs the default host adapters and non-root identity', async () => {
    const defaults = cloudHypervisorManagerTestHelpers.defaultDependencies;
    const child = defaults.launch(process.execPath, ['-e', ''], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin' },
      extendEnv: false,
    });
    await expect(child).resolves.toMatchObject({ exitCode: 0 });
    await expect(defaults.sleep(0)).resolves.toBeUndefined();
    expect(defaults.createClient('/tmp/api.socket', 100)).toBeDefined();
    expect(defaults.createNetwork(
      {} as MicrovmNetworkPlan,
      hostTools,
      { plan: {} as MicrovmNetworkPlan, release: jest.fn() },
    )).toBeDefined();
    expect(defaults.createRootfsPreparer({
      runDirectory: '/work/rootfs',
      baseRootfsPath: '/opt/rootfs',
      supervisorBinaryPath: '/opt/supervisor',
      supervisorSha256: 'a'.repeat(64),
    }, hostTools, jest.fn())).toBeDefined();
    expect(defaults.createVirtiofsdManager(
      '/opt/virtiofsd',
      '/run/awf',
      '/run/awf-shares',
      { uid: 1000, gid: 1000 },
      cgroupMock(),
      { mount: hostTools.mount, umount: hostTools.umount },
    )).toBeDefined();
    expect(defaults.createVsockClient('/tmp/vsock.socket', 52, 100)).toBeDefined();
    expect(defaults.createCgroup('/sys/fs/cgroup/awf/run', { memoryMib: 512, vcpuCount: 2 })).toBeDefined();

    const originalSudoUid = process.env.SUDO_UID;
    const originalSudoGid = process.env.SUDO_GID;
    const uidSpy = jest.spyOn(process, 'getuid').mockReturnValue(0);
    const gidSpy = jest.spyOn(process, 'getgid').mockReturnValue(0);
    try {
      process.env.SUDO_UID = '2001';
      process.env.SUDO_GID = '2002';
      expect(cloudHypervisorManagerTestHelpers.resolveCloudHypervisorIdentity()).toEqual({
        uid: 2001,
        gid: 2002,
      });

      delete process.env.SUDO_UID;
      delete process.env.SUDO_GID;
      expect(cloudHypervisorManagerTestHelpers.resolveCloudHypervisorIdentity)
        .toThrow(/non-root target uid\/gid/);
    } finally {
      uidSpy.mockRestore();
      gidSpy.mockRestore();
      if (originalSudoUid === undefined) delete process.env.SUDO_UID;
      else process.env.SUDO_UID = originalSudoUid;
      if (originalSudoGid === undefined) delete process.env.SUDO_GID;
      else process.env.SUDO_GID = originalSudoGid;
    }
  });

  it('constructs unique, contained run paths outside workDir', () => {
    const first = createCloudHypervisorRunPaths('/opt/cloud-hypervisor');
    const second = createCloudHypervisorRunPaths('/opt/cloud-hypervisor');
    expect(first.runId).not.toBe(second.runId);
    expect(first.runDirectory).toContain('/run/awf-cloud-hypervisor/cloud-hypervisor/');
    expect(first.cgroupPath).toContain('/sys/fs/cgroup/awf-cloud-hypervisor/');
    expect(() => createCloudHypervisorRunPaths(
      '/opt/cloud-hypervisor',
      '../escape',
    )).toThrow(/Unsafe microVM run id/);
  });
  });

