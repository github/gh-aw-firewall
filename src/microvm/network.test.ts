import {
  LinuxNetworkCommands,
  MicrovmNetworkManager,
  createMicrovmNetworkPlan,
  generateMicrovmNftRuleset,
  type MicrovmConnectivityProbe,
  type MicrovmNetworkCommandOptions,
  type MicrovmNetworkPlan,
} from './network';

interface CommandCall {
  command: string;
  args: readonly string[];
  options: MicrovmNetworkCommandOptions;
}

function createPlan(
  runId = 'run-123',
  overrides: Partial<Parameters<typeof createMicrovmNetworkPlan>[1]> = {},
): MicrovmNetworkPlan {
  return createMicrovmNetworkPlan(runId, {
    infrastructureBridge: 'awfbr0',
    enableApiProxy: true,
    tapOwnerUid: 1000,
    tapOwnerGid: 1000,
    ...overrides,
  });
}

function commandHarness(failAt?: number): {
  calls: CommandCall[];
  commands: LinuxNetworkCommands;
} {
  const calls: CommandCall[] = [];
  let rejectingCall = 0;
  const commands = new LinuxNetworkCommands(
    jest.fn(async (command, args, options) => {
      calls.push({ command, args, options });
      if (options.reject && ++rejectingCall === failAt) {
        throw new Error(`stage ${failAt} failed`);
      }
    }),
  );
  return { calls, commands };
}

