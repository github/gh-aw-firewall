import { mainActionFsMocks } from './main-action-fs-mock.test-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./main-action-fs-mock.test-utils').mainActionFsMockFactory());

import { createMainAction, testHelpers } from './main-action';

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
jest.mock('../enclave/gateway');
jest.mock('../external-runtime-backend-resolver', () => {
  const actual = jest.requireActual('../external-runtime-backend-resolver');
  return {
    ...actual,
    resolveExternalRuntimeBackend: jest.fn(actual.resolveExternalRuntimeBackend),
  };
});

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
import * as sbxManager from '../sbx-manager';
import * as enclaveGateway from '../enclave/gateway';
import * as externalRuntimeResolver from '../external-runtime-backend-resolver';
import { MAIN_ACTION_STUB_CONFIG, setupMainActionTestHarness } from './main-action.test-utils';

const {
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  chmodSync: mockChmodSync,
  openSync: mockOpenSync,
  closeSync: mockCloseSync,
} = mainActionFsMocks;

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
const mockedSbxManager = sbxManager as jest.Mocked<typeof sbxManager>;
const mockedEnclaveGateway = enclaveGateway as jest.Mocked<typeof enclaveGateway>;
const mockedExternalRuntimeResolver = externalRuntimeResolver as jest.Mocked<typeof externalRuntimeResolver>;

