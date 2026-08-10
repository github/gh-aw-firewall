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
    cloudHypervisorBinary: '/opt/cloud-hypervisor',
    apiSocketPath: '/run/awf/api.socket',
    logFilePath: '/run/awf/cloud-hypervisor.log',
  };

  it('joins the namespace, drops privileges, then execs Cloud Hypervisor with no shell', () => {
    const result = buildCloudHypervisorLaunchCommand(baseOptions);
    expect(result.command).toBe('/usr/sbin/ip');
    expect(result.args).toEqual([
      'netns', 'exec', 'awfch-abc123',
      '/usr/bin/setpriv',
      '--reuid=1000',
      '--regid=1000',
      '--clear-groups',
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
    // No argument contains shell metacharacters that would matter if ever
    // interpolated; more importantly, args are a plain array (never joined
    // into a shell string) so metacharacters have no special meaning here.
    expect(result.args.every((arg) => typeof arg === 'string')).toBe(true);
  });

  it.each([
    ['unsafe namespace name', { namespaceName: '../etc' }, /Unsafe Cloud Hypervisor network namespace name/],
    ['zero uid', { identity: { uid: 0, gid: 1000 } }, /uid must be a positive integer/],
    ['negative gid', { identity: { uid: 1000, gid: -1 } }, /gid must be a positive integer/],
    ['relative binary path', { cloudHypervisorBinary: 'cloud-hypervisor' }, /binary path must be absolute/],
    ['relative socket path', { apiSocketPath: 'api.socket' }, /API socket path must be absolute/],
  ])('rejects %s', (_label, overrides, error) => {
    expect(() => buildCloudHypervisorLaunchCommand({ ...baseOptions, ...overrides }))
      .toThrow(error);
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
    rm: jest.Mock;
  } {
    return {
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn().mockResolvedValue(undefined),
      rm: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('writes cgroup v2 memory/cpu/pids limits derived from the guest configuration', async () => {
    const deps = dependencies();
    const cgroup = new CloudHypervisorCgroup(
      '/sys/fs/cgroup/awf/run-1',
      2,
      { memoryMib: 512, vcpuCount: 2 },
      deps,
    );
    await cgroup.setup();

    expect(deps.mkdir).toHaveBeenCalledWith('/sys/fs/cgroup/awf/run-1');
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/sys/fs/cgroup/awf/run-1/memory.max',
      String((512 + 256) * 1024 * 1024),
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/sys/fs/cgroup/awf/run-1/cpu.max',
      '200000 100000',
    );
    expect(deps.writeFile).toHaveBeenCalledWith('/sys/fs/cgroup/awf/run-1/pids.max', '256');
  });

  it('writes cgroup v1 equivalents', async () => {
    const deps = dependencies();
    const cgroup = new CloudHypervisorCgroup(
      '/sys/fs/cgroup/memory/awf/run-1',
      1,
      { memoryMib: 1024, vcpuCount: 1 },
      deps,
    );
    await cgroup.setup();

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/sys/fs/cgroup/memory/awf/run-1/memory.limit_in_bytes',
      String((1024 + 256) * 1024 * 1024),
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/sys/fs/cgroup/memory/awf/run-1/cpu.cfs_quota_us',
      '100000',
    );
  });

  it('assigns a PID into cgroup.procs and rejects invalid PIDs', async () => {
    const deps = dependencies();
    const cgroup = new CloudHypervisorCgroup('/sys/fs/cgroup/awf/run-1', 2, { memoryMib: 512, vcpuCount: 2 }, deps);
    await cgroup.assign(4321);
    expect(deps.writeFile).toHaveBeenCalledWith('/sys/fs/cgroup/awf/run-1/cgroup.procs', '4321');

    await expect(cgroup.assign(0)).rejects.toThrow(/invalid PID/);
    await expect(cgroup.assign(-5)).rejects.toThrow(/invalid PID/);
  });

  it('only removes the cgroup directory if setup succeeded', async () => {
    const deps = dependencies();
    const cgroup = new CloudHypervisorCgroup('/sys/fs/cgroup/awf/run-1', 2, { memoryMib: 512, vcpuCount: 2 }, deps);
    await cgroup.cleanup();
    expect(deps.rm).not.toHaveBeenCalled();

    await cgroup.setup();
    await cgroup.cleanup();
    expect(deps.rm).toHaveBeenCalledWith('/sys/fs/cgroup/awf/run-1');
  });
});
