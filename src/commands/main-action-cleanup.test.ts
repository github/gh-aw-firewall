import { mainActionFsMocks } from './main-action-fs-mock.test-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./main-action-fs-mock.test-utils').mainActionFsMockFactory());

import { createMainAction, testHelpers } from './main-action';
import { buildCleanupFn } from './main-action-cleanup';

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
import * as enclaveManager from '../enclave/manager';
import { captureEnclaveStartupDiagnostics } from '../enclave/startup-diagnostics';
import * as enclaveGithubGateway from '../enclave/github-gateway';
import * as enclaveHostLifecycle from '../enclave/cloud-hypervisor-lifecycle';
import * as dockerHostLifecycle from '../enclave/docker-lifecycle';
import * as dynamicDelegation from '../enclave/dynamic-delegation';
import * as externalRuntimeResolver from '../external-runtime-backend-resolver';
import { MAIN_ACTION_STUB_CONFIG, setupMainActionTestHarness } from './main-action.test-utils';
import type { WrapperConfig } from '../types';
import { RoutingFailureExitError } from '../routing/bootstrap';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';

const {
  writeFileSync: mockWriteFileSync,
  openSync: mockOpenSync,
  fchmodSync: mockFchmodSync,
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
const mockedEnclaveGithubGateway =
  enclaveGithubGateway as jest.Mocked<typeof enclaveGithubGateway>;
const mockedExternalRuntimeResolver = externalRuntimeResolver as jest.Mocked<typeof externalRuntimeResolver>;
const mockedEnclaveHostLifecycle = enclaveHostLifecycle as jest.Mocked<typeof enclaveHostLifecycle>;
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
        runtime: 'cloud-hypervisor',
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
    it.each([false, true])('drains Docker host executions before broker/network teardown (keep=%s)', async (keepContainers) => {
      const cleanup = testHelpers.buildCleanupFn(
        { ...MAIN_ACTION_STUB_CONFIG, keepContainers }, () => true, () => false,
      );
      await cleanup('SIGTERM');
      expect(jest.mocked(dockerHostLifecycle.closeDockerEnclaveAdmissions).mock.invocationCallOrder[0])
        .toBeLessThan(jest.mocked(dockerHostLifecycle.stopDockerEnclaveLifecycle).mock.invocationCallOrder[0]);
      expect(jest.mocked(dockerHostLifecycle.stopDockerEnclaveLifecycle).mock.invocationCallOrder[0])
        .toBeLessThan(mockedEnclaveGateway.shutdownEnclaveGateway.mock.invocationCallOrder[0]);
      expect(jest.mocked(dockerHostLifecycle.stopDockerEnclaveLifecycle).mock.invocationCallOrder[0])
        .toBeLessThan(mockedDockerManager.stopContainers.mock.invocationCallOrder[0]);
    });

    it('retains seeds and infrastructure when Docker host cleanup is uncertain', async () => {
      jest.mocked(dockerHostLifecycle.stopDockerEnclaveLifecycle)
        .mockRejectedValueOnce(new Error('Docker recovery pending'));
      const cleanup = testHelpers.buildCleanupFn(
        { ...MAIN_ACTION_STUB_CONFIG }, () => true, () => false,
      );
      await expect(cleanup()).rejects.toThrow('Docker recovery pending');
      expect(mockedEnclaveGateway.shutdownEnclaveGateway).not.toHaveBeenCalled();
      expect(mockedDockerManager.stopContainers).not.toHaveBeenCalled();
      expect(mockedDockerManager.cleanup).not.toHaveBeenCalled();
    });

    it('sweeps delegated identities after Docker drain failure and preserves the Docker error', async () => {
      const dockerError = new Error('Docker recovery pending');
      jest.mocked(dockerHostLifecycle.isDockerEnclaveSelected).mockReturnValueOnce(true);
      jest.mocked(dockerHostLifecycle.stopDockerEnclaveLifecycle).mockRejectedValueOnce(dockerError);
      const cleanup = testHelpers.buildCleanupFn(
        { ...MAIN_ACTION_STUB_CONFIG }, () => false, () => false,
      );
      await expect(cleanup()).rejects.toBe(dockerError);
      expect(dynamicDelegation.stopEnclaveDynamicDelegation).toHaveBeenCalledTimes(1);
      expect(mockedEnclaveGateway.shutdownEnclaveGateway).not.toHaveBeenCalled();
      expect(mockedDockerManager.stopContainers).not.toHaveBeenCalled();
      expect(mockedDockerManager.cleanup).not.toHaveBeenCalled();
    });

    it.each([false, true])('drains Docker before delegation shutdown and preserves failed revocation (containers started=%s)', async (containersStarted) => {
      jest.mocked(dockerHostLifecycle.isDockerEnclaveSelected).mockReturnValueOnce(true);
      jest.mocked(dynamicDelegation.stopEnclaveDynamicDelegation)
        .mockRejectedValueOnce(new Error('delegation revocation pending'));
      const cleanup = testHelpers.buildCleanupFn(
        { ...MAIN_ACTION_STUB_CONFIG }, () => containersStarted, () => false,
      );
      await expect(cleanup()).rejects.toThrow('delegation revocation pending');
      expect(jest.mocked(dockerHostLifecycle.stopDockerEnclaveLifecycle).mock.invocationCallOrder[0])
        .toBeLessThan(jest.mocked(dynamicDelegation.stopEnclaveDynamicDelegation).mock.invocationCallOrder[0]);
      expect(mockedEnclaveGateway.shutdownEnclaveGateway).not.toHaveBeenCalled();
      expect(mockedEnclaveGithubGateway.disconnectEnclaveGithubGateway).not.toHaveBeenCalled();
      expect(mockedDockerManager.stopContainers).not.toHaveBeenCalled();
      expect(mockedDockerManager.cleanup).not.toHaveBeenCalled();
    });

    it('continues generic cleanup and then rethrows the runtime failure', async () => {
      const runtimeError = new Error('External runtime teardown failed');
      const backend = {
        runtime: 'cloud-hypervisor',
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

    describe('Cloud Hypervisor enclave cleanup ordering', () => {
      it('preserves supporting infrastructure and private state when primary VM cleanup fails', async () => {
        const failure = new Error('primary VMM cleanup uncertain');
        const backend = {
          runtime: 'cloud-hypervisor',
          preflight: jest.fn(), start: jest.fn(), exec: jest.fn(),
          collectDiagnostics: jest.fn(), stop: jest.fn().mockRejectedValue(failure),
        };
        const cleanup = testHelpers.buildCleanupFn(
          {
            ...MAIN_ACTION_STUB_CONFIG, containerRuntime: 'cloud-hypervisor',
            enclaves: { enabled: true },
          } as WrapperConfig,
          () => true, () => false, backend,
        );
        await expect(cleanup('SIGTERM')).rejects.toBe(failure);
        expect(mockedEnclaveHostLifecycle.closeCloudHypervisorEnclaveAdmissions)
          .toHaveBeenCalled();
        expect(mockedEnclaveHostLifecycle.stopCloudHypervisorEnclaveLifecycle)
          .toHaveBeenCalled();
        expect(mockedEnclaveGithubGateway.disconnectEnclaveGithubGateway).not.toHaveBeenCalled();
        expect(mockedDockerManager.stopContainers).not.toHaveBeenCalled();
        expect(mockedDockerManager.cleanup).not.toHaveBeenCalled();
      });

      it('closes host admissions before broker shutdown on the shared cleanup path', async () => {
        const cleanup = testHelpers.buildCleanupFn(
          { ...MAIN_ACTION_STUB_CONFIG }, () => true, () => false,
        );
        await cleanup('SIGTERM');
        expect(mockedEnclaveHostLifecycle.closeCloudHypervisorEnclaveAdmissions)
          .toHaveBeenCalledWith(expect.objectContaining({ workDir: MAIN_ACTION_STUB_CONFIG.workDir }));
        expect(mockedEnclaveHostLifecycle.closeCloudHypervisorEnclaveAdmissions.mock.invocationCallOrder[0])
          .toBeLessThan(mockedEnclaveGateway.shutdownEnclaveGateway.mock.invocationCallOrder[0]);
        expect(mockedEnclaveGateway.shutdownEnclaveGateway.mock.invocationCallOrder[0])
          .toBeLessThan(mockedEnclaveHostLifecycle.stopCloudHypervisorEnclaveLifecycle.mock.invocationCallOrder[0]);
        expect(mockedEnclaveHostLifecycle.stopCloudHypervisorEnclaveLifecycle.mock.invocationCallOrder[0])
          .toBeLessThan(mockedDockerManager.stopContainers.mock.invocationCallOrder[0]);
      });

      it('closes the host backend before propagating container teardown failure', async () => {
        const failure = new Error('compose down failed');
        mockedDockerManager.stopContainers.mockRejectedValueOnce(failure);
        const cleanup = testHelpers.buildCleanupFn(
          { ...MAIN_ACTION_STUB_CONFIG }, () => true, () => false,
        );
        await expect(cleanup()).rejects.toBe(failure);
        expect(mockedEnclaveHostLifecycle.stopCloudHypervisorEnclaveLifecycle).toHaveBeenCalledTimes(1);
        expect(mockedEnclaveHostLifecycle.stopCloudHypervisorEnclaveLifecycle.mock.invocationCallOrder[0])
          .toBeLessThan(mockedDockerManager.stopContainers.mock.invocationCallOrder[0]);
        expect(mockedDockerManager.cleanup).not.toHaveBeenCalled();
      });

      it('closes the host backend when broker draining fails, before disconnecting its data plane', async () => {
        mockedEnclaveGateway.shutdownEnclaveGateway.mockRejectedValueOnce(new Error('broker shutdown failed'));
        const cleanup = testHelpers.buildCleanupFn(
          { ...MAIN_ACTION_STUB_CONFIG }, () => true, () => false,
        );
        await cleanup();
        expect(mockedEnclaveHostLifecycle.stopCloudHypervisorEnclaveLifecycle).toHaveBeenCalledTimes(1);
        expect(mockedEnclaveHostLifecycle.stopCloudHypervisorEnclaveLifecycle.mock.invocationCallOrder[0])
          .toBeLessThan(mockedEnclaveGithubGateway.disconnectEnclaveGithubGateway.mock.invocationCallOrder[0]);
      });

      it('closes the host backend before propagating audit-preservation failure', async () => {
        const failure = new Error('audit preservation failed');
        mockedDockerManager.preserveIptablesAudit.mockImplementationOnce(() => { throw failure; });
        const cleanup = testHelpers.buildCleanupFn(
          { ...MAIN_ACTION_STUB_CONFIG }, () => true, () => false,
        );
        await expect(cleanup()).rejects.toBe(failure);
        expect(mockedEnclaveHostLifecycle.stopCloudHypervisorEnclaveLifecycle).toHaveBeenCalledTimes(1);
        expect(mockedDockerManager.stopContainers).not.toHaveBeenCalled();
        expect(mockedDockerManager.cleanup).not.toHaveBeenCalled();
      });

      it('does not delete generic work state when host backend cleanup is uncertain', async () => {
        mockedEnclaveHostLifecycle.stopCloudHypervisorEnclaveLifecycle
          .mockRejectedValueOnce(new Error('host cleanup uncertain'));
        const cleanup = testHelpers.buildCleanupFn(
          { ...MAIN_ACTION_STUB_CONFIG, enclaves: { enabled: true } } as WrapperConfig,
          () => true, () => false,
        );
        await expect(cleanup()).rejects.toThrow('host cleanup uncertain');
        expect(mockedDockerManager.stopContainers).not.toHaveBeenCalled();
        expect(mockedEnclaveGithubGateway.disconnectEnclaveGithubGateway).not.toHaveBeenCalled();
        expect(mockedDockerManager.cleanup).not.toHaveBeenCalled();
      });
    });
  });

  describe('external runtime diagnostics', () => {
    it('aggregates backend and Docker diagnostics with explicit failures', async () => {
      const backend = {
        runtime: 'cloud-hypervisor',
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
    it('preserves the routing exit code through an infrastructure readiness error', async () => {
      const routingFailure = new RoutingFailureExitError('Model routing selection timed out');
      const readinessFailure = Object.assign(
        new Error('Model routing selection timed out'),
        { cause: routingFailure },
      );
      mockedCliWorkflow.runMainWorkflow.mockRejectedValueOnce(readinessFailure);

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(processExitSpy).toHaveBeenCalledWith(78);
    });

    it('does not repeat cleanup and keeps exit 78 when routing fails after the workflow cleaned up', async () => {
      mockedCliWorkflow.runMainWorkflow.mockImplementation(
        async (_config, _deps, callbacks) => {
          callbacks.onContainersStarted?.();
          await callbacks.performCleanup();
          throw new RoutingFailureExitError('Model routing failed (provider_unavailable): Routed execution failed');
        }
      );
      mockedDockerManager.stopContainers.mockResolvedValue(undefined);
      mockedDockerManager.cleanup.mockResolvedValue(undefined);

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedDockerManager.stopContainers).toHaveBeenCalledTimes(1);
      expect(processExitSpy).toHaveBeenCalledWith(78);
    });

    it('keeps exit 78 when cleanup after a routing failure throws', async () => {
      mockedCliWorkflow.runMainWorkflow.mockImplementation(
        async (_config, _deps, callbacks) => {
          callbacks.onContainersStarted?.();
          throw new RoutingFailureExitError('Model routing selection timed out');
        }
      );
      mockedDockerManager.stopContainers.mockRejectedValueOnce(new Error('spawn docker ENOENT'));

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedLogger.warn).toHaveBeenCalledWith('Cleanup after a fatal error failed.', expect.any(Error));
      expect(processExitSpy).toHaveBeenCalledWith(78);
    });

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

  describe('extracted helper functions', () => {
    it('buildCleanupFn runs cleanup using provided state getters', async () => {
      const performCleanup = buildCleanupFn(
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
      expect(mockedEnclaveGithubGateway.disconnectEnclaveGithubGateway)
        .toHaveBeenCalledWith(MAIN_ACTION_STUB_CONFIG);
      expect(
        mockedDockerManager.preserveIptablesAudit.mock.invocationCallOrder[0]
      ).toBeLessThan(
        mockedEnclaveGithubGateway.disconnectEnclaveGithubGateway.mock.invocationCallOrder[0]
      );
      expect(
        mockedEnclaveGithubGateway.disconnectEnclaveGithubGateway.mock.invocationCallOrder[0]
      ).toBeLessThan(
        mockedDockerManager.stopContainers.mock.invocationCallOrder[0]
      );
      expect(mockedDockerManager.stopContainers).toHaveBeenCalledWith(
        MAIN_ACTION_STUB_CONFIG.workDir,
        MAIN_ACTION_STUB_CONFIG.keepContainers,
        { routerLogsDir: undefined },
      );
      expect(mockedHostIptables.cleanupHostIptables).toHaveBeenCalled();
      expect(mockedDockerManager.cleanup).toHaveBeenCalled();
    });

    it.each([
      ['the work directory', undefined, '/synthetic/awf-test/router-logs'],
      ['proxyLogsDir', '/tmp/custom-logs', '/tmp/custom-logs/router-logs'],
    ])('buildCleanupFn saves the router logs under %s when the run has a router', async (
      _where, proxyLogsDir, routerLogsDir,
    ) => {
      const config = {
        ...MAIN_ACTION_STUB_CONFIG,
        proxyLogsDir,
        experimentalModelRouting: true,
        modelRouting: { objective: { goal: 'cost', mode: 'balanced' }, task: { conversationFile: '/c.json' } },
        modelRoutingBootstrap: { root: '/synthetic/routing' },
      } as unknown as import('../types').WrapperConfig;

      await testHelpers.buildCleanupFn(config, () => true, () => true)();

      expect(mockedDockerManager.stopContainers).toHaveBeenCalledWith(
        config.workDir, false, { routerLogsDir },
      );
    });

    it('buildCleanupFn tears down only once across repeated calls', async () => {
      const performCleanup = buildCleanupFn(
        MAIN_ACTION_STUB_CONFIG,
        () => true,
        () => true,
      );

      await Promise.all([performCleanup(), performCleanup('SIGTERM')]);
      await performCleanup();

      expect(mockedDockerManager.stopContainers).toHaveBeenCalledTimes(1);
      expect(mockedHostIptables.cleanupHostIptables).toHaveBeenCalledTimes(1);
      expect(mockedDockerManager.cleanup).toHaveBeenCalledTimes(1);
    });

    it('preserves audits after an enclave drain failure', async () => {
      mockedEnclaveGateway.shutdownEnclaveGateway.mockRejectedValueOnce(
        new Error('drain failed: Bearer SECRET repository seed')
      );
      const config = {
        ...MAIN_ACTION_STUB_CONFIG,
        enclaves: normalizeEnclavesConfig([
          { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
        ]),
      };
      const performCleanup = testHelpers.buildCleanupFn(
        config,
        () => true,
        () => false,
      );

      await performCleanup();

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        'Enclave gateway did not complete graceful shutdown; preserved enclave audit is marked incomplete.',
      );
      expect(JSON.stringify(mockedLogger.warn.mock.calls)).not.toContain('SECRET');
      expect(captureEnclaveStartupDiagnostics).toHaveBeenCalledWith(
        config.workDir, config.proxyLogsDir, 'shutdown-failure',
      );
      expect(jest.mocked(captureEnclaveStartupDiagnostics).mock.invocationCallOrder[0])
        .toBeLessThan(mockedDockerManager.stopContainers.mock.invocationCallOrder[0]);
      expect(mockedDockerManager.preserveIptablesAudit).toHaveBeenCalled();
      expect(mockedDockerManager.stopContainers).toHaveBeenCalled();
    });

    it('marks the protected audit incomplete when preservation fails', async () => {
      mockedDockerManager.preserveIptablesAudit.mockReturnValueOnce(false);
      const config = {
        ...MAIN_ACTION_STUB_CONFIG,
        enclaves: {
          enabled: true,
          executors: {
            script: { enabled: false },
            agent: {
              enabled: true,
              github: { cli: 'issues-read-v1' },
            },
          },
        },
      } as unknown as import('../types').WrapperConfig;
      const performCleanup = testHelpers.buildCleanupFn(
        config,
        () => true,
        () => false,
      );

      await performCleanup();

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        'One or more protected enclave audit artifacts could not be preserved.'
      );
      expect(mockOpenSync).toHaveBeenCalledWith(
        expect.stringContaining('enclave-audit-incomplete.txt'),
        expect.any(Number),
        0o600,
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        42,
        expect.stringContaining('protected audit preservation'),
        { encoding: 'utf8' },
      );
      expect(mockFchmodSync).toHaveBeenLastCalledWith(42, 0o644);
    });

    it('warns when the incomplete audit marker cannot be written', async () => {
      mockedDockerManager.preserveIptablesAudit.mockReturnValueOnce(false);
      mockOpenSync.mockImplementationOnce(() => {
        throw new Error('marker write failed');
      });
      const config = {
        ...MAIN_ACTION_STUB_CONFIG,
        enclaves: {
          enabled: true,
          executors: {
            script: { enabled: false },
            agent: {
              enabled: true,
              github: { cli: 'issues-read-v1' },
            },
          },
        },
      } as unknown as import('../types').WrapperConfig;
      const performCleanup = testHelpers.buildCleanupFn(
        config,
        () => true,
        () => false,
      );

      await performCleanup();

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        'Failed to write the incomplete enclave audit marker.',
        expect.objectContaining({ message: 'marker write failed' }),
      );
      expect(mockedDockerManager.stopContainers).toHaveBeenCalled();
    });
  });
});
