import type { ExecaChildProcess } from 'execa';
import type { MicrovmNetworkLifecycle } from '../microvm/network';
import { createMicrovmNetworkPlan } from '../microvm/network';
import type { MicrovmVsockClient } from '../microvm/vsock-client';
import type { CloudHypervisorApiClient } from './api-client';
import type { CloudHypervisorCgroup } from './launcher';
import type { CloudHypervisorCleanupRegistry } from './cleanup-registry';
import type { CloudHypervisorVmmIdentityManager } from './vmm-identity';
import { CloudHypervisorManager } from './manager';

import {
  virtiofsdManagerMock, config, processMock, networkConfig, guestConfig, cleanupHandleMock, vmmIdentityMock, dependencies,
} from './manager.test-utils';

  describe('stop and cleanup', () => {
  it('cleans up the network and cgroup before removing the run directory', async () => {
    const order: string[] = [];
    const deps = dependencies({
      createNetwork: jest.fn((plan) => ({
        plan,
        setup: jest.fn().mockResolvedValue(plan),
        cleanup: jest.fn(async () => {
          order.push('network');
        }),
      })),
      createCgroup: jest.fn(() => ({
        cgroupPath: '/sys/fs/cgroup/awf-cloud-hypervisor/cleanup',
        setup: jest.fn().mockResolvedValue(undefined),
        assign: jest.fn().mockResolvedValue(undefined),
        expectedLimits: jest.fn().mockReturnValue({
          memoryMax: String(768 * 1024 * 1024),
          cpuMax: '300000 100000',
          pidsMax: '256',
        }),
        cleanup: jest.fn(async () => {
          order.push('cgroup');
        }),
      } as unknown as CloudHypervisorCgroup)),
      rm: jest.fn(async () => {
        order.push('run-directory');
      }),
      createVmmIdentity: jest.fn(() => ({
        ...vmmIdentityMock(),
        cleanup: jest.fn(async () => {
          order.push('vmm-identity');
        }),
      } as unknown as CloudHypervisorVmmIdentityManager)),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'cleanup',
      networkConfig(),
    );

    await manager.start();
    await manager.stop();

    expect(order).toEqual(['network', 'cgroup', 'run-directory', 'vmm-identity']);
  });

  it('commits cleanup intent before resources and removes it only after teardown', async () => {
    const order: string[] = [];
    const handle = cleanupHandleMock();
    (handle.complete as jest.Mock).mockImplementation(async () => { order.push('record-complete'); });
    const registry: CloudHypervisorCleanupRegistry = {
      reapPending: jest.fn(async () => { order.push('reap'); }),
      createPending: jest.fn(async () => {
        order.push('record-create');
        return handle;
      }),
      create: jest.fn().mockResolvedValue(handle),
    };
    const deps = dependencies({
      cleanupRegistry: registry,
      createNetwork: jest.fn((plan) => ({
        plan,
        setup: jest.fn(async () => {
          order.push('network-setup');
          return plan;
        }),
        cleanup: jest.fn(async () => { order.push('network-cleanup'); }),
      })),
      rm: jest.fn(async () => { order.push('run-directory'); }),
    });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'durable-order', networkConfig(),
    );

    await manager.start();
    await manager.stop();

    expect(order.indexOf('reap')).toBeLessThan(order.indexOf('record-create'));
    expect(order.indexOf('record-create')).toBeLessThan(order.indexOf('network-setup'));
    expect(order.slice(-3)).toEqual(['network-cleanup', 'run-directory', 'record-complete']);
  });

  it('creates no network reservation when durable cleanup record creation fails', async () => {
    const release = jest.fn().mockResolvedValue(undefined);
    const deps = dependencies({
      reserveNetwork: jest.fn(async (runId, options) => ({
        plan: createMicrovmNetworkPlan(runId, options),
        release,
      })),
      cleanupRegistry: {
        reapPending: jest.fn().mockResolvedValue(undefined),
        createPending: jest.fn().mockRejectedValue(new Error('registry unavailable')),
        create: jest.fn().mockRejectedValue(new Error('registry unavailable')),
      },
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'record-failure',
      networkConfig(),
    );

    await expect(manager.start()).rejects.toThrow('registry unavailable');
    expect(release).not.toHaveBeenCalled();
    expect(deps.createNetwork).not.toHaveBeenCalled();
  });

  it('quiesces and stops virtiofsd while preserving the run directory and network in keep mode', async () => {
    const child = processMock();
    const virtiofsd = virtiofsdManagerMock();
    const guestClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createVirtiofsdManager: jest.fn().mockReturnValue(virtiofsd),
      createVsockClient: jest.fn().mockReturnValue(guestClient),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'keep',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();
    await manager.startInstance();

    await manager.stop({ preserve: true });

    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(virtiofsd.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.cleanup).not.toHaveBeenCalled();
    expect(deps.rm).toHaveBeenCalledWith(
      '/prepared',
      { recursive: true, force: true },
    );
    expect(deps.rm).not.toHaveBeenCalledWith(
      expect.stringContaining('/run/awf-cloud-hypervisor/'),
      expect.anything(),
    );
    const cgroup = (deps.createCgroup as jest.Mock).mock.results[0].value as CloudHypervisorCgroup;
    expect(cgroup.cleanup).toHaveBeenCalledTimes(1);
  });

  it('invokes a beforeCleanup hook after process termination but before run-directory removal', async () => {
    // Regression test: Cloud Hypervisor does not flush buffered guest
    // serial console output until its process actually exits, so
    // diagnostics collection must happen after process termination is
    // confirmed but before stop() removes the run directory those
    // diagnostic files live in. Discovered via live-KVM validation: a
    // guest boot failure produced a completely empty serial console log
    // when diagnostics were collected any earlier (e.g. before
    // vmm.shutdown()/process termination).
    const child = processMock();
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'keep',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();

    const beforeCleanup = jest.fn(async () => {});

    await manager.stop({ beforeCleanup });

    expect(beforeCleanup).toHaveBeenCalledTimes(1);
    expect(deps.rm).toHaveBeenCalledWith(
      expect.stringContaining('/run/awf-cloud-hypervisor/'),
      { recursive: true, force: true },
    );
    // beforeCleanup must run strictly before the run-directory removal
    // call (deps.rm), i.e. after process termination is confirmed but
    // before diagnostic files are deleted.
    const runRmIndex = (deps.rm as jest.Mock).mock.calls.findIndex(
      ([target]) => String(target).startsWith('/run/awf-cloud-hypervisor/'),
    );
    const rmCallOrder = (deps.rm as jest.Mock).mock.invocationCallOrder[runRmIndex];
    expect(beforeCleanup.mock.invocationCallOrder[0]).toBeLessThan(rmCallOrder);
  });

  it('propagates a beforeCleanup hook failure alongside other stop() errors', async () => {
    const child = processMock();
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'keep',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();

    await expect(
      manager.stop({
        beforeCleanup: async () => {
          throw new Error('diagnostics write failed');
        },
      }),
    ).rejects.toThrow(/diagnostics write failed/);
    // Run-directory removal must still proceed even if beforeCleanup fails.
    expect(deps.rm).toHaveBeenCalledWith(
      expect.stringContaining('/run/awf-cloud-hypervisor/'),
      { recursive: true, force: true },
    );
    const vmmIdentity = (deps.createVmmIdentity as jest.Mock).mock.results[0]
      .value as CloudHypervisorVmmIdentityManager;
    expect(vmmIdentity.cleanup).toHaveBeenCalledTimes(1);
  });

  it('retains virtiofsd and network until process termination is confirmed', async () => {
    const child = Promise.resolve({ exitCode: null }) as unknown as ExecaChildProcess<string>;
    Object.assign(child, {
      exitCode: null,
      signalCode: null,
      killed: false,
      pid: 9,
      kill: jest.fn(() => {
        Object.assign(child, { killed: true });
        return true;
      }),
    });
    const virtiofsd = virtiofsdManagerMock();
    const guestClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createVirtiofsdManager: jest.fn().mockReturnValue(virtiofsd),
      createVsockClient: jest.fn().mockReturnValue(guestClient),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'termination',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();
    await manager.startInstance();

    await expect(manager.stop()).rejects.toThrow(/stopped before network\/run-directory removal/);
    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(lifecycle.cleanup).not.toHaveBeenCalled();
    expect(virtiofsd.stop).toHaveBeenCalledTimes(1);
    expect(deps.rm).not.toHaveBeenCalled();

    Object.assign(child, { exitCode: 0 });
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(virtiofsd.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.cleanup).toHaveBeenCalledTimes(1);
  });

  it('waits briefly for natural VM exit after guest shutdown before sending SIGTERM', async () => {
    const child = processMock();
    const guestClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    let sleepCalls = 0;
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createVsockClient: jest.fn().mockReturnValue(guestClient),
      sleep: jest.fn(async () => {
        sleepCalls += 1;
        if (sleepCalls === 3) Object.assign(child, { exitCode: 0 });
      }),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'natural-exit',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();
    await manager.startInstance();
    await manager.stop();
    expect(child.kill).not.toHaveBeenCalled();
    expect(sleepCalls).toBeGreaterThan(0);
  });

  it('rolls back the network and cgroup when vm.create fails', async () => {
    const client = {
      ping: jest.fn().mockResolvedValue({ version: '53.0' }),
      vmCreate: jest.fn().mockRejectedValue(new Error('invalid disk path')),
      vmBoot: jest.fn().mockResolvedValue(undefined),
      vmInfo: jest.fn().mockResolvedValue({ state: 'Created' }),
      vmCounters: jest.fn().mockResolvedValue({}),
      vmShutdown: jest.fn().mockResolvedValue(undefined),
      vmmShutdown: jest.fn().mockResolvedValue(undefined),
    } as unknown as CloudHypervisorApiClient;
    const deps = dependencies({
      createClient: jest.fn().mockReturnValue(client),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'create-failure',
      networkConfig(),
    );

    await expect(manager.start()).rejects.toThrow('invalid disk path');

    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(lifecycle.cleanup).toHaveBeenCalledTimes(1);
    expect(deps.rm).toHaveBeenCalled();
    const cgroup = (deps.createCgroup as jest.Mock).mock.results[0].value as CloudHypervisorCgroup;
    expect(cgroup.cleanup).toHaveBeenCalledTimes(1);
  });

  });

