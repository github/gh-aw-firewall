const mockExecSync = jest.fn();

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./main-action-fs-mock.test-utils').mainActionFsMockFactory());

jest.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

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
jest.mock('../sbx-manager');

import { logger } from '../logger';
import * as dockerManager from '../docker-manager';
import * as cliWorkflow from '../cli-workflow';
import * as redactSecrets from '../redact-secrets';
import * as optionParsers from '../option-parsers';
import * as dindProbe from '../dind-probe';
import * as dindBootstrap from '../dind-bootstrap';
import * as preflight from './preflight';
import * as signalHandler from './signal-handler';
import * as validateOptions from './validate-options';
import * as sbxManager from '../sbx-manager';
import { DOH_PROXY_IP } from '../host-iptables-shared';
import { MAIN_ACTION_STUB_CONFIG, setupMainActionTestHarness } from './main-action.test-utils';

const mockedLogger = logger as jest.Mocked<typeof logger>;
const mockedDockerManager = dockerManager as jest.Mocked<typeof dockerManager>;
const mockedCliWorkflow = cliWorkflow as jest.Mocked<typeof cliWorkflow>;
const mockedRedactSecrets = redactSecrets as jest.Mocked<typeof redactSecrets>;
const mockedOptionParsers = optionParsers as jest.Mocked<typeof optionParsers>;
const mockedDindProbe = dindProbe as jest.Mocked<typeof dindProbe>;
const mockedDindBootstrap = dindBootstrap as jest.Mocked<typeof dindBootstrap>;
const mockedPreflight = preflight as jest.Mocked<typeof preflight>;
const mockedSignalHandler = signalHandler as jest.Mocked<typeof signalHandler>;
const mockedValidateOptions = validateOptions as jest.Mocked<typeof validateOptions>;
const mockedSbxManager = sbxManager as jest.Mocked<typeof sbxManager>;

