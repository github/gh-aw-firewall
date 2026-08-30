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
jest.mock('../guard-result-proxy');

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
import * as guardResultProxy from '../guard-result-proxy';
import { GUARD_RESULT_FD_ENV_VAR } from '../guard-result';
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
const mockedGuardResultProxy = guardResultProxy as jest.Mocked<typeof guardResultProxy>;

describe('guard result channel wiring', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let getOptionValueSource: jest.Mock;
  const savedFdEnv = process.env[GUARD_RESULT_FD_ENV_VAR];

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
    delete process.env[GUARD_RESULT_FD_ENV_VAR];
    mockedGuardResultProxy.captureGuardSnapshotPair.mockResolvedValue(null);
    mockedGuardResultProxy.areGuardContainersRemoved.mockResolvedValue(true);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (savedFdEnv === undefined) {
      delete process.env[GUARD_RESULT_FD_ENV_VAR];
    } else {
      process.env[GUARD_RESULT_FD_ENV_VAR] = savedFdEnv;
    }
  });

  describe('mainAction fail-fast validation', () => {
    it('behaves exactly as today when the env var is absent', async () => {
      mockedCliWorkflow.runMainWorkflow.mockResolvedValue(0);
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedCliWorkflow.runMainWorkflow).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('exits with code 1 before starting the agent when the fd is not numeric', async () => {
      process.env[GUARD_RESULT_FD_ENV_VAR] = 'not-a-number';
      const action = createMainAction(getOptionValueSource);
      await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(mockedCliWorkflow.runMainWorkflow).not.toHaveBeenCalled();
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid AWF_GUARD_RESULT_FD'),
        expect.any(Error),
      );
    });

    it('exits with code 1 before starting the agent when the fd is not an open descriptor', async () => {
      process.env[GUARD_RESULT_FD_ENV_VAR] = '999999';
      const action = createMainAction(getOptionValueSource);
      await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(mockedCliWorkflow.runMainWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('buildCleanupFn guard result emission', () => {
    it('does not capture or emit a guard result when no guard config is provided', async () => {
      const performCleanup = testHelpers.buildCleanupFn(
        MAIN_ACTION_STUB_CONFIG,
        () => true,
        () => true,
      );

      await performCleanup();

      expect(mockedGuardResultProxy.captureGuardSnapshotPair).not.toHaveBeenCalled();
      expect(mockedGuardResultProxy.areGuardContainersRemoved).not.toHaveBeenCalled();
    });

    it('captures snapshots before stopContainers and verifies removal when a guard config is provided', async () => {
      const invocationCallOrder: string[] = [];
      mockedGuardResultProxy.captureGuardSnapshotPair.mockImplementation(async () => {
        invocationCallOrder.push('captureGuardSnapshotPair');
        return null;
      });
      mockedDockerManager.stopContainers.mockImplementation(async () => {
        invocationCallOrder.push('stopContainers');
      });
      mockedGuardResultProxy.areGuardContainersRemoved.mockImplementation(async () => {
        invocationCallOrder.push('areGuardContainersRemoved');
        return true;
      });

      const performCleanup = testHelpers.buildCleanupFn(
        { ...MAIN_ACTION_STUB_CONFIG, enableApiProxy: true },
        () => true,
        () => true,
        undefined,
        {
          fd: 42,
          invocationId: 'inv-1',
          apiProxyEnabled: true,
          getAgentExitCode: () => 1,
        },
      );

      await performCleanup();

      expect(invocationCallOrder).toEqual([
        'captureGuardSnapshotPair',
        'stopContainers',
        'areGuardContainersRemoved',
      ]);
    });

    it('skips snapshot capture when the API proxy is not enabled', async () => {
      const performCleanup = testHelpers.buildCleanupFn(
        { ...MAIN_ACTION_STUB_CONFIG, enableApiProxy: false },
        () => true,
        () => true,
        undefined,
        {
          fd: 42,
          invocationId: 'inv-1',
          apiProxyEnabled: false,
          getAgentExitCode: () => 1,
        },
      );

      await performCleanup();

      expect(mockedGuardResultProxy.captureGuardSnapshotPair).not.toHaveBeenCalled();
    });

    it('treats containers as not removed when --keep-containers is set', async () => {
      const performCleanup = testHelpers.buildCleanupFn(
        { ...MAIN_ACTION_STUB_CONFIG, keepContainers: true, enableApiProxy: true },
        () => true,
        () => true,
        undefined,
        {
          fd: 42,
          invocationId: 'inv-1',
          apiProxyEnabled: true,
          getAgentExitCode: () => 1,
        },
      );

      await performCleanup();

      // stopContainers isn't reached with keepContainers on this stub, but the
      // guard result path still runs and must not claim removal was verified.
      expect(mockedGuardResultProxy.areGuardContainersRemoved).not.toHaveBeenCalled();
    });
  });
});
