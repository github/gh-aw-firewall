import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { assembleAndValidateConfig } from './config-assembly';
import { logger } from '../../logger';
import { buildConfig } from '../build-config';
import { warnClassicPATWithCopilotModel } from '../../api-proxy-config';
import { LogAndLimitsResult } from './log-and-limits';
import { NetworkOptionsResult } from './network-options';
import { AgentOptionsResult } from './agent-options';
import {
  validateRateLimitFlags,
  validateEnableTokenSteeringFlag,
  validateSkipPullWithBuildLocal,
  validateAllowHostPorts,
  applyHostServicePortsConfig,
  buildRateLimitConfig,
} from '../../option-parsers';

// Mock the logger
jest.mock('../../logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock the option-parsers module
jest.mock('../../option-parsers', () => ({
  validateRateLimitFlags: jest.fn(),
  validateEnableTokenSteeringFlag: jest.fn(),
  validateSkipPullWithBuildLocal: jest.fn(),
  validateAllowHostPorts: jest.fn(),
  applyHostServicePortsConfig: jest.fn(),
  buildRateLimitConfig: jest.fn(),
  applyAgentTimeout: jest.fn(),
}));

// Mock the api-proxy-config module
jest.mock('../../api-proxy-config', () => ({
  validateApiProxyConfig: jest.fn().mockReturnValue({
    warnings: [],
    debugMessages: [],
  }),
  emitApiProxyTargetWarnings: jest.fn(),
  emitCliProxyStatusLogs: jest.fn(),
  warnClassicPATWithCopilotModel: jest.fn(),
}));

// Mock buildConfig
let mockBuildConfig: jest.Mock;
jest.mock('../build-config', () => ({
  buildConfig: jest.fn((args: any) => ({
    agentCommand: args.agentCommand,
    logLevel: args.logLevel,
    allowedDomains: args.allowedDomains,
    blockedDomains: args.blockedDomains,
    enableApiProxy: false,
    enableTokenSteering: false,
    envAll: false,
    envFile: undefined,
    awfDockerHost: undefined,
    dockerHostPathPrefix: undefined,
    openaiApiKey: undefined,
    anthropicApiKey: undefined,
    copilotGithubToken: undefined,
    copilotProviderApiKey: undefined,
    geminiApiKey: undefined,
    allowHostServicePorts: undefined,
    enableHostAccess: false,
    allowHostPorts: undefined,
    skipPull: false,
    buildLocal: false,
  })),
}));

describe('config-assembly', () => {
  let mockExit: jest.SpyInstance;
  let testDir: string;

  // Helper to create minimal valid input structures
  const createMinimalLogAndLimits = (): LogAndLimitsResult => ({
    logLevel: 'info' as const,
    memoryLimit: undefined,
    agentImage: undefined,
    modelAliases: {},
    maxEffectiveTokens: undefined,
    maxAiCredits: undefined,
    effectiveTokenModelMultipliers: {},
    effectiveTokenDefaultModelMultiplier: undefined,
    maxRuns: undefined,
    maxPermissionDenied: undefined,
  });

  const createMinimalNetworkOptions = (): NetworkOptionsResult => ({
    dockerHostCheck: { valid: true },
    allowedDomains: ['example.com'],
    blockedDomains: [],
    localhostResult: {
      allowedDomains: ['example.com'],
      localhostDetected: false,
      shouldEnableHostAccess: false,
    },
    upstreamProxy: undefined,
    dnsServers: ['8.8.8.8'],
    dnsOverHttps: undefined,
    resolvedCopilotApiTarget: undefined,
    resolvedCopilotApiBasePath: undefined,
    dockerHostPathPrefixResolution: { dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false },
  });

  const createMinimalAgentOptions = (): AgentOptionsResult => ({
    additionalEnv: {},
    volumeMounts: [],
    allowedUrls: [],
  });

  const callAssembleWith = (options: Record<string, unknown> = {}) =>
    assembleAndValidateConfig(
      options,
      'echo test',
      createMinimalLogAndLimits(),
      createMinimalNetworkOptions(),
      createMinimalAgentOptions(),
    );

  const createBuildConfigResult = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    agentCommand: 'echo test',
    logLevel: 'info',
    allowedDomains: ['example.com'],
    blockedDomains: [],
    enableApiProxy: false,
    enableTokenSteering: false,
    envAll: false,
    envFile: undefined,
    awfDockerHost: undefined,
    dockerHostPathPrefix: undefined,
    openaiApiKey: undefined,
    anthropicApiKey: undefined,
    copilotGithubToken: undefined,
    copilotProviderApiKey: undefined,
    geminiApiKey: undefined,
    allowHostServicePorts: undefined,
    enableHostAccess: false,
    allowHostPorts: undefined,
    skipPull: false,
    buildLocal: false,
    ...overrides,
  });

  const mockBuildConfigOnce = (overrides: Record<string, unknown>): void => {
    mockBuildConfig.mockReturnValueOnce(createBuildConfigResult(overrides));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Get reference to the mocked buildConfig
    mockBuildConfig = buildConfig as jest.Mock;
    
    mockBuildConfig.mockImplementation((args: any) =>
      createBuildConfigResult({
        agentCommand: args.agentCommand,
        logLevel: args.logLevel,
        allowedDomains: args.allowedDomains,
        blockedDomains: args.blockedDomains,
      }),
    );

    // Mock process.exit to throw an error instead (so we can test error paths)
    mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });

    // Default mock return values
    (validateRateLimitFlags as jest.Mock).mockReturnValue({ valid: true });
    (validateEnableTokenSteeringFlag as jest.Mock).mockReturnValue({ valid: true });
    (validateSkipPullWithBuildLocal as jest.Mock).mockReturnValue({ valid: true });
    (validateAllowHostPorts as jest.Mock).mockReturnValue({ valid: true });
    (applyHostServicePortsConfig as jest.Mock).mockReturnValue({
      valid: true,
      enableHostAccess: false,
    });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test directory creation
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
  });

  afterEach(() => {
    mockExit.mockRestore();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('docker-host validation', () => {
    it('should reject non-unix:// docker host URIs', () => {
      mockBuildConfigOnce({
        awfDockerHost: 'tcp://127.0.0.1:2375',
        dockerHostPathPrefix: undefined,
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--docker-host must be a unix:// socket URI'),
      );
    });

    it('should accept unix:// docker host URIs', () => {
      mockBuildConfigOnce({
        awfDockerHost: 'unix:///var/run/docker.sock',
        dockerHostPathPrefix: undefined,
      });

      const result = callAssembleWith();

      expect(result).toBeDefined();
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should reject relative docker-host-path-prefix', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: 'relative/path',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--docker-host-path-prefix must be an absolute path'),
      );
    });

    it('should accept absolute docker-host-path-prefix', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: '/host',
      });

      const result = callAssembleWith();

      expect(result).toBeDefined();
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should reject relative chroot binaries source path', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: undefined,
        chrootBinariesSourcePath: 'relative/path',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('chroot.binariesSourcePath must be an absolute path'),
      );
    });

    it('should accept absolute chroot binaries source path', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: undefined,
        chrootBinariesSourcePath: '/tmp/gh-aw/runner-bin',
      });

      const result = callAssembleWith();

      expect(result).toBeDefined();
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should reject chroot binaries source path set to root', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: undefined,
        chrootBinariesSourcePath: '/',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('chroot.binariesSourcePath cannot be "/"'),
      );
    });

    it('should reject chroot binaries source path containing a colon', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: undefined,
        chrootBinariesSourcePath: '/tmp/bin:/extra',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('chroot.binariesSourcePath must not contain ":" or newline characters'),
      );
    });

    it('should reject chroot binaries source path containing a newline', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: undefined,
        chrootBinariesSourcePath: '/tmp/bin\n/extra',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('chroot.binariesSourcePath must not contain ":" or newline characters'),
      );
    });
  });

  describe('rate limit validation', () => {
    it('should exit if rate limit config build fails', () => {
      mockBuildConfigOnce({
        enableApiProxy: true,
      });

      (buildRateLimitConfig as jest.Mock).mockReturnValueOnce({
        error: 'Invalid rate limit configuration',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid rate limit configuration'),
      );
    });

    it('should exit if rate limit flags are used without --enable-api-proxy', () => {
      (validateRateLimitFlags as jest.Mock).mockReturnValueOnce({
        valid: false,
        error: 'Rate limit flags require --enable-api-proxy',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        'Rate limit flags require --enable-api-proxy',
      );
    });

    it('should set rate limit config when API proxy is enabled', () => {
      mockBuildConfigOnce({
        enableApiProxy: true,
      });

      const mockRateLimitConfig = {
        enabled: true,
        rpm: 100,
        rph: 1000,
        bytesPm: 10000,
      };

      (buildRateLimitConfig as jest.Mock).mockReturnValueOnce({
        config: mockRateLimitConfig,
      });

      const result = callAssembleWith();

      expect(result.rateLimitConfig).toEqual(mockRateLimitConfig);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Rate limiting: enabled=true'),
      );
    });
  });

  describe('feature flag validation', () => {
    it('should exit if --enable-token-steering is used without --enable-api-proxy', () => {
      (validateEnableTokenSteeringFlag as jest.Mock).mockReturnValueOnce({
        valid: false,
        error: '--enable-token-steering requires --enable-api-proxy',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        '--enable-token-steering requires --enable-api-proxy',
      );
    });
  });

  describe('environment variable warnings', () => {
    it('should warn when --env-all is used', () => {
      mockBuildConfigOnce({
        envAll: true,
      });

      callAssembleWith();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Using --env-all'),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('may expose sensitive credentials'),
      );
    });

    it('should log debug message when --env-file is used', () => {
      mockBuildConfigOnce({
        envFile: '/tmp/test.env',
      });

      callAssembleWith();

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Loading environment variables from file'),
      );
    });
  });

  describe('host service ports validation', () => {
    it('should exit if service ports validation fails', () => {
      (applyHostServicePortsConfig as jest.Mock).mockReturnValueOnce({
        valid: false,
        error: 'Invalid port format',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid port format'),
      );
    });

    it('should apply enableHostAccess from service ports result', () => {
      (applyHostServicePortsConfig as jest.Mock).mockReturnValueOnce({
        valid: true,
        enableHostAccess: true,
      });

      const result = callAssembleWith();

      expect(result.enableHostAccess).toBe(true);
    });
  });

  describe('host ports validation', () => {
    it('should exit if --allow-host-ports is used without --enable-host-access', () => {
      (validateAllowHostPorts as jest.Mock).mockReturnValueOnce({
        valid: false,
        error: '--allow-host-ports requires --enable-host-access',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--allow-host-ports requires --enable-host-access'),
      );
    });
  });

  describe('skip-pull validation', () => {
    it('should exit if --skip-pull is used with --build-local', () => {
      (validateSkipPullWithBuildLocal as jest.Mock).mockReturnValueOnce({
        valid: false,
        error: '--skip-pull and --build-local are incompatible',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--skip-pull and --build-local are incompatible'),
      );
    });
  });

  describe('host access warnings', () => {
    it('should warn when host access is enabled with host.docker.internal', () => {
      mockBuildConfigOnce({
        enableHostAccess: true,
      });

      (applyHostServicePortsConfig as jest.Mock).mockReturnValueOnce({
        valid: true,
        enableHostAccess: true,
      });

      const networkOptions = createMinimalNetworkOptions();
      networkOptions.allowedDomains = ['host.docker.internal'];

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        networkOptions,
        createMinimalAgentOptions(),
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Host access enabled with host.docker.internal'),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Containers can access ANY service'),
      );
    });

    it('should warn when host access is enabled with subdomain of host.docker.internal', () => {
      mockBuildConfigOnce({
        enableHostAccess: true,
      });

      (applyHostServicePortsConfig as jest.Mock).mockReturnValueOnce({
        valid: true,
        enableHostAccess: true,
      });

      const networkOptions = createMinimalNetworkOptions();
      networkOptions.allowedDomains = ['api.host.docker.internal'];

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        networkOptions,
        createMinimalAgentOptions(),
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Host access enabled with host.docker.internal'),
      );
    });

    it('should not warn when host access is enabled without host.docker.internal', () => {
      mockBuildConfigOnce({
        enableHostAccess: true,
      });

      (applyHostServicePortsConfig as jest.Mock).mockReturnValueOnce({
        valid: true,
        enableHostAccess: true,
      });

      const networkOptions = createMinimalNetworkOptions();
      networkOptions.allowedDomains = ['example.com'];

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        networkOptions,
        createMinimalAgentOptions(),
      );

      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Host access enabled with host.docker.internal'),
      );
    });
  });

  describe('API proxy configuration', () => {
    it('should log API proxy status when enabled', () => {
      mockBuildConfigOnce({
        enableApiProxy: true,
        openaiApiKey: 'sk-test',
        anthropicApiKey: 'test-key',
      });

      (buildRateLimitConfig as jest.Mock).mockReturnValueOnce({
        config: { enabled: false },
      });

      callAssembleWith();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('API proxy enabled: OpenAI=true, Anthropic=true'),
      );
    });
  });

  describe('COPILOT_MODEL detection in env files', () => {
    it('should detect COPILOT_MODEL in env file', () => {
      const envFilePath = path.join(testDir, 'test.env');
      fs.writeFileSync(envFilePath, 'COPILOT_MODEL=gpt-4\n');

      mockBuildConfigOnce({
        envFile: envFilePath,
        copilotGithubToken: 'ghp_testtoken',
      });

      callAssembleWith();

      expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
        true, // classic PAT detected
        true, // COPILOT_MODEL detected
        expect.any(Function),
      );
    });

    it('should detect COPILOT_MODEL with export prefix in env file', () => {
      const envFilePath = path.join(testDir, 'test.env');
      fs.writeFileSync(envFilePath, 'export COPILOT_MODEL=gpt-4\n');

      mockBuildConfigOnce({
        envFile: envFilePath,
        copilotGithubToken: 'ghp_testtoken',
      });

      callAssembleWith();

      expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
        true,
        true,
        expect.any(Function),
      );
    });

    it('should skip comment lines when checking env file', () => {
      const envFilePath = path.join(testDir, 'test.env');
      fs.writeFileSync(envFilePath, '# COPILOT_MODEL=gpt-4\nOTHER_VAR=value\n');

      mockBuildConfigOnce({
        envFile: envFilePath,
        copilotGithubToken: 'ghp_testtoken',
      });

      callAssembleWith();

      expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
        true,
        false, // COPILOT_MODEL not detected (commented out)
        expect.any(Function),
      );
    });

    it('should handle unreadable env file gracefully', () => {
      mockBuildConfigOnce({
        envFile: '/nonexistent/file.env',
        copilotGithubToken: 'ghp_testtoken',
      });

      // Should not throw
      expect(() => {
        callAssembleWith();
      }).not.toThrow();
    });

    it('should detect COPILOT_MODEL from --env flags', () => {
      mockBuildConfigOnce({
        copilotGithubToken: 'ghp_testtoken',
      });

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'gpt-4' };

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        agentOptions,
      );

      expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
        true,
        true, // COPILOT_MODEL detected from flags
        expect.any(Function),
      );
    });

    it('should detect COPILOT_MODEL from host env when --env-all is active', () => {
      const originalCopilotModel = process.env.COPILOT_MODEL;
      try {
        process.env.COPILOT_MODEL = 'gpt-4';

        mockBuildConfigOnce({
          envAll: true,
          copilotGithubToken: 'ghp_testtoken',
        });

        callAssembleWith();

        expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
          true,
          true, // COPILOT_MODEL detected from host env
          expect.any(Function),
        );
      } finally {
        if (originalCopilotModel) {
          process.env.COPILOT_MODEL = originalCopilotModel;
        } else {
          delete process.env.COPILOT_MODEL;
        }
      }
    });

    it('should not fall back to host env when --env sets empty COPILOT_MODEL', () => {
      const originalCopilotModel = process.env.COPILOT_MODEL;
      try {
        process.env.COPILOT_MODEL = 'gpt-4';

        mockBuildConfigOnce({
          envAll: true,
          copilotGithubToken: 'ghp_testtoken',
        });

        const agentOptions = createMinimalAgentOptions();
        agentOptions.additionalEnv = { COPILOT_MODEL: '' };

        assembleAndValidateConfig(
          {},
          'echo test',
          createMinimalLogAndLimits(),
          createMinimalNetworkOptions(),
          agentOptions,
        );

        expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
          true,
          false,
          expect.any(Function),
        );
      } finally {
        if (originalCopilotModel) {
          process.env.COPILOT_MODEL = originalCopilotModel;
        } else {
          delete process.env.COPILOT_MODEL;
        }
      }
    });

    it('should handle array of env files', () => {
      const envFilePath1 = path.join(testDir, 'test1.env');
      const envFilePath2 = path.join(testDir, 'test2.env');
      fs.writeFileSync(envFilePath1, 'VAR1=value1\n');
      fs.writeFileSync(envFilePath2, 'COPILOT_MODEL=gpt-4\n');

      mockBuildConfigOnce({
        envFile: [envFilePath1, envFilePath2],
        copilotGithubToken: 'ghp_testtoken',
      });

      callAssembleWith();

      expect(warnClassicPATWithCopilotModel).toHaveBeenCalledWith(
        true,
        true, // COPILOT_MODEL found in second file
        expect.any(Function),
      );
    });

    it('should reject retired COPILOT_MODEL aliases before launch', () => {
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
      });

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'gpt-5-codex' };

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          createMinimalLogAndLimits(),
          createMinimalNetworkOptions(),
          agentOptions,
        );
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("model 'gpt-5-codex' is retired or unsupported"),
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Did you mean 'gpt-5.3-codex'?"),
      );
    });

    it('should reject retired COPILOT_MODEL aliases in BYOK mode (copilotProviderApiKey)', () => {
      mockBuildConfigOnce({
        copilotProviderApiKey: 'byok-api-key-for-azure-foundry',
      });

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'gpt-5-codex' };

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          createMinimalLogAndLimits(),
          createMinimalNetworkOptions(),
          agentOptions,
        );
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("model 'gpt-5-codex' is retired or unsupported"),
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Did you mean 'gpt-5.3-codex'?"),
      );
    });

    it('should allow custom COPILOT_MODEL values in BYOK mode with a provider base URL', () => {
      mockBuildConfigOnce({
        copilotProviderApiKey: 'byok-api-key-for-azure-foundry',
        copilotProviderBaseUrl: 'https://example-resource.openai.azure.com/openai/deployments/o4-mini-aw',
        additionalEnv: { COPILOT_MODEL: 'o4-mini-aw' },
      });

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: 'o4-mini-aw' };

      const result = assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        agentOptions,
      );

      expect(logger.error).not.toHaveBeenCalled();
      expect(result.additionalEnv?.COPILOT_MODEL).toBe('o4-mini-aw');
    });

    it('should log normalization when COPILOT_MODEL casing is adjusted', () => {
      mockBuildConfigOnce({
        copilotGithubToken: 'github_pat_testtoken',
      });

      const agentOptions = createMinimalAgentOptions();
      agentOptions.additionalEnv = { COPILOT_MODEL: ' GPT-4.1 ' };

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        agentOptions,
      );

      expect(logger.info).toHaveBeenCalledWith(
        "Normalized COPILOT_MODEL value 'GPT-4.1' -> 'gpt-4.1'",
      );
    });
  });

  describe('successful config assembly', () => {
    it('should return assembled config when all validations pass', () => {
      const config = callAssembleWith();

      expect(config).toBeDefined();
      expect(config.agentCommand).toBe('echo test');
      expect(config.logLevel).toBe('info');
      expect(mockExit).not.toHaveBeenCalled();
    });
  });
});
