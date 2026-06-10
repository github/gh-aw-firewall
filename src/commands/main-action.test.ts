// Module-level mock functions for fs — must be declared before jest.mock('fs')
// so the factory can close over them. jest.mock is hoisted but the factory runs
// lazily after module initialisation, when these variables are defined.
const mockMkdirSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockChmodSync = jest.fn();

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    chmodSync: (...args: unknown[]) => mockChmodSync(...args),
  };
});

import { createMainAction } from './main-action';

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

import { logger } from '../logger';
import * as dockerManager from '../docker-manager';
import * as hostIptables from '../host-iptables';
import * as cliWorkflow from '../cli-workflow';
import * as redactSecrets from '../redact-secrets';
import * as optionParsers from '../option-parsers';
import * as dindProbe from '../dind-probe';
import * as dindBootstrap from '../dind-bootstrap';
import * as preflight from './preflight';
import * as signalHandler from './signal-handler';
import * as validateOptions from './validate-options';

const mockedLogger = logger as jest.Mocked<typeof logger>;
const mockedDockerManager = dockerManager as jest.Mocked<typeof dockerManager>;
const mockedHostIptables = hostIptables as jest.Mocked<typeof hostIptables>;
const mockedCliWorkflow = cliWorkflow as jest.Mocked<typeof cliWorkflow>;
const mockedRedactSecrets = redactSecrets as jest.Mocked<typeof redactSecrets>;
const mockedOptionParsers = optionParsers as jest.Mocked<typeof optionParsers>;
const mockedDindProbe = dindProbe as jest.Mocked<typeof dindProbe>;
const mockedDindBootstrap = dindBootstrap as jest.Mocked<typeof dindBootstrap>;
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
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      if (code === 1) {
        throw new Error(`process.exit: ${code}`);
      }
      return undefined as never;
    });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    getOptionValueSource = jest.fn().mockReturnValue(undefined);

    // Default mock implementations
    mockedPreflight.applyConfigFilePrecedence.mockImplementation(() => {});
    mockedValidateOptions.validateOptions.mockReturnValue(STUB_CONFIG);
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
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('when args is empty', () => {
    it('exits with code 1 and prints usage error', async () => {
      const action = createMainAction(getOptionValueSource);
      await expect(action([], {})).rejects.toThrow('process.exit: 1');
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(mockedOptionParsers.joinShellArgs).not.toHaveBeenCalled();
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

    it('runs DinD bootstrap before workflow execution', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedDindBootstrap.runDindBootstrap).toHaveBeenCalledWith(STUB_CONFIG);
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
      await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        'Fatal error:',
        expect.any(Error)
      );
      expect(mockedDockerManager.cleanup).toHaveBeenCalledWith(
        STUB_CONFIG.workDir,
        false,
        STUB_CONFIG.proxyLogsDir,
        STUB_CONFIG.auditDir,
        STUB_CONFIG.sessionStateDir
      );
      expect(mockedHostIptables.cleanupHostIptables).not.toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('performCleanup with keepContainers=true', () => {
    it('logs preserved paths and skips cleanup when keepContainers is true', async () => {
      const configWithKeep = { ...STUB_CONFIG, keepContainers: true };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithKeep as unknown as import('../types').WrapperConfig
      );
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, _deps, callbacks) => {
        await callbacks.performCleanup();
        return 0;
      });
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      // cleanup should NOT be called (keepContainers=true)
      expect(mockedDockerManager.cleanup).not.toHaveBeenCalled();
      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Configuration files preserved')
      );
    });
  });

  describe('performCleanup with containers started', () => {
    it('stops containers and cleans host iptables when both flags are set', async () => {
      const configWithFlags = { ...STUB_CONFIG, keepContainers: false };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithFlags as unknown as import('../types').WrapperConfig
      );
      mockedDockerManager.stopContainers.mockResolvedValue(undefined);
      mockedHostIptables.cleanupHostIptables.mockResolvedValue(undefined);
      mockedDockerManager.cleanup.mockResolvedValue(undefined);

      // Make runMainWorkflow call both onContainersStarted and onHostIptablesSetup
      mockedCliWorkflow.runMainWorkflow.mockImplementation(
        async (_config, _deps, callbacks) => {
          callbacks.onHostIptablesSetup?.();
          callbacks.onContainersStarted?.();
          await callbacks.performCleanup();
          return 0;
        }
      );

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedDockerManager.preserveIptablesAudit).toHaveBeenCalled();
      expect(mockedDockerManager.stopContainers).toHaveBeenCalled();
      expect(mockedHostIptables.cleanupHostIptables).toHaveBeenCalled();
      expect(mockedDockerManager.cleanup).toHaveBeenCalled();
    });
  });

  describe('performCleanup signal parameter', () => {
    it('logs signal name when cleanup is triggered with a signal', async () => {
      let capturedSignalHandlers: Parameters<typeof mockedSignalHandler.registerSignalHandlers>[0] | undefined;
      mockedSignalHandler.registerSignalHandlers.mockImplementation((opts) => {
        capturedSignalHandlers = opts;
      });
      mockedCliWorkflow.runMainWorkflow.mockResolvedValue(0);
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(capturedSignalHandlers).toBeDefined();
      mockedLogger.info.mockClear();
      await capturedSignalHandlers!.performCleanup('SIGINT');
      expect(mockedLogger.info).toHaveBeenCalledWith('Received SIGINT, cleaning up...');
    });
  });

  describe('onContainersStarted and onHostIptablesSetup callbacks', () => {
    it('getContainersStarted returns true after onContainersStarted is called', async () => {
      let capturedOpts: Parameters<typeof mockedSignalHandler.registerSignalHandlers>[0] | undefined;
      mockedSignalHandler.registerSignalHandlers.mockImplementation((opts) => {
        capturedOpts = opts;
      });
      mockedCliWorkflow.runMainWorkflow.mockImplementation(
        async (_config, _deps, callbacks) => {
          callbacks.onContainersStarted?.();
          return 0;
        }
      );

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      // After onContainersStarted is called, the flag should be true
      expect(capturedOpts!.getContainersStarted()).toBe(true);
    });
  });

  describe('fatal error cleanup after containers started', () => {
    it('stops containers during cleanup when workflow fails after startup callbacks', async () => {
      mockedCliWorkflow.runMainWorkflow.mockImplementation(
        async (_config, _deps, callbacks) => {
          callbacks.onHostIptablesSetup?.();
          callbacks.onContainersStarted?.();
          throw new Error('signal test');
        }
      );
      mockedDockerManager.stopContainers.mockResolvedValue(undefined);
      mockedDockerManager.cleanup.mockResolvedValue(undefined);

      const action = createMainAction(getOptionValueSource);
      await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');

      // Verify containers were stopped as part of cleanup
      expect(mockedDockerManager.stopContainers).toHaveBeenCalled();
    });
  });

  describe('redaction of sensitive config fields', () => {
    it('does not log API keys in debug output', async () => {
      const configWithKeys = {
        ...STUB_CONFIG,
        openaiApiKey: 'sk-secret',
        anthropicApiKey: 'ant-secret',
        copilotGithubToken: 'ghp-secret',
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
      expect(configDebugCall).toBeDefined();
      const serialized = String(configDebugCall?.[1]);
      expect(serialized).not.toContain('sk-secret');
      expect(serialized).not.toContain('ant-secret');
      expect(serialized).not.toContain('ghp-secret');
      expect(serialized).not.toContain('cop-secret');
      expect(serialized).not.toContain('gem-secret');
    });
  });

  describe('resolved config artifact', () => {
    beforeEach(() => {
      mockMkdirSync.mockReset();
      mockWriteFileSync.mockReset();
      mockChmodSync.mockReset();
    });

    afterEach(() => jest.restoreAllMocks());

    it('writes awf-resolved-config.json to audit dir when set', async () => {
      const configWithAudit = {
        ...STUB_CONFIG,
        auditDir: '/tmp/awf-audit',
      };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithAudit as unknown as import('../types').WrapperConfig
      );
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/awf-audit', { recursive: true, mode: 0o755 });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/awf-audit/awf-resolved-config.json',
        expect.stringContaining('"allowedDomains"'),
        { mode: 0o644 },
      );
      expect(mockChmodSync).toHaveBeenCalledWith('/tmp/awf-audit/awf-resolved-config.json', 0o644);
      // Verify secret key names are excluded from the artifact
      const written = mockWriteFileSync.mock.calls.find(
        (c) => String(c[0]).includes('awf-resolved-config.json')
      );
      expect(written).toBeDefined();
      const writtenJson = String(written![1]);
      expect(writtenJson).not.toContain('ApiKey');
      expect(writtenJson).not.toContain('GithubToken');
    });

    it('redacts secret values in agentCommand in the artifact', async () => {
      const secretValue = 'super-secret-token-12345';
      const configWithSecret = {
        ...STUB_CONFIG,
        auditDir: '/tmp/awf-audit',
        agentCommand: `my-agent --token ${secretValue}`,
      };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithSecret as unknown as import('../types').WrapperConfig
      );
      // Make redactSecrets actually remove the secret value
      mockedRedactSecrets.redactSecrets.mockImplementation((s: string) =>
        s.replace(secretValue, '[REDACTED]')
      );

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      const written = mockWriteFileSync.mock.calls.find(
        (c) => String(c[0]).includes('awf-resolved-config.json')
      );
      expect(written).toBeDefined();
      const writtenJson = String(written![1]);
      expect(writtenJson).not.toContain(secretValue);
      expect(writtenJson).toContain('[REDACTED]');
    });

    it('falls back to workDir/audit when auditDir is not set', async () => {
      mockedValidateOptions.validateOptions.mockReturnValue(STUB_CONFIG);
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/awf-test/audit/awf-resolved-config.json',
        expect.any(String),
        { mode: 0o644 },
      );
    });
  });
});
