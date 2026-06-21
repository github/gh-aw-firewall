import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

jest.mock('../../logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../option-parsers', () => {
  const actual = jest.requireActual('../../option-parsers');
  return {
    validateRateLimitFlags: jest.fn(),
    validateEnableTokenSteeringFlag: jest.fn(),
    validateSkipPullWithBuildLocal: jest.fn(),
    validateAllowHostPorts: jest.fn(),
    applyHostServicePortsConfig: jest.fn(),
    buildRateLimitConfig: jest.fn(),
    applyAgentTimeout: jest.fn(),
    isLoopbackTcpDockerHostUri: actual.isLoopbackTcpDockerHostUri,
  };
});

jest.mock('../../api-proxy-config', () => ({
  validateApiProxyConfig: jest.fn().mockReturnValue({
    warnings: [],
    debugMessages: [],
  }),
  emitApiProxyTargetWarnings: jest.fn(),
  emitCliProxyStatusLogs: jest.fn(),
  warnClassicPATWithCopilotModel: jest.fn(),
}));

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

let mockExit: jest.SpyInstance;
let testDir: string;
const mockBuildConfig = buildConfig as jest.Mock;

export const createMinimalLogAndLimits = (): LogAndLimitsResult => ({
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
  maxCacheMisses: undefined,
});

export const createMinimalNetworkOptions = (): NetworkOptionsResult => ({
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

export const createMinimalAgentOptions = (): AgentOptionsResult => ({
  additionalEnv: {},
  volumeMounts: [],
  allowedUrls: [],
});

export const callAssembleWith = (options: Record<string, unknown> = {}) =>
  assembleAndValidateConfig(
    options,
    'echo test',
    createMinimalLogAndLimits(),
    createMinimalNetworkOptions(),
    createMinimalAgentOptions(),
  );

export const createBuildConfigResult = (
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

export const mockBuildConfigOnce = (overrides: Record<string, unknown>): void => {
  mockBuildConfig.mockReturnValueOnce(createBuildConfigResult(overrides));
};

export const getMockExit = (): jest.SpyInstance => mockExit;
export const getTestDir = (): string => testDir;

export function setupConfigAssemblyTestSuite(): void {
  beforeEach(() => {
    jest.clearAllMocks();

    mockBuildConfig.mockImplementation((args: any) =>
      createBuildConfigResult({
        agentCommand: args.agentCommand,
        logLevel: args.logLevel,
        allowedDomains: args.allowedDomains,
        blockedDomains: args.blockedDomains,
      }),
    );

    mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });

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
}

export {
  assembleAndValidateConfig,
  logger,
  warnClassicPATWithCopilotModel,
  validateRateLimitFlags,
  validateEnableTokenSteeringFlag,
  validateSkipPullWithBuildLocal,
  validateAllowHostPorts,
  applyHostServicePortsConfig,
  buildRateLimitConfig,
};
