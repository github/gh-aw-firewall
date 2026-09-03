import { constants } from 'fs';
import type { MicrovmNetworkLifecycle } from '../microvm/network';
import type { CloudHypervisorCgroup } from './launcher';
import type { CloudHypervisorCleanupRegistry } from './cleanup-registry';
import { CloudHypervisorManager } from './manager';

import {
  exportsConfig, virtiofsdManagerMock, config, processMock, networkConfig, guestConfig, cleanupHandleMock, dependencies,
} from './manager.test-helpers';

  describe('virtiofsd lifecycle', () => {
  it('preserves failed virtiofsd confinement evidence before partial-start cleanup', async () => {
    const virtiofsd = virtiofsdManagerMock();
    (virtiofsd.start as jest.Mock).mockRejectedValue(
      new Error('virtiofsd sandbox verification failed'),
    );
    const deps = dependencies({
      createVirtiofsdManager: jest.fn().mockReturnValue(virtiofsd),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'virtiofs-failure',
      networkConfig(),
      guestConfig(),
    );

    await expect(manager.start()).rejects.toThrow(/sandbox verification failed/);
    expect(deps.copyFile).toHaveBeenCalledWith(
      '/run/virtiofs-0-confinement.json',
      expect.stringMatching(
        /^\/tmp\/awf\/diagnostics\/cloud-hypervisor\/startup-.*\/virtiofs-0-confinement\.json$/,
      ),
      constants.COPYFILE_EXCL,
    );
    const copyCallOrder = (deps.copyFile as jest.Mock).mock.invocationCallOrder;
    const evidenceCopyOrder = copyCallOrder[copyCallOrder.length - 1];
    const runRemoval = (deps.rm as jest.Mock).mock.calls.findIndex(
      ([target]) => String(target).startsWith('/run/awf-cloud-hypervisor/'),
    );
    expect(evidenceCopyOrder).toBeLessThan(
      (deps.rm as jest.Mock).mock.invocationCallOrder[runRemoval],
    );
  });

  it('starts virtiofsd without an enforcement argument when no write policy applies', async () => {
    const virtiofsd = virtiofsdManagerMock();
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(processMock()),
      createVirtiofsdManager: jest.fn().mockReturnValue(virtiofsd),
    });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'plain', networkConfig(), guestConfig(),
    );

    await manager.start();

    expect(virtiofsd.start).toHaveBeenCalledWith(exportsConfig, undefined);
  });

  it('forwards host mount enforcement and publishes a read-only workspace', async () => {
    const virtiofsd = virtiofsdManagerMock();
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(processMock()),
      createVirtiofsdManager: jest.fn().mockReturnValue(virtiofsd),
    });
    const mountEnforcement = { plans: [{ tag: 'workspace', writableOverlays: [] }] };
    const narrowedExports = [{ ...exportsConfig[0], mode: 'ro' as const }];
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'narrowed',
      networkConfig(),
      { ...guestConfig(), exports: narrowedExports, mountEnforcement },
    );

    const client = await manager.start();

    expect(virtiofsd.start).toHaveBeenCalledWith(narrowedExports, mountEnforcement);
    expect((client.vmCreate as jest.Mock).mock.calls[0][0].payload.cmdline)
      .toContain(`awf.virtiofs=workspace:${Buffer.from('/workspace').toString('base64url')}:ro`);
  });

  it('refuses a read-only workspace that no host mount plan enforces', async () => {
    const deps = dependencies({ launch: jest.fn().mockReturnValue(processMock()) });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'unenforced',
      networkConfig(),
      {
        ...guestConfig(),
        exports: [{ ...exportsConfig[0], mode: 'ro' as const }],
        mountEnforcement: { plans: [{ tag: 'tmp-gh-aw', writableOverlays: [] }] },
      },
    );

    await expect(manager.start())
      .rejects.toThrow('Cloud Hypervisor requires read-write tag "workspace" at /workspace');
  });

  it('preserves the cgroup and run directory when virtiofsd cannot be reaped', async () => {
    const virtiofsd = virtiofsdManagerMock();
    (virtiofsd.stop as jest.Mock).mockRejectedValue(new Error('virtiofsd did not exit'));
    const handle = cleanupHandleMock();
    const registry: CloudHypervisorCleanupRegistry = {
      reapPending: jest.fn().mockResolvedValue(undefined),
      createPending: jest.fn().mockResolvedValue(handle),
      create: jest.fn().mockResolvedValue(handle),
    };
    const deps = dependencies({
      createVirtiofsdManager: jest.fn().mockReturnValue(virtiofsd),
      cleanupRegistry: registry,
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'virtiofsd-stuck',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();
    (deps.rm as jest.Mock).mockClear();

    await expect(manager.stop()).rejects.toThrow(
      /stopped before cgroup\/run-directory removal.*virtiofsd did not exit/,
    );

    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    const cgroup = (deps.createCgroup as jest.Mock).mock.results[0].value as CloudHypervisorCgroup;
    expect(lifecycle.cleanup).not.toHaveBeenCalled();
    expect(cgroup.cleanup).not.toHaveBeenCalled();
    expect(deps.rm).not.toHaveBeenCalled();
    expect(handle.complete).not.toHaveBeenCalled();
  });
  });

