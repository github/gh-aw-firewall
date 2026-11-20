import './main-action-enclave-mocks.test-utils';
import { mainActionFsMocks } from './main-action-fs-mock.test-utils';
import { createMainAction } from './main-action';
import { publishEarlyResolvedConfig } from '../resolved-config-artifact';
import * as enclaveManager from '../enclave/manager';
import {
  MAIN_ACTION_STUB_CONFIG,
  getMainActionMocks,
  setupMainActionPlatformHarness,
} from './main-action.test-utils';
import type { WrapperConfig } from '../types';

const {
  mockedDockerManager,
  mockedCliWorkflow,
  mockedRedactSecrets,
  mockedOptionParsers,
  mockedDindProbe,
  mockedDindBootstrap,
  mockedValidateOptions,
} = getMainActionMocks();
const mockedEnclaveManager = enclaveManager as jest.Mocked<typeof enclaveManager>;

describe('createMainAction', () => {
  const platformHarness = setupMainActionPlatformHarness();
  let processExitSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let getOptionValueSource: jest.Mock;

  beforeEach(() => {
    mockedEnclaveManager.prepareEnclaves.mockResolvedValue(undefined);
    mockedDockerManager.runAgentCommand.mockResolvedValue({ exitCode: 0, blockedDomains: [] });
    mockedRedactSecrets.deriveSensitiveEndpointForms.mockImplementation((domains?: string[]) =>
      domains ?? []
    );
    mockedRedactSecrets.redactSensitiveValues.mockImplementation((value: string, values: string[]) =>
      values.reduce((redacted, sensitive) => redacted.split(sensitive).join('[REDACTED]'), value)
    );
    processExitSpy = platformHarness.processExitSpy;
    consoleErrorSpy = platformHarness.consoleErrorSpy;
    getOptionValueSource = platformHarness.getOptionValueSource;
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