describe('createMainAction', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let getOptionValueSource: jest.Mock;

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

    it('runs the reflection endpoint when --reflect is set', async () => {
      const action = createMainAction(getOptionValueSource);
      await action([], { reflect: true });
      expect(mockedValidateOptions.validateOptions).toHaveBeenCalledWith(
        expect.anything(),
        'curl --fail --silent --show-error --noproxy "*" http://api-proxy:10000/reflect'
      );
      expect(mockedOptionParsers.joinShellArgs).not.toHaveBeenCalled();
      expect(mockedCliWorkflow.runMainWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          additionalEnv: expect.objectContaining({
            AWF_COMMAND_STDOUT_ONLY: '1',
          }),
        }),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('when --reflect is used with a command', () => {
    it('exits with code 1 and prints a usage error', async () => {
      const action = createMainAction(getOptionValueSource);
      await expect(action(['echo hi'], { reflect: true })).rejects.toThrow('process.exit: 1');
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--reflect cannot be used with a command')
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
      const configWithDockerHost = { ...MAIN_ACTION_STUB_CONFIG, awfDockerHost: '/var/run/docker.sock' };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithDockerHost as unknown as import('../types').WrapperConfig
      );
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedDockerManager.setAwfDockerHost).toHaveBeenCalledWith('/var/run/docker.sock');
    });

    it('passes containerRuntime through to runAgentCommand', async () => {
      mockedValidateOptions.validateOptions.mockReturnValue({
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'gvisor',
      } as unknown as import('../types').WrapperConfig);
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, deps) => {
        await deps.runAgentCommand('/tmp/awf-test', ['github.com'], undefined, 10);
        return 0;
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedDockerManager.runAgentCommand).toHaveBeenCalledWith(
        '/tmp/awf-test',
        ['github.com'],
        undefined,
        10,
        'gvisor'
      );
    });

    it('registers signal handlers', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedSignalHandler.registerSignalHandlers).toHaveBeenCalled();
    });

    it('runs DinD bootstrap before workflow execution', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedDindBootstrap.runDindBootstrap).toHaveBeenCalledWith(MAIN_ACTION_STUB_CONFIG);
    });

    it('skips probe and DinD bootstrap when dockerHostPathPrefix is already set', async () => {
      mockedValidateOptions.validateOptions.mockReturnValue({
        ...MAIN_ACTION_STUB_CONFIG,
        dockerHostPathPrefix: '/host',
      } as unknown as import('../types').WrapperConfig);

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedDindProbe.probeSplitFilesystem).not.toHaveBeenCalled();
      expect(mockedDindBootstrap.runDindBootstrap).not.toHaveBeenCalled();
    });

    it('auto-applies detected DinD prefix and logs info', async () => {
      mockedDindProbe.probeSplitFilesystem.mockResolvedValue({
        prefix: '/host',
        splitDetected: true,
        inconclusive: false,
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Auto-applied --docker-host-path-prefix /host')
      );
    });

    it('logs warning when split filesystem is detected without a known prefix', async () => {
      mockedDindProbe.probeSplitFilesystem.mockResolvedValue({
        prefix: undefined,
        splitDetected: true,
        inconclusive: false,
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Split runner/daemon filesystem detected')
      );
    });

    it('logs empty DNS servers when dnsServers is undefined', async () => {
      mockedValidateOptions.validateOptions.mockReturnValue({
        ...MAIN_ACTION_STUB_CONFIG,
        dnsServers: undefined,
      } as unknown as import('../types').WrapperConfig);

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedLogger.debug).toHaveBeenCalledWith('DNS servers: ');
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
        ...MAIN_ACTION_STUB_CONFIG,
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

    describe('sbx runtime wiring', () => {
      it('passes configured mounts/workdir/environment into sbx create/exec', async () => {
        const sbxConfig = {
          ...MAIN_ACTION_STUB_CONFIG,
          containerRuntime: 'sbx',
          containerWorkDir: '/home/runner/work/repo/repo',
          volumeMounts: ['/tmp/tooling:/tmp/tooling:ro'],
          enableApiProxy: true,
          tty: true,
        } as unknown as import('../types').WrapperConfig;
        mockedValidateOptions.validateOptions.mockReturnValue(sbxConfig);
        mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, deps, _callbacks) => {
          await deps.startContainers('/tmp/awf-test', ['github.com']);
          const result = await deps.runAgentCommand('/tmp/awf-test', ['github.com'], undefined, 10);
          return result.exitCode;
        });

        const action = createMainAction(getOptionValueSource);
        await action(['echo hi'], {});

        expect(mockedSbxManager.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
          extraMounts: ['/tmp/tooling:/tmp/tooling:ro'],
        }));
        expect(mockedSbxManager.assertSbxApiProxyReflect).toHaveBeenCalledWith(
          'awf-agent-test',
          expect.objectContaining({
            NO_PROXY: expect.stringContaining('api-proxy'),
          }),
          '/home/runner/work/repo/repo',
        );
        expect(mockedSbxManager.execInSandbox).toHaveBeenCalledWith(
          'awf-agent-test',
          'echo hi',
          expect.objectContaining({
            timeoutMinutes: 10,
            workDir: '/home/runner/work/repo/repo',
            tty: true,
            environment: expect.objectContaining({
              HTTPS_PROXY: expect.any(String),
              SQUID_PROXY_HOST: expect.any(String),
            }),
          }),
        );
      });

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
        MAIN_ACTION_STUB_CONFIG.workDir,
        false,
        MAIN_ACTION_STUB_CONFIG.proxyLogsDir,
        MAIN_ACTION_STUB_CONFIG.auditDir,
        MAIN_ACTION_STUB_CONFIG.sessionStateDir,
        MAIN_ACTION_STUB_CONFIG.dockerHostPathPrefix,
        MAIN_ACTION_STUB_CONFIG.imageRegistry,
        MAIN_ACTION_STUB_CONFIG.imageTag,
        MAIN_ACTION_STUB_CONFIG.agentImage,
      );
      expect(mockedHostIptables.cleanupHostIptables).not.toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    describe('when external runtime resolution fails', () => {
      it('uses fatal-error cleanup and exits with code 1', async () => {
        mockedExternalRuntimeResolver.resolveExternalRuntimeBackend.mockImplementationOnce(() => {
          throw new Error('backend is not registered');
        });

        const action = createMainAction(getOptionValueSource);
        await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');

        expect(mockedLogger.error).toHaveBeenCalledWith(
          'Fatal error:',
          expect.objectContaining({ message: 'backend is not registered' }),
        );
        expect(mockedDockerManager.cleanup).toHaveBeenCalled();
        expect(mockedCliWorkflow.runMainWorkflow).not.toHaveBeenCalled();
        expect(processExitSpy).toHaveBeenCalledWith(1);
      });
    });

    describe('when external runtime preflight fails', () => {
      it('aborts before entering the main workflow', async () => {
        mockedExternalRuntimeResolver.resolveExternalRuntimeBackend.mockImplementationOnce(() => ({
          runtime: 'sbx',
          preflight: jest.fn().mockRejectedValue(new Error('preflight failed')),
          start: jest.fn(),
          exec: jest.fn(),
          collectDiagnostics: jest.fn(),
          stop: jest.fn(),
        }));

        const action = createMainAction(getOptionValueSource);
        await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');

        expect(mockedCliWorkflow.runMainWorkflow).not.toHaveBeenCalled();
        expect(mockedLogger.error).toHaveBeenCalledWith(
          'Fatal error:',
          expect.objectContaining({ message: 'preflight failed' }),
        );
      });
    });
  });

  describe('performCleanup with keepContainers=true', () => {
    it('logs preserved paths and skips cleanup when keepContainers is true', async () => {
      const configWithKeep = { ...MAIN_ACTION_STUB_CONFIG, keepContainers: true };
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

    it('quiesces an external runtime through its preserve hook', async () => {
      const preserve = jest.fn().mockResolvedValue(undefined);
      const backend = {
        runtime: 'firecracker',
        preflight: jest.fn(),
        start: jest.fn(),
        exec: jest.fn(),
        collectDiagnostics: jest.fn(),
        stop: jest.fn(),
        preserve,
      };
      const cleanup = testHelpers.buildCleanupFn(
        {
          ...MAIN_ACTION_STUB_CONFIG,
          keepContainers: true,
          diagnosticLogs: true,
        },
        () => false,
        () => false,
        backend,
      );

      await cleanup();

      expect(backend.collectDiagnostics).toHaveBeenCalledTimes(1);
      expect(preserve).toHaveBeenCalledTimes(1);
      expect(backend.stop).not.toHaveBeenCalled();
    });
  });

  describe('external runtime cleanup failures', () => {
    it('continues generic cleanup and then rethrows the runtime failure', async () => {
      const runtimeError = new Error('Firecracker teardown failed');
      const backend = {
        runtime: 'firecracker',
        preflight: jest.fn(),
        start: jest.fn(),
        exec: jest.fn(),
        collectDiagnostics: jest.fn(),
        stop: jest.fn().mockRejectedValue(runtimeError),
      };
      const cleanup = testHelpers.buildCleanupFn(
        {
          ...MAIN_ACTION_STUB_CONFIG,
          keepContainers: false,
          diagnosticLogs: true,
        },
        () => false,
        () => false,
        backend,
      );

      await expect(cleanup()).rejects.toBe(runtimeError);
      expect(backend.collectDiagnostics).toHaveBeenCalledTimes(1);
      expect(mockedDockerManager.cleanup).toHaveBeenCalled();
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        'External runtime cleanup failed; continuing with infrastructure teardown.',
        runtimeError,
      );
    });
  });

  describe('external runtime diagnostics', () => {
    it('aggregates backend and Docker diagnostics with explicit failures', async () => {
      const backend = {
        runtime: 'firecracker',
        preflight: jest.fn().mockResolvedValue(undefined),
        start: jest.fn(),
        exec: jest.fn(),
        collectDiagnostics: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn(),
      };
      let collectDiagnostics!: (workDir: string) => Promise<void>;
      mockedExternalRuntimeResolver.resolveExternalRuntimeBackend
        .mockReturnValueOnce(backend);
      mockedCliWorkflow.runMainWorkflow.mockImplementationOnce(
        async (_config, dependencies) => {
          collectDiagnostics = dependencies.collectDiagnosticLogs!;
          return 0;
        },
      );

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      await expect(collectDiagnostics('/tmp/awf')).resolves.toBeUndefined();
      expect(backend.collectDiagnostics).toHaveBeenCalledTimes(1);
      expect(mockedDockerManager.collectDiagnosticLogs)
        .toHaveBeenCalledWith('/tmp/awf');

      backend.collectDiagnostics.mockRejectedValueOnce(
        new Error('backend diagnostics failed'),
      );
      mockedDockerManager.collectDiagnosticLogs.mockRejectedValueOnce(
        'docker diagnostics failed',
      );
      await expect(collectDiagnostics('/tmp/awf')).rejects.toThrow(
        /backend diagnostics failed; docker diagnostics failed/,
      );
    });
  });

  describe('performCleanup with containers started', () => {
    it('stops containers and cleans host iptables when both flags are set', async () => {
      const configWithFlags = { ...MAIN_ACTION_STUB_CONFIG, keepContainers: false };
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
        ...MAIN_ACTION_STUB_CONFIG,
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
      mockOpenSync.mockReset();
      mockOpenSync.mockReturnValue(42);
      mockCloseSync.mockReset();
    });

    afterEach(() => jest.restoreAllMocks());

    it('writes awf-resolved-config.json to audit dir when set', async () => {
      const configWithAudit = {
        ...MAIN_ACTION_STUB_CONFIG,
        auditDir: '/tmp/awf-audit',
      };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithAudit as unknown as import('../types').WrapperConfig
      );
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/awf-audit', { recursive: true, mode: 0o700 });
      expect(mockOpenSync).toHaveBeenCalledWith('/tmp/awf-audit/awf-resolved-config.json', 'wx', 0o600);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        42,
        expect.stringContaining('"allowedDomains"'),
      );
      // Verify secret key names are excluded from the artifact
      const written = mockWriteFileSync.mock.calls.find(
        (c) => typeof c[0] === 'number'
      );
      expect(written).toBeDefined();
      const writtenJson = String(written![1]);
      expect(writtenJson).not.toContain('ApiKey');
      expect(writtenJson).not.toContain('GithubToken');
    });

    it('redacts secret values in agentCommand in the artifact', async () => {
      const secretValue = 'super-secret-token-12345';
      const configWithSecret = {
        ...MAIN_ACTION_STUB_CONFIG,
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
        (c) => typeof c[0] === 'number'
      );
      expect(written).toBeDefined();
      const writtenJson = String(written![1]);
      expect(writtenJson).not.toContain(secretValue);
      expect(writtenJson).toContain('[REDACTED]');
    });

    it('falls back to workDir/audit when auditDir is not set', async () => {
      mockedValidateOptions.validateOptions.mockReturnValue(MAIN_ACTION_STUB_CONFIG);
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockOpenSync).toHaveBeenCalledWith(
        '/tmp/awf-test/audit/awf-resolved-config.json',
        'wx',
        0o600,
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        42,
        expect.any(String),
      );
    });
  });

  describe('extracted helper functions', () => {
    it('redactConfigForLogging removes sensitive keys and redacts agentCommand', () => {
      const secretValue = 'secret-123';
      const configWithSecrets = {
        ...MAIN_ACTION_STUB_CONFIG,
        agentCommand: `agent --token ${secretValue}`,
        openaiApiKey: 'sk-secret',
      } as unknown as import('../types').WrapperConfig;
      mockedRedactSecrets.redactSecrets.mockImplementation((s: string) =>
        s.replace(secretValue, '[REDACTED]')
      );

      const redacted = testHelpers.redactConfigForLogging(configWithSecrets);

      expect(redacted).not.toHaveProperty('openaiApiKey');
      expect(redacted.agentCommand).toContain('[REDACTED]');
      expect(redacted.agentCommand).not.toContain(secretValue);
    });

    it('redactConfigForLogging redacts additionalEnv object values', () => {
      const redacted = testHelpers.redactConfigForLogging({
        ...MAIN_ACTION_STUB_CONFIG,
        additionalEnv: { ANTHROPIC_API_KEY: 'sk-real', GH_TOKEN: 'token123' },
      } as unknown as import('../types').WrapperConfig);

      expect(redacted.additionalEnv).toEqual({
        ANTHROPIC_API_KEY: '[REDACTED]',
        GH_TOKEN: '[REDACTED]',
      });
    });

    it('redactConfigForLogging preserves null additionalEnv', () => {
      const redacted = testHelpers.redactConfigForLogging({
        ...MAIN_ACTION_STUB_CONFIG,
        additionalEnv: null as unknown as Record<string, string>,
      } as unknown as import('../types').WrapperConfig);

      expect(redacted.additionalEnv).toBeNull();
    });

    it('redactConfigForLogging preserves non-object additionalEnv values', () => {
      const redacted = testHelpers.redactConfigForLogging({
        ...MAIN_ACTION_STUB_CONFIG,
        additionalEnv: 'raw-env-string' as unknown as Record<string, string>,
      } as unknown as import('../types').WrapperConfig);

      expect(redacted.additionalEnv).toBe('raw-env-string');
    });

    it('persistConfigAuditArtifact logs debug when writing the artifact fails', () => {
      mockMkdirSync.mockImplementationOnce(() => {
        throw new Error('write failed');
      });

      testHelpers.persistConfigAuditArtifact(MAIN_ACTION_STUB_CONFIG, { foo: 'bar' });

      expect(mockedLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Failed to write resolved config artifact:')
      );
    });

    it('buildCleanupFn runs cleanup using provided state getters', async () => {
      const performCleanup = testHelpers.buildCleanupFn(
        MAIN_ACTION_STUB_CONFIG,
        () => true,
        () => true,
      );

      await performCleanup();

      expect(mockedDockerManager.preserveIptablesAudit).toHaveBeenCalledWith(
        MAIN_ACTION_STUB_CONFIG.workDir,
        MAIN_ACTION_STUB_CONFIG.auditDir
      );
      expect(mockedEnclaveGateway.shutdownEnclaveGateway).toHaveBeenCalledWith(
        MAIN_ACTION_STUB_CONFIG
      );
      expect(
        mockedEnclaveGateway.shutdownEnclaveGateway.mock.invocationCallOrder[0]
      ).toBeLessThan(
        mockedDockerManager.preserveIptablesAudit.mock.invocationCallOrder[0]
      );
      expect(mockedDockerManager.stopContainers).toHaveBeenCalledWith(
        MAIN_ACTION_STUB_CONFIG.workDir,
        MAIN_ACTION_STUB_CONFIG.keepContainers
      );
      expect(mockedHostIptables.cleanupHostIptables).toHaveBeenCalled();
      expect(mockedDockerManager.cleanup).toHaveBeenCalled();
    });

    it('preserves audits after an enclave drain failure', async () => {
      mockedEnclaveGateway.shutdownEnclaveGateway.mockRejectedValueOnce(
        new Error('drain failed')
      );
      const performCleanup = testHelpers.buildCleanupFn(
        MAIN_ACTION_STUB_CONFIG,
        () => true,
        () => false,
      );

      await performCleanup();

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        'Enclave gateway did not complete graceful shutdown; preserved enclave audit is marked incomplete.',
        expect.any(Error)
      );
      expect(mockedDockerManager.preserveIptablesAudit).toHaveBeenCalled();
      expect(mockedDockerManager.stopContainers).toHaveBeenCalled();
    });
  });
});
