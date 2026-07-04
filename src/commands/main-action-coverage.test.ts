/**
 * Additional branch coverage for commands/main-action.ts.
 *
 * Covers branches not exercised by main-action.test.ts:
 *   1. redactConfigForLogging – additionalEnv with object value           (BRDA:51,2,0)
 *   2. redactConfigForLogging – additionalEnv with null/falsy value       (BRDA:51,3,1)
 *   3. redactConfigForLogging – additionalEnv with non-object value       (BRDA:51,3,2)
 *   4. createMainAction – dockerHostPathPrefix pre-set → skip DinD probe  (BRDA:187,12,1)
 *   5. createMainAction – probeResult.prefix truthy → auto-apply prefix   (BRDA:189,13,0)
 *   6. createMainAction – probeResult.splitDetected → log warning         (BRDA:192,14,0)
 *   7. createMainAction – config.dnsServers undefined → ?? fallback       (BRDA:212,17,1)
 */

// fs mocks must be declared before jest.mock('fs') because the factory
// runs lazily but the variables need to be in scope.
const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockOpenSync = jest.fn().mockReturnValue(99);
const mockCloseSync = jest.fn();

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    openSync: (...args: unknown[]) => mockOpenSync(...args),
    closeSync: (...args: unknown[]) => mockCloseSync(...args),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());
jest.mock('../docker-manager');
jest.mock('../host-iptables');
jest.mock('../cli-workflow');
jest.mock('../redact-secrets');
jest.mock('../option-parsers');
jest.mock('../dind-probe');
jest.mock('../dind-bootstrap');
jest.mock('./preflight');
jest.mock('./signal-handler');
jest.mock('./validate-options');
jest.mock('../topology');

import { createMainAction, testHelpers } from './main-action';
import { logger } from '../logger';
import * as dockerManager from '../docker-manager';
import * as cliWorkflow from '../cli-workflow';
import * as dindProbe from '../dind-probe';
import * as dindBootstrap from '../dind-bootstrap';
import * as preflight from './preflight';
import * as signalHandler from './signal-handler';
import * as validateOptions from './validate-options';
import * as redactSecrets from '../redact-secrets';
import * as optionParsers from '../option-parsers';

const mockedLogger = logger as jest.Mocked<typeof logger>;
const mockedDockerManager = dockerManager as jest.Mocked<typeof dockerManager>;
const mockedCliWorkflow = cliWorkflow as jest.Mocked<typeof cliWorkflow>;
const mockedDindProbe = dindProbe as jest.Mocked<typeof dindProbe>;
const mockedDindBootstrap = dindBootstrap as jest.Mocked<typeof dindBootstrap>;
const mockedPreflight = preflight as jest.Mocked<typeof preflight>;
const mockedSignalHandler = signalHandler as jest.Mocked<typeof signalHandler>;
const mockedValidateOptions = validateOptions as jest.Mocked<typeof validateOptions>;
const mockedRedactSecrets = redactSecrets as jest.Mocked<typeof redactSecrets>;
const mockedOptionParsers = optionParsers as jest.Mocked<typeof optionParsers>;

/** Minimal WrapperConfig stub reused across tests. */
const BASE_STUB_CONFIG = {
  allowedDomains: ['github.com'],
  blockedDomains: undefined,
  agentCommand: 'echo hi',
  logLevel: 'info',
  keepContainers: false,
  workDir: '/tmp/awf-test',
  imageRegistry: 'ghcr.io/github/gh-aw-firewall',
  imageTag: 'latest',
  buildLocal: false,
  dnsServers: ['8.8.8.8'],
  awfDockerHost: undefined,
  proxyLogsDir: undefined,
  auditDir: undefined,
  sessionStateDir: undefined,
  dockerHostPathPrefix: undefined,
} as unknown as import('../types').WrapperConfig;

