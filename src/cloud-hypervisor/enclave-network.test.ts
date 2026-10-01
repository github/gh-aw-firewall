import { resolveCloudHypervisorEnclaveNetwork } from './enclave-network';
import { createAgentEnclaveCloudHypervisorProfile } from './workload-profile';
import { createMicrovmNetworkPlan, generateMicrovmNftRuleset } from '../microvm/network';
import { MicrovmNetworkManager } from '../microvm/network';
import { LinuxNetworkCommands } from '../microvm/network';
import {
  ENCLAVE_MCP_GATEWAY_CONTAINER_ENV,
  ENCLAVE_MCP_GATEWAY_IDENTITY_ENV,
  ENCLAVE_MCP_GATEWAY_RUN_LABEL,
} from '../enclave/gateway';

const guest = {
  exports: [{ tag: 'seed', source: '/seed', target: '/seed', mode: 'ro' as const }],
  supervisorBinaryPath: '/opt/awf-supervisor',
  supervisorSha256: 'a'.repeat(64),
  workspaceMount: null as null,
};

function profile(
  github = false,
  engine: 'copilot' | 'claude' | 'codex' | 'gemini' = 'copilot',
  providerProfile: 'openai' | 'anthropic' = 'anthropic',
) {
  return createAgentEnclaveCloudHypervisorProfile({
    enclaveId: 'agent-entry',
    invocationId: 'invocation-1',
    guest,
    apiProxy: { ip: '172.31.0.30', engine, profile: providerProfile },
    ...(github ? { githubDataPlane: { ip: '172.31.0.40', port: 8080 } } : {}),
  });
}

function inspection(github = false) {
  const network = {
    Name: 'awf-enclave-agent',
    Id: 'a'.repeat(64),
    Driver: 'bridge',
    Scope: 'local',
    Internal: true,
    IPAM: { Config: [{ Subnet: '172.31.0.0/24' }] },
    Containers: {
      proxy: { Name: 'awf-enclave-agent-api-proxy', IPv4Address: '172.31.0.30/24' },
      ...(github ? {
        gateway: { Name: 'awmg-mcpg', IPv4Address: '172.31.0.40/24' },
      } : {}),
    },
  };
  const dependencies = {
    inspectNetwork: jest.fn(async () => [network]),
    inspectContainer: jest.fn(async () => ({
      Name: '/awmg-mcpg',
      State: { Running: true },
      Config: { Labels: { [ENCLAVE_MCP_GATEWAY_RUN_LABEL]: 'run-identity-123' } },
    })),
    inspectBridge: jest.fn(async () => [
      { ifname: 'br-aaaaaaaaaaaa', linkinfo: { info_kind: 'bridge' } },
    ]),
  };
  return { network, dependencies };
}

const tools = { docker: '/usr/bin/docker', ip: '/usr/sbin/ip' };

