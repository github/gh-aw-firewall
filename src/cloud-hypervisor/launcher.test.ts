import {
  CloudHypervisorCgroup,
  buildCloudHypervisorLaunchCommand,
  computeCloudHypervisorLandlockRules,
  type CloudHypervisorCgroupDependencies,
} from './launcher';

describe('buildCloudHypervisorLaunchCommand', () => {
  const baseOptions = {
    tools: { ip: '/usr/sbin/ip', setpriv: '/usr/bin/setpriv' },
    namespaceName: 'awfch-abc123',
    identity: { uid: 1000, gid: 1000 },
    kvmGid: 978,
    cloudHypervisorBinary: '/opt/cloud-hypervisor',
    apiSocketPath: '/run/awf/api.socket',
    logFilePath: '/run/awf/cloud-hypervisor.log',
  };

  it('joins the namespace, drops privileges but retains the kvm group, then execs Cloud Hypervisor with no shell', () => {
    const result = buildCloudHypervisorLaunchCommand(baseOptions);
    expect(result.command).toBe('/usr/sbin/ip');
    expect(result.args).toEqual([
      'netns', 'exec', 'awfch-abc123',
      '/usr/bin/setpriv',
      '--reuid=1000',
      '--regid=1000',
      '--groups=978',
      '--no-new-privs',
      '--inh-caps=-all',
      '--bounding-set=-all',
      '--',
      '/opt/cloud-hypervisor',
      '--api-socket', 'path=/run/awf/api.socket',
      '--log-file', '/run/awf/cloud-hypervisor.log',
      '-v',
      '--seccomp', 'true',
    ]);
    expect(result.args).not.toContain('--clear-groups');
    // No argument contains shell metacharacters that would matter if ever
    // interpolated; more importantly, args are a plain array (never joined
    // into a shell string) so metacharacters have no special meaning here.
    expect(result.args.every((arg) => typeof arg === 'string')).toBe(true);
  });

  it.each([
    ['unsafe namespace name', { namespaceName: '../etc' }, /Unsafe Cloud Hypervisor network namespace name/],
    ['zero uid', { identity: { uid: 0, gid: 1000 } }, /uid must be a positive integer/],
    ['negative gid', { identity: { uid: 1000, gid: -1 } }, /gid must be a positive integer/],
    ['negative kvm gid', { kvmGid: -1 }, /\/dev\/kvm group id must be a non-negative integer/],
    ['relative binary path', { cloudHypervisorBinary: 'cloud-hypervisor' }, /binary path must be absolute/],
    ['relative socket path', { apiSocketPath: 'api.socket' }, /API socket path must be absolute/],
  ])('rejects %s', (_label, overrides, error) => {
    expect(() => buildCloudHypervisorLaunchCommand({ ...baseOptions, ...overrides }))
      .toThrow(error);
  });

  it('accepts a kvm gid of 0 (root-owned /dev/kvm on unusual hosts)', () => {
    expect(() => buildCloudHypervisorLaunchCommand({ ...baseOptions, kvmGid: 0 })).not.toThrow();
  });
});

describe('computeCloudHypervisorLandlockRules', () => {
  it('restricts the VMM to exactly the staged paths plus required device nodes', () => {
    const rules = computeCloudHypervisorLandlockRules({
      kernelPath: '/run/awf/kernel',
      rootfsPath: '/run/awf/rootfs.ext4',
      workspacePath: '/run/awf/workspace.ext4',
      runDirectory: '/run/awf/run',
      apiSocketPath: '/run/awf/run/api.socket',
      vsockSocketPath: '/run/awf/run/vsock.socket',
    });

    expect(rules).toEqual([
      { path: '/run/awf/kernel', access: 'r' },
      { path: '/run/awf/rootfs.ext4', access: 'rw' },
      { path: '/run/awf/run', access: 'rw' },
      { path: '/dev/kvm', access: 'rw' },
      { path: '/dev/net/tun', access: 'rw' },
      { path: '/run/awf/workspace.ext4', access: 'rw' },
    ]);
  });

  it('omits the workspace rule when no workspace disk is configured', () => {
    const rules = computeCloudHypervisorLandlockRules({
      kernelPath: '/run/awf/kernel',
      rootfsPath: '/run/awf/rootfs.ext4',
      runDirectory: '/run/awf/run',
      apiSocketPath: '/run/awf/run/api.socket',
      vsockSocketPath: '/run/awf/run/vsock.socket',
    });

    expect(rules.some((rule) => rule.path.includes('workspace'))).toBe(false);
  });
});

