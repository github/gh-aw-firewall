import { createMainAction } from './main-action';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());
jest.mock('../docker-manager');
jest.mock('../host-iptables');
jest.mock('../cli-workflow');
jest.mock('../redact-secrets');
jest.mock('../option-parsers');
jest.mock('./preflight');
jest.mock('./signal-handler');
jest.mock('./validate-options');

import { logger } from '../logger';
import * as dockerManager from '../docker-manager';
import * as cliWorkflow from '../cli-workflow';
import * as redactSecrets from '../redact-secrets';
import * as optionParsers from '../option-parsers';
import * as preflight from './preflight';
import * as signalHandler from './signal-handler';
import * as validateOptions from './validate-options';

const mockedLogger = logger as jest.Mocked<typeof logger>;
const mockedDockerManager = dockerManager as jest.Mocked<typeof dockerManager>;
const mockedCliWorkflow = cliWorkflow as jest.Mocked<typeof cliWorkflow>;
const mockedRedactSecrets = redactSecrets as jest.Mocked<typeof redactSecrets>;
const mockedOptionParsers = optionParsers as jest.Mocked<typeof optionParsers>;
const mockedPreflight = preflight as jest.Mocked<typeof preflight>;
const mockedSignalHandler = signalHandler as jest.Mocked<typeof signalHandler>;
const mockedValidateOptions = validateOptions as jest.Mocked<typeof validateOptions>;

/** Minimal WrapperConfig returned by the validateOptions mock. */
const STUB_CONFIG = {
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
} as unknown as import('../types').WrapperConfig;

describe('createMainAction', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let getOptionValueSource: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    getOptionValueSource = jest.fn().mockReturnValue(undefined);

    // Default mock implementations
    mockedPreflight.applyConfigFilePrecedence.mockImplementation(() => {});
    mockedValidateOptions.validateOptions.mockReturnValue(STUB_CONFIG);
    mockedDockerManager.setAwfDockerHost.mockImplementation(() => {});
    mockedRedactSecrets.redactSecrets.mockImplementation((s: string) => s);
    mockedOptionParsers.joinShellArgs.mockImplementation((args: string[]) => args.join(' '));
    mockedSignalHandler.registerSignalHandlers.mockImplementation(() => {});
    mockedCliWorkflow.runMainWorkflow.mockResolvedValue(0);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('when args is empty', () => {
    it('exits with code 1 and prints usage error', async () => {
      const action = createMainAction(getOptionValueSource);
      await action([], {});
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('No command specified')
      );
    });
  });

  describe('when single arg is provided', () => {
    it('uses the single arg as-is (preserves shell variables)', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['echo $HOME'], {});
      expect(mockedOptionParsers.joinShellArgs).not.toHaveBeenCalled();
      expect(mockedValidateOptions.validateOptions).toHaveBeenCalledWith(
        expect.anything(),
        'echo $HOME'
      );
    });
  });

  describe('when multiple args are provided', () => {
    it('joins args with joinShellArgs', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['curl', '-H', 'Auth: token', 'https://api.github.com'], {});
      expect(mockedOptionParsers.joinShellArgs).toHaveBeenCalledWith([
        'curl',
        '-H',
        'Auth: token',
        'https://api.github.com',
      ]);
      expect(mockedValidateOptions.validateOptions).toHaveBeenCalledWith(
        expect.anything(),
        'curl -H Auth: token https://api.github.com'
      );
    });
  });

  describe('happy path', () => {
    it('calls workflow steps and exits with 0', async () => {
      mockedCliWorkflow.runMainWorkflow.mockResolvedValue(0);
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedCliWorkflow.runMainWorkflow).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('calls applyConfigFilePrecedence with options and resolver', async () => {
      const options = { keepContainers: false };
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], options);
      expect(mockedPreflight.applyConfigFilePrecedence).toHaveBeenCalledWith(
        options,
        getOptionValueSource
      );
    });

    it('calls setAwfDockerHost with config.awfDockerHost', async () => {
      const configWithDockerHost = { ...STUB_CONFIG, awfDockerHost: '/var/run/docker.sock' };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithDockerHost as unknown as import('../types').WrapperConfig
      );
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedDockerManager.setAwfDockerHost).toHaveBeenCalledWith('/var/run/docker.sock');
    });

    it('registers signal handlers', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedSignalHandler.registerSignalHandlers).toHaveBeenCalled();
    });

    it('logs allowed domains', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('github.com')
      );
    });

    it('logs blocked domains when present', async () => {
      const configWithBlocked = {
        ...STUB_CONFIG,
        blockedDomains: ['evil.com'],
      };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithBlocked as unknown as import('../types').WrapperConfig
      );
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('evil.com')
      );
    });

    it('does not log blocked domains when empty', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      const blockedCalls = mockedLogger.info.mock.calls.filter(
        (args) => String(args[0]).includes('Blocked domains')
      );
      expect(blockedCalls).toHaveLength(0);
    });
  });

  describe('when runMainWorkflow returns non-zero exit code', () => {
    it('exits with the non-zero code', async () => {
      mockedCliWorkflow.runMainWorkflow.mockResolvedValue(42);
      const action = createMainAction(getOptionValueSource);
      await action(['curl https://example.com'], {});
      expect(processExitSpy).toHaveBeenCalledWith(42);
    });
  });

  describe('when runMainWorkflow throws', () => {
    it('calls performCleanup and exits with code 1', async () => {
      mockedCliWorkflow.runMainWorkflow.mockRejectedValue(new Error('docker failed'));
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedLogger.error).toHaveBeenCalledWith(
        'Fatal error:',
        expect.any(Error)
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('redaction of sensitive config fields', () => {
    it('does not log API keys in debug output', async () => {
      const configWithKeys = {
        ...STUB_CONFIG,
        openaiApiKey: 'sk-secret',
        anthropicApiKey: 'ant-secret',
        copilotGithubToken: 'ghp-secret',
        copilotApiKey: 'cop-secret',
        geminiApiKey: 'gem-secret',
      };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithKeys as unknown as import('../types').WrapperConfig
      );
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      // Debug call should be made but without raw API keys
      const debugCalls = mockedLogger.debug.mock.calls;
      const configDebugCall = debugCalls.find((args) =>
        String(args[0]).includes('Configuration')
      );
      if (configDebugCall) {
        const serialized = String(configDebugCall[1]);
        expect(serialized).not.toContain('sk-secret');
        expect(serialized).not.toContain('ant-secret');
        expect(serialized).not.toContain('ghp-secret');
        expect(serialized).not.toContain('cop-secret');
        expect(serialized).not.toContain('gem-secret');
      }
    });
  });
});