describe('Cloud Hypervisor agent-enclave host network boundary', () => {
  it.each([false, true])('admits only selected proxy and optional GitHub data plane (github=%s)', async (github) => {
    const { dependencies } = inspection(github);
    const options = await resolveCloudHypervisorEnclaveNetwork(profile(github), tools, dependencies, {
      [ENCLAVE_MCP_GATEWAY_CONTAINER_ENV]: 'awmg-mcpg',
      [ENCLAVE_MCP_GATEWAY_IDENTITY_ENV]: 'run-identity-123',
    });
    expect(dependencies.inspectNetwork).toHaveBeenCalledWith(tools.docker);
    expect(dependencies.inspectBridge).toHaveBeenCalledWith(tools.ip, 'br-aaaaaaaaaaaa');
    expect(dependencies.inspectContainer).toHaveBeenCalledTimes(github ? 1 : 0);
    const plan = createMicrovmNetworkPlan('enclave-run', {
      ...options, tapOwnerUid: 2001, tapOwnerGid: 2002, tapVnetHdr: true,
    });
    expect(plan.mode).toBe('enclave-agent');
    expect(plan.infrastructureBridge).toBe('br-aaaaaaaaaaaa');
    expect(plan.infrastructureCidr).toBe('172.31.0.0/24');
    expect(plan.allowedEndpoints).toEqual([
      { name: 'enclave-api-proxy', ip: '172.31.0.30', port: 10002 },
      ...(github ? [{ name: 'github-data-plane', ip: '172.31.0.40', port: 8080 }] : []),
    ]);

    const rules = generateMicrovmNftRuleset(plan);
    const forward = rules.split('  chain forward {')[1].split('  chain prerouting {')[0];
    const allowed = forward.split('\n').filter((line) =>
      line.includes(`iifname "${plan.tapName}"`) && line.includes('counter accept'));
    expect(allowed).toEqual(plan.allowedEndpoints.map((peer) =>
      `    iifname "${plan.tapName}" oifname "${plan.namespaceVethName}" ` +
      `ether saddr ${plan.guestMac} ip saddr ${plan.guestIp} ` +
      `ip daddr ${peer.ip} tcp dport ${peer.port} ct state new,established counter accept`));
    expect(rules).toContain('type filter hook forward priority filter; policy drop;');
    expect(rules).toContain(`iifname "${plan.tapName}" udp dport 53 counter drop`);
    expect(rules).toContain(`iifname "${plan.tapName}" tcp dport 53 counter drop`);
    expect(rules).toContain(`iifname "${plan.tapName}" ip daddr ${plan.hostGatewayIp} counter drop`);
    for (const forbidden of [
      '172.30.0.10', '172.30.0.20', '172.30.0.30', '127.0.0.1',
      '169.254.169.254', '8.8.8.8', '172.31.0.1', '172.31.0.99',
    ]) {
      expect(allowed.join('\n')).not.toContain(`ip daddr ${forbidden} tcp dport`);
    }
    expect(allowed.join('\n')).not.toContain('tcp dport 18443');
    expect(allowed.join('\n')).not.toContain('tcp dport 8081');
    expect(allowed.join('\n')).not.toContain('tcp dport 10000');
    expect(allowed.join('\n')).not.toContain('tcp dport 10001');
    expect(rules.split('\n').filter((line) => line.includes('snat to')))
      .toHaveLength(plan.allowedEndpoints.length);
  });

  it.each([
    '10000', '10001', '10002',
  ])('permits the supported selected engine port %s without opening others', async (port) => {
    const selected = {
      '10000': ['codex', 'openai'],
      '10001': ['claude', 'anthropic'],
      '10002': ['copilot', 'anthropic'],
    }[port] as ['copilot' | 'claude' | 'codex' | 'gemini', 'openai' | 'anthropic'];
    const options = await resolveCloudHypervisorEnclaveNetwork(
      profile(false, selected[0], selected[1]), tools, inspection().dependencies,
    );
    const plan = createMicrovmNetworkPlan('engine-port', {
      ...options, tapOwnerUid: 2001, tapOwnerGid: 2002,
    });
    expect(plan.allowedEndpoints).toEqual([
      { name: 'enclave-api-proxy', ip: '172.31.0.30', port: Number(port) },
    ]);
  });

  it.each([
    ['external network', (network: any) => { network.Internal = false; }],
    ['wrong subnet', (network: any) => { network.IPAM.Config[0].Subnet = '172.30.0.0/24'; }],
    ['wrong gateway', (network: any) => { network.IPAM.Config[0].Gateway = '172.31.0.254'; }],
    ['extra container', (network: any) => {
      network.Containers.other = { Name: 'squid', IPv4Address: '172.31.0.10/24' };
    }],
    ['wrong proxy', (network: any) => { network.Containers.proxy.IPv4Address = '172.31.0.99/24'; }],
  ])('rejects %s before network side effects', async (_name, mutate) => {
    const { network, dependencies } = inspection();
    mutate(network);
    await expect(resolveCloudHypervisorEnclaveNetwork(profile(), tools, dependencies))
      .rejects.toThrow();
    expect(dependencies.inspectBridge).not.toHaveBeenCalled();
  });

  it('rejects a non-Docker bridge, unconfigured gateway, and unsafe caller endpoints', async () => {
    const wrongBridge = inspection();
    wrongBridge.dependencies.inspectBridge.mockResolvedValueOnce([
      { ifname: 'br-aaaaaaaaaaaa', linkinfo: { info_kind: 'veth' } },
    ]);
    await expect(resolveCloudHypervisorEnclaveNetwork(profile(), tools, wrongBridge.dependencies))
      .rejects.toThrow(/bridge is unavailable/);
    await expect(resolveCloudHypervisorEnclaveNetwork(profile(), tools, inspection(true).dependencies))
      .rejects.toThrow(/membership/);
    await expect(resolveCloudHypervisorEnclaveNetwork(profile(true), tools, inspection(true).dependencies, {}))
      .rejects.toThrow(/gateway identity/);
    await expect(resolveCloudHypervisorEnclaveNetwork(profile(true), tools, inspection(true).dependencies, {
      [ENCLAVE_MCP_GATEWAY_CONTAINER_ENV]: 'untrusted-container',
      [ENCLAVE_MCP_GATEWAY_IDENTITY_ENV]: 'run-identity-123',
    })).rejects.toThrow(/membership/);
    expect(() => createAgentEnclaveCloudHypervisorProfile({
      enclaveId: 'agent-entry',
      invocationId: 'invocation-1',
      guest,
      apiProxy: { ip: '172.30.0.30', engine: 'copilot', profile: 'anthropic' },
    })).toThrow(/dedicated API proxy/);
    expect(() => createAgentEnclaveCloudHypervisorProfile({
      enclaveId: 'agent-entry',
      invocationId: 'invocation-1',
      guest,
      apiProxy: { ip: '172.31.0.30', engine: 'copilot', profile: 'anthropic' },
      githubDataPlane: { ip: '172.31.0.40', port: 18443 },
    })).toThrow(/compiler-owned GitHub data plane/);
    expect(() => createMicrovmNetworkPlan('bad-options', {
      infrastructureBridge: 'awfbr0', enableApiProxy: true, tapOwnerUid: 2001, tapOwnerGid: 2002,
      enclaveAgent: { apiProxyPort: 10002, githubDataPlane: false },
    })).toThrow(/closed microVM/);
  });

  it.each([
    ['stopped gateway', (details: any) => { details.State.Running = false; }],
    ['gateway identity mismatch', (details: any) => {
      details.Config.Labels[ENCLAVE_MCP_GATEWAY_RUN_LABEL] = 'different-run';
    }],
  ])('rejects a %s even when the fixed network membership matches', async (_name, mutate) => {
    const { dependencies } = inspection(true);
    const details = await dependencies.inspectContainer();
    mutate(details);
    dependencies.inspectContainer.mockResolvedValueOnce(details);
    await expect(resolveCloudHypervisorEnclaveNetwork(
      profile(true),
      tools,
      dependencies,
      {
        [ENCLAVE_MCP_GATEWAY_CONTAINER_ENV]: 'awmg-mcpg',
        [ENCLAVE_MCP_GATEWAY_IDENTITY_ENV]: 'run-identity-123',
      },
    )).rejects.toThrow(/did not match the compiler handoff/);
  });

  it('rolls back its own interfaces, namespace, and bridge rule after partial setup failure', async () => {
    const options = await resolveCloudHypervisorEnclaveNetwork(profile(), tools, inspection().dependencies);
    const plan = createMicrovmNetworkPlan('rollback-run', {
      ...options, tapOwnerUid: 2001, tapOwnerGid: 2002,
    });
    const calls: string[] = [];
    const commands = new LinuxNetworkCommands(async (command, args) => {
      const call = `${command} ${args.join(' ')}`;
      calls.push(call);
      if (args.includes('tuntap')) throw new Error('injected TAP failure');
      return { exitCode: args.includes('-C') ? 1 : 0 };
    });
    const release = jest.fn(async () => undefined);
    const lifecycle = new MicrovmNetworkManager(plan, commands, undefined, { plan, release });
    await expect(lifecycle.setup()).rejects.toThrow(/injected TAP failure/);
    expect(calls).toEqual(expect.arrayContaining([
      expect.stringContaining(`link delete ${plan.hostVethName}`),
      expect.stringContaining(`netns delete ${plan.namespaceName}`),
      expect.stringContaining(`-D DOCKER-USER -i ${plan.infrastructureBridge}`),
    ]));
    await lifecycle.cleanup();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
