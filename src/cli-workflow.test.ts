import { runMainWorkflow } from './cli-workflow';
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

type WorkflowDependencies = Parameters<typeof runMainWorkflow>[1];
type WorkflowOptions = Parameters<typeof runMainWorkflow>[2];

const createWorkflowDependencies = (
  overrides: Partial<WorkflowDependencies> = {}
): WorkflowDependencies => ({
  ensureFirewallNetwork: jest.fn().mockResolvedValue({
    squidIp: '172.30.0.10',
    agentIp: '172.30.0.20',
    proxyIp: '172.30.0.30',
    subnet: '172.30.0.0/24',
  }),
  setupHostIptables: jest.fn().mockResolvedValue(undefined),
  writeConfigs: jest.fn().mockResolvedValue(undefined),
  startContainers: jest.fn().mockResolvedValue(undefined),
  runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
  ...overrides,
});

const createWorkflowOptions = (
  overrides: Partial<WorkflowOptions> = {}
): WorkflowOptions => ({
  logger: createLogger(),
  performCleanup: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

const createOrderedWorkflowDependencies = (
  callOrder: string[],
  runAgentExitCode = 0,
  overrides: Partial<WorkflowDependencies> = {}
): WorkflowDependencies => createWorkflowDependencies({
  ensureFirewallNetwork: jest.fn().mockImplementation(async () => {
    callOrder.push('ensureFirewallNetwork');
    return {
      squidIp: '172.30.0.10',
      agentIp: '172.30.0.20',
      proxyIp: '172.30.0.30',
      subnet: '172.30.0.0/24',
    };
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
    return { exitCode: runAgentExitCode };
  }),
  ...overrides,
});

const createOrderedWorkflowOptions = (
  callOrder: string[],
  overrides: Partial<WorkflowOptions> = {}
): WorkflowOptions => ({
  logger: createLogger(),
  performCleanup: jest.fn().mockImplementation(async () => {
    callOrder.push('performCleanup');
  }),
  ...overrides,
});

const runWorkflowWithDefaults = async (
  config: WrapperConfig = baseConfig,
  dependencyOverrides: Partial<WorkflowDependencies> = {},
  optionOverrides: Partial<WorkflowOptions> = {}
) => {
  const dependencies = createWorkflowDependencies(dependencyOverrides);
  const options = createWorkflowOptions(optionOverrides);
  const exitCode = await runMainWorkflow(config, dependencies, options);

  return { dependencies, options, exitCode };
};

describe('runMainWorkflow', () => {
  it('executes workflow steps in order and logs success for zero exit code', async () => {
    const callOrder: string[] = [];
    const dependencies = createOrderedWorkflowDependencies(callOrder);
    const { logger, performCleanup } = createOrderedWorkflowOptions(callOrder);

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

  it('skips host network setup and iptables in network-isolation mode', async () => {
    const callOrder: string[] = [];
    const dependencies = {
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
    const performCleanup = jest.fn();
    const logger = createLogger();
    const onHostIptablesSetup = jest.fn();

    const exitCode = await runMainWorkflow(
      { ...baseConfig, networkIsolation: true },
      dependencies,
      { logger, performCleanup, onHostIptablesSetup },
    );

    expect(dependencies.ensureFirewallNetwork).not.toHaveBeenCalled();
    expect(dependencies.setupHostIptables).not.toHaveBeenCalled();
    expect(onHostIptablesSetup).not.toHaveBeenCalled();
    expect(callOrder).toEqual([
      'writeConfigs',
      'startContainers',
      'runAgentCommand',
    ]);
    expect(exitCode).toBe(0);
  });

  it('runs the topology preflight before containers in network-isolation mode', async () => {
    const callOrder: string[] = [];
    const assertTopologySupported = jest.fn().mockImplementation(async () => {
      callOrder.push('assertTopologySupported');
    });
    const dependencies = createWorkflowDependencies({
      assertTopologySupported,
      writeConfigs: jest.fn().mockImplementation(async () => {
        callOrder.push('writeConfigs');
      }),
      startContainers: jest.fn().mockImplementation(async () => {
        callOrder.push('startContainers');
      }),
    });

    const exitCode = await runMainWorkflow(
      { ...baseConfig, networkIsolation: true },
      dependencies,
      createWorkflowOptions(),
    );

    expect(assertTopologySupported).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['assertTopologySupported', 'writeConfigs', 'startContainers']);
    expect(exitCode).toBe(0);
  });

  it('does not run the topology preflight when network-isolation is off', async () => {
    const assertTopologySupported = jest.fn().mockResolvedValue(undefined);
    const { exitCode } = await runWorkflowWithDefaults(baseConfig, { assertTopologySupported });

    expect(assertTopologySupported).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it('connects topology-attach containers via onNetworkReady callback during startup', async () => {
    const callOrder: string[] = [];
    const connectTopologyContainers = jest.fn().mockImplementation(async () => {
      callOrder.push('connectTopologyContainers');
    });
    const dependencies = createWorkflowDependencies({
      connectTopologyContainers,
      startContainers: jest.fn().mockImplementation(async (_workDir: string, _allowedDomains: string[], _proxyLogsDir?: string, _skipPull?: boolean, onNetworkReady?: () => Promise<void>) => {
        callOrder.push('startContainers');
        // Simulate the phased startup: startContainers invokes the hook
        // between squid-proxy creation and the full health-gated bring-up.
        if (onNetworkReady) await onNetworkReady();
      }),
      runAgentCommand: jest.fn().mockImplementation(async () => {
        callOrder.push('runAgentCommand');
        return { exitCode: 0 };
      }),
    });

    const exitCode = await runMainWorkflow(
      { ...baseConfig, networkIsolation: true, topologyAttach: ['mcp-gateway', 'difc-proxy'] },
      dependencies,
      createWorkflowOptions(),
    );

    expect(connectTopologyContainers).toHaveBeenCalledWith('awf-net', ['mcp-gateway', 'difc-proxy']);
    // connectTopologyContainers runs INSIDE startContainers (via the callback),
    // so the observable call order is the same as before, but the mechanism now
    // ensures peers are attached before the cli-proxy liveness probe fires.
    expect(callOrder).toEqual(['startContainers', 'connectTopologyContainers', 'runAgentCommand']);
    expect(exitCode).toBe(0);
  });

  it('passes an onNetworkReady callback to startContainers only when topology peers are configured', async () => {
    // With topology-attach peers, startContainers must receive the callback.
    const startContainersWithPeers = jest.fn().mockResolvedValue(undefined);
    await runMainWorkflow(
      { ...baseConfig, networkIsolation: true, topologyAttach: ['mcp-gateway'] },
      createWorkflowDependencies({ startContainers: startContainersWithPeers, connectTopologyContainers: jest.fn() }),
      createWorkflowOptions(),
    );
    expect(startContainersWithPeers.mock.calls[0][4]).toBeInstanceOf(Function);

    // Without topology-attach peers, onNetworkReady must be undefined.
    const startContainersNoPeers = jest.fn().mockResolvedValue(undefined);
    await runMainWorkflow(
      { ...baseConfig, networkIsolation: true, topologyAttach: [] },
      createWorkflowDependencies({ startContainers: startContainersNoPeers }),
      createWorkflowOptions(),
    );
    expect(startContainersNoPeers.mock.calls[0][4]).toBeUndefined();
  });

  it('does not connect topology containers when topologyAttach is empty', async () => {
    const connectTopologyContainers = jest.fn().mockResolvedValue(undefined);
    const exitCode = await runMainWorkflow(
      { ...baseConfig, networkIsolation: true, topologyAttach: [] },
      createWorkflowDependencies({ connectTopologyContainers }),
      createWorkflowOptions(),
    );

    expect(connectTopologyContainers).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it('does not connect topology containers when network-isolation is off', async () => {
    const connectTopologyContainers = jest.fn().mockResolvedValue(undefined);
    const { exitCode } = await runWorkflowWithDefaults(
      { ...baseConfig, topologyAttach: ['mcp-gateway'] },
      { connectTopologyContainers },
    );

    expect(connectTopologyContainers).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it('passes agentTimeout to runAgentCommand', async () => {
    const configWithTimeout: WrapperConfig = {
      ...baseConfig,
      agentTimeout: 30,
    };
    const { dependencies } = await runWorkflowWithDefaults(configWithTimeout);

    expect(dependencies.runAgentCommand).toHaveBeenCalledWith(
      configWithTimeout.workDir,
      configWithTimeout.allowedDomains,
      undefined,
      30
    );
  });

  it('passes undefined agentTimeout when not set', async () => {
    const { dependencies } = await runWorkflowWithDefaults();

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
    const { dependencies } = await runWorkflowWithDefaults(configWithHostAccess, {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10', proxyIp: '172.30.0.30' }),
    });

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
    const { dependencies } = await runWorkflowWithDefaults(configWithServicePorts, {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10', proxyIp: '172.30.0.30' }),
    });

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
    const { dependencies } = await runWorkflowWithDefaults(baseConfig, {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10', proxyIp: '172.30.0.30' }),
    });

    expect(dependencies.setupHostIptables).toHaveBeenCalledWith(
      '172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, undefined, undefined
    );
  });

  it('logs warning with exit code when command fails', async () => {
    const callOrder: string[] = [];
    const dependencies = createOrderedWorkflowDependencies(callOrder, 42);
    const { logger, performCleanup } = createOrderedWorkflowOptions(callOrder);

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
    const dependencies = {
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
    const dependencies = {
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
    const dependencies = {
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
    const dependencies = {
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

  it('calls collectDiagnosticLogs on startContainers failure when diagnosticLogs is enabled', async () => {
    const startError = new Error('Squid container is unhealthy');
    const collectDiagnosticLogs = jest.fn().mockResolvedValue(undefined);
    const configWithDiagnostics: WrapperConfig = {
      ...baseConfig,
      diagnosticLogs: true,
    };
    const dependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockRejectedValue(startError),
      runAgentCommand: jest.fn(),
      collectDiagnosticLogs,
    };
    const logger = createLogger();

    await expect(runMainWorkflow(configWithDiagnostics, dependencies, { logger, performCleanup: jest.fn() })).rejects.toBe(startError);

    expect(collectDiagnosticLogs).toHaveBeenCalledWith(configWithDiagnostics.workDir);
    expect(dependencies.runAgentCommand).not.toHaveBeenCalled();
  });

  it('does not call collectDiagnosticLogs on startContainers failure when diagnosticLogs is disabled', async () => {
    const startError = new Error('Squid container is unhealthy');
    const collectDiagnosticLogs = jest.fn().mockResolvedValue(undefined);
    const dependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockRejectedValue(startError),
      runAgentCommand: jest.fn(),
      collectDiagnosticLogs,
    };
    const logger = createLogger();

    await expect(runMainWorkflow(baseConfig, dependencies, { logger, performCleanup: jest.fn() })).rejects.toBe(startError);

    expect(collectDiagnosticLogs).not.toHaveBeenCalled();
  });

  it('warns but continues when collectDiagnosticLogs throws during startContainers failure', async () => {
    const startError = new Error('docker compose failed');
    const diagError = new Error('disk full');
    const configWithDiagnostics: WrapperConfig = {
      ...baseConfig,
      diagnosticLogs: true,
    };
    const dependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockRejectedValue(startError),
      runAgentCommand: jest.fn(),
      collectDiagnosticLogs: jest.fn().mockRejectedValue(diagError),
    };
    const logger = createLogger();

    await expect(runMainWorkflow(configWithDiagnostics, dependencies, { logger, performCleanup: jest.fn() })).rejects.toBe(startError);

    expect(logger.warn).toHaveBeenCalledWith('Failed to collect diagnostic logs; continuing with cleanup.', diagError);
  });

  it('warns but continues when collectDiagnosticLogs throws during post-run collection', async () => {
    const diagError = new Error('disk full');
    const configWithDiagnostics: WrapperConfig = {
      ...baseConfig,
      diagnosticLogs: true,
    };
    const dependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockResolvedValue(undefined),
      runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 1 }),
      collectDiagnosticLogs: jest.fn().mockRejectedValue(diagError),
    };
    const logger = createLogger();
    const performCleanup = jest.fn().mockResolvedValue(undefined);

    const exitCode = await runMainWorkflow(configWithDiagnostics, dependencies, { logger, performCleanup });

    expect(exitCode).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith('Failed to collect diagnostic logs; continuing with cleanup.', diagError);
    expect(performCleanup).toHaveBeenCalled();
  });

  it('passes apiProxyIp when enableApiProxy is true', async () => {
    const configWithApiProxy: WrapperConfig = {
      ...baseConfig,
      enableApiProxy: true,
    };
    const { dependencies } = await runWorkflowWithDefaults(configWithApiProxy, {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10', proxyIp: '172.30.0.30', agentIp: '172.30.0.20', subnet: '172.30.0.0/24' }),
    });

    expect(dependencies.setupHostIptables).toHaveBeenCalledWith(
      '172.30.0.10', 3128, expect.any(Array), '172.30.0.30', undefined, undefined, undefined
    );
  });

  it('passes undefined apiProxyIp when enableApiProxy is false', async () => {
    const { dependencies } = await runWorkflowWithDefaults(baseConfig, {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10', proxyIp: '172.30.0.30', agentIp: '172.30.0.20', subnet: '172.30.0.0/24' }),
    });

    expect(dependencies.setupHostIptables).toHaveBeenCalledWith(
      '172.30.0.10', 3128, expect.any(Array), undefined, undefined, undefined, undefined
    );
  });

  it('passes dohProxyIp when dnsOverHttps is enabled', async () => {
    const configWithDoH: WrapperConfig = {
      ...baseConfig,
      dnsOverHttps: 'https://dns.google/dns-query',
    };
    const { dependencies } = await runWorkflowWithDefaults(configWithDoH, {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10', proxyIp: '172.30.0.30', agentIp: '172.30.0.20', subnet: '172.30.0.0/24' }),
    });

    expect(dependencies.setupHostIptables).toHaveBeenCalledWith(
      '172.30.0.10', 3128, expect.any(Array), undefined, '172.30.0.40', undefined, undefined
    );
  });

  it('passes undefined dohProxyIp when dnsOverHttps is not set', async () => {
    const { dependencies } = await runWorkflowWithDefaults();

    expect(dependencies.setupHostIptables).toHaveBeenCalledWith(
      '172.30.0.10', 3128, expect.any(Array), undefined, undefined, undefined, undefined
    );
  });

  it('passes cliProxyConfig when difcProxyHost is set', async () => {
    const configWithDifc: WrapperConfig = {
      ...baseConfig,
      difcProxyHost: 'proxy.corp.com:18443',
    };
    const { dependencies } = await runWorkflowWithDefaults(configWithDifc, {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10', proxyIp: '172.30.0.30', agentIp: '172.30.0.20', subnet: '172.30.0.0/24' }),
    });

    expect(dependencies.setupHostIptables).toHaveBeenCalledWith(
      '172.30.0.10', 3128, expect.any(Array), undefined, undefined, undefined,
      { ip: '172.30.0.50', difcProxyPort: 18443 }
    );
  });

  it('passes undefined cliProxyConfig when difcProxyHost is not set', async () => {
    const { dependencies } = await runWorkflowWithDefaults();

    expect(dependencies.setupHostIptables).toHaveBeenCalledWith(
      '172.30.0.10', 3128, expect.any(Array), undefined, undefined, undefined, undefined
    );
  });

  it('rethrows startContainers error after collecting diagnostics', async () => {
    const startError = new Error('docker compose failed');
    const configWithDiagnostics: WrapperConfig = {
      ...baseConfig,
      diagnosticLogs: true,
    };
    const performCleanup = jest.fn().mockResolvedValue(undefined);
    const dependencies = {
      ensureFirewallNetwork: jest.fn().mockResolvedValue({ squidIp: '172.30.0.10' }),
      setupHostIptables: jest.fn().mockResolvedValue(undefined),
      writeConfigs: jest.fn().mockResolvedValue(undefined),
      startContainers: jest.fn().mockRejectedValue(startError),
      runAgentCommand: jest.fn(),
      collectDiagnosticLogs: jest.fn().mockResolvedValue(undefined),
    };
    const logger = createLogger();

    await expect(runMainWorkflow(configWithDiagnostics, dependencies, { logger, performCleanup })).rejects.toBe(startError);
    // performCleanup should NOT be called — that is the caller's (cli.ts) responsibility
    expect(performCleanup).not.toHaveBeenCalled();
  });
});
