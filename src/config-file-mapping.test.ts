import { mapAwfFileConfigToCliOptions } from './config-file';

describe('mapAwfFileConfigToCliOptions', () => {
  it('maps nested config values to CLI option names', () => {
    const result = mapAwfFileConfigToCliOptions({
      network: { allowDomains: ['github.com', 'api.github.com'], dnsServers: ['1.1.1.1', '1.0.0.1'] },
      apiProxy: { enabled: true, targets: { anthropic: { host: 'api.anthropic.com', basePath: '/anthropic' } } },
      container: { agentTimeout: 15, containerWorkDir: '/workspace' },
      rateLimiting: { enabled: false, requestsPerMinute: 60 },
    });

    expect(result.allowDomains).toBe('github.com,api.github.com');
    expect(result.dnsServers).toBe('1.1.1.1,1.0.0.1');
    expect(result.enableApiProxy).toBe(true);
    expect(result.anthropicApiTarget).toBe('api.anthropic.com');
    expect(result.anthropicApiBasePath).toBe('/anthropic');
    expect(result.agentTimeout).toBe('15');
    expect(result.containerWorkdir).toBe('/workspace');
    expect(result.rateLimit).toBe(false);
    expect(result.rateLimitRpm).toBe('60');
  });

  it('returns undefined for unset optional fields', () => {
    const result = mapAwfFileConfigToCliOptions({});

    expect(result.allowDomains).toBeUndefined();
    expect(result.blockDomains).toBeUndefined();
    expect(result.dnsServers).toBeUndefined();
    expect(result.upstreamProxy).toBeUndefined();
    expect(result.enableApiProxy).toBeUndefined();
    expect(result.sslBump).toBeUndefined();
    expect(result.rateLimit).toBeUndefined();
  });

  it('maps all API proxy target fields', () => {
    const result = mapAwfFileConfigToCliOptions({
      apiProxy: {
        targets: {
          openai: { host: 'api.openai.com', basePath: '/v1' },
          copilot: { host: 'api.githubcopilot.com' },
          gemini: { host: 'generativelanguage.googleapis.com', basePath: '/v1beta' },
        },
      },
    });

    expect(result.openaiApiTarget).toBe('api.openai.com');
    expect(result.openaiApiBasePath).toBe('/v1');
    expect(result.copilotApiTarget).toBe('api.githubcopilot.com');
    expect(result.geminiApiTarget).toBe('generativelanguage.googleapis.com');
    expect(result.geminiApiBasePath).toBe('/v1beta');
  });

  it('maps authHeader fields for openai and anthropic targets', () => {
    const result = mapAwfFileConfigToCliOptions({
      apiProxy: {
        targets: {
          openai: { host: 'azure-openai.internal', authHeader: 'api-key' },
          anthropic: { host: 'anthropic-gw.internal', authHeader: 'api-key' },
        },
      },
    });

    expect(result.openaiApiAuthHeader).toBe('api-key');
    expect(result.anthropicApiAuthHeader).toBe('api-key');
  });

  it('leaves authHeader undefined when not set', () => {
    const result = mapAwfFileConfigToCliOptions({
      apiProxy: {
        targets: {
          openai: { host: 'api.openai.com' },
          anthropic: { host: 'api.anthropic.com' },
        },
      },
    });

    expect(result.openaiApiAuthHeader).toBeUndefined();
    expect(result.anthropicApiAuthHeader).toBeUndefined();
  });

  it('maps antigravity target fields to existing gemini runtime options', () => {
    const result = mapAwfFileConfigToCliOptions({
      apiProxy: {
        targets: {
          antigravity: { host: 'gateway.google.com', basePath: '/v1alpha' },
        },
      },
    });

    expect(result.geminiApiTarget).toBe('gateway.google.com');
    expect(result.geminiApiBasePath).toBe('/v1alpha');
  });

  it('prefers antigravity target fields when both antigravity and gemini are set', () => {
    const result = mapAwfFileConfigToCliOptions({
      apiProxy: {
        targets: {
          gemini: { host: 'generativelanguage.googleapis.com', basePath: '/v1beta' },
          antigravity: { host: 'gateway.google.com', basePath: '/v1alpha' },
        },
      },
    });

    expect(result.geminiApiTarget).toBe('gateway.google.com');
    expect(result.geminiApiBasePath).toBe('/v1alpha');
  });

  it('falls back to gemini fields when antigravity only overrides one field', () => {
    const result = mapAwfFileConfigToCliOptions({
      apiProxy: {
        targets: {
          gemini: { host: 'generativelanguage.googleapis.com', basePath: '/v1beta' },
          antigravity: { host: 'gateway.google.com' },
        },
      },
    });

    expect(result.geminiApiTarget).toBe('gateway.google.com');
    expect(result.geminiApiBasePath).toBe('/v1beta');
  });

  it('maps anthropicAutoCache and anthropicCacheTailTtl fields', () => {
    const result = mapAwfFileConfigToCliOptions({
      apiProxy: {
        anthropicAutoCache: true,
        anthropicCacheTailTtl: '1h',
      },
    });
    expect(result.anthropicAutoCache).toBe(true);
    expect(result.anthropicCacheTailTtl).toBe('1h');
  });

  it('maps effective-token guard fields', () => {
    const result = mapAwfFileConfigToCliOptions({
      apiProxy: {
        maxEffectiveTokens: 6000,
        modelMultipliers: {
          'gpt-4o': 2,
          'claude-sonnet-4': 1.5,
        },
        defaultModelMultiplier: 27,
        enableTokenSteering: true,
      },
    });
    expect(result.maxEffectiveTokens).toBe(6000);
    expect(result.effectiveTokenModelMultipliers).toEqual({
      'gpt-4o': 2,
      'claude-sonnet-4': 1.5,
    });
    expect(result.effectiveTokenDefaultModelMultiplier).toBe(27);
    expect(result.enableTokenSteering).toBe(true);
  });

  it('maps maxRuns field', () => {
    const result = mapAwfFileConfigToCliOptions({ apiProxy: { maxRuns: 42 } });
    expect(result.maxRuns).toBe(42);
  });

  it('maps requestedModel field', () => {
    const result = mapAwfFileConfigToCliOptions({ apiProxy: { requestedModel: 'gpt-4o' } });
    expect(result.requestedModel).toBe('gpt-4o');
  });

  it('maps modelFallback field', () => {
    const result = mapAwfFileConfigToCliOptions({
      apiProxy: { modelFallback: { enabled: false, strategy: 'middle_power' } },
    });
    expect(result.modelFallback).toEqual({ enabled: false, strategy: 'middle_power' });
  });

  it('maps modelFallback.excludeEngines field', () => {
    const result = mapAwfFileConfigToCliOptions({
      apiProxy: {
        modelFallback: { enabled: true, strategy: 'middle_power', excludeEngines: ['openai', 'copilot'] },
      },
    });
    expect(result.modelFallback).toEqual({
      enabled: true,
      strategy: 'middle_power',
      excludeEngines: ['openai', 'copilot'],
    });
  });

  it('leaves maxRuns undefined when not set', () => {
    const result = mapAwfFileConfigToCliOptions({});
    expect(result.maxRuns).toBeUndefined();
  });

  it('leaves anthropicAutoCache and anthropicCacheTailTtl undefined when not set', () => {
    const result = mapAwfFileConfigToCliOptions({});
    expect(result.anthropicAutoCache).toBeUndefined();
    expect(result.anthropicCacheTailTtl).toBeUndefined();
  });

  it('maps security fields', () => {
    const result = mapAwfFileConfigToCliOptions({
      security: {
        sslBump: true,
        enableDlp: false,
        enableHostAccess: true,
        allowHostPorts: ['8080', '9090'],
        allowHostServicePorts: '5432',
        difcProxy: { host: 'proxy.example.com', caCert: '/path/ca.crt' },
      },
    });

    expect(result.sslBump).toBe(true);
    expect(result.enableDlp).toBe(false);
    expect(result.enableHostAccess).toBe(true);
    expect(result.allowHostPorts).toBe('8080,9090');
    expect(result.allowHostServicePorts).toBe('5432');
    expect(result.difcProxyHost).toBe('proxy.example.com');
    expect(result.difcProxyCaCert).toBe('/path/ca.crt');
  });

  it('maps container fields', () => {
    const result = mapAwfFileConfigToCliOptions({
      container: {
        memoryLimit: '4g',
        enableDind: true,
        workDir: '/tmp/awf',
        imageRegistry: 'ghcr.io/custom',
        imageTag: 'v1.0',
        skipPull: true,
        buildLocal: false,
        agentImage: 'custom:latest',
        tty: true,
        dockerHost: 'unix:///var/run/docker.sock',
        dockerHostPathPrefix: '/host',
      },
    });

    expect(result.memoryLimit).toBe('4g');
    expect(result.enableDind).toBe(true);
    expect(result.workDir).toBe('/tmp/awf');
    expect(result.imageRegistry).toBe('ghcr.io/custom');
    expect(result.imageTag).toBe('v1.0');
    expect(result.skipPull).toBe(true);
    expect(result.buildLocal).toBe(false);
    expect(result.agentImage).toBe('custom:latest');
    expect(result.tty).toBe(true);
    expect(result.dockerHost).toBe('unix:///var/run/docker.sock');
    expect(result.dockerHostPathPrefix).toBe('/host');
  });

  it('maps environment fields', () => {
    const result = mapAwfFileConfigToCliOptions({
      environment: {
        envFile: '.env',
        envAll: true,
        excludeEnv: ['HOME', 'PATH'],
      },
    });

    expect(result.envFile).toBe('.env');
    expect(result.envAll).toBe(true);
    expect(result.excludeEnv).toEqual(['HOME', 'PATH']);
  });

  it('maps logging fields', () => {
    const result = mapAwfFileConfigToCliOptions({
      logging: {
        logLevel: 'debug',
        diagnosticLogs: true,
        auditDir: '/tmp/audit',
        proxyLogsDir: '/tmp/proxy',
        sessionStateDir: '/tmp/state',
      },
    });

    expect(result.logLevel).toBe('debug');
    expect(result.diagnosticLogs).toBe(true);
    expect(result.auditDir).toBe('/tmp/audit');
    expect(result.proxyLogsDir).toBe('/tmp/proxy');
    expect(result.sessionStateDir).toBe('/tmp/state');
  });

  it('maps apiProxy.auth.anthropicTokenUrl', () => {
    const result = mapAwfFileConfigToCliOptions({
      apiProxy: {
        auth: {
          anthropicTokenUrl: 'https://anthropic.internal.example/v1/oauth/token',
        },
      },
    });

    expect(result.anthropicTokenUrl).toBe('https://anthropic.internal.example/v1/oauth/token');
  });

  it('maps rateLimiting fields including rph and bytesPm', () => {
    const result = mapAwfFileConfigToCliOptions({
      rateLimiting: { enabled: true, requestsPerHour: 3600, bytesPerMinute: 1048576 },
    });

    expect(result.rateLimit).toBeUndefined(); // enabled: true → no negated flag
    expect(result.rateLimitRph).toBe('3600');
    expect(result.rateLimitBytesPm).toBe('1048576');
  });

  it('returns undefined for empty allowDomains array', () => {
    const result = mapAwfFileConfigToCliOptions({ network: { allowDomains: [] } });
    expect(result.allowDomains).toBeUndefined();
  });
});
