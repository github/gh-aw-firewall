import { runMainWorkflow, WorkflowDependencies } from './cli-workflow';
import { WrapperConfig } from './types';
import { HostAccessConfig } from './host-iptables';

const baseConfig: WrapperConfig = {
  allowedDomains: ['github.com'],
  agentCommand: 'echo "hello"',
  logLevel: 'info',
  keepContainers: false,
  workDir: '/tmp/awf-test',
  imageRegistry: 'registry',
  imageTag: 'latest',
  buildLocal: false,
};

const createLogger = () => ({
  info: jest.fn(),
  success: jest.fn(),
  warn: jest.fn(),
});

describe('runMainWorkflow', () => {
  it('executes workflow steps in order and logs success for zero exit code', async () => {
    const callOrder: string[] = [];
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn().mockImplementation(async () => {
        callOrder.push('ensureFirewallNetwork');
        return { squidIp: '172.30.0.10' };
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
    };
    const performCleanup = jest.fn().mockImplementation(async () => {
      callOrder.push('performCleanup');
    });
    const logger = createLogger();

    const exitCode = await runMainWorkflow(baseConfig, dependencies, {
      logger,
      performCleanup,
    });

    expect(callOrder).toEqual([
      'ensureFirewallNetwork',
      'setupHostIptables',
      'writeConfigs',
      'startContainers',
      'runAgentCommand',
      'performCleanup',
    ]);
    expect(exitCode).toBe(0);
    expect(logger.success).toHaveBeenCalledWith('Command completed successfully');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('passes agentTimeout to runAgentCommand', async () => {
    const configWithTimeout: WrapperConfig = {
      ...baseConfig,
      agentTimeout: 30,
    };
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockResolvedValue(undefined),
      runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
    };
    const performCleanup = jest.fn().mockResolvedValue(undefined);
    const logger = createLogger();

    await runMainWorkflow(configWithTimeout, dependencies, { logger, performCleanup });

    expect(dependencies.runAgentCommand).toHaveBeenCalledWith(
      configWithTimeout.workDir,
      configWithTimeout.allowedDomains,
      undefined,
      30
    );
  });

  it('passes undefined agentTimeout when not set', async () => {
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockResolvedValue(undefined),
      runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
    };
    const performCleanup = jest.fn().mockResolvedValue(undefined);
    const logger = createLogger();

    await runMainWorkflow(baseConfig, dependencies, { logger, performCleanup });

    expect(dependencies.runAgentCommand).toHaveBeenCalledWith(
      baseConfig.workDir,
      baseConfig.allowedDomains,
      undefined,
      undefined
    );
  });

  it('passes hostAccess config when enableHostAccess is true', async () => {
    const configWithHostAccess: WrapperConfig = {
      ...baseConfig,
      enableHostAccess: true,
      allowHostPorts: '3000,8080',
    };
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10', proxyIp: '172.30.0.30' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockResolvedValue(undefined),
      runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
    };
    const performCleanup = jest.fn().mockResolvedValue(undefined);
    const logger = createLogger();

    await runMainWorkflow(configWithHostAccess, dependencies, { logger, performCleanup });

    const expectedHostAccess: HostAccessConfig = { enabled: true, allowHostPorts: '3000,8080' };
    expect(dependencies.setupHostIptables).toHaveBeenCalledWith(
      '172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, expectedHostAccess, undefined
    );
  });

  it('passes allowHostServicePorts in hostAccess config when set', async () => {
    const configWithServicePorts: WrapperConfig = {
      ...baseConfig,
      enableHostAccess: true,
      allowHostPorts: '3000',
      allowHostServicePorts: '5432,6379',
    };
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10', proxyIp: '172.30.0.30' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockResolvedValue(undefined),
      runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
    };
    const performCleanup = jest.fn().mockResolvedValue(undefined);
    const logger = createLogger();

    await runMainWorkflow(configWithServicePorts, dependencies, { logger, performCleanup });

    const expectedHostAccess: HostAccessConfig = {
      enabled: true,
      allowHostPorts: '3000',
      allowHostServicePorts: '5432,6379',
    };
    expect(dependencies.setupHostIptables).toHaveBeenCalledWith(
      '172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, expectedHostAccess, undefined
    );
  });

  it('passes undefined hostAccess when enableHostAccess is not set', async () => {
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10', proxyIp: '172.30.0.30' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockResolvedValue(undefined),
      runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
    };
    const performCleanup = jest.fn().mockResolvedValue(undefined);
    const logger = createLogger();

    await runMainWorkflow(baseConfig, dependencies, { logger, performCleanup });

    expect(dependencies.setupHostIptables).toHaveBeenCalledWith(
      '172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, undefined, undefined
    );
  });

  it('logs warning with exit code when command fails', async () => {
    const callOrder: string[] = [];
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn().mockImplementation(async () => {
        callOrder.push('ensureFirewallNetwork');
        return { squidIp: '172.30.0.10' };
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
        return { exitCode: 42 };
      }),
    };
    const performCleanup = jest.fn().mockImplementation(async () => {
      callOrder.push('performCleanup');
    });
    const logger = createLogger();

    const exitCode = await runMainWorkflow(baseConfig, dependencies, {
      logger,
      performCleanup,
    });

    expect(exitCode).toBe(42);
    expect(callOrder).toEqual([
      'ensureFirewallNetwork',
      'setupHostIptables',
      'writeConfigs',
      'startContainers',
      'runAgentCommand',
      'performCleanup',
    ]);
    expect(logger.warn).toHaveBeenCalledWith('Command completed with exit code: 42');
    expect(logger.success).not.toHaveBeenCalled();
  });

  it('calls collectDiagnosticLogs before cleanup on non-zero exit when diagnosticLogs is enabled', async () => {
    const callOrder: string[] = [];
    const configWithDiagnostics: WrapperConfig = {
      ...baseConfig,
      diagnosticLogs: true,
    };
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockResolvedValue(undefined),
      runAgentCommand: jest.fn().mockImplementation(async () => {
        callOrder.push('runAgentCommand');
        return { exitCode: 1 };
      }),
      collectDiagnosticLogs: jest.fn().mockImplementation(async () => {
        callOrder.push('collectDiagnosticLogs');
      }),
    };
    const performCleanup = jest.fn().mockImplementation(async () => {
      callOrder.push('performCleanup');
    });
    const logger = createLogger();

    await runMainWorkflow(configWithDiagnostics, dependencies, { logger, performCleanup });

    expect(callOrder).toEqual(['runAgentCommand', 'collectDiagnosticLogs', 'performCleanup']);
    expect(dependencies.collectDiagnosticLogs).toHaveBeenCalledWith(configWithDiagnostics.workDir);
  });

  it('does not call collectDiagnosticLogs when diagnosticLogs is disabled', async () => {
    const collectDiagnosticLogs = jest.fn().mockResolvedValue(undefined);
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockResolvedValue(undefined),
      runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 1 }),
      collectDiagnosticLogs,
    };
    const logger = createLogger();

    await runMainWorkflow(baseConfig, dependencies, { logger, performCleanup: jest.fn() });

    expect(collectDiagnosticLogs).not.toHaveBeenCalled();
  });

  it('does not call collectDiagnosticLogs on zero exit even when diagnosticLogs is enabled', async () => {
    const collectDiagnosticLogs = jest.fn().mockResolvedValue(undefined);
    const configWithDiagnostics: WrapperConfig = {
      ...baseConfig,
      diagnosticLogs: true,
    };
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockResolvedValue(undefined),
      runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
      collectDiagnosticLogs,
    };
    const logger = createLogger();

    await runMainWorkflow(configWithDiagnostics, dependencies, { logger, performCleanup: jest.fn() });

    expect(collectDiagnosticLogs).not.toHaveBeenCalled();
  });

  it('does not call collectDiagnosticLogs when dependency is not provided', async () => {
    const configWithDiagnostics: WrapperConfig = {
      ...baseConfig,
      diagnosticLogs: true,
    };
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockResolvedValue(undefined),
      runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 1 }),
      // collectDiagnosticLogs not provided
    };
    const logger = createLogger();

    await expect(runMainWorkflow(configWithDiagnostics, dependencies, { logger, performCleanup: jest.fn() })).resolves.toBe(1);
  });
});
