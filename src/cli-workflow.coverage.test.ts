/**
 * Additional coverage tests for cli-workflow.ts targeting
 * callback branches not exercised by cli-workflow.test.ts.
 */
import { runMainWorkflow, WorkflowDependencies } from './cli-workflow';
import { WrapperConfig } from './types';

const baseConfig: WrapperConfig = {
  allowedDomains: ['github.com'],
  agentCommand: 'echo "hello"',
  logLevel: 'info',
  keepContainers: false,
  workDir: '/work/awf-test',
  imageRegistry: 'registry',
  imageTag: 'latest',
  buildLocal: false,
};

const createDeps = (overrides: Partial<WorkflowDependencies> = {}): WorkflowDependencies => ({
  ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10', proxyIp: '172.30.0.30', agentIp: '172.30.0.20', subnet: '172.30.0.0/24' }),
  setupHostIptables: jest.fn().mockResolvedValue(undefined),
  writeConfigs: jest.fn().mockResolvedValue(undefined),
  startContainers: jest.fn().mockResolvedValue(undefined),
  runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
  ...overrides,
});

const createLogger = () => ({
  info: jest.fn(),
  success: jest.fn(),
  warn: jest.fn(),
});

describe('cli-workflow coverage', () => {
  describe('onHostIptablesSetup callback', () => {
    it('calls onHostIptablesSetup after iptables are set up', async () => {
      const onHostIptablesSetup = jest.fn();
      const logger = createLogger();

      await runMainWorkflow(baseConfig, createDeps(), {
        logger,
        performCleanup: jest.fn().mockResolvedValue(undefined),
        onHostIptablesSetup,
      });

      expect(onHostIptablesSetup).toHaveBeenCalledTimes(1);
    });

    it('calls onHostIptablesSetup before writeConfigs', async () => {
      const callOrder: string[] = [];
      const deps = createDeps({
        writeConfigs: jest.fn().mockImplementation(async () => { callOrder.push('writeConfigs'); }),
        runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
      });
      const logger = createLogger();

      await runMainWorkflow(baseConfig, deps, {
        logger,
        performCleanup: jest.fn().mockResolvedValue(undefined),
        onHostIptablesSetup: () => { callOrder.push('onHostIptablesSetup'); },
      });

      expect(callOrder.indexOf('onHostIptablesSetup')).toBeLessThan(callOrder.indexOf('writeConfigs'));
    });
  });

  describe('onContainersStarted callback', () => {
    it('calls onContainersStarted after successful startContainers', async () => {
      const onContainersStarted = jest.fn();
      const logger = createLogger();

      await runMainWorkflow(baseConfig, createDeps(), {
        logger,
        performCleanup: jest.fn().mockResolvedValue(undefined),
        onContainersStarted,
      });

      expect(onContainersStarted).toHaveBeenCalledTimes(1);
    });

    it('calls onContainersStarted even when startContainers throws', async () => {
      const startError = new Error('docker compose failed');
      const onContainersStarted = jest.fn();
      const deps = createDeps({
        startContainers: jest.fn().mockRejectedValue(startError),
      });
      const logger = createLogger();

      await expect(
        runMainWorkflow(baseConfig, deps, {
          logger,
          performCleanup: jest.fn(),
          onContainersStarted,
        })
      ).rejects.toBe(startError);

      expect(onContainersStarted).toHaveBeenCalledTimes(1);
    });

    it('does not call onContainersStarted when not provided', async () => {
      // Verifies optional chaining works without throwing
      const logger = createLogger();

      await expect(
        runMainWorkflow(baseConfig, createDeps(), {
          logger,
          performCleanup: jest.fn().mockResolvedValue(undefined),
          // no onContainersStarted
        })
      ).resolves.toBe(0);
    });

    it('does not call onHostIptablesSetup when not provided', async () => {
      const logger = createLogger();

      await expect(
        runMainWorkflow(baseConfig, createDeps(), {
          logger,
          performCleanup: jest.fn().mockResolvedValue(undefined),
          // no onHostIptablesSetup
        })
      ).resolves.toBe(0);
    });
  });

  describe('custom dnsServers', () => {
    it('passes custom dnsServers to setupHostIptables', async () => {
      const configWithDns: WrapperConfig = {
        ...baseConfig,
        dnsServers: ['1.1.1.1', '1.0.0.1'],
      };
      const deps = createDeps();
      const logger = createLogger();

      await runMainWorkflow(configWithDns, deps, {
        logger,
        performCleanup: jest.fn().mockResolvedValue(undefined),
      });

      expect(deps.setupHostIptables).toHaveBeenCalledWith(
        expect.any(String),
        3128,
        ['1.1.1.1', '1.0.0.1'],
        undefined,
        undefined,
        undefined,
        undefined
      );
    });

    it('uses DEFAULT_DNS_SERVERS when dnsServers is not set', async () => {
      const deps = createDeps();
      const logger = createLogger();

      await runMainWorkflow(baseConfig, deps, {
        logger,
        performCleanup: jest.fn().mockResolvedValue(undefined),
      });

      expect(deps.setupHostIptables).toHaveBeenCalledWith(
        expect.any(String),
        3128,
        ['8.8.8.8', '8.8.4.4'],
        undefined,
        undefined,
        undefined,
        undefined
      );
    });
  });

  describe('proxyLogsDir passthrough', () => {
    it('passes proxyLogsDir to startContainers and runAgentCommand', async () => {
      const configWithProxy: WrapperConfig = {
        ...baseConfig,
        proxyLogsDir: '/custom/proxy/logs',
      };
      const deps = createDeps();
      const logger = createLogger();

      await runMainWorkflow(configWithProxy, deps, {
        logger,
        performCleanup: jest.fn().mockResolvedValue(undefined),
      });

      expect(deps.startContainers).toHaveBeenCalledWith(
        configWithProxy.workDir,
        configWithProxy.allowedDomains,
        '/custom/proxy/logs',
        undefined
      );
      expect(deps.runAgentCommand).toHaveBeenCalledWith(
        configWithProxy.workDir,
        configWithProxy.allowedDomains,
        '/custom/proxy/logs',
        undefined
      );
    });
  });
});
