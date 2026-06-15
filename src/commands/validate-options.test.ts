import * as fs from 'fs';
import { validateOptions } from './validate-options';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());
jest.mock('fs');
// Keep the real SQUID_DANGEROUS_CHARS regex so inline URL checks work correctly.
jest.mock('../domain-validation', () => ({ SQUID_DANGEROUS_CHARS: /[\s\0"'`;#]/ }));
jest.mock('../domain-utils');
jest.mock('../api-proxy-config');
jest.mock('../option-parsers');
jest.mock('./preflight');
jest.mock('./network-setup');
jest.mock('./build-config');

import { logger } from '../logger';
import * as domainUtils from '../domain-utils';
import * as apiProxyConfig from '../api-proxy-config';
import * as optionParsers from '../option-parsers';
import * as preflight from './preflight';
import * as networkSetup from './network-setup';
import * as buildConfig from './build-config';

const mockedLogger = logger as jest.Mocked<typeof logger>;
const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedDomainUtils = domainUtils as jest.Mocked<typeof domainUtils>;
const mockedApiProxyConfig = apiProxyConfig as jest.Mocked<typeof apiProxyConfig>;
const mockedOptionParsers = optionParsers as jest.Mocked<typeof optionParsers>;
const mockedPreflight = preflight as jest.Mocked<typeof preflight>;
const mockedNetworkSetup = networkSetup as jest.Mocked<typeof networkSetup>;
const mockedBuildConfig = buildConfig as jest.Mocked<typeof buildConfig>;

/** Minimal WrapperConfig returned by the buildConfig mock for the happy path. */
const STUB_CONFIG = {
  allowedDomains: ['github.com'],
  blockedDomains: undefined,
  agentCommand: 'echo hi',
  logLevel: 'info',
  keepContainers: false,
  tty: false,
  workDir: '/tmp/workdir',
  buildLocal: false,
  skipPull: false,
  agentImage: undefined,
  imageRegistry: '',
  imageTag: '',
  additionalEnv: undefined,
  envAll: false,
  excludeEnv: undefined,
  envFile: undefined,
  volumeMounts: undefined,
  containerWorkDir: undefined,
  dnsServers: ['8.8.8.8'],
  dnsOverHttps: undefined,
  memoryLimit: undefined,
  proxyLogsDir: undefined,
  auditDir: undefined,
  sessionStateDir: undefined,
  enableHostAccess: false,
  localhostDetected: false,
  allowHostPorts: undefined,
  allowHostServicePorts: undefined,
  sslBump: false,
  enableDind: false,
  enableDlp: false,
  allowedUrls: undefined,
  enableApiProxy: false,
  anthropicAutoCache: false,
  anthropicCacheTailTtl: undefined,
  modelAliases: undefined,
  maxEffectiveTokens: undefined,
  maxAiCredits: undefined,
  effectiveTokenModelMultipliers: undefined,
  effectiveTokenDefaultModelMultiplier: undefined,
  maxRuns: undefined,
  maxPermissionDenied: undefined,
  enableTokenSteering: false,
  openaiApiKey: undefined,
  anthropicApiKey: undefined,
  copilotGithubToken: undefined,
  copilotProviderApiKey: undefined,
  geminiApiKey: undefined,
  copilotApiTarget: undefined,
  copilotApiBasePath: undefined,
  openaiApiTarget: undefined,
  openaiApiBasePath: undefined,
  anthropicApiTarget: undefined,
  anthropicApiBasePath: undefined,
  geminiApiTarget: undefined,
  geminiApiBasePath: undefined,
  difcProxyHost: undefined,
  difcProxyCaCert: undefined,
  githubToken: undefined,
  diagnosticLogs: false,
  awfDockerHost: undefined,
  upstreamProxy: undefined,
  dockerHostPathPrefix: undefined,
} as unknown as import('../types').WrapperConfig;

/** Returns a set of options that pass all validation checks. */
function validOptions(): Record<string, unknown> {
  return {
    logLevel: 'info',
  };
}

describe('validateOptions', () => {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    // --- Option parser defaults (all succeed) ---
    mockedOptionParsers.checkDockerHost.mockReturnValue({ valid: true });
    mockedOptionParsers.resolveDockerHostPathPrefix.mockReturnValue({
      dockerHostPathPrefix: undefined,
      autoApplied: false,
      dindHint: false,
    });
    mockedOptionParsers.parseEnvironmentVariables.mockReturnValue({ success: true, env: {} });
    mockedOptionParsers.parseVolumeMounts.mockReturnValue({ success: true, mounts: [] });
    mockedOptionParsers.parseMemoryLimit.mockReturnValue({ value: undefined } as ReturnType<typeof optionParsers.parseMemoryLimit>);
    mockedOptionParsers.applyAgentTimeout.mockImplementation(() => undefined);
    mockedOptionParsers.buildRateLimitConfig.mockReturnValue({
      config: { enabled: false, rpm: 0, rph: 0, bytesPm: 0 },
    });
    mockedOptionParsers.validateRateLimitFlags.mockReturnValue({ valid: true });
    mockedOptionParsers.validateEnableTokenSteeringFlag.mockReturnValue({ valid: true });
    mockedOptionParsers.validateSkipPullWithBuildLocal.mockReturnValue({ valid: true });
    mockedOptionParsers.validateAllowHostPorts.mockReturnValue({ valid: true });
    mockedOptionParsers.applyHostServicePortsConfig.mockReturnValue({
      valid: true,
      enableHostAccess: false,
    });

    // --- Preflight / network defaults ---
    mockedPreflight.resolveAllowedDomains.mockReturnValue({
      allowedDomains: ['github.com'],
      localhostResult: {
        localhostDetected: false,
        allowedDomains: ['github.com'],
        shouldEnableHostAccess: false,
      },
      resolvedCopilotApiTarget: undefined,
      resolvedCopilotApiBasePath: undefined,
    });
    mockedPreflight.resolveBlockedDomains.mockReturnValue([]);
    mockedNetworkSetup.resolveNetworkConfig.mockReturnValue({
      upstreamProxy: undefined,
      dnsServers: ['8.8.8.8'],
      dnsOverHttps: undefined,
    });

    // --- Domain utils defaults ---
    mockedDomainUtils.parseDomains.mockReturnValue([]);
    mockedDomainUtils.processAgentImageOption.mockReturnValue({
      agentImage: 'default',
      isPreset: true,
      error: undefined,
      infoMessage: undefined,
    });

    // --- API proxy config defaults ---
    mockedApiProxyConfig.validateAnthropicCacheTailTtl.mockImplementation(() => undefined);
    mockedApiProxyConfig.validateApiProxyConfig.mockReturnValue({ enabled: false, warnings: [], debugMessages: [] });
    mockedApiProxyConfig.emitApiProxyTargetWarnings.mockImplementation(() => undefined);
    mockedApiProxyConfig.emitCliProxyStatusLogs.mockImplementation(() => undefined);
    mockedApiProxyConfig.warnClassicPATWithCopilotModel.mockImplementation(() => undefined);

    // --- fs defaults ---
    mockedFs.existsSync.mockReturnValue(true);

    // --- buildConfig default ---
    mockedBuildConfig.buildConfig.mockReturnValue(STUB_CONFIG);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Log level validation
  // ---------------------------------------------------------------------------

  describe('log level validation', () => {
    it('exits when logLevel is invalid', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(() => validateOptions({ logLevel: 'verbose' }, 'echo hi')).toThrow('process.exit called');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid log level'));
      consoleSpy.mockRestore();
    });

    it('accepts valid log levels', () => {
      for (const level of ['debug', 'info', 'warn', 'error']) {
        expect(() => validateOptions({ logLevel: level }, 'echo hi')).not.toThrow();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Numeric option validation
  // ---------------------------------------------------------------------------

  describe('maxEffectiveTokens validation', () => {
    it('exits when maxEffectiveTokens is not a positive integer', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(() =>
        validateOptions({ logLevel: 'info', maxEffectiveTokens: 'abc' }, 'echo hi'),
      ).toThrow('process.exit called');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid maxEffectiveTokens'));
      consoleSpy.mockRestore();
    });

    describe('maxAiCredits validation', () => {
      it('exits when maxAiCredits is not a positive number', () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() =>
          validateOptions({ logLevel: 'info', maxAiCredits: 'abc' }, 'echo hi'),
        ).toThrow('process.exit called');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid maxAiCredits'));
        consoleSpy.mockRestore();
      });

      it('exits when maxAiCredits is zero', () => {
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() =>
          validateOptions({ logLevel: 'info', maxAiCredits: 0 }, 'echo hi'),
        ).toThrow('process.exit called');
        consoleSpy.mockRestore();
      });
    });

    it('exits when maxEffectiveTokens is zero', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(() =>
        validateOptions({ logLevel: 'info', maxEffectiveTokens: 0 }, 'echo hi'),
      ).toThrow('process.exit called');
      consoleSpy.mockRestore();
    });
  });

  describe('maxRuns validation', () => {
    it('exits when maxRuns is not a positive integer', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(() =>
        validateOptions({ logLevel: 'info', maxRuns: 'not-a-number' }, 'echo hi'),
      ).toThrow('process.exit called');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid maxRuns'));
      consoleSpy.mockRestore();
    });
  });

  describe('maxPermissionDenied validation', () => {
    it('exits when maxPermissionDenied is not a positive integer', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(() =>
        validateOptions({ logLevel: 'info', maxPermissionDenied: 'not-a-number' }, 'echo hi'),
      ).toThrow('process.exit called');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid maxPermissionDenied'));
      consoleSpy.mockRestore();
    });
  });

  describe('parseModelMultipliersCli error', () => {
    it('exits when --max-model-multiplier is malformed', () => {
      mockedOptionParsers.parseModelMultipliersCli.mockReturnValue({ error: 'bad format' });
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(() =>
        validateOptions({ logLevel: 'info', maxModelMultiplier: 'bad:x' }, 'echo hi'),
      ).toThrow('process.exit called');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('bad format'));
      consoleSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Environment variable / file validation
  // ---------------------------------------------------------------------------

  describe('environment variable validation', () => {
    it('exits when --env flag has invalid format', () => {
      mockedOptionParsers.parseEnvironmentVariables.mockReturnValue({
        success: false,
        invalidVar: 'NOVALUE',
      } as ReturnType<typeof optionParsers.parseEnvironmentVariables>);
      expect(() =>
        validateOptions({ logLevel: 'info', env: ['NOVALUE'] }, 'echo hi'),
      ).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid environment variable format'),
      );
    });

    it('exits when --env-file path does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(() =>
        validateOptions({ logLevel: 'info', envFile: '/missing/file.env' }, 'echo hi'),
      ).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('--env-file: file not found'),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Volume mount validation
  // ---------------------------------------------------------------------------

  describe('volume mount validation', () => {
    it('exits when a mount spec is invalid', () => {
      mockedOptionParsers.parseVolumeMounts.mockReturnValue({
        success: false,
        invalidMount: '/bad:path',
        reason: 'must be absolute',
      } as ReturnType<typeof optionParsers.parseVolumeMounts>);
      expect(() =>
        validateOptions({ logLevel: 'info', mount: ['/bad:path'] }, 'echo hi'),
      ).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid volume mount'));
    });
  });

  // ---------------------------------------------------------------------------
  // --allow-urls / SSL Bump validation
  // ---------------------------------------------------------------------------

  describe('--allow-urls requires --ssl-bump', () => {
    it('exits when --allow-urls is set without --ssl-bump', () => {
      mockedDomainUtils.parseDomains.mockReturnValue(['https://github.com/org/*']);
      expect(() =>
        validateOptions({ logLevel: 'info', allowUrls: 'https://github.com/org/*' }, 'echo hi'),
      ).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('--allow-urls requires --ssl-bump'),
      );
    });
  });

  describe('URL pattern security validation', () => {
    it.each([
      ['http://github.com/org/*', 'http scheme'],
      ['.*', 'relative dot-wildcard'],
      ['*', 'bare star'],
    ])('exits when URL pattern does not start with https://: %s (%s)', (url) => {
      mockedDomainUtils.parseDomains.mockReturnValue([url]);
      expect(() =>
        validateOptions(
          { logLevel: 'info', allowUrls: url, sslBump: true },
          'echo hi',
        ),
      ).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('URL patterns must start with https://'),
      );
    });

    it.each([
      ['https://*', 'bare wildcard'],
      ['https://*.*', 'wildcard with dot'],
      ['https://.*', 'dot-wildcard'],
      ['https://example*', 'wildcard in hostname without path'],
    ])('exits for overly broad pattern: %s (%s)', (url) => {
      mockedDomainUtils.parseDomains.mockReturnValue([url]);
      expect(() =>
        validateOptions({ logLevel: 'info', allowUrls: url, sslBump: true }, 'echo hi'),
      ).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('is too broad and would bypass security controls'),
      );
    });

    it.each([
      ['https://github.com/org/ path', 'space'],
      ['https://github.com/org/"path"', 'double quote'],
      ["https://github.com/org/'path'", 'single quote'],
      ['https://github.com/org/path;rm', 'semicolon'],
      ['https://github.com/org/`cmd`', 'backtick'],
      ['https://github.com/org/path#frag', 'hash'],
    ])('exits when URL pattern contains Squid-unsafe character: %s (%s)', (url) => {
      mockedDomainUtils.parseDomains.mockReturnValue([url]);
      expect(() =>
        validateOptions({ logLevel: 'info', allowUrls: url, sslBump: true }, 'echo hi'),
      ).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('URL pattern contains characters unsafe for Squid config'),
      );
    });

    it('exits when URL pattern has no path component', () => {
      mockedDomainUtils.parseDomains.mockReturnValue(['https://github.com']);
      expect(() =>
        validateOptions(
          { logLevel: 'info', allowUrls: 'https://github.com', sslBump: true },
          'echo hi',
        ),
      ).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('must include a path component'),
      );
    });

    it('accepts a well-formed URL pattern', () => {
      mockedDomainUtils.parseDomains.mockReturnValue(['https://github.com/org/*']);
      expect(() =>
        validateOptions(
          { logLevel: 'info', allowUrls: 'https://github.com/org/*', sslBump: true },
          'echo hi',
        ),
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Memory limit / agent image validation
  // ---------------------------------------------------------------------------

  describe('memory limit validation', () => {
    it('exits when --memory-limit is invalid', () => {
      mockedOptionParsers.parseMemoryLimit.mockReturnValue({ error: 'invalid memory limit format' });
      expect(() =>
        validateOptions({ logLevel: 'info', memoryLimit: 'bad' }, 'echo hi'),
      ).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('invalid memory limit format'),
      );
    });
  });

  describe('agent image validation', () => {
    it('exits when --agent-image processing fails', () => {
      mockedDomainUtils.processAgentImageOption.mockReturnValue({
        agentImage: 'myimage:latest',
        isPreset: false,
        error: 'cannot combine --agent-image with --build-local',
        infoMessage: undefined,
      });
      expect(() =>
        validateOptions(
          { logLevel: 'info', agentImage: 'myimage:latest', buildLocal: true },
          'echo hi',
        ),
      ).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('cannot combine --agent-image with --build-local'),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Post-config validations (docker host, rate limits, feature flags, ports)
  // ---------------------------------------------------------------------------

  describe('--docker-host validation', () => {
    it('exits when --docker-host is not a unix:// URI', () => {
      mockedBuildConfig.buildConfig.mockReturnValue({
        ...STUB_CONFIG,
        awfDockerHost: 'tcp://localhost:2376',
      });
      expect(() => validateOptions(validOptions(), 'echo hi')).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('--docker-host must be a unix:// socket URI'),
      );
    });

    it('accepts a valid unix:// docker host', () => {
      mockedBuildConfig.buildConfig.mockReturnValue({
        ...STUB_CONFIG,
        awfDockerHost: 'unix:///var/run/docker.sock',
      });
      expect(() => validateOptions(validOptions(), 'echo hi')).not.toThrow();
    });
  });

  describe('--docker-host-path-prefix validation', () => {
    it('exits when --docker-host-path-prefix is not an absolute path', () => {
      mockedBuildConfig.buildConfig.mockReturnValue({
        ...STUB_CONFIG,
        dockerHostPathPrefix: 'relative/path',
      });
      expect(() => validateOptions(validOptions(), 'echo hi')).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('--docker-host-path-prefix must be an absolute path'),
      );
    });
  });

  describe('rate limit validation', () => {
    it('exits when buildRateLimitConfig returns an error', () => {
      mockedBuildConfig.buildConfig.mockReturnValue({
        ...STUB_CONFIG,
        enableApiProxy: true,
      });
      mockedOptionParsers.buildRateLimitConfig.mockReturnValue({ error: 'invalid rate limit' });
      expect(() => validateOptions(validOptions(), 'echo hi')).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('invalid rate limit'),
      );
    });

    it('exits when rate limit flags are used without --enable-api-proxy', () => {
      mockedOptionParsers.validateRateLimitFlags.mockReturnValue({
        valid: false,
        error: '--rpm requires --enable-api-proxy',
      });
      expect(() => validateOptions(validOptions(), 'echo hi')).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('--rpm requires --enable-api-proxy'),
      );
    });
  });

  describe('feature flag compatibility', () => {
    it('exits when --enable-token-steering is used without --enable-api-proxy', () => {
      mockedOptionParsers.validateEnableTokenSteeringFlag.mockReturnValue({
        valid: false,
        error: '--enable-token-steering requires --enable-api-proxy',
      });
      expect(() => validateOptions(validOptions(), 'echo hi')).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('--enable-token-steering requires --enable-api-proxy'),
      );
    });

    it('exits when --skip-pull and --build-local are combined', () => {
      mockedOptionParsers.validateSkipPullWithBuildLocal.mockReturnValue({
        valid: false,
        error: '--skip-pull cannot be used with --build-local',
      });
      expect(() => validateOptions(validOptions(), 'echo hi')).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('--skip-pull cannot be used with --build-local'),
      );
    });
  });

  describe('host port / service port validation', () => {
    it('exits when --allow-host-service-ports validation fails', () => {
      mockedOptionParsers.applyHostServicePortsConfig.mockReturnValue({
        valid: false,
        error: 'invalid port range',
      } as ReturnType<typeof optionParsers.applyHostServicePortsConfig>);
      expect(() => validateOptions(validOptions(), 'echo hi')).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('invalid port range'),
      );
    });

    it('exits when --allow-host-ports requires --enable-host-access', () => {
      mockedOptionParsers.validateAllowHostPorts.mockReturnValue({
        valid: false,
        error: '--allow-host-ports requires --enable-host-access',
      });
      expect(() => validateOptions(validOptions(), 'echo hi')).toThrow('process.exit called');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('--allow-host-ports requires --enable-host-access'),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Warnings
  // ---------------------------------------------------------------------------

  describe('host.docker.internal warning', () => {
    it('warns when --enable-host-access is combined with host.docker.internal domain', () => {
      mockedOptionParsers.applyHostServicePortsConfig.mockReturnValue({
        valid: true,
        enableHostAccess: true,
      });
      mockedPreflight.resolveAllowedDomains.mockReturnValue({
        allowedDomains: ['host.docker.internal'],
        localhostResult: {
          localhostDetected: false,
          allowedDomains: ['host.docker.internal'],
          shouldEnableHostAccess: false,
        },
        resolvedCopilotApiTarget: undefined,
        resolvedCopilotApiBasePath: undefined,
      });
      mockedBuildConfig.buildConfig.mockReturnValue({
        ...STUB_CONFIG,
        allowedDomains: ['host.docker.internal'],
        enableHostAccess: true,
      });
      validateOptions(validOptions(), 'echo hi');
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('host.docker.internal in allowed domains'),
      );
    });
  });

  describe('--env-all warning', () => {
    it('warns when --env-all is set', () => {
      mockedBuildConfig.buildConfig.mockReturnValue({
        ...STUB_CONFIG,
        envAll: true,
      });
      validateOptions(validOptions(), 'echo hi');
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--env-all'),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  describe('valid inputs', () => {
    it('returns the WrapperConfig assembled by buildConfig', () => {
      const result = validateOptions(validOptions(), 'echo hi');
      expect(mockedBuildConfig.buildConfig).toHaveBeenCalled();
      expect(result).toBe(STUB_CONFIG);
    });

    it('passes the agentCommand to buildConfig', () => {
      validateOptions(validOptions(), 'my-agent --flag');
      expect(mockedBuildConfig.buildConfig).toHaveBeenCalledWith(
        expect.objectContaining({ agentCommand: 'my-agent --flag' }),
      );
    });

    it('passes the logLevel to buildConfig', () => {
      validateOptions({ logLevel: 'debug' }, 'echo hi');
      expect(mockedBuildConfig.buildConfig).toHaveBeenCalledWith(
        expect.objectContaining({ logLevel: 'debug' }),
      );
    });
  });
});
