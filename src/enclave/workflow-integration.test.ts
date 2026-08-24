import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import { runMainWorkflow } from '../cli-workflow';

jest.mock('../container-runtime', () => ({
  runtimeNeedsStaticDns: jest.fn().mockReturnValue(false),
  runtimeUsesComposeAgent: jest.fn().mockReturnValue(true),
}));

function config(): WrapperConfig {
  return {
    workDir: '/tmp/awf-enclave-test',
    networkIsolation: true,
    enclaves: normalizeEnclavesConfig([
      { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]),
  } as WrapperConfig;
}

function githubConfig(): WrapperConfig {
  return {
    ...config(),
    enableApiProxy: true,
    copilotGithubToken: 'copilot-test-token',
    enclaves: normalizeEnclavesConfig([{
      agent: {
        model: 'trusted-model',
        github: { cli: 'issues-read-v1' },
      },
      repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
    }]),
  } as WrapperConfig;
}

describe('unified enclave workflow integration', () => {
  it('stages before config generation and container startup', async () => {
    const order: string[] = [];
    await runMainWorkflow(config(), {
      ensureFirewallNetwork: jest.fn(),
      setupHostIptables: jest.fn(),
      prepareEnclaves: jest.fn(async () => { order.push('prepareEnclaves'); }),
      writeConfigs: jest.fn(async () => { order.push('writeConfigs'); }),
      startContainers: jest.fn(async () => { order.push('startContainers'); }),
      runAgentCommand: jest.fn(async () => ({ exitCode: 0 })),
    }, {
      logger: { info: jest.fn(), success: jest.fn(), warn: jest.fn() },
      performCleanup: jest.fn(),
    });
    expect(order.slice(0, 3)).toEqual(['prepareEnclaves', 'writeConfigs', 'startContainers']);
  });

  it('fails closed when lifecycle staging is absent', async () => {
    await expect(runMainWorkflow(config(), {
      ensureFirewallNetwork: jest.fn(),
      setupHostIptables: jest.fn(),
      writeConfigs: jest.fn(),
      startContainers: jest.fn(),
      runAgentCommand: jest.fn(),
    }, {
      logger: { info: jest.fn(), success: jest.fn(), warn: jest.fn() },
      performCleanup: jest.fn(),
    })).rejects.toThrow(/no staging implementation/);
  });

  it('attaches and proves both private gateways before primary-agent startup', async () => {
    const order: string[] = [];
    await runMainWorkflow(githubConfig(), {
      ensureFirewallNetwork: jest.fn(),
      setupHostIptables: jest.fn(),
      prepareEnclaves: jest.fn(),
      writeConfigs: jest.fn(),
      startContainers: jest.fn(async (
        _workDir: string,
        _domains: string[],
        _logs?: string,
        _skipPull?: boolean,
        _networkReady?: () => Promise<void>,
        infrastructureReady?: () => Promise<void>,
      ) => {
        order.push('infrastructure');
        await infrastructureReady?.();
      }),
      connectEnclaveGateway: jest.fn(async () => { order.push('mcp-connect'); }),
      connectEnclaveGithubGateway: jest.fn(async () => { order.push('github-connect'); }),
      assertEnclaveGithubGatewayReady: jest.fn(async () => { order.push('github-ready'); }),
      assertEnclaveGatewayReady: jest.fn(async () => { order.push('mcp-ready'); }),
      runAgentCommand: jest.fn(async () => {
        order.push('agent');
        return { exitCode: 0 };
      }),
    }, {
      logger: { info: jest.fn(), success: jest.fn(), warn: jest.fn() },
      performCleanup: jest.fn(),
    });
    expect(order).toEqual([
      'infrastructure',
      'mcp-connect',
      'github-connect',
      'github-ready',
      'mcp-ready',
      'agent',
    ]);
  });

  it('fails before agent startup when the GitHub gateway lifecycle is absent', async () => {
    const runAgentCommand = jest.fn();
    await expect(runMainWorkflow(githubConfig(), {
      ensureFirewallNetwork: jest.fn(),
      setupHostIptables: jest.fn(),
      prepareEnclaves: jest.fn(),
      writeConfigs: jest.fn(),
      startContainers: jest.fn(async (
        _workDir: string,
        _domains: string[],
        _logs?: string,
        _skipPull?: boolean,
        _networkReady?: () => Promise<void>,
        infrastructureReady?: () => Promise<void>,
      ) => infrastructureReady?.()),
      connectEnclaveGateway: jest.fn(),
      assertEnclaveGatewayReady: jest.fn(),
      runAgentCommand,
    }, {
      logger: { info: jest.fn(), success: jest.fn(), warn: jest.fn() },
      performCleanup: jest.fn(),
    })).rejects.toThrow(/issues-read-v1 requires/);
    expect(runAgentCommand).not.toHaveBeenCalled();
  });
});
