import type { MicrovmNetworkLifecycle } from '../microvm/network';
import type { MicrovmVsockClient } from '../microvm/vsock-client';
import type { CloudHypervisorApiClient } from './api-client';
import type { CloudHypervisorCgroup } from './launcher';
import type { CloudHypervisorCleanupHandle } from './cleanup-registry';
import type { CloudHypervisorVmmIdentityManager } from './vmm-identity';
import { CloudHypervisorManager } from './manager';
import { buildSupervisorBootArgs } from './manager';

import {
  hostTools, virtiofsdManagerMock, config, processMock, networkConfig, guestConfig, dependencies,
} from './manager.test-utils';

  describe('launch and boot', () => {
  it('builds explicit supervisor boot cmdline with PCI-required root/interface naming', () => {
    const args = buildSupervisorBootArgs({
      runId: 'run',
      resourceToken: '000000000000',
      namespaceName: 'ns',
      netnsPath: '/var/run/netns/ns',
      nftTableName: 'table',
      hostForwardRuleComment: 'awf:awf_vm_0123456789ab',
      infrastructureBridge: 'awfbr0',
      hostVethName: 'host',
      namespaceVethName: 'namespace',
      tapName: 'tap',
      infrastructureIp: '172.30.0.20',
      infrastructureCidr: '172.30.0.0/24',
      hostGatewayIp: '172.30.0.1',
      guestSubnet: '100.64.0.0/30',
      guestIp: '100.64.0.2',
      guestGatewayIp: '100.64.0.1',
      guestPrefixLength: 30,
      guestMac: '02:00:00:00:00:01',
      tapOwnerUid: 1000,
      tapOwnerGid: 1000,
      tapVnetHdr: true,
      allowedEndpoints: [],
      networkInterface: { iface_id: 'eth0', host_dev_name: 'tap' },
    }, guestConfig());
    expect(args).toContain('root=/dev/vda');
    expect(args).toContain('panic=0');
    expect(args).not.toContain('panic=1');
    expect(args).toContain('awf.guest-ip=100.64.0.2');
    expect(args).toContain('awf.guest-gateway=100.64.0.1');
    expect(args).not.toContain('awf.workspace-device=');
    expect(args).toContain('awf.virtiofs=workspace:L3dvcmtzcGFjZQ:rw');
    expect(args).toContain('net.ifnames=0');
    expect(args).not.toContain('pci=off');
    expect(args).not.toContain('8.8.8.8');
  });

  it('fails fast when Cloud Hypervisor exits by signal before API readiness', async () => {
    const child = processMock();
    Object.assign(child, { signalCode: 'SIGKILL', kill: jest.fn() });
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      access: jest.fn().mockRejectedValue(missing),
      sleep: jest.fn().mockResolvedValue(undefined),
    });
    const manager = new CloudHypervisorManager(
      config({ apiTimeoutMs: 2000 }),
      '/tmp/awf',
      deps,
      'signal',
      networkConfig(),
    );

    await expect(manager.start()).rejects.toThrow(
      /exited before API readiness with code null and signal SIGKILL/,
    );
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('launches via the secure launcher and creates/boots the VM over the API', async () => {
    const deps = dependencies();
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'run-1',
      networkConfig(),
    );
    const client = await manager.start();

    expect(deps.launch).toHaveBeenCalledWith(
      '/usr/bin/ip',
      expect.arrayContaining([
        'netns', 'exec', expect.stringMatching(/^awfvm-/),
        '/usr/bin/setpriv',
        '--reuid=2001',
        '--regid=2002',
        '--clear-groups',
      ]),
      expect.objectContaining({
        reject: false,
        extendEnv: false,
        env: { PATH: expect.stringContaining('/bin') },
      }),
    );
    const launchEnv = (deps.launch as jest.Mock).mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(Object.keys(launchEnv)).toEqual(['PATH']);
    expect(client.vmCreate).toHaveBeenCalledWith(expect.objectContaining({
      cpus: { boot_vcpus: 2, max_vcpus: 2 },
      memory: { size: 512 * 1024 * 1024 },
      payload: expect.objectContaining({ kernel: expect.stringContaining('/kernel') }),
      landlock_enable: true,
    }));
    expect(client.vmCreate).not.toHaveBeenCalledWith(expect.objectContaining({ vsock: expect.anything() }));
    expect(client.ping).toHaveBeenCalledTimes(1);
    // Regression test: Cloud Hypervisor defaults all three offloads to
    // enabled, but this network path is a fully-software bridge/veth/tap
    // chain with no real NIC downstream to finish partially-offloaded
    // frames. Live-KVM validation showed guest-to-Squid forward traffic
    // being accepted by nftables (visible via its per-rule counters) but
    // the return path never matching the established/related accept
    // rule -- disabling all three offloads removes offload-related
    // packet malformation as a possible cause, explicitly rather than
    // relying on Cloud Hypervisor's own defaults.
    expect(client.vmCreate).toHaveBeenCalledWith(expect.objectContaining({
      net: [expect.objectContaining({
        offload_tso: false,
        offload_ufo: false,
        offload_csum: false,
      })],
    }));
    expect(deps.createCgroup).toHaveBeenCalledWith(
      expect.stringContaining('awf-cloud-hypervisor/run-1'),
      { memoryMib: 512, vcpuCount: 2 },
    );
    const cgroup = (deps.createCgroup as jest.Mock).mock.results[0].value as CloudHypervisorCgroup;
    expect(cgroup.setup).toHaveBeenCalledTimes(1);
    expect(cgroup.assign).toHaveBeenCalledWith(4242);
    const cleanupRecord = await (deps.cleanupRegistry.createPending as jest.Mock).mock.results[0].value as
      CloudHypervisorCleanupHandle;
    expect((cgroup.assign as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((cleanupRecord.captureProcess as jest.Mock).mock.invocationCallOrder[0]);
    expect(deps.verifyConfinement).toHaveBeenCalledWith(expect.objectContaining({
      pid: 4242,
      expectedExecutable: '/opt/cloud-hypervisor',
      identity: expect.objectContaining({ uid: 2001, gid: 2002 }),
      networkNamespace: expect.stringMatching(/^awfvm-/),
      cgroupPath: expect.stringContaining('awf-cloud-hypervisor/run-1'),
      cgroupLimits: {
        memoryMax: String(768 * 1024 * 1024),
        cpuMax: '300000 100000',
        pidsMax: '256',
      },
    }));
    expect((deps.verifyConfinement as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((client.vmCreate as jest.Mock).mock.invocationCallOrder[0]);
    // Private run directory: ancestor levels stay traversable-only (0711,
    // root-owned); only the leaf is chowned to the non-root identity.
    expect(deps.mkdir).toHaveBeenCalledWith('/run/awf-cloud-hypervisor', { recursive: true, mode: 0o711 });
    expect(deps.chmod).toHaveBeenCalledWith('/run/awf-cloud-hypervisor', 0o711);
    expect(deps.mkdir).toHaveBeenCalledWith('/run/awf-cloud-hypervisor/cloud-hypervisor', { recursive: true, mode: 0o711 });
    expect(deps.chmod).toHaveBeenCalledWith('/run/awf-cloud-hypervisor/cloud-hypervisor', 0o711);
    expect(deps.mkdir).toHaveBeenCalledWith(
      '/run/awf-cloud-hypervisor/cloud-hypervisor/run-1',
      { recursive: true, mode: 0o700 },
    );
    expect(deps.chown).toHaveBeenCalledWith(
      '/run/awf-cloud-hypervisor/cloud-hypervisor/run-1',
      2001,
      2002,
    );
    expect(deps.copySparseFile).toHaveBeenCalledWith(
      '/usr/bin/rsync',
      '/opt/rootfs.ext4',
      '/run/awf-cloud-hypervisor/cloud-hypervisor/run-1/rootfs.ext4',
    );
    expect(deps.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        infrastructureBridge: 'awfbr0',
        tapOwnerUid: 2001,
        tapOwnerGid: 2002,
        tapVnetHdr: true,
      }),
      hostTools,
      expect.objectContaining({ plan: expect.objectContaining({ runId: 'run-1' }) }),
      expect.any(Object),
    );
    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(lifecycle.setup).toHaveBeenCalledTimes(1);
    const vmmIdentity = (deps.createVmmIdentity as jest.Mock).mock.results[0]
      .value as CloudHypervisorVmmIdentityManager;
    expect(vmmIdentity.allocate).toHaveBeenCalledTimes(1);
    expect(vmmIdentity.validateTapOwnership).toHaveBeenCalledWith(
      '/usr/bin/ip',
      expect.stringMatching(/^awfvm-/),
      expect.stringMatching(/^vmt/),
    );
    expect(vmmIdentity.withDeviceAccess).toHaveBeenCalledTimes(1);
  });

  it('reuses a verified artifact snapshot instead of running preflight again', async () => {
    const deps = dependencies();
    const verified = await deps.preflight(config());
    (deps.preflight as jest.Mock).mockReset().mockRejectedValue(
      new Error('preflight must not rerun'),
    );
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'verified-snapshot',
      networkConfig(),
      undefined,
      verified,
    );

    await expect(manager.start()).resolves.toBeDefined();
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.copySparseFile).toHaveBeenCalledWith(
      '/usr/bin/rsync',
      verified.rootfsPath,
      expect.stringContaining('/rootfs.ext4'),
    );
  });

  it('terminates the partial process and removes its run directory on readiness failure', async () => {
    const child = processMock();
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      access: jest.fn().mockRejectedValue(missing),
      sleep: jest.fn(async () => new Promise((resolve) => setTimeout(resolve, 2))),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'partial',
      networkConfig(),
    );

    await expect(manager.start()).rejects.toThrow(/API socket was not ready/);
    expect(child.kill).toHaveBeenCalledWith(
      'SIGTERM',
      { forceKillAfterTimeout: 2_000 },
    );
    expect(deps.rm).toHaveBeenCalledWith(
      '/run/awf-cloud-hypervisor/cloud-hypervisor/partial',
      { recursive: true, force: true },
    );
    const lifecycle = (deps.createNetwork as jest.Mock).mock.results[0]
      .value as MicrovmNetworkLifecycle;
    expect(lifecycle.cleanup).toHaveBeenCalledTimes(1);
    const cgroup = (deps.createCgroup as jest.Mock).mock.results[0].value as CloudHypervisorCgroup;
    expect(cgroup.cleanup).toHaveBeenCalledTimes(1);
    const vmmIdentity = (deps.createVmmIdentity as jest.Mock).mock.results[0]
      .value as CloudHypervisorVmmIdentityManager;
    expect(vmmIdentity.cleanup).toHaveBeenCalledTimes(1);
  });

  it('fails closed and never creates a VM when runtime confinement verification fails', async () => {
    const child = processMock();
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      verifyConfinement: jest.fn().mockRejectedValue(
        new Error('Cloud Hypervisor CapEff does not match launch policy'),
      ),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'unconfined',
      networkConfig(),
    );

    await expect(manager.start()).rejects.toThrow(/CapEff does not match launch policy/);
    const client = (deps.createClient as jest.Mock).mock.results[0].value as CloudHypervisorApiClient;
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(client.vmCreate).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith(
      'SIGTERM',
      { forceKillAfterTimeout: 2_000 },
    );
  });

  it('refuses to launch without host-side network enforcement', async () => {
    const deps = dependencies();
    const manager = new CloudHypervisorManager(config(), '/tmp/awf', deps, 'unsafe');

    await expect(manager.start()).rejects.toThrow(/unfiltered microVM/);
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('configures one rootfs disk and virtio-fs devices, then stops daemons after the VMM', async () => {
    const order: string[] = [];
    const child = processMock();
    const virtiofsd = virtiofsdManagerMock();
    (virtiofsd.stop as jest.Mock).mockImplementation(async () => {
      order.push('virtiofsd');
      expect(child.exitCode).toBe(0);
    });

    const guestClient = {
      connect: jest.fn().mockResolvedValue({
        version: 1,
        type: 'ready',
        requestId: 'control',
        capabilities: { stdin: true, tty: false, resize: false },
      }),
      execute: jest.fn().mockResolvedValue({
        requestId: 'command',
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
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
      'guest',
      networkConfig({
        controlPeers: [{ ip: '172.30.0.60', ports: [8080] }],
        hostAliases: { 'awmg-mcpg': '172.30.0.60' },
      }),
      guestConfig(),
    );

    const client = await manager.start();
    expect(deps.createRootfsPreparer).toHaveBeenCalledWith(
      expect.objectContaining({
        hostAliases: {
          'api-proxy': '172.30.0.30',
          'awmg-mcpg': '172.30.0.60',
        },
      }),
      hostTools,
      expect.any(Function),
    );
    const writableRootfsCopy = (deps.createRootfsPreparer as jest.Mock).mock.calls[0][2];
    await writableRootfsCopy(
      '/snapshot/rootfs.ext4',
      '/tmp/awf/cloud-hypervisor-rootfs/guest/rootfs.ext4',
    );
    expect(deps.copySparseFile).toHaveBeenCalledWith(
      '/usr/bin/rsync',
      '/snapshot/rootfs.ext4',
      '/tmp/awf/cloud-hypervisor-rootfs/guest/rootfs.ext4',
    );
    expect(deps.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedEndpoints: expect.arrayContaining([
          { name: 'control-peer', ip: '172.30.0.60', port: 8080 },
        ]),
      }),
      hostTools,
      expect.objectContaining({ plan: expect.objectContaining({ runId: 'guest' }) }),
      expect.any(Object),
    );
    expect(client.vmCreate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ cmdline: expect.stringContaining('init=/usr/sbin/awf-supervisor') }),
      memory: expect.objectContaining({ shared: true }),
      disks: [expect.objectContaining({ id: 'rootfs', image_type: 'Raw', readonly: false })],
      fs: [expect.objectContaining({
        tag: 'workspace',
        socket: '/run/virtiofs-0.sock',
        num_queues: 1,
        queue_size: 1024,
      })],
      vsock: expect.objectContaining({ cid: 3 }),
    }));
    const vmConfig = (client.vmCreate as jest.Mock).mock.calls[0][0];
    expect(vmConfig.landlock_rules).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/workspace' }),
    ]));
    const vmmIdentity = (deps.createVmmIdentity as jest.Mock).mock.results[0]
      .value as CloudHypervisorVmmIdentityManager;
    expect(vmmIdentity.validateOwnedPaths).not.toHaveBeenCalledWith([
      '/run/awf-cloud-hypervisor/cloud-hypervisor/guest/awf-vsock.socket',
    ]);
    await manager.startInstance();
    expect(client.vmBoot).toHaveBeenCalledTimes(1);
    expect(vmmIdentity.validateOwnedPaths).toHaveBeenCalledWith([
      '/run/awf-cloud-hypervisor/cloud-hypervisor/guest/awf-vsock.socket',
    ]);
    const ownershipValidationOrder = (vmmIdentity.validateOwnedPaths as jest.Mock)
      .mock.invocationCallOrder;
    const vsockOwnershipValidationOrder =
      ownershipValidationOrder[ownershipValidationOrder.length - 1];
    expect(vsockOwnershipValidationOrder).toBeGreaterThan(
      (client.vmBoot as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((deps.createVsockClient as jest.Mock).mock.invocationCallOrder[0])
      .toBeGreaterThan(vsockOwnershipValidationOrder);
    expect(deps.createVsockClient).toHaveBeenCalledWith(
      expect.stringContaining('/run/awf-cloud-hypervisor/cloud-hypervisor/guest/awf-vsock.socket'),
      52,
      1,
    );
    await expect(manager.execute({
      requestId: 'command',
      argv: ['true'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).resolves.toEqual(expect.objectContaining({ exitCode: 0 }));
    const forwardedRequest = (guestClient.execute as jest.Mock).mock.calls[0][0];
    const rawGuestStdout = Buffer.concat([
      Buffer.from('discarded prefix'),
      Buffer.alloc(1024 * 1024, 0x7a),
    ]);
    forwardedRequest.rawStdout.write(rawGuestStdout);
    forwardedRequest.rawStderr.write(Buffer.from([0xff, 0x00, 0xfe]));
    await manager.collectDiagnostics('/tmp/diagnostics');
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/guest-stdout.raw.log',
      Buffer.alloc(1024 * 1024, 0x7a),
      { mode: 0o600 },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/guest-stderr.raw.log',
      Buffer.from([0xff, 0x00, 0xfe]),
      { mode: 0o600 },
    );
    await manager.collectGuestOutputAudit('/tmp/audit/cloud-hypervisor');
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/audit/cloud-hypervisor/guest-stdout.raw.log',
      Buffer.alloc(1024 * 1024, 0x7a),
      { mode: 0o600 },
    );
    await manager.stop();

    expect(guestClient.shutdown).toHaveBeenCalledTimes(1);
    expect(client.vmShutdown).toHaveBeenCalledTimes(1);
    expect(client.vmmShutdown).toHaveBeenCalledTimes(1);
    expect(virtiofsd.stop).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['virtiofsd']);
  });
  });

