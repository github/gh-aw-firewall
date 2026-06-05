import { validateAwfFileConfig } from './config-file';

describe('validateAwfFileConfig', () => {
  it('accepts valid nested config sections', () => {
    const errors = validateAwfFileConfig({
      network: { allowDomains: ['github.com'] },
      apiProxy: { enabled: true, targets: { openai: { host: 'api.openai.com' } } },
      container: { agentTimeout: 30 },
    });

    expect(errors).toEqual([]);
  });

  it('reports unknown keys and invalid value types', () => {
    const errors = validateAwfFileConfig({
      network: { allowDomains: 'github.com' },
      unknown: true,
    });

    expect(errors).toContain('config.unknown is not supported');
    expect(errors).toContain('config.network.allowDomains must be an array of strings');
  });

  it('rejects unsupported copilot basePath', () => {
    const errors = validateAwfFileConfig({
      apiProxy: { targets: { copilot: { host: 'api.githubcopilot.com', basePath: '/v1' } } },
    });

    expect(errors).toContain('config.apiProxy.targets.copilot.basePath is not supported');
  });

  it('rejects non-object config root', () => {
    expect(validateAwfFileConfig(null)).toEqual(['config root must be an object']);
    expect(validateAwfFileConfig('string')).toEqual(['config root must be an object']);
    expect(validateAwfFileConfig(42)).toEqual(['config root must be an object']);
    expect(validateAwfFileConfig([])).toEqual(['config root must be an object']);
  });

  it('rejects non-string $schema', () => {
    const errors = validateAwfFileConfig({ $schema: 123 });
    expect(errors).toContain('config.$schema must be a string');
  });

  it('rejects non-object network', () => {
    const errors = validateAwfFileConfig({ network: 'invalid' });
    expect(errors).toContain('config.network must be an object');
  });

  it('rejects non-string network.upstreamProxy', () => {
    const errors = validateAwfFileConfig({ network: { upstreamProxy: 123 } });
    expect(errors).toContain('config.network.upstreamProxy must be a string');
  });

  it('rejects non-string-array network.blockDomains', () => {
    const errors = validateAwfFileConfig({ network: { blockDomains: [1, 2, 3] } });
    expect(errors).toContain('config.network.blockDomains must be an array of strings');
  });

  it('rejects non-string-array network.dnsServers', () => {
    const errors = validateAwfFileConfig({ network: { dnsServers: 'not-array' } });
    expect(errors).toContain('config.network.dnsServers must be an array of strings');
  });

  it('rejects non-object apiProxy', () => {
    const errors = validateAwfFileConfig({ apiProxy: 'invalid' });
    expect(errors).toContain('config.apiProxy must be an object');
  });

  it('rejects non-boolean apiProxy.enabled', () => {
    const errors = validateAwfFileConfig({ apiProxy: { enabled: 'yes' } });
    expect(errors).toContain('config.apiProxy.enabled must be a boolean');
  });

  it('rejects apiProxy.enableOpenCode as unsupported', () => {
    const errors = validateAwfFileConfig({ apiProxy: { enableOpenCode: true } });
    expect(errors).toContain('config.apiProxy.enableOpenCode is not supported');
  });

  it('accepts boolean apiProxy.enableTokenSteering', () => {
    expect(validateAwfFileConfig({ apiProxy: { enableTokenSteering: true } })).toEqual([]);
    expect(validateAwfFileConfig({ apiProxy: { enableTokenSteering: false } })).toEqual([]);
  });

  it('rejects non-boolean apiProxy.enableTokenSteering', () => {
    const errors = validateAwfFileConfig({ apiProxy: { enableTokenSteering: 'yes' } });
    expect(errors).toContain('config.apiProxy.enableTokenSteering must be a boolean');
  });

  it('accepts boolean apiProxy.anthropicAutoCache', () => {
    expect(validateAwfFileConfig({ apiProxy: { anthropicAutoCache: true } })).toEqual([]);
    expect(validateAwfFileConfig({ apiProxy: { anthropicAutoCache: false } })).toEqual([]);
  });

  it('rejects non-boolean apiProxy.anthropicAutoCache', () => {
    const errors = validateAwfFileConfig({ apiProxy: { anthropicAutoCache: 'yes' } });
    expect(errors).toContain('config.apiProxy.anthropicAutoCache must be a boolean');
  });

  it('accepts valid apiProxy.anthropicCacheTailTtl values', () => {
    expect(validateAwfFileConfig({ apiProxy: { anthropicCacheTailTtl: '5m' } })).toEqual([]);
    expect(validateAwfFileConfig({ apiProxy: { anthropicCacheTailTtl: '1h' } })).toEqual([]);
  });

  it('rejects invalid apiProxy.anthropicCacheTailTtl', () => {
    const errors = validateAwfFileConfig({ apiProxy: { anthropicCacheTailTtl: '10m' } });
    expect(errors).toContain('config.apiProxy.anthropicCacheTailTtl must be one of: 5m, 1h');
  });

  it('validates effective-token guard fields in apiProxy', () => {
    expect(validateAwfFileConfig({
      apiProxy: {
        maxEffectiveTokens: 5000,
        maxAiCredits: 1.5,
        modelMultipliers: { 'gpt-4o': 2, 'claude-sonnet-4': 1.5 },
        defaultModelMultiplier: 27,
        maxModelMultiplierCap: 5,
      },
    })).toEqual([]);

    expect(validateAwfFileConfig({ apiProxy: { maxEffectiveTokens: 0 } }))
      .toContain('config.apiProxy.maxEffectiveTokens must be a positive integer');
    expect(validateAwfFileConfig({ apiProxy: { maxAiCredits: 0 } }))
      .toContain('config.apiProxy.maxAiCredits must be > 0');
    expect(validateAwfFileConfig({ apiProxy: { modelMultipliers: { 'gpt-4o': 0 } } }))
      .toContain('config.apiProxy.modelMultipliers.gpt-4o must be > 0');
    expect(validateAwfFileConfig({ apiProxy: { defaultModelMultiplier: 0 } }))
      .toContain('config.apiProxy.defaultModelMultiplier must be > 0');
  });

  it('validates maxModelMultiplierCap in apiProxy', () => {
    expect(validateAwfFileConfig({ apiProxy: { maxModelMultiplierCap: 4 } })).toEqual([]);
    expect(validateAwfFileConfig({ apiProxy: { maxModelMultiplierCap: 0.5 } })).toEqual([]);
    expect(validateAwfFileConfig({ apiProxy: { maxModelMultiplierCap: 0 } }))
      .toContain('config.apiProxy.maxModelMultiplierCap must be > 0');
    expect(validateAwfFileConfig({ apiProxy: { maxModelMultiplierCap: -1 } }))
      .toContain('config.apiProxy.maxModelMultiplierCap must be > 0');
  });

  it('validates maxRuns in apiProxy', () => {
    expect(validateAwfFileConfig({ apiProxy: { maxRuns: 10 } })).toEqual([]);
    expect(validateAwfFileConfig({ apiProxy: { maxRuns: 1 } })).toEqual([]);
    expect(validateAwfFileConfig({ apiProxy: { maxRuns: 0 } }))
      .toContain('config.apiProxy.maxRuns must be a positive integer');
    expect(validateAwfFileConfig({ apiProxy: { maxRuns: -1 } }))
      .toContain('config.apiProxy.maxRuns must be a positive integer');
  });

  it('validates apiProxy.modelFallback fields', () => {
    expect(validateAwfFileConfig({ apiProxy: { modelFallback: { enabled: true, strategy: 'middle_power' } } })).toEqual([]);
    expect(validateAwfFileConfig({ apiProxy: { modelFallback: { enabled: 'yes' } } }))
      .toContain('config.apiProxy.modelFallback.enabled must be a boolean');
    expect(validateAwfFileConfig({ apiProxy: { modelFallback: { strategy: 'unknown' } } }))
      .toContain('config.apiProxy.modelFallback.strategy must be one of: middle_power');
  });

  it('validates apiProxy.modelRouter fields', () => {
    expect(validateAwfFileConfig({
      apiProxy: { modelRouter: { providerType: 'azure', baseUrl: 'https://router.example.com/v1' } },
    })).toEqual([]);

    expect(validateAwfFileConfig({ apiProxy: { modelRouter: { providerType: 123 } } }))
      .toContain('config.apiProxy.modelRouter.providerType must be a string');
    expect(validateAwfFileConfig({ apiProxy: { modelRouter: { baseUrl: 456 } } }))
      .toContain('config.apiProxy.modelRouter.baseUrl must be a string');
  });

  it('rejects non-object apiProxy.targets', () => {
    const errors = validateAwfFileConfig({ apiProxy: { targets: 'invalid' } });
    expect(errors).toContain('config.apiProxy.targets must be an object');
  });

  it('rejects non-object provider target', () => {
    const errors = validateAwfFileConfig({ apiProxy: { targets: { openai: 'invalid' } } });
    expect(errors).toContain('config.apiProxy.targets.openai must be an object');
  });

  it('rejects non-string provider target host', () => {
    const errors = validateAwfFileConfig({ apiProxy: { targets: { openai: { host: 123 } } } });
    expect(errors).toContain('config.apiProxy.targets.openai.host must be a string');
  });

  it('rejects non-string provider target basePath', () => {
    const errors = validateAwfFileConfig({ apiProxy: { targets: { anthropic: { basePath: 456 } } } });
    expect(errors).toContain('config.apiProxy.targets.anthropic.basePath must be a string');
  });

  it('accepts copilot extraHeaders as object of string values', () => {
    const errors = validateAwfFileConfig({
      apiProxy: { targets: { copilot: { extraHeaders: { 'x-session-id': 'run-42' } } } },
    });
    expect(errors).toEqual([]);
  });

  it('rejects non-object copilot extraHeaders', () => {
    const errors = validateAwfFileConfig({
      apiProxy: { targets: { copilot: { extraHeaders: 'invalid' } } },
    });
    expect(errors).toContain('config.apiProxy.targets.copilot.extraHeaders must be an object');
  });

  it('rejects non-string copilot extraHeaders values', () => {
    const errors = validateAwfFileConfig({
      apiProxy: { targets: { copilot: { extraHeaders: { 'x-session-id': 42 } } } },
    });
    expect(errors).toContain('config.apiProxy.targets.copilot.extraHeaders.x-session-id must be a string');
  });

  it('accepts copilot extraBodyFields as object of string values', () => {
    const errors = validateAwfFileConfig({
      apiProxy: { targets: { copilot: { extraBodyFields: { session_id: 'run-42' } } } },
    });
    expect(errors).toEqual([]);
  });

  it('rejects non-object copilot extraBodyFields', () => {
    const errors = validateAwfFileConfig({
      apiProxy: { targets: { copilot: { extraBodyFields: 'invalid' } } },
    });
    expect(errors).toContain('config.apiProxy.targets.copilot.extraBodyFields must be an object');
  });

  it('rejects non-string copilot extraBodyFields values', () => {
    const errors = validateAwfFileConfig({
      apiProxy: { targets: { copilot: { extraBodyFields: { session_id: 42 } } } },
    });
    expect(errors).toContain('config.apiProxy.targets.copilot.extraBodyFields.session_id must be a string');
  });

  it('accepts gemini target with host and basePath', () => {
    const errors = validateAwfFileConfig({
      apiProxy: { targets: { gemini: { host: 'generativelanguage.googleapis.com', basePath: '/v1' } } },
    });
    expect(errors).toEqual([]);
  });

  it('accepts antigravity target with host and basePath', () => {
    const errors = validateAwfFileConfig({
      apiProxy: { targets: { antigravity: { host: 'generativelanguage.googleapis.com', basePath: '/v1' } } },
    });
    expect(errors).toEqual([]);
  });

  it('accepts authHeader on openai and anthropic targets', () => {
    const errors = validateAwfFileConfig({
      apiProxy: { targets: {
        openai: { host: 'azure-openai.internal', authHeader: 'api-key' },
        anthropic: { host: 'anthropic-gw.internal', authHeader: 'api-key' },
      } },
    });
    expect(errors).toEqual([]);
  });

  it('rejects non-string authHeader', () => {
    const errors = validateAwfFileConfig({
      apiProxy: { targets: { openai: { authHeader: 123 } } },
    });
    expect(errors).toContain('config.apiProxy.targets.openai.authHeader must be a string');
  });

  it('rejects non-object security', () => {
    const errors = validateAwfFileConfig({ security: 'invalid' });
    expect(errors).toContain('config.security must be an object');
  });

  it('rejects non-boolean security.sslBump', () => {
    const errors = validateAwfFileConfig({ security: { sslBump: 'yes' } });
    expect(errors).toContain('config.security.sslBump must be a boolean');
  });

  it('rejects non-boolean security.enableDlp', () => {
    const errors = validateAwfFileConfig({ security: { enableDlp: 1 } });
    expect(errors).toContain('config.security.enableDlp must be a boolean');
  });

  it('rejects non-boolean security.enableHostAccess', () => {
    const errors = validateAwfFileConfig({ security: { enableHostAccess: 'true' } });
    expect(errors).toContain('config.security.enableHostAccess must be a boolean');
  });

  it('rejects non-string/array security.allowHostPorts', () => {
    const errors = validateAwfFileConfig({ security: { allowHostPorts: 8080 } });
    expect(errors).toContain('config.security.allowHostPorts must be a string or array of strings');
  });

  it('accepts security.allowHostPorts as string', () => {
    const errors = validateAwfFileConfig({ security: { allowHostPorts: '8080' } });
    expect(errors).toEqual([]);
  });

  it('accepts security.allowHostPorts as string array', () => {
    const errors = validateAwfFileConfig({ security: { allowHostPorts: ['8080', '9090'] } });
    expect(errors).toEqual([]);
  });

  it('rejects non-string/array security.allowHostServicePorts', () => {
    const errors = validateAwfFileConfig({ security: { allowHostServicePorts: 9090 } });
    expect(errors).toContain('config.security.allowHostServicePorts must be a string or array of strings');
  });

  it('rejects non-object security.difcProxy', () => {
    const errors = validateAwfFileConfig({ security: { difcProxy: 'invalid' } });
    expect(errors).toContain('config.security.difcProxy must be an object');
  });

  it('rejects non-string security.difcProxy.host', () => {
    const errors = validateAwfFileConfig({ security: { difcProxy: { host: 123 } } });
    expect(errors).toContain('config.security.difcProxy.host must be a string');
  });

  it('rejects non-string security.difcProxy.caCert', () => {
    const errors = validateAwfFileConfig({ security: { difcProxy: { caCert: 456 } } });
    expect(errors).toContain('config.security.difcProxy.caCert must be a string');
  });

  it('rejects unknown security.difcProxy keys', () => {
    const errors = validateAwfFileConfig({ security: { difcProxy: { host: 'proxy.example.com', unknown: true } } });
    expect(errors).toContain('config.security.difcProxy.unknown is not supported');
  });

  it('rejects non-object container', () => {
    const errors = validateAwfFileConfig({ container: 'invalid' });
    expect(errors).toContain('config.container must be an object');
  });

  it('rejects non-string container.memoryLimit', () => {
    const errors = validateAwfFileConfig({ container: { memoryLimit: 512 } });
    expect(errors).toContain('config.container.memoryLimit must be a string');
  });

  it('rejects non-positive-integer container.agentTimeout', () => {
    expect(validateAwfFileConfig({ container: { agentTimeout: 0 } })).toContain('config.container.agentTimeout must be a positive integer');
    expect(validateAwfFileConfig({ container: { agentTimeout: -1 } })).toContain('config.container.agentTimeout must be a positive integer');
    expect(validateAwfFileConfig({ container: { agentTimeout: 1.5 } })).toContain('config.container.agentTimeout must be a positive integer');
    expect(validateAwfFileConfig({ container: { agentTimeout: 'five' } })).toContain('config.container.agentTimeout must be a positive integer');
  });

  it('rejects non-boolean container.enableDind', () => {
    const errors = validateAwfFileConfig({ container: { enableDind: 1 } });
    expect(errors).toContain('config.container.enableDind must be a boolean');
  });

  it('rejects non-string container.workDir', () => {
    const errors = validateAwfFileConfig({ container: { workDir: 123 } });
    expect(errors).toContain('config.container.workDir must be a string');
  });

  it('rejects non-string container.containerWorkDir', () => {
    const errors = validateAwfFileConfig({ container: { containerWorkDir: 123 } });
    expect(errors).toContain('config.container.containerWorkDir must be a string');
  });

  it('rejects non-string container.imageRegistry', () => {
    const errors = validateAwfFileConfig({ container: { imageRegistry: 123 } });
    expect(errors).toContain('config.container.imageRegistry must be a string');
  });

  it('rejects non-string container.imageTag', () => {
    const errors = validateAwfFileConfig({ container: { imageTag: 123 } });
    expect(errors).toContain('config.container.imageTag must be a string');
  });

  it('rejects non-boolean container.skipPull', () => {
    const errors = validateAwfFileConfig({ container: { skipPull: 'yes' } });
    expect(errors).toContain('config.container.skipPull must be a boolean');
  });

  it('rejects non-boolean container.buildLocal', () => {
    const errors = validateAwfFileConfig({ container: { buildLocal: 'yes' } });
    expect(errors).toContain('config.container.buildLocal must be a boolean');
  });

  it('rejects non-string container.agentImage', () => {
    const errors = validateAwfFileConfig({ container: { agentImage: 123 } });
    expect(errors).toContain('config.container.agentImage must be a string');
  });

  it('rejects non-boolean container.tty', () => {
    const errors = validateAwfFileConfig({ container: { tty: 'yes' } });
    expect(errors).toContain('config.container.tty must be a boolean');
  });

  it('rejects non-string container.dockerHost', () => {
    const errors = validateAwfFileConfig({ container: { dockerHost: 123 } });
    expect(errors).toContain('config.container.dockerHost must be a string');
  });

  it('rejects non-string container.dockerHostPathPrefix', () => {
    const errors = validateAwfFileConfig({ container: { dockerHostPathPrefix: 123 } });
    expect(errors).toContain('config.container.dockerHostPathPrefix must be a string');
  });

  it('rejects non-string container.runnerToolCachePath', () => {
    const errors = validateAwfFileConfig({ container: { runnerToolCachePath: 123 } });
    expect(errors).toContain('config.container.runnerToolCachePath must be a string');
  });

  it('rejects unknown container keys', () => {
    const errors = validateAwfFileConfig({ container: { unknown: true } });
    expect(errors).toContain('config.container.unknown is not supported');
  });

  it('rejects non-object chroot', () => {
    const errors = validateAwfFileConfig({ chroot: 'invalid' });
    expect(errors).toContain('config.chroot must be an object');
  });

  it('rejects non-object chroot.identity', () => {
    const errors = validateAwfFileConfig({ chroot: { identity: 'invalid' } });
    expect(errors).toContain('config.chroot.identity must be an object');
  });

  it('rejects invalid chroot.identity field types', () => {
    expect(validateAwfFileConfig({ chroot: { identity: { home: 1 } } })).toContain('config.chroot.identity.home must be a string');
    expect(validateAwfFileConfig({ chroot: { identity: { user: 1 } } })).toContain('config.chroot.identity.user must be a string');
    expect(validateAwfFileConfig({ chroot: { identity: { uid: 0 } } })).toContain('config.chroot.identity.uid must be a positive integer');
    expect(validateAwfFileConfig({ chroot: { identity: { uid: -1 } } })).toContain('config.chroot.identity.uid must be a positive integer');
    expect(validateAwfFileConfig({ chroot: { identity: { uid: 1.5 } } })).toContain('config.chroot.identity.uid must be a positive integer');
    expect(validateAwfFileConfig({ chroot: { identity: { gid: 0 } } })).toContain('config.chroot.identity.gid must be a positive integer');
    expect(validateAwfFileConfig({ chroot: { identity: { gid: -1 } } })).toContain('config.chroot.identity.gid must be a positive integer');
    expect(validateAwfFileConfig({ chroot: { identity: { gid: 1.5 } } })).toContain('config.chroot.identity.gid must be a positive integer');
  });

  it('rejects unknown chroot.identity keys', () => {
    const errors = validateAwfFileConfig({ chroot: { identity: { home: '/tmp', extra: true } } });
    expect(errors).toContain('config.chroot.identity.extra is not supported');
  });

  it('rejects non-object dind', () => {
    const errors = validateAwfFileConfig({ dind: 'invalid' });
    expect(errors).toContain('config.dind must be an object');
  });

  it('rejects invalid dind field types', () => {
    expect(validateAwfFileConfig({ dind: { preStageDirs: 'true' } })).toContain('config.dind.preStageDirs must be a boolean');
    expect(validateAwfFileConfig({ dind: { workDir: 1 } })).toContain('config.dind.workDir must be a string');
    expect(validateAwfFileConfig({ dind: { stagingImage: 1 } })).toContain('config.dind.stagingImage must be a string');
  });

  it('rejects non-object dind.stageEngineBinary', () => {
    const errors = validateAwfFileConfig({ dind: { stageEngineBinary: 'invalid' } });
    expect(errors).toContain('config.dind.stageEngineBinary must be an object');
  });

  it('rejects invalid dind.stageEngineBinary field types', () => {
    expect(validateAwfFileConfig({ dind: { stageEngineBinary: { path: 1 } } })).toContain('config.dind.stageEngineBinary.path must be a string');
    expect(validateAwfFileConfig({ dind: { stageEngineBinary: { targetPath: 1 } } })).toContain('config.dind.stageEngineBinary.targetPath must be a string');
  });

  it('rejects non-object environment', () => {
    const errors = validateAwfFileConfig({ environment: 'invalid' });
    expect(errors).toContain('config.environment must be an object');
  });

  it('rejects non-string environment.envFile', () => {
    const errors = validateAwfFileConfig({ environment: { envFile: 123 } });
    expect(errors).toContain('config.environment.envFile must be a string');
  });

  it('rejects non-boolean environment.envAll', () => {
    const errors = validateAwfFileConfig({ environment: { envAll: 'yes' } });
    expect(errors).toContain('config.environment.envAll must be a boolean');
  });

  it('rejects non-string-array environment.excludeEnv', () => {
    const errors = validateAwfFileConfig({ environment: { excludeEnv: 'HOME' } });
    expect(errors).toContain('config.environment.excludeEnv must be an array of strings');
  });

  it('rejects unknown environment keys', () => {
    const errors = validateAwfFileConfig({ environment: { unknown: true } });
    expect(errors).toContain('config.environment.unknown is not supported');
  });

  it('rejects non-object logging', () => {
    const errors = validateAwfFileConfig({ logging: 'invalid' });
    expect(errors).toContain('config.logging must be an object');
  });

  it('rejects invalid logging.logLevel', () => {
    const errors = validateAwfFileConfig({ logging: { logLevel: 'verbose' } });
    expect(errors).toContain('config.logging.logLevel must be one of: debug, info, warn, error');
  });

  it('rejects non-string logging.logLevel type', () => {
    const errors = validateAwfFileConfig({ logging: { logLevel: 42 } });
    expect(errors).toContain('config.logging.logLevel must be one of: debug, info, warn, error');
  });

  it('accepts valid logging.logLevel values', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) {
      expect(validateAwfFileConfig({ logging: { logLevel: level } })).toEqual([]);
    }
  });

  it('rejects non-boolean logging.diagnosticLogs', () => {
    const errors = validateAwfFileConfig({ logging: { diagnosticLogs: 'yes' } });
    expect(errors).toContain('config.logging.diagnosticLogs must be a boolean');
  });

  it('rejects non-string logging.auditDir', () => {
    const errors = validateAwfFileConfig({ logging: { auditDir: 123 } });
    expect(errors).toContain('config.logging.auditDir must be a string');
  });

  it('rejects non-string logging.proxyLogsDir', () => {
    const errors = validateAwfFileConfig({ logging: { proxyLogsDir: 123 } });
    expect(errors).toContain('config.logging.proxyLogsDir must be a string');
  });

  it('rejects non-string logging.sessionStateDir', () => {
    const errors = validateAwfFileConfig({ logging: { sessionStateDir: 123 } });
    expect(errors).toContain('config.logging.sessionStateDir must be a string');
  });

  it('rejects non-object rateLimiting', () => {
    const errors = validateAwfFileConfig({ rateLimiting: 'invalid' });
    expect(errors).toContain('config.rateLimiting must be an object');
  });

  it('rejects non-boolean rateLimiting.enabled', () => {
    const errors = validateAwfFileConfig({ rateLimiting: { enabled: 'yes' } });
    expect(errors).toContain('config.rateLimiting.enabled must be a boolean');
  });

  it('rejects non-positive-integer rateLimiting.requestsPerMinute', () => {
    const errors = validateAwfFileConfig({ rateLimiting: { requestsPerMinute: -5 } });
    expect(errors).toContain('config.rateLimiting.requestsPerMinute must be a positive integer');
  });

  it('rejects non-positive-integer rateLimiting.requestsPerHour', () => {
    const errors = validateAwfFileConfig({ rateLimiting: { requestsPerHour: 0 } });
    expect(errors).toContain('config.rateLimiting.requestsPerHour must be a positive integer');
  });

  it('rejects non-positive-integer rateLimiting.bytesPerMinute', () => {
    const errors = validateAwfFileConfig({ rateLimiting: { bytesPerMinute: 'lots' } });
    expect(errors).toContain('config.rateLimiting.bytesPerMinute must be a positive integer');
  });

  it('accepts valid rateLimiting values', () => {
    const errors = validateAwfFileConfig({
      rateLimiting: { enabled: true, requestsPerMinute: 60, requestsPerHour: 3600, bytesPerMinute: 1048576 },
    });
    expect(errors).toEqual([]);
  });

  it('accepts valid security config', () => {
    const errors = validateAwfFileConfig({
      security: {
        sslBump: true,
        enableDlp: false,
        enableHostAccess: true,
        allowHostPorts: '8080',
        allowHostServicePorts: ['5432', '6379'],
        difcProxy: { host: 'proxy.example.com', caCert: '/path/to/ca.crt' },
      },
    });
    expect(errors).toEqual([]);
  });

  it('accepts empty config object', () => {
    expect(validateAwfFileConfig({})).toEqual([]);
  });
});
