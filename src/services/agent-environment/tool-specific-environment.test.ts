import { buildToolEnvironment } from './tool-specific-environment';
import { WrapperConfig } from '../../types';

jest.mock('../../logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../agent-volumes/docker-host-staging', () => ({
  extractCommandBinaryName: jest.fn(() => null),
  shouldUseDockerHostStaging: jest.fn(() => false),
}));

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowDomains: 'example.com',
    agentCommand: 'echo test',
    workDir: '/tmp/awf-test',
    ...overrides,
  } as WrapperConfig;
}

describe('buildToolEnvironment', () => {
  describe('gVisor + Claude: Bun JIT disable', () => {
    it('sets BUN_JSC_useJIT=0 when running claude under gvisor', () => {
      const env: Record<string, string> = {};
      buildToolEnvironment({
        config: makeConfig({ agentCommand: 'claude', containerRuntime: 'gvisor' }),
        environment: env,
      });
      expect(env.BUN_JSC_useJIT).toBe('0');
    });

    it('sets BUN_JSC_useJIT=0 for claude with arguments under gvisor', () => {
      const env: Record<string, string> = {};
      buildToolEnvironment({
        config: makeConfig({ agentCommand: 'claude --model opus', containerRuntime: 'gvisor' }),
        environment: env,
      });
      expect(env.BUN_JSC_useJIT).toBe('0');
    });

    it('sets BUN_JSC_useJIT=0 for absolute path to claude under gvisor', () => {
      const env: Record<string, string> = {};
      buildToolEnvironment({
        config: makeConfig({ agentCommand: '/usr/local/bin/claude', containerRuntime: 'gvisor' }),
        environment: env,
      });
      expect(env.BUN_JSC_useJIT).toBe('0');
    });

    it('does not set BUN_JSC_useJIT when running claude without gvisor', () => {
      const env: Record<string, string> = {};
      buildToolEnvironment({
        config: makeConfig({ agentCommand: 'claude' }),
        environment: env,
      });
      expect(env.BUN_JSC_useJIT).toBeUndefined();
    });

    it('does not set BUN_JSC_useJIT when running non-claude command under gvisor', () => {
      const env: Record<string, string> = {};
      buildToolEnvironment({
        config: makeConfig({ agentCommand: 'copilot', containerRuntime: 'gvisor' }),
        environment: env,
      });
      expect(env.BUN_JSC_useJIT).toBeUndefined();
    });

    it('does not set BUN_JSC_useJIT for claude under sbx runtime', () => {
      const env: Record<string, string> = {};
      buildToolEnvironment({
        config: makeConfig({ agentCommand: 'claude', containerRuntime: 'sbx' }),
        environment: env,
      });
      expect(env.BUN_JSC_useJIT).toBeUndefined();
    });
  });
});
