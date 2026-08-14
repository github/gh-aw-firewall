import {
  LinuxNetworkCommands,
} from './network-commands';
import {
  MicrovmNetworkManager,
} from './network-manager';
import {
  createMicrovmNetworkPlan,
  generateMicrovmNftRuleset,
} from './network-plan';
import type {
  MicrovmConnectivityProbe,
  MicrovmNetworkCommandOptions,
  MicrovmNetworkPlan,
  MicrovmNetworkRulesetFile,
} from './network-types';

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
    const withControls = createPlan('control-peers', {
      controlPeers: [
        { ip: '172.30.0.60', ports: [8080] },
        { ip: '172.30.0.61', ports: [9090] },
      ],
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
    expect(withControls.allowedEndpoints).toEqual(expect.arrayContaining([
      { name: 'control-peer', ip: '172.30.0.60', port: 8080 },
      { name: 'control-peer', ip: '172.30.0.61', port: 9090 },
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
    // `counter` on these rules is purely diagnostic (nft -a list ruleset
    // then reports packet/byte hit counts per rule) and does not change
    // any accept/drop decision — see generateMicrovmNftRuleset's comment.
    expect(ruleset).toContain('ct state invalid counter drop');
    expect(ruleset).toContain(
      `iifname "${plan.tapName}" ether saddr != ${plan.guestMac} counter drop`,
    );
    expect(ruleset).toContain(
      `iifname "${plan.tapName}" ip saddr != ${plan.guestIp} counter drop`,
    );
    expect(ruleset).toContain('ip daddr 169.254.0.0/16 counter drop');
    expect(ruleset).toContain('ip daddr 224.0.0.0/4 counter drop');
    expect(ruleset).toContain('ip daddr 172.30.0.1 counter drop');
    expect(ruleset).toContain('udp dport 53 counter drop');
    expect(ruleset).toContain('tcp dport 53 counter drop');
    expect(ruleset).toContain('ct state established,related counter accept');
    expect(ruleset).toContain('ip daddr 172.30.0.10 tcp dport 3128');
    for (let port = 10000; port <= 10004; port += 1) {
      expect(ruleset).toContain(`ip daddr 172.30.0.30 tcp dport ${port}`);
    }
    expect(ruleset).not.toContain('masquerade');
    expect(ruleset).not.toContain('flush ruleset');
    expect(ruleset).not.toMatch(/ip daddr 0\.0\.0\.0\/0.*accept/);
  });

  it('registers a prerouting nat hook so return traffic is un-SNAT-ed', () => {
    // Regression coverage: a live-KVM connectivity investigation proved
    // (via packet capture + per-rule hit counters) that without an
    // explicit `prerouting` chain of type nat, nftables never applies
    // conntrack's automatic reverse-SNAT translation to a reply packet
    // (e.g. Squid's SYN-ACK) -- it keeps the SNAT'd destination address
    // all the way to the forward chain, never matches the
    // "ct state established,related" accept rule (which expects the
    // guest's real IP), and is silently dropped by forward's own
    // default policy with zero visible drop counters anywhere. The
    // presence of this hook (not any specific rule inside it -- reverse
    // translation is automatic once the hook exists) is what fixes it.
    const plan = createPlan();
    const ruleset = generateMicrovmNftRuleset(plan);

    expect(ruleset).toContain('chain prerouting {');
    expect(ruleset).toContain('type nat hook prerouting priority dstnat; policy accept;');
  });

  it('accepts return traffic on ip daddr + ct state alone, without an impossible ether daddr match', () => {
    // Regression coverage: the return-leg accept rule previously also
    // required `ether daddr <guest-mac>`. At the forward hook this
    // reflects the *incoming* frame's own L2 destination as it arrived on
    // the veth (this veth's own kernel-assigned MAC), never the guest's
    // MAC -- the guest's MAC is only ever a real L2 identity on the
    // *other* side of the tap device, a separate L2 segment entirely.
    // That condition could therefore never match any real reply packet
    // (proven live: Squid's SYN-ACK reaching this veth, yet matching
    // neither this accept rule nor even the ct-state-invalid drop),
    // silently discarding every response via the chain's own default
    // policy. Removing it is what actually fixes the live guest<->Squid
    // connection, on top of the prerouting nat hook above.
    const plan = createPlan();
    const ruleset = generateMicrovmNftRuleset(plan);
    const returnLine = ruleset
      .split('\n')
      .find(
        (line) =>
          line.includes(`iifname "${plan.namespaceVethName}"`) &&
          line.includes(`oifname "${plan.tapName}"`),
      );

    expect(returnLine).toBeDefined();
    expect(returnLine).not.toContain('ether daddr');
    expect(returnLine).toContain(`ip daddr ${plan.guestIp}`);
    expect(returnLine).toContain('ct state established,related counter accept');
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
    // Docker's own "same bridge" forwarding accept rule does not reliably
    // match traffic from this manually-injected veth (see
    // ensureBridgeForwardAcceptRule's doc comment), so a scoped
    // DOCKER-USER rule is inserted for this exact bridge (after "link set
    // hostVeth up", calls[4]): first checked (-C, absent in this mock so
    // it "fails"/doesn't already exist), then inserted (-I).
    expect(calls[5].args).toEqual([
      '-t', 'filter', '-C', 'DOCKER-USER',
      '-i', plan.infrastructureBridge, '-o', plan.infrastructureBridge,
      '-j', 'ACCEPT',
    ]);
    expect(calls[6].args).toEqual([
      '-t', 'filter', '-I', 'DOCKER-USER', '1',
      '-i', plan.infrastructureBridge, '-o', plan.infrastructureBridge,
      '-j', 'ACCEPT',
    ]);
    expect(calls[7].args).toEqual([
      'netns', 'exec', plan.namespaceName, 'ip',
      'tuntap', 'add',
      'dev', plan.tapName,
      'mode', 'tap',
      'user', '1000',
      'group', '1000',
    ]);
    expect(calls[13].args).toContain('net.ipv4.ip_forward=1');
    expect(calls[14].args).toContain('net.ipv6.conf.all.disable_ipv6=1');
    expect(calls[15].args).toContain('net.ipv6.conf.default.disable_ipv6=1');
    // The ruleset is written to a real temporary file and passed by path
    // (not piped via "-f -") — see LinuxNetworkCommands.nftInNamespace's
    // MicrovmNetworkRulesetFile doc comment for why.
    expect(calls[16].command).toBe('ip');
    expect(calls[16].args.slice(0, 4)).toEqual(['netns', 'exec', plan.namespaceName, 'nft']);
    expect(calls[16].args[4]).toBe('-f');
    expect(calls[16].args[5]).toMatch(/awf-nft-[0-9a-f]{16}\.nft$/);
    expect(calls[16].options).toEqual({ reject: true });
    expect(probe.verify).toHaveBeenCalledWith(plan);
  });

  it.each([
    '172.30.0.0',
    '172.30.0.0/24/extra',
  ])('rejects malformed infrastructure CIDR %s before executing commands', async (infrastructureCidr) => {
    const plan = {
      ...createPlan(),
      infrastructureCidr,
    };
    const { calls, commands } = commandHarness();

    await expect(new MicrovmNetworkManager(plan, commands).setup())
      .rejects.toThrow(`Invalid microVM infrastructure CIDR: ${infrastructureCidr}`);
    expect(calls).toEqual([]);
  });

  it('creates the TAP with vnet_hdr only when the plan opts in (Cloud Hypervisor requires it; Firecracker does not)', async () => {
    // Regression test: Cloud Hypervisor's own tap handling
    // (Tap::open_named() in net_util/src/tap.rs) always re-opens the tap
    // with IFF_VNET_HDR requested. If the tap wasn't *created* with that
    // feature available, the host and Cloud Hypervisor disagree on frame
    // layout for the host-to-guest direction: guest-to-host traffic (and
    // the host-side veth/nft layer) keeps working, but host-to-guest
    // traffic silently never reaches the guest -- observed live as a tap
    // RX=10 packets / TX=1 packet asymmetry despite response packets
    // already having arrived on the host-side veth. Firecracker's own tap
    // handling does not request IFF_VNET_HDR, so this flag defaults to
    // false (unchanged prior behavior) and is opted into explicitly.
    const withVnetHdr = createPlan('run-vnet-hdr', { tapVnetHdr: true });
    const { calls: vnetHdrCalls, commands: vnetHdrCommands } = commandHarness();
    await new MicrovmNetworkManager(withVnetHdr, vnetHdrCommands).setup();
    const vnetHdrTapCall = vnetHdrCalls.find((call) => call.args.includes('tuntap'));
    expect(vnetHdrTapCall?.args).toEqual([
      'netns', 'exec', withVnetHdr.namespaceName, 'ip',
      'tuntap', 'add',
      'dev', withVnetHdr.tapName,
      'mode', 'tap',
      'user', '1000',
      'group', '1000',
      'vnet_hdr',
    ]);

    const withoutVnetHdr = createPlan('run-no-vnet-hdr');
    expect(withoutVnetHdr.tapVnetHdr).toBe(false);
    const { calls: plainCalls, commands: plainCommands } = commandHarness();
    await new MicrovmNetworkManager(withoutVnetHdr, plainCommands).setup();
    const plainTapCall = plainCalls.find((call) => call.args.includes('tuntap'));
    expect(plainTapCall?.args).not.toContain('vnet_hdr');
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

  it('captureDiagnostics delegates to the namespace and host bridge once setup completes, and is empty before/after', async () => {
    const plan = createPlan();
    const { commands } = commandHarness();
    const manager = new MicrovmNetworkManager(plan, commands);

    // Before setup(), there's no namespace to inspect.
    expect(await manager.captureDiagnostics()).toBe('');

    await manager.setup();
    const captureSpy = jest.spyOn(commands, 'captureDiagnosticsInNamespace')
      .mockResolvedValue('--- nft -a list ruleset ---\n(fake)');
    const bridgeSpy = jest.spyOn(commands, 'captureHostBridgeDiagnostics')
      .mockResolvedValue('--- bridge fdb show br awfbr0 ---\n(fake fdb)');
    expect(await manager.captureDiagnostics()).toBe(
      '--- nft -a list ruleset ---\n(fake)\n--- bridge fdb show br awfbr0 ---\n(fake fdb)',
    );
    expect(captureSpy).toHaveBeenCalledWith(plan.namespaceName);
    expect(bridgeSpy).toHaveBeenCalledWith(plan.infrastructureBridge);

    await manager.cleanup();
    expect(await manager.captureDiagnostics()).toBe('');
  });

  it('inserts a scoped DOCKER-USER accept rule for the bridge during setup and removes it during cleanup', async () => {
    // Regression test: live-KVM validation found traffic between our
    // manually-injected veth and Docker-managed containers (Squid, the
    // API proxy) on the same bridge was silently dropped by the host's
    // FORWARD chain default-drop policy -- Docker's own generated "same
    // bridge" accept rule in DOCKER-FORWARD never matched real traffic
    // in this environment (confirmed via Squid's own access log showing
    // zero incoming connection attempts, despite the microVM's own
    // nftables table already accepting the traffic outbound). A scoped
    // DOCKER-USER rule (both iif/oif = this exact bridge) fixes this
    // without weakening any other bridge's isolation.
    const plan = createPlan();
    const { calls, commands } = commandHarness();
    const manager = new MicrovmNetworkManager(plan, commands);

    await manager.setup();
    const insertCall = calls.find((call) => call.args.includes('-I'));
    expect(insertCall?.args).toEqual([
      '-t', 'filter', '-I', 'DOCKER-USER', '1',
      '-i', plan.infrastructureBridge, '-o', plan.infrastructureBridge,
      '-j', 'ACCEPT',
    ]);

    await manager.cleanup();
    const deleteCall = calls.find((call) => call.args.includes('-D'));
    expect(deleteCall?.args).toEqual([
      '-t', 'filter', '-D', 'DOCKER-USER',
      '-i', plan.infrastructureBridge, '-o', plan.infrastructureBridge,
      '-j', 'ACCEPT',
    ]);
    // Removal must be tolerant of the rule already being gone (e.g. a
    // partial-setup rollback before the rule was ever inserted).
    expect(deleteCall?.options).toEqual({ reject: false });
  });

  it('skips inserting the DOCKER-USER accept rule when a check shows it already exists', async () => {
    const plan = createPlan();
    const executeCalls: string[][] = [];
    const commands = new LinuxNetworkCommands(
      jest.fn(async (_command, args) => {
        executeCalls.push(args as string[]);
        if (args.includes('-C')) return { exitCode: 0 };
        return undefined;
      }),
    );

    await new MicrovmNetworkManager(plan, commands).setup();

    expect(executeCalls.some((args) => args.includes('-I'))).toBe(false);
  });
});

describe('LinuxNetworkCommands.ensureBridgeForwardAcceptRule / removeBridgeForwardAcceptRule', () => {
  it('inserts the rule only when the existence check does not already report it present', async () => {
    const calls: { args: readonly string[] }[] = [];
    const commands = new LinuxNetworkCommands(
      jest.fn(async (_command, args) => {
        calls.push({ args });
        if (args.includes('-C')) return { exitCode: 1 };
        return { exitCode: 0 };
      }),
    );

    await commands.ensureBridgeForwardAcceptRule('awfbr0');

    expect(calls).toEqual([
      { args: ['-t', 'filter', '-C', 'DOCKER-USER', '-i', 'awfbr0', '-o', 'awfbr0', '-j', 'ACCEPT'] },
      { args: ['-t', 'filter', '-I', 'DOCKER-USER', '1', '-i', 'awfbr0', '-o', 'awfbr0', '-j', 'ACCEPT'] },
    ]);
  });

  it('does not insert the rule again when the existence check reports it already present', async () => {
    const calls: { args: readonly string[] }[] = [];
    const commands = new LinuxNetworkCommands(
      jest.fn(async (_command, args) => {
        calls.push({ args });
        return { exitCode: 0 };
      }),
    );

    await commands.ensureBridgeForwardAcceptRule('awfbr0');

    expect(calls).toEqual([
      { args: ['-t', 'filter', '-C', 'DOCKER-USER', '-i', 'awfbr0', '-o', 'awfbr0', '-j', 'ACCEPT'] },
    ]);
  });

  it('removeBridgeForwardAcceptRule never throws even if the rule is already gone', async () => {
    const commands = new LinuxNetworkCommands(
      jest.fn(async () => {
        throw new Error('Bad rule (does a matching rule exist in that chain?)');
      }),
    );

    await expect(commands.removeBridgeForwardAcceptRule('awfbr0')).resolves.toBeUndefined();
  });
});

describe('LinuxNetworkCommands.nftInNamespace ruleset file handling', () => {
  // Regression coverage: nft -f - can fail with `Not a regular file:
  // "/dev/stdin"` on nftables builds that open /dev/stdin directly rather
  // than reading the already-piped fd 0 (observed on GitHub-hosted Ubuntu
  // runners). The ruleset must be written to a real temp file and passed
  // by path instead.
  function rulesetFileHarness(): {
    rulesetFile: jest.Mocked<MicrovmNetworkRulesetFile>;
    calls: CommandCall[];
    commands: LinuxNetworkCommands;
  } {
    const calls: CommandCall[] = [];
    const rulesetFile: jest.Mocked<MicrovmNetworkRulesetFile> = {
      write: jest.fn(async (contents: string) => `/tmp/awf-nft-fake.nft:${contents.length}`),
      remove: jest.fn(async (_rulesetPath: string) => undefined),
    };
    const commands = new LinuxNetworkCommands(
      jest.fn(async (command, args, options) => {
        calls.push({ command, args, options });
      }),
      undefined,
      rulesetFile,
    );
    return { rulesetFile, calls, commands };
  }

  it('writes the ruleset to a file and passes its path instead of "-f -"', async () => {
    const { rulesetFile, calls, commands } = rulesetFileHarness();
    await commands.nftInNamespace('awffc-test', ['-f', '-'], 'table inet awf {}');

    expect(rulesetFile.write).toHaveBeenCalledWith('table inet awf {}');
    expect(calls).toEqual([{
      command: 'ip',
      args: ['netns', 'exec', 'awffc-test', 'nft', '-f', '/tmp/awf-nft-fake.nft:17'],
      options: { reject: true },
    }]);
  });

  it('removes the temp file after a successful nft invocation', async () => {
    const { rulesetFile, commands } = rulesetFileHarness();
    await commands.nftInNamespace('awffc-test', ['-f', '-'], 'table inet awf {}');

    expect(rulesetFile.remove).toHaveBeenCalledWith('/tmp/awf-nft-fake.nft:17');
  });

  it('still removes the temp file when the nft invocation fails', async () => {
    const rulesetFile: jest.Mocked<MicrovmNetworkRulesetFile> = {
      write: jest.fn(async (_contents: string) => '/tmp/awf-nft-fake.nft'),
      remove: jest.fn(async (_rulesetPath: string) => undefined),
    };
    const commands = new LinuxNetworkCommands(
      jest.fn(async () => {
        throw new Error('nft rejected the ruleset');
      }),
      undefined,
      rulesetFile,
    );

    await expect(
      commands.nftInNamespace('awffc-test', ['-f', '-'], 'table inet awf {}'),
    ).rejects.toThrow('nft rejected the ruleset');
    expect(rulesetFile.remove).toHaveBeenCalledWith('/tmp/awf-nft-fake.nft');
  });

  it('skips ruleset file handling entirely when no input is given', async () => {
    const { rulesetFile, calls, commands } = rulesetFileHarness();
    await commands.nftInNamespace('awffc-test', ['list', 'ruleset']);

    expect(rulesetFile.write).not.toHaveBeenCalled();
    expect(rulesetFile.remove).not.toHaveBeenCalled();
    expect(calls).toEqual([{
      command: 'ip',
      args: ['netns', 'exec', 'awffc-test', 'nft', 'list', 'ruleset'],
      options: { reject: true },
    }]);
  });

  it('the default ruleset file performs a real fs write/remove round trip', async () => {
    // Exercises the real (non-mocked) MicrovmNetworkRulesetFile end to end
    // against the OS temp directory, catching issues a fully-mocked
    // executor test would miss (e.g. permission or path-construction bugs).
    const commands = new LinuxNetworkCommands(
      jest.fn(async () => undefined),
    );
    await expect(
      commands.nftInNamespace('awffc-real-fs-test', ['-f', '-'], 'table inet awf { }'),
    ).resolves.toBeUndefined();
  });
});

describe('LinuxNetworkCommands.captureDiagnosticsInNamespace', () => {
  // Regression coverage: a live-KVM connectivity failure investigation
  // found bare exit codes insufficient to diagnose whether a guest's
  // packets ever reached the tap/veth or were dropped by an nftables
  // forward-chain rule. This best-effort, read-only capture surfaces both
  // the live ruleset and interface counters for that triage.
  it('combines nft/link/route/neighbor/fdb diagnostics into one report', async () => {
    const commands = new LinuxNetworkCommands(
      jest.fn(async (_command, args) => {
        if (args.includes('nft')) {
          return { stdout: 'table inet awf_fc_abc123 { chain forward { ... } }' };
        }
        if (args.includes('-s') && args.includes('link')) {
          return { stdout: '2: eth0: <UP> ... RX: 0 bytes 0 packets' };
        }
        if (args.includes('-d') && args.includes('link')) {
          return { stdout: '2: eth0: <UP> ... vnet_hdr' };
        }
        if (args.includes('route')) {
          return { stdout: 'default via 100.64.0.1 dev tap0' };
        }
        if (args.includes('neigh')) {
          return { stdout: '100.64.0.1 dev tap0 lladdr 02:00:00:00:00:01 REACHABLE' };
        }
        if (args.includes('bridge')) {
          return { stdout: '02:00:00:00:00:01 dev tap0 master awfbr0' };
        }
        if (args.includes('conntrack')) {
          return { stdout: 'tcp 6 100 ESTABLISHED src=100.64.0.2 dst=172.30.0.10' };
        }
        if (args.some((a) => a.includes('rp_filter'))) {
          return { stdout: '/proc/sys/net/ipv4/conf/tap0/rp_filter=1' };
        }
        return { stdout: '' };
      }),
    );

    const result = await commands.captureDiagnosticsInNamespace('awffc-test');

    expect(result).toContain('--- nft -a list ruleset (handles + hit counters) ---');
    expect(result).toContain('table inet awf_fc_abc123');
    expect(result).toContain('--- ip -s link show (packet/byte/error counters) ---');
    expect(result).toContain('RX: 0 bytes 0 packets');
    expect(result).toContain('--- ip -d link show (detailed link info, incl. vnet_hdr/multiqueue flags) ---');
    expect(result).toContain('vnet_hdr');
    expect(result).toContain('--- ip route show ---');
    expect(result).toContain('default via 100.64.0.1 dev tap0');
    expect(result).toContain('--- ip neigh show (ARP/neighbor table) ---');
    expect(result).toContain('REACHABLE');
    expect(result).toContain('--- bridge fdb show (forwarding database) ---');
    expect(result).toContain('master awfbr0');
    expect(result).toContain('--- conntrack -L (connection tracking table state for this namespace) ---');
    expect(result).toContain('ESTABLISHED src=100.64.0.2');
    expect(result).toContain('--- rp_filter (reverse-path filter mode) per interface in this namespace: 0=off 1=strict 2=loose ---');
    expect(result).toContain('rp_filter=1');
  });

  it('never throws and reports unavailability when a command fails', async () => {
    const commands = new LinuxNetworkCommands(
      jest.fn(async () => {
        throw new Error('ip netns exec failed: No such file or directory');
      }),
    );

    const result = await commands.captureDiagnosticsInNamespace('awffc-test');

    expect(result).toContain('(empty or unavailable)');
  });
});

describe('LinuxNetworkCommands.captureHostBridgeDiagnostics', () => {
  // Regression coverage: Docker (and any other host-level firewall)
  // manages its own iptables/nftables rules in the default (root) network
  // namespace, entirely separate from the microVM's own table. Those
  // rules could independently drop/alter traffic on the shared bridge in
  // a way the microVM's own nftables counters would never reveal, so this
  // capture must also check the host-level ruleset (both nft and legacy
  // iptables, since Docker may configure either backend).
  it('combines bridge fdb, host nftables ruleset, legacy iptables rules, and bridge-netfilter sysctls', async () => {
    const commands = new LinuxNetworkCommands(
      jest.fn(async (command, args) => {
        if (command === 'bridge') return { stdout: 'aa:bb:cc:dd:ee:ff dev vethX master awfbr0' };
        if (command === 'nft') return { stdout: 'table ip docker { ... }' };
        if (command === 'iptables' && args.includes('-S')) {
          return { stdout: '-P FORWARD DROP\n-A DOCKER-USER -j RETURN' };
        }
        if (command === 'sysctl') {
          return { stdout: 'net.bridge.bridge-nf-call-iptables = 1\nnet.bridge.bridge-nf-call-ip6tables = 1' };
        }
        if (command === 'ip' && args.includes('-s') && args.includes('link')) {
          return { stdout: '5: vethX@if4: <UP> ... RX: 10 bytes 1 packets' };
        }
        return { stdout: '' };
      }),
    );

    const result = await commands.captureHostBridgeDiagnostics('awfbr0');

    expect(result).toContain('--- bridge fdb show br awfbr0 (host-side, outside any netns) ---');
    expect(result).toContain('master awfbr0');
    expect(result).toContain('--- nft -a list ruleset (host/default namespace');
    expect(result).toContain('table ip docker');
    expect(result).toContain('--- iptables -S (host/default namespace');
    expect(result).toContain('-P FORWARD DROP');
    expect(result).toContain('--- sysctl net.bridge.bridge-nf-call-* ');
    expect(result).toContain('net.bridge.bridge-nf-call-iptables = 1');
    expect(result).toContain('--- ip -s link show (host/default namespace: per-port RX/TX counters, incl. container veths) ---');
    expect(result).toContain('RX: 10 bytes 1 packets');
  });

  it('never throws and reports unavailability when a command fails', async () => {
    const commands = new LinuxNetworkCommands(
      jest.fn(async () => {
        throw new Error('command not found');
      }),
    );

    const result = await commands.captureHostBridgeDiagnostics('awfbr0');

    expect(result).toContain('(empty or unavailable)');
  });
});