describe('main-action additional branch coverage', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let getOptionValueSource: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(
      (code?: string | number | null) => {
        if (code !== 0) throw new Error(`process.exit: ${code}`);
        return undefined as never;
      },
    );
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    getOptionValueSource = jest.fn().mockReturnValue(undefined);

    mockedPreflight.applyConfigFilePrecedence.mockImplementation(() => {});
    // Return a fresh copy each time — createMainAction mutates config.dockerHostPathPrefix
    // when the probe returns a prefix, which would leak into subsequent tests if shared.
    mockedValidateOptions.validateOptions.mockReturnValue({ ...BASE_STUB_CONFIG });
    mockedDockerManager.setAwfDockerHost.mockImplementation(() => {});
    mockedRedactSecrets.redactSecrets.mockImplementation((s: string) => s);
    mockedOptionParsers.joinShellArgs.mockImplementation((args: string[]) => args.join(' '));
    mockedDindProbe.probeSplitFilesystem.mockResolvedValue({
      prefix: undefined,
      splitDetected: false,
      inconclusive: false,
    });
    mockedDindBootstrap.runDindBootstrap.mockResolvedValue(undefined);
    mockedSignalHandler.registerSignalHandlers.mockImplementation(() => {});
    mockedCliWorkflow.runMainWorkflow.mockResolvedValue(0);
    mockMkdirSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    mockOpenSync.mockReturnValue(99);
    mockCloseSync.mockImplementation(() => {});
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // ─── redactConfigForLogging: additionalEnv branches ──────────────────────

  describe('testHelpers.redactConfigForLogging – additionalEnv', () => {
    it('replaces all additionalEnv values with [REDACTED] when value is a plain object', () => {
      const config = {
        ...BASE_STUB_CONFIG,
        additionalEnv: { ANTHROPIC_API_KEY: 'sk-real', GH_TOKEN: 'token123' },
      } as any;

      const result = testHelpers.redactConfigForLogging(config);

      expect(result.additionalEnv).toEqual({
        ANTHROPIC_API_KEY: '[REDACTED]',
        GH_TOKEN: '[REDACTED]',
      });
    });

    it('passes through additionalEnv as-is when value is null (falsy short-circuit)', () => {
      const config = { ...BASE_STUB_CONFIG, additionalEnv: null } as any;

      const result = testHelpers.redactConfigForLogging(config);

      // null fails the `&& value` sub-condition → no redaction, value passed through
      expect(result.additionalEnv).toBeNull();
    });

    it('passes through additionalEnv as-is when value is a non-object string', () => {
      const config = { ...BASE_STUB_CONFIG, additionalEnv: 'raw-env-string' } as any;

      const result = testHelpers.redactConfigForLogging(config);

      // Truthy but not an object → fails `typeof value === 'object'` → value passed through
      expect(result.additionalEnv).toBe('raw-env-string');
    });
  });

  // ─── createMainAction: DinD probe skipped when prefix already set ─────────

  describe('createMainAction – dockerHostPathPrefix pre-set', () => {
    it('skips probeSplitFilesystem and runDindBootstrap when prefix is already configured', async () => {
      mockedValidateOptions.validateOptions.mockReturnValue({
        ...BASE_STUB_CONFIG,
        dockerHostPathPrefix: '/host',
      } as any);

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedDindProbe.probeSplitFilesystem).not.toHaveBeenCalled();
      expect(mockedDindBootstrap.runDindBootstrap).not.toHaveBeenCalled();
    });
  });

  // ─── createMainAction: probe detects a valid prefix ───────────────────────

  describe('createMainAction – probeResult.prefix truthy', () => {
    it('auto-applies detected prefix and logs an info message', async () => {
      mockedDindProbe.probeSplitFilesystem.mockResolvedValue({
        prefix: '/host',
        splitDetected: true,
        inconclusive: false,
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Auto-applied --docker-host-path-prefix /host'),
      );
    });
  });

  // ─── createMainAction: split filesystem detected but no usable prefix ─────

  describe('createMainAction – probeResult.splitDetected without prefix', () => {
    it('logs a warning when split filesystem is detected but no known prefix resolved', async () => {
      mockedDindProbe.probeSplitFilesystem.mockResolvedValue({
        prefix: undefined,
        splitDetected: true,
        inconclusive: false,
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Split runner/daemon filesystem detected'),
      );
    });
  });

  // ─── createMainAction: dnsServers undefined → ?? fallback ─────────────────

  describe('createMainAction – config.dnsServers undefined', () => {
    it('logs an empty DNS servers line when dnsServers is undefined (nullish coalescing fallback)', async () => {
      mockedValidateOptions.validateOptions.mockReturnValue({
        ...BASE_STUB_CONFIG,
        dnsServers: undefined,
      } as any);

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedLogger.debug).toHaveBeenCalledWith('DNS servers: ');
    });
  });
});