describe('CloudHypervisorCgroup', () => {
  function dependencies(): CloudHypervisorCgroupDependencies & {
    mkdir: jest.Mock;
    writeFile: jest.Mock;
    rmdir: jest.Mock;
  } {
    return {
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn().mockResolvedValue(undefined),
      rmdir: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('enables cpu/memory/pids delegation at the cgroup root and parent before creating the leaf', async () => {
    const deps = dependencies();
    const cgroup = new CloudHypervisorCgroup(
      '/sys/fs/cgroup/awf-cloud-hypervisor/run-1',
      { memoryMib: 512, vcpuCount: 2 },
      deps,
    );
    await cgroup.setup();

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/sys/fs/cgroup/cgroup.subtree_control',
      '+cpu +memory +pids',
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/sys/fs/cgroup/awf-cloud-hypervisor/cgroup.subtree_control',
      '+cpu +memory +pids',
    );
    expect(deps.mkdir).toHaveBeenCalledWith('/sys/fs/cgroup/awf-cloud-hypervisor');
    expect(deps.mkdir).toHaveBeenCalledWith('/sys/fs/cgroup/awf-cloud-hypervisor/run-1');

    // Cross-mock chronological order (jest's shared invocation counter,
    // not per-mock array indices) must be: enable root -> mkdir parent ->
    // enable parent -> mkdir leaf. A cgroup v2 child only gets a
    // controller's interface files once that controller is enabled in
    // the *parent's* subtree_control, so the parent directory must exist
    // before its own subtree_control can be written, and the leaf must
    // not be created until the parent has delegated the controllers down.
    const writeFileCallIndex = (target: string): number => {
      const index = deps.writeFile.mock.calls.findIndex(([path]) => path === target);
      return deps.writeFile.mock.invocationCallOrder[index];
    };
    const mkdirCallIndex = (target: string): number => {
      const index = deps.mkdir.mock.calls.findIndex(([path]) => path === target);
      return deps.mkdir.mock.invocationCallOrder[index];
    };
    const rootEnableOrder = writeFileCallIndex('/sys/fs/cgroup/cgroup.subtree_control');
    const parentMkdirOrder = mkdirCallIndex('/sys/fs/cgroup/awf-cloud-hypervisor');
    const parentEnableOrder = writeFileCallIndex('/sys/fs/cgroup/awf-cloud-hypervisor/cgroup.subtree_control');
    const leafMkdirOrder = mkdirCallIndex('/sys/fs/cgroup/awf-cloud-hypervisor/run-1');

    expect(parentMkdirOrder).toBeGreaterThan(rootEnableOrder);
    expect(parentEnableOrder).toBeGreaterThan(parentMkdirOrder);
    expect(leafMkdirOrder).toBeGreaterThan(parentEnableOrder);
  });

  it('writes cgroup v2 memory/cpu/pids limits derived from the guest configuration', async () => {
    const deps = dependencies();
    const cgroup = new CloudHypervisorCgroup(
      '/sys/fs/cgroup/awf-cloud-hypervisor/run-1',
      { memoryMib: 512, vcpuCount: 2 },
      deps,
    );
    await cgroup.setup();

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/sys/fs/cgroup/awf-cloud-hypervisor/run-1/memory.max',
      String((512 + 256) * 1024 * 1024),
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/sys/fs/cgroup/awf-cloud-hypervisor/run-1/cpu.max',
      '200000 100000',
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/sys/fs/cgroup/awf-cloud-hypervisor/run-1/pids.max',
      '256',
    );
  });

  it('assigns a PID into cgroup.procs and rejects invalid PIDs', async () => {
    const deps = dependencies();
    const cgroup = new CloudHypervisorCgroup('/sys/fs/cgroup/awf-cloud-hypervisor/run-1', { memoryMib: 512, vcpuCount: 2 }, deps);
    await cgroup.assign(4321);
    expect(deps.writeFile).toHaveBeenCalledWith('/sys/fs/cgroup/awf-cloud-hypervisor/run-1/cgroup.procs', '4321');

    await expect(cgroup.assign(0)).rejects.toThrow(/invalid PID/);
    await expect(cgroup.assign(-5)).rejects.toThrow(/invalid PID/);
  });

  it('only rmdirs the leaf cgroup directory (never a recursive removal) if setup succeeded', async () => {
    const deps = dependencies();
    const cgroup = new CloudHypervisorCgroup('/sys/fs/cgroup/awf-cloud-hypervisor/run-1', { memoryMib: 512, vcpuCount: 2 }, deps);
    await cgroup.cleanup();
    expect(deps.rmdir).not.toHaveBeenCalled();

    await cgroup.setup();
    await cgroup.cleanup();
    expect(deps.rmdir).toHaveBeenCalledWith('/sys/fs/cgroup/awf-cloud-hypervisor/run-1');
    expect(deps.rmdir).toHaveBeenCalledTimes(1);
  });
});