describe('createMainAction coverage gaps', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let getOptionValueSource: jest.Mock;
  const savedGithubWorkspace = process.env.GITHUB_WORKSPACE;

  beforeEach(() => {
    const harness = setupMainActionTestHarness({
      mockedPreflight,
      mockedValidateOptions,
      mockedDockerManager,
      mockedRedactSecrets,
      mockedOptionParsers,
      mockedDindProbe,
      mockedDindBootstrap,
      mockedSignalHandler,
      mockedCliWorkflow,
      mockedSbxManager,
    });
    processExitSpy = harness.processExitSpy;
    consoleErrorSpy = harness.consoleErrorSpy;
    getOptionValueSource = harness.getOptionValueSource;
  });

  afterEach(() => {
    if (savedGithubWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = savedGithubWorkspace;
    }
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('sbx: isSbxAvailable false throws', () => {
    it('throws when sbx CLI is not found', async () => {
      const sbxConfig = {
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'sbx',
      } as unknown as import('../types').WrapperConfig;
      mockedValidateOptions.validateOptions.mockReturnValue(sbxConfig);
      mockedSbxManager.isSbxAvailable.mockResolvedValue(false);
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, deps) => {
        await deps.startContainers('/tmp/awf-test', ['github.com']);
        return 0;
      });

      const action = createMainAction(getOptionValueSource);
      await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        'Fatal error:',
        expect.objectContaining({ message: expect.stringContaining('sbx') }),
      );
    });
  });

  describe('sbx: api-proxy reflection preflight failure', () => {
    it('fails closed when /reflect is unreachable', async () => {
      const sbxConfig = {
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'sbx',
        enableApiProxy: true,
        containerWorkDir: '/workspace',
      } as unknown as import('../types').WrapperConfig;
      mockedValidateOptions.validateOptions.mockReturnValue(sbxConfig);
      mockedSbxManager.assertSbxApiProxyReflect.mockRejectedValue(
        new Error('sbx sandbox cannot reach the API proxy /reflect endpoint'),
      );
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, deps) => {
        await deps.startContainers('/tmp/awf-test', ['github.com']);
        return 0;
      });

      const action = createMainAction(getOptionValueSource);
      await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');

      expect(mockedLogger.error).toHaveBeenCalledWith(
        'Fatal error:',
        expect.objectContaining({
          message: expect.stringContaining('/reflect'),
        }),
      );
    });
  });

  describe('sbx: runAgentCommand logs api-proxy diagnostics on non-zero exit', () => {
    it('dumps api-proxy logs when agent exits non-zero with enableApiProxy', async () => {
      const sbxConfig = {
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'sbx',
        enableApiProxy: true,
        containerWorkDir: '/workspace',
      } as unknown as import('../types').WrapperConfig;
      mockedValidateOptions.validateOptions.mockReturnValue(sbxConfig);

      // Reflection preflight is mocked separately; squid diag succeeds, agent fails.
      mockedSbxManager.execInSandbox
        .mockResolvedValueOnce({ exitCode: 0 }) // squid diag
        .mockResolvedValueOnce({ exitCode: 42 }); // agent command fails
      mockExecSync
        .mockReturnValueOnce('api-proxy diagnostic log\n')
        .mockReturnValueOnce('healthy\n');

      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, deps) => {
        await deps.startContainers('/tmp/awf-test', ['github.com']);
        const result = await deps.runAgentCommand('/tmp/awf-test', ['github.com'], undefined, 5);
        return result.exitCode;
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(processExitSpy).toHaveBeenCalledWith(42);
      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Agent command exited with code 42'),
      );
      expect(mockExecSync).toHaveBeenNthCalledWith(
        1,
        'docker logs --tail 80 awf-api-proxy 2>&1',
        { encoding: 'utf-8', timeout: 10000 },
      );
      expect(mockExecSync).toHaveBeenNthCalledWith(
        2,
        'docker inspect --format={{.State.Health.Status}} awf-api-proxy 2>&1',
        { encoding: 'utf-8', timeout: 5000 },
      );
      expect(mockedLogger.info).toHaveBeenCalledWith(
        '[sbx-diag] api-proxy logs:\napi-proxy diagnostic log\n',
      );
      expect(mockedLogger.info).toHaveBeenCalledWith(
        '[sbx-diag] api-proxy health status: healthy',
      );
    });
  });

  describe('sbx cleanup: keepContainers=false removes sandbox', () => {
    it('calls removeSandbox during cleanup when not keepContainers', async () => {
      const sbxConfig = {
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'sbx',
        keepContainers: false,
      } as unknown as import('../types').WrapperConfig;
      mockedValidateOptions.validateOptions.mockReturnValue(sbxConfig);
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, _deps, callbacks) => {
        await callbacks.performCleanup();
        return 0;
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedSbxManager.removeSandbox).toHaveBeenCalled();
    });
  });

  describe('sbx signal handling', () => {
    it('stops the selected external backend instead of the compose agent', async () => {
      const sbxConfig = {
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'sbx',
        keepContainers: false,
      } as unknown as import('../types').WrapperConfig;
      mockedValidateOptions.validateOptions.mockReturnValue(sbxConfig);
      let signalOptions: Parameters<typeof mockedSignalHandler.registerSignalHandlers>[0] | undefined;
      mockedSignalHandler.registerSignalHandlers.mockImplementation((options) => {
        signalOptions = options;
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      await signalOptions!.fastKillAgentContainer();

      expect(mockedSbxManager.removeSandbox).toHaveBeenCalled();
      expect(mockedDockerManager.fastKillAgentContainer).not.toHaveBeenCalled();
    });
  });

  describe('sbx cleanup: keepContainers=true skips removeSandbox', () => {
    it('does not call removeSandbox when keepContainers is true', async () => {
      const sbxConfig = {
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'sbx',
        keepContainers: true,
      } as unknown as import('../types').WrapperConfig;
      mockedValidateOptions.validateOptions.mockReturnValue(sbxConfig);
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, _deps, callbacks) => {
        await callbacks.performCleanup();
        return 0;
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedSbxManager.removeSandbox).not.toHaveBeenCalled();
    });
  });

  describe('non-sbx runAgentCommand uses containerRuntime', () => {
    it('passes containerRuntime to runAgentCommand for non-sbx config', async () => {
      const dockerConfig = {
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'docker',
      } as unknown as import('../types').WrapperConfig;
      mockedValidateOptions.validateOptions.mockReturnValue(dockerConfig);
      mockedDockerManager.runAgentCommand.mockResolvedValue({ exitCode: 0, blockedDomains: [] });
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, deps) => {
        const result = await deps.runAgentCommand('/tmp/awf-test', ['github.com'], undefined, 5);
        return result.exitCode;
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedDockerManager.runAgentCommand).toHaveBeenCalledWith(
        '/tmp/awf-test',
        ['github.com'],
        undefined,
        5,
        'docker',
      );
    });
  });

  describe('sbx: dnsOverHttps and difcProxyHost wiring', () => {
    it('sets dohProxyIp when dnsOverHttps is enabled', async () => {
      const sbxConfig = {
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'sbx',
        dnsOverHttps: true,
        containerWorkDir: '/workspace',
      } as unknown as import('../types').WrapperConfig;
      mockedValidateOptions.validateOptions.mockReturnValue(sbxConfig);
      mockedSbxManager.execInSandbox.mockResolvedValue({ exitCode: 0 });
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, deps) => {
        await deps.startContainers('/tmp/awf-test', ['github.com']);
        const result = await deps.runAgentCommand('/tmp/awf-test', ['github.com']);
        return result.exitCode;
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedSbxManager.execInSandbox).toHaveBeenLastCalledWith(
        'awf-agent-test',
        'echo hi',
        expect.objectContaining({
          environment: expect.objectContaining({
            AWF_DOH_ENABLED: 'true',
            AWF_DOH_PROXY_IP: DOH_PROXY_IP,
          }),
        }),
      );
    });
  });

  describe('sbx: GITHUB_WORKSPACE env fallback', () => {
    it('falls back to cwd when GITHUB_WORKSPACE is not set', async () => {
      delete process.env.GITHUB_WORKSPACE;
      const sbxConfig = {
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'sbx',
        containerWorkDir: '/workspace',
      } as unknown as import('../types').WrapperConfig;
      mockedValidateOptions.validateOptions.mockReturnValue(sbxConfig);
      mockedSbxManager.execInSandbox.mockResolvedValue({ exitCode: 0 });
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, deps) => {
        await deps.startContainers('/tmp/awf-test', ['github.com']);
        const result = await deps.runAgentCommand('/tmp/awf-test', ['github.com']);
        return result.exitCode;
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedSbxManager.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: process.cwd() }),
      );
    });

    it('uses GITHUB_WORKSPACE when set', async () => {
      process.env.GITHUB_WORKSPACE = '/github/workspace';
      const sbxConfig = {
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'sbx',
        containerWorkDir: '/workspace',
      } as unknown as import('../types').WrapperConfig;
      mockedValidateOptions.validateOptions.mockReturnValue(sbxConfig);
      mockedSbxManager.execInSandbox.mockResolvedValue({ exitCode: 0 });
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, deps) => {
        await deps.startContainers('/tmp/awf-test', ['github.com']);
        const result = await deps.runAgentCommand('/tmp/awf-test', ['github.com']);
        return result.exitCode;
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedSbxManager.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: '/github/workspace' }),
      );
    });
  });
});
