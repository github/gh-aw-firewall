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
    enclaves: normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { script: { enabled: true } },
    }),
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
});
