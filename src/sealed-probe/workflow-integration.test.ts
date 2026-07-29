import { runMainWorkflow } from '../cli-workflow';
import type { SealedProbesConfig, WrapperConfig } from '../types';

jest.mock('../topology', () => ({
  TOPOLOGY_NETWORK_NAME: 'awf-net',
  getTopologyContainerIps: jest.fn(),
  patchComposeWithTopologyHosts: jest.fn(),
  connectTopologyContainers: jest.fn(),
  assertTopologySupported: jest.fn(),
}));

jest.mock('../container-runtime', () => ({
  runtimeNeedsStaticDns: jest.fn().mockReturnValue(false),
  runtimeUsesComposeAgent: jest.fn().mockReturnValue(true),
}));

/**
 * Lifecycle ordering guarantees for sealed probes.
 *
 * Staging is credential-bearing and must complete before anything untrusted
 * exists, so it runs ahead of config generation and container startup — and a
 * staging failure must stop the run before the primary agent is invoked.
 */

const sealedProbes: SealedProbesConfig = {
  enabled: true,
  privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
  runtime: 'docker',
  timeout: 30,
  memoryLimit: '512m',
  interpreter: 'python3',
  maxInvocations: 32,
};

const baseConfig: WrapperConfig = {
  allowedDomains: ['github.com'],
  agentCommand: 'echo hi',
  logLevel: 'info',
  keepContainers: false,
  workDir: '/tmp/awf-sealed-workflow',
  imageRegistry: 'registry',
  imageTag: 'latest',
  buildLocal: false,
} as WrapperConfig;

function createDeps(callOrder: string[], overrides: Record<string, unknown> = {}) {
  return {
    ensureFirewallNetwork: jest.fn().mockImplementation(async () => {
      callOrder.push('ensureFirewallNetwork');
      return { squidIp: '172.30.0.10', agentIp: '172.30.0.20', proxyIp: '172.30.0.30', subnet: '172.30.0.0/24' };
    }),
    setupHostIptables: jest.fn().mockImplementation(async () => {
      callOrder.push('setupHostIptables');
    }),
    writeConfigs: jest.fn().mockImplementation(async () => {
      callOrder.push('writeConfigs');
    }),
    startContainers: jest.fn().mockImplementation(async () => {
      callOrder.push('startContainers');
    }),
    runAgentCommand: jest.fn().mockImplementation(async () => {
      callOrder.push('runAgentCommand');
      return { exitCode: 0 };
    }),
    prepareSealedProbes: jest.fn().mockImplementation(async () => {
      callOrder.push('prepareSealedProbes');
    }),
    ...overrides,
  } as unknown as Parameters<typeof runMainWorkflow>[1];
}

function createOptions() {
  return {
    logger: { info: jest.fn(), success: jest.fn(), warn: jest.fn() },
    performCleanup: jest.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof runMainWorkflow>[2];
}

describe('sealed-probe staging in the main workflow', () => {
  it('stages seeds before configs are written and containers start', async () => {
    const callOrder: string[] = [];
    const deps = createDeps(callOrder);

    await runMainWorkflow({ ...baseConfig, sealedProbes }, deps, createOptions());

    expect(callOrder[0]).toBe('prepareSealedProbes');
    expect(callOrder.indexOf('prepareSealedProbes')).toBeLessThan(callOrder.indexOf('writeConfigs'));
    expect(callOrder.indexOf('prepareSealedProbes')).toBeLessThan(callOrder.indexOf('startContainers'));
  });

  it('does not stage anything when sealed probes are disabled', async () => {
    const callOrder: string[] = [];
    const deps = createDeps(callOrder);

    await runMainWorkflow(baseConfig, deps, createOptions());

    expect(callOrder).not.toContain('prepareSealedProbes');
    expect((deps as unknown as { prepareSealedProbes: jest.Mock }).prepareSealedProbes).not.toHaveBeenCalled();
  });

  it('aborts before the primary agent runs when staging fails', async () => {
    const callOrder: string[] = [];
    const deps = createDeps(callOrder, {
      prepareSealedProbes: jest.fn().mockRejectedValue(new Error('seed unavailable')),
    });

    await expect(
      runMainWorkflow({ ...baseConfig, sealedProbes }, deps, createOptions()),
    ).rejects.toThrow('seed unavailable');

    expect(callOrder).toEqual([]);
    expect((deps as unknown as { writeConfigs: jest.Mock }).writeConfigs).not.toHaveBeenCalled();
    expect((deps as unknown as { startContainers: jest.Mock }).startContainers).not.toHaveBeenCalled();
    expect((deps as unknown as { runAgentCommand: jest.Mock }).runAgentCommand).not.toHaveBeenCalled();
  });

  it('stages before host iptables setup too, so no network state is created on failure', async () => {
    const callOrder: string[] = [];
    const deps = createDeps(callOrder);

    await runMainWorkflow({ ...baseConfig, sealedProbes }, deps, createOptions());

    expect(callOrder.indexOf('prepareSealedProbes')).toBeLessThan(callOrder.indexOf('ensureFirewallNetwork'));
  });

  it('refuses to run when sealed probes are enabled but no staging implementation was injected', async () => {
    const callOrder: string[] = [];
    const deps = createDeps(callOrder, { prepareSealedProbes: undefined });

    await expect(
      runMainWorkflow({ ...baseConfig, sealedProbes }, deps, createOptions()),
    ).rejects.toThrow(/no staging implementation/);

    expect(callOrder).toEqual([]);
  });
});