describe('microVM network planning', () => {
  it('allocates deterministic, disjoint per-run guest addressing and bounded names', () => {
    const first = createPlan('run-123');
    const same = createPlan('run-123');
    const second = createPlan('run-456');

    expect(first).toEqual(same);
    expect(second.guestSubnet).not.toBe(first.guestSubnet);
    expect(second.guestMac).not.toBe(first.guestMac);
    expect(first.guestSubnet).toMatch(/^100\.(?:6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\.\d+\.\d+\/30$/);
    expect(first.guestGatewayIp).not.toBe(first.guestIp);
    expect(first.infrastructureIp).toBe('172.30.0.20');
    expect(first.infrastructureCidr).toBe('172.30.0.0/24');
    expect(first.netnsPath).toBe(`/var/run/netns/${first.namespaceName}`);
    expect(first.networkInterface).toEqual({
      iface_id: 'eth0',
      host_dev_name: first.tapName,
      guest_mac: first.guestMac,
    });
    for (const name of [
      first.tapName,
      first.hostVethName,
      first.namespaceVethName,
      first.infrastructureBridge,
    ]) {
      expect(name.length).toBeLessThanOrEqual(15);
      expect(name).toMatch(/^[A-Za-z0-9_.-]+$/);
    }
  });

  it('derives exact service endpoints from centralized proxy policy', () => {
    const enabled = createPlan();
    const disabled = createPlan('without-api', { enableApiProxy: false });
    const withControl = createPlan('control-peer', {
      controlPeer: { ip: '172.30.0.60', ports: [8443, 8444] },
    });

    expect(enabled.allowedEndpoints).toEqual([
      { name: 'squid', ip: '172.30.0.10', port: 3128 },
      { name: 'api-proxy-openai', ip: '172.30.0.30', port: 10000 },
      { name: 'api-proxy-anthropic', ip: '172.30.0.30', port: 10001 },
      { name: 'api-proxy-copilot', ip: '172.30.0.30', port: 10002 },
      { name: 'api-proxy-gemini', ip: '172.30.0.30', port: 10003 },
      { name: 'api-proxy-vertex', ip: '172.30.0.30', port: 10004 },
    ]);
    expect(disabled.allowedEndpoints).toEqual([
      { name: 'squid', ip: '172.30.0.10', port: 3128 },
    ]);
    expect(withControl.allowedEndpoints).toEqual(expect.arrayContaining([
      { name: 'control-peer', ip: '172.30.0.60', port: 8443 },
      { name: 'control-peer', ip: '172.30.0.60', port: 8444 },
    ]));
  });

  it('rejects unsafe names, identities, peers, and direct DNS before execution', () => {
    expect(() => createPlan('../escape')).toThrow(/run id/);
    expect(() => createPlan('underscore_is_not_valid')).toThrow(/run id/);
    expect(() => createPlan('a'.repeat(65))).toThrow(/run id/);
    expect(() => createPlan('bad-bridge', {
      infrastructureBridge: 'bridge-name-is-too-long',
    })).toThrow(/IFNAMSIZ/);
    expect(() => createPlan('root-owner', { tapOwnerUid: 0 })).toThrow(/uid/);
    expect(() => createPlan('public-peer', {
      controlPeer: { ip: '8.8.8.8', ports: [443] },
    })).toThrow(/RFC1918/);
    expect(() => createPlan('metadata-peer', {
      controlPeer: { ip: '169.254.169.254', ports: [443] },
    })).toThrow(/RFC1918/);
    expect(() => createPlan('dns-peer', {
      controlPeer: { ip: '172.30.0.60', ports: [53] },
    })).toThrow(/direct DNS/);
    expect(() => createPlan('off-topology-peer', {
      controlPeer: { ip: '10.20.30.40', ports: [8443] },
    })).toThrow(/outside 172\.30\.0\.0\/24/);
  });

  it('rejects a future centralized infrastructure policy that overlaps the guest link', () => {
    const plan = createPlan('overlap-defense');

    expect(() => generateMicrovmNftRuleset({
      ...plan,
      infrastructureCidr: plan.guestSubnet,
      infrastructureIp: plan.guestIp,
    })).toThrow(/guest subnet overlaps infrastructure/);
  });
});

describe('microVM nftables policy', () => {
  it('installs default-drop policy with exact endpoint, identity, and return rules', () => {
    const plan = createPlan();
    const ruleset = generateMicrovmNftRuleset(plan);

    expect(ruleset).toContain(`table inet ${plan.nftTableName}`);
    expect(ruleset.match(/policy drop;/g)).toHaveLength(3);
    expect(ruleset).toContain(
      `iifname "${plan.tapName}" ether saddr != ${plan.guestMac} drop`,
    );
    expect(ruleset).toContain(
      `iifname "${plan.tapName}" ip saddr != ${plan.guestIp} drop`,
    );
    expect(ruleset).toContain('ip daddr 169.254.0.0/16 drop');
    expect(ruleset).toContain('ip daddr 224.0.0.0/4 drop');
    expect(ruleset).toContain('ip daddr 172.30.0.1 drop');
    expect(ruleset).toContain('udp dport 53 drop');
    expect(ruleset).toContain('tcp dport 53 drop');
    expect(ruleset).toContain('ct state established,related accept');
    expect(ruleset).toContain('ip daddr 172.30.0.10 tcp dport 3128');
    for (let port = 10000; port <= 10004; port += 1) {
      expect(ruleset).toContain(`ip daddr 172.30.0.30 tcp dport ${port}`);
    }
    expect(ruleset).not.toContain('masquerade');
    expect(ruleset).not.toContain('flush ruleset');
    expect(ruleset).not.toMatch(/ip daddr 0\.0\.0\.0\/0.*accept/);
  });

  it('emits SNAT only for the same exact allowed destination pairs', () => {
    const plan = createPlan('narrow-snat', { enableApiProxy: false });
    const ruleset = generateMicrovmNftRuleset(plan);
    const snatLines = ruleset.split('\n').filter((line) => line.includes('snat to'));

    expect(snatLines).toEqual([
      expect.stringContaining(
        `ip daddr 172.30.0.10 tcp dport 3128 snat to ${plan.infrastructureIp}`,
      ),
    ]);
  });
});

describe('microVM network lifecycle', () => {
  it('creates the namespace, veth, TAP, forwarding, and atomic policy in order', async () => {
    const plan = createPlan();
    const { calls, commands } = commandHarness();
    const probe: MicrovmConnectivityProbe = {
      verify: jest.fn().mockResolvedValue(undefined),
    };
    const manager = new MicrovmNetworkManager(plan, commands, probe);

    await expect(manager.setup()).resolves.toBe(plan);

    expect(calls[0]).toEqual({
      command: 'ip',
      args: ['netns', 'add', plan.namespaceName],
      options: { reject: true },
    });
    expect(calls[1].args).toEqual([
      'link', 'add', plan.hostVethName,
      'type', 'veth',
      'peer', 'name', plan.namespaceVethName,
    ]);
    expect(calls[2].args).toEqual([
      'link', 'set', plan.namespaceVethName,
      'netns', plan.namespaceName,
    ]);
    expect(calls[3].args).toEqual([
      'link', 'set', plan.hostVethName,
      'master', plan.infrastructureBridge,
    ]);
    expect(calls[5].args).toEqual([
      'netns', 'exec', plan.namespaceName, 'ip',
      'tuntap', 'add',
      'dev', plan.tapName,
      'mode', 'tap',
      'user', '1000',
      'group', '1000',
    ]);
    expect(calls[11].args).toContain('net.ipv4.ip_forward=1');
    expect(calls[12].args).toContain('net.ipv6.conf.all.disable_ipv6=1');
    expect(calls[13].args).toContain('net.ipv6.conf.default.disable_ipv6=1');
    expect(calls[14]).toEqual({
      command: 'ip',
      args: ['netns', 'exec', plan.namespaceName, 'nft', '-f', '-'],
      options: {
        reject: true,
        input: generateMicrovmNftRuleset(plan),
      },
    });
    expect(probe.verify).toHaveBeenCalledWith(plan);
  });

  it('rolls back every partial setup stage with run-specific cleanup', async () => {
    const plan = createPlan('rollback-all');
    const setupStageCount = 15;

    for (let failAt = 1; failAt <= setupStageCount; failAt += 1) {
      const { calls, commands } = commandHarness(failAt);
      const manager = new MicrovmNetworkManager(plan, commands);

      await expect(manager.setup()).rejects.toThrow(`stage ${failAt} failed`);
      const cleanupCalls = calls.filter((call) => call.args.includes('delete'));
      if (failAt === 1) {
        expect(cleanupCalls).toEqual([]);
      } else if (failAt === 2) {
        expect(cleanupCalls).toEqual([{
          command: 'ip',
          args: ['netns', 'delete', plan.namespaceName],
          options: { reject: true },
        }]);
      } else {
        expect(cleanupCalls).toEqual([
          {
            command: 'ip',
            args: ['link', 'delete', plan.hostVethName],
            options: { reject: true },
          },
          {
            command: 'ip',
            args: ['netns', 'delete', plan.namespaceName],
            options: { reject: true },
          },
        ]);
      }
    }
  });

  it('treats a supplied connectivity probe failure as setup failure', async () => {
    const plan = createPlan('probe-failure');
    const { calls, commands } = commandHarness();
    const probe: MicrovmConnectivityProbe = {
      verify: jest.fn().mockRejectedValue(new Error('proxy unreachable')),
    };
    const manager = new MicrovmNetworkManager(plan, commands, probe);

    await expect(manager.setup()).rejects.toThrow('proxy unreachable');
    expect(calls.slice(-1)[0].args).toEqual([
      'netns', 'delete', plan.namespaceName,
    ]);
  });

  it('disconnects the host veth before deleting the namespace and its nft policy', async () => {
    const plan = createPlan('cleanup-twice');
    const { calls, commands } = commandHarness();
    const manager = new MicrovmNetworkManager(plan, commands);

    await manager.setup();
    await manager.cleanup();
    const callsAfterFirstCleanup = calls.length;
    await manager.cleanup();

    expect(calls).toHaveLength(callsAfterFirstCleanup);
    const cleanupCalls = calls.filter((call) => call.args.includes('delete'));
    expect(cleanupCalls).toHaveLength(2);
    expect(cleanupCalls.filter((call) => call.args.includes('delete'))).toEqual([
      expect.objectContaining({
        args: expect.arrayContaining([plan.hostVethName]),
      }),
      expect.objectContaining({
        args: expect.arrayContaining([plan.namespaceName]),
      }),
    ]);
    expect(cleanupCalls.every((call) => call.options.reject)).toBe(true);
    expect(calls.some((call) => call.args.includes('flush'))).toBe(false);
  });

  it('retains the namespace and nft policy for a retry when host veth deletion fails', async () => {
    const plan = createPlan('cleanup-retry');
    let hostVethDeleteFailed = false;
    const { calls, commands } = commandHarness();
    const originalIp = commands.ip.bind(commands);
    jest.spyOn(commands, 'ip').mockImplementation(async (args, reject = true) => {
      if (
        !hostVethDeleteFailed
        && args[0] === 'link'
        && args[1] === 'delete'
        && args[2] === plan.hostVethName
      ) {
        hostVethDeleteFailed = true;
        throw new Error('host veth deletion failed');
      }
      return originalIp(args, reject);
    });
    const manager = new MicrovmNetworkManager(plan, commands);

    await manager.setup();
    await expect(manager.cleanup()).rejects.toThrow('host veth deletion failed');
    expect(calls.some((call) => (
      call.args[0] === 'netns'
      && call.args[1] === 'delete'
      && call.args[2] === plan.namespaceName
    ))).toBe(false);

    await expect(manager.cleanup()).resolves.toBeUndefined();
    expect(calls.filter((call) => (
      call.args[0] === 'netns'
      && call.args[1] === 'delete'
      && call.args[2] === plan.namespaceName
    ))).toHaveLength(1);
  });

  it('retains the namespace for a retry when namespace deletion fails', async () => {
    const plan = createPlan('namespace-retry');
    let namespaceDeleteFailed = false;
    const { calls, commands } = commandHarness();
    const originalIp = commands.ip.bind(commands);
    jest.spyOn(commands, 'ip').mockImplementation(async (args, reject = true) => {
      if (
        !namespaceDeleteFailed
        && args[0] === 'netns'
        && args[1] === 'delete'
        && args[2] === plan.namespaceName
      ) {
        namespaceDeleteFailed = true;
        throw new Error('namespace deletion failed');
      }
      return originalIp(args, reject);
    });
    const manager = new MicrovmNetworkManager(plan, commands);

    await manager.setup();
    await expect(manager.cleanup()).rejects.toThrow('namespace deletion failed');
    await expect(manager.cleanup()).resolves.toBeUndefined();

    expect(calls.filter((call) => (
      call.args[0] === 'netns'
      && call.args[1] === 'delete'
      && call.args[2] === plan.namespaceName
    ))).toHaveLength(1);
  });
});
