import { mainActionFsMocks } from './main-action-fs-mock.test-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./main-action-fs-mock.test-utils').mainActionFsMockFactory());

import { createMainAction } from './main-action';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());
jest.mock('../docker-manager');
jest.mock('../host-iptables');
jest.mock('../cli-workflow');
jest.mock('../redact-secrets');
jest.mock('../resolved-config-artifact');
jest.mock('../option-parsers');
jest.mock('../dind-probe');
jest.mock('../dind-bootstrap');
jest.mock('./preflight');
jest.mock('./signal-handler');
jest.mock('./validate-options');
jest.mock('../sbx-manager');
jest.mock('../enclave/gateway');
jest.mock('../enclave/startup-diagnostics');
jest.mock('../enclave/github-gateway');
jest.mock('../enclave/cloud-hypervisor-lifecycle');
jest.mock('../enclave/docker-lifecycle');
jest.mock('../enclave/dynamic-delegation');
jest.mock('../enclave/manager', () => ({
  ...jest.requireActual('../enclave/manager'),
  prepareEnclaves: jest.fn(),
}));
jest.mock('../external-runtime-backend-resolver', () => {
  const actual = jest.requireActual('../external-runtime-backend-resolver');
  return {
    ...actual,
    resolveExternalRuntimeBackend: jest.fn(actual.resolveExternalRuntimeBackend),
  };
});
jest.mock('../services/agent-volumes/credential-hiding', () => ({
  ...jest.requireActual('../services/agent-volumes/credential-hiding'),
  buildCredentialHidingOverlays: jest.fn(() => []),
}));

import * as dockerManager from '../docker-manager';
import * as cliWorkflow from '../cli-workflow';
import * as redactSecrets from '../redact-secrets';
import { publishEarlyResolvedConfig } from '../resolved-config-artifact';
import * as optionParsers from '../option-parsers';
import * as dindProbe from '../dind-probe';
import * as dindBootstrap from '../dind-bootstrap';
import * as preflight from './preflight';
import * as signalHandler from './signal-handler';
import * as validateOptions from './validate-options';
import * as sbxManager from '../sbx-manager';
import * as enclaveManager from '../enclave/manager';
import { MAIN_ACTION_STUB_CONFIG, setupMainActionTestHarness } from './main-action.test-utils';
import type { WrapperConfig } from '../types';

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
const mockedEnclaveManager = enclaveManager as jest.Mocked<typeof enclaveManager>;

describe('createMainAction', () => {
  const originalPlatform = process.platform;
  let processExitSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let effectiveUidSpy: jest.SpyInstance;
  let getOptionValueSource: jest.Mock;

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  beforeEach(() => {
    effectiveUidSpy = jest.spyOn(process, 'geteuid').mockReturnValue(0);
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
    mockedEnclaveManager.prepareEnclaves.mockResolvedValue(undefined);
    mockedDockerManager.runAgentCommand.mockResolvedValue({ exitCode: 0, blockedDomains: [] });
    mockedRedactSecrets.deriveSensitiveEndpointForms.mockImplementation((domains?: string[]) =>
      domains ?? []
    );
    mockedRedactSecrets.redactSensitiveValues.mockImplementation((value: string, values: string[]) =>
      values.reduce((redacted, sensitive) => redacted.split(sensitive).join('[REDACTED]'), value)
    );
    processExitSpy = harness.processExitSpy;
    consoleErrorSpy = harness.consoleErrorSpy;
    getOptionValueSource = harness.getOptionValueSource;
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    effectiveUidSpy.mockRestore();
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
      const persistedConfig = jest.mocked(publishEarlyResolvedConfig).mock.calls
        .map((call) => call[0])
        .find((contents) => contents.includes('"allowedDomains"'));
      expect(persistedConfig).toBeDefined();
      expect(persistedConfig).not.toContain('"containerRuntime": "cloud-hypervisor"');
      expect(persistedConfig).not.toContain('"cloudHypervisor"');
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

    describe('work directory selection', () => {
      it('atomically creates a unique default work directory', async () => {
        mockedValidateOptions.validateOptions
          .mockReturnValueOnce({
            ...MAIN_ACTION_STUB_CONFIG,
            workDir: undefined,
          } as unknown as WrapperConfig)
          .mockReturnValueOnce({
            ...MAIN_ACTION_STUB_CONFIG,
            workDir: undefined,
          } as unknown as WrapperConfig);
        mainActionFsMocks.mkdtempSync
          .mockReturnValueOnce('/synthetic/awf-first')
          .mockReturnValueOnce('/synthetic/awf-second');
        const action = createMainAction(getOptionValueSource);

        await action(['echo first'], {});
        await action(['echo second'], {});

        expect(mainActionFsMocks.mkdtempSync).toHaveBeenNthCalledWith(
          1,
          expect.stringMatching(/awf-$/),
        );
        expect(mainActionFsMocks.mkdtempSync).toHaveBeenNthCalledWith(
          2,
          expect.stringMatching(/awf-$/),
        );
        expect(mockedCliWorkflow.runMainWorkflow).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ workDir: '/synthetic/awf-first' }),
          expect.anything(),
          expect.anything(),
        );
        expect(mockedCliWorkflow.runMainWorkflow).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ workDir: '/synthetic/awf-second' }),
          expect.anything(),
          expect.anything(),
        );
      });

      it('preserves an explicit work directory', async () => {
        mockedValidateOptions.validateOptions.mockReturnValue({
          ...MAIN_ACTION_STUB_CONFIG,
          workDir: '/synthetic/explicit-workdir',
        } as unknown as WrapperConfig);
        const action = createMainAction(getOptionValueSource);
        await action(['echo explicit'], { workDir: '/synthetic/explicit-workdir' });

        expect(mainActionFsMocks.mkdtempSync).not.toHaveBeenCalled();
        expect(mockedValidateOptions.validateOptions).toHaveBeenCalledWith(
          expect.objectContaining({ workDir: '/synthetic/explicit-workdir' }),
          'echo explicit',
        );
      });

      it.each(['probe', 'bootstrap'] as const)(
        'cleans an auto-created work directory when %s setup fails',
        async failurePoint => {
          mockedValidateOptions.validateOptions.mockReturnValue({
            ...MAIN_ACTION_STUB_CONFIG,
            workDir: undefined,
          } as unknown as WrapperConfig);
          mainActionFsMocks.mkdtempSync.mockReturnValue('/synthetic/awf-setup-failure');
          if (failurePoint === 'probe') {
            mockedDindProbe.probeSplitFilesystem.mockRejectedValue(new Error('probe failed'));
          } else {
            mockedDindBootstrap.runDindBootstrap.mockRejectedValue(new Error('bootstrap failed'));
          }

          const action = createMainAction(getOptionValueSource);
          await expect(action(['echo setup'], {})).rejects.toThrow('process.exit: 1');

          const cleanupCalls = mockedDockerManager.cleanup.mock.calls;
          expect(cleanupCalls[cleanupCalls.length - 1]?.slice(0, 2)).toEqual([
            '/synthetic/awf-setup-failure',
            false,
          ]);
        },
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
});
