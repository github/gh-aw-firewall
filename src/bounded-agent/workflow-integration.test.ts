import { runMainWorkflow } from '../cli-workflow';
import type { WrapperConfig } from '../types';
import { BOUNDED_AGENT_DEFAULTS, type BoundedAgentsConfig } from '../types/bounded-agent-options';

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
 * Lifecycle ordering guarantees for bounded agents.
 *
 * Preflight + staging are credential-bearing and must complete before anything
 * untrusted exists, so they run ahead of config generation, host network setup,
 * and container startup — and a failure must stop the run before the primary
 * agent is invoked. Bounded queries must remain independently wired.
 */

const boundedAgents: BoundedAgentsConfig = {
  ...BOUNDED_AGENT_DEFAULTS,
  enabled: true,
  model: 'gpt-4o-mini',
  privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
};

const baseConfig: WrapperConfig = {
  allowedDomains: ['github.com'],
  agentCommand: 'echo hi',
  logLevel: 'info',
  keepContainers: false,
  workDir: '/tmp/awf-bounded-agent-workflow',
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
    prepareBoundedQueries: jest.fn().mockImplementation(async () => {
      callOrder.push('prepareBoundedQueries');
    }),
    prepareBoundedAgents: jest.fn().mockImplementation(async () => {
      callOrder.push('prepareBoundedAgents');
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

describe('bounded-agent staging in the main workflow', () => {
  it('stages seeds before configs are written and containers start', async () => {
    const callOrder: string[] = [];
    const deps = createDeps(callOrder);

    await runMainWorkflow({ ...baseConfig, boundedAgents }, deps, createOptions());

    expect(callOrder[0]).toBe('prepareBoundedAgents');
    expect(callOrder.indexOf('prepareBoundedAgents')).toBeLessThan(callOrder.indexOf('writeConfigs'));
    expect(callOrder.indexOf('prepareBoundedAgents')).toBeLessThan(callOrder.indexOf('startContainers'));
    expect(callOrder.indexOf('prepareBoundedAgents')).toBeLessThan(callOrder.indexOf('ensureFirewallNetwork'));
  });

  it('does not stage anything when bounded agents are disabled', async () => {
    const callOrder: string[] = [];
    const deps = createDeps(callOrder);

    await runMainWorkflow(baseConfig, deps, createOptions());

    expect(callOrder).not.toContain('prepareBoundedAgents');
    expect((deps as unknown as { prepareBoundedAgents: jest.Mock }).prepareBoundedAgents)
      .not.toHaveBeenCalled();
  });

  it('aborts before the primary agent runs when preflight or staging fails', async () => {
    const callOrder: string[] = [];
    const deps = createDeps(callOrder, {
      prepareBoundedAgents: jest.fn().mockRejectedValue(new Error('runsc is not registered')),
    });

    await expect(
      runMainWorkflow({ ...baseConfig, boundedAgents }, deps, createOptions()),
    ).rejects.toThrow('runsc is not registered');

    expect(callOrder).toEqual([]);
    expect((deps as unknown as { writeConfigs: jest.Mock }).writeConfigs).not.toHaveBeenCalled();
    expect((deps as unknown as { startContainers: jest.Mock }).startContainers).not.toHaveBeenCalled();
    expect((deps as unknown as { runAgentCommand: jest.Mock }).runAgentCommand).not.toHaveBeenCalled();
  });

  it('refuses to run when bounded agents are enabled but no staging implementation was injected', async () => {
    const callOrder: string[] = [];
    const deps = createDeps(callOrder, { prepareBoundedAgents: undefined });

    await expect(
      runMainWorkflow({ ...baseConfig, boundedAgents }, deps, createOptions()),
    ).rejects.toThrow(/no staging implementation/);

    expect(callOrder).toEqual([]);
  });

  it('leaves bounded-query staging independently wired', async () => {
    const callOrder: string[] = [];
    const deps = createDeps(callOrder);

    await runMainWorkflow({ ...baseConfig, boundedAgents }, deps, createOptions());
    expect(callOrder).not.toContain('prepareBoundedQueries');

    callOrder.length = 0;
    await runMainWorkflow(
      {
        ...baseConfig,
        boundedAgents,
        boundedQueries: {
          enabled: true,
          privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
          runtime: 'docker',
          timeout: 30,
          memoryLimit: '512m',
          interpreter: 'python3',
          maxInvocations: 32,
        },
      },
      deps,
      createOptions(),
    );
    expect(callOrder.indexOf('prepareBoundedQueries')).toBeLessThan(
      callOrder.indexOf('prepareBoundedAgents'),
    );
  });
});
