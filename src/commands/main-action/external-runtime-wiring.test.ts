import { createWorkflowDependencies, registerRuntimeSignalHandlers } from './external-runtime-wiring';
import { MAIN_ACTION_STUB_CONFIG } from '../main-action.test-utils';
import type { MainActionLifecycleState } from './exit-handling';
import type { ExternalAgentRuntimeBackend } from '../../external-runtime-backend';
import type { ProtectedCommandOutputCapture } from '../../protected-command-output-capture';
import { runAgentCommand, collectDiagnosticLogs, fastKillAgentContainer, startContainers } from '../../docker-manager';
import { createDockerHarnessObservation } from '../../docker-harness-observation';
import { prepareEnclaves } from '../../enclave/manager';
import { registerSignalHandlers } from '../signal-handler';
import { emitStartupExitMarker } from '../main-action-startup-diagnostics';

jest.mock('../../docker-manager');
jest.mock('../../docker-harness-observation');
jest.mock('../../harness-observation');
jest.mock('../../enclave/manager');
jest.mock('../signal-handler');
jest.mock('../main-action-startup-diagnostics');

describe('main action runtime wiring', () => {
  let state: MainActionLifecycleState;
  let config: typeof MAIN_ACTION_STUB_CONFIG;

  beforeEach(() => {
    jest.resetAllMocks();
    config = { ...MAIN_ACTION_STUB_CONFIG };
    state = {
      exitCode: 0,
      containersStarted: false,
      agentCommandStarted: false,
      hostIptablesSetup: false,
      cloudHypervisorPrimaryPreflightPassed: false,
      performCleanup: jest.fn().mockResolvedValue(undefined),
      startupExitState: { startedAt: 0, lastProgressWrite: 'not-attempted', progressWriteFailures: 0 },
    };
  });

  function addBackend(): ExternalAgentRuntimeBackend {
    const backend: ExternalAgentRuntimeBackend = {
      runtime: 'cloud-hypervisor',
      preflight: jest.fn().mockResolvedValue(undefined),
      start: jest.fn().mockResolvedValue(undefined),
      exec: jest.fn().mockResolvedValue({ exitCode: 0 }),
      collectDiagnostics: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    };
    state.externalRuntimeBackend = backend;
    return backend;
  }

  it('selects Docker harness dependencies and preserves optional capture arguments', async () => {
    const probeHarness = jest.fn();
    const releaseHarness = jest.fn();
    jest.mocked(createDockerHarnessObservation).mockReturnValue({ probeHarness, releaseHarness });
    jest.mocked(runAgentCommand).mockResolvedValue({ exitCode: 0, blockedDomains: [] });
    const dependencies = createWorkflowDependencies(config, state);
    expect(dependencies.probeHarness).toBe(probeHarness);
    expect(dependencies.releaseHarness).toBe(releaseHarness);
    expect(dependencies.startContainers).toBe(startContainers);
    await dependencies.runAgentCommand(config.workDir, config.allowedDomains);
    expect(runAgentCommand).toHaveBeenLastCalledWith(
      config.workDir, config.allowedDomains, undefined, undefined, config.containerRuntime,
    );
    const capture = {} as ProtectedCommandOutputCapture;
    await dependencies.runAgentCommand(config.workDir, config.allowedDomains, '/logs', 3, capture);
    expect(runAgentCommand).toHaveBeenLastCalledWith(
      config.workDir, config.allowedDomains, '/logs', 3, config.containerRuntime, capture,
    );
  });

  it('binds the external backend and tracks command start before execution and a nonzero marker', async () => {
    const backend = addBackend();
    jest.mocked(backend.exec).mockImplementation(async function (this: ExternalAgentRuntimeBackend) {
      expect(this).toBe(backend);
      expect(state.agentCommandStarted).toBe(true);
      return { exitCode: 7 };
    });
    const dependencies = createWorkflowDependencies(config, state);
    state.containersStarted = true;
    expect(createDockerHarnessObservation).not.toHaveBeenCalled();
    expect(dependencies.releaseHarness).toBeUndefined();
    await dependencies.runAgentCommand(config.workDir, config.allowedDomains);
    expect(backend.exec).toHaveBeenCalledWith(config.workDir, config.allowedDomains, undefined, undefined);
    expect(emitStartupExitMarker).toHaveBeenCalledWith(config, state.startupExitState, expect.objectContaining({
      exitCode: 7, agentStarted: true, containersStarted: true, cleanup: 'pending',
    }));
  });

  it('attempts both diagnostic collectors and aggregates their failures', async () => {
    const backend = addBackend();
    jest.mocked(backend.collectDiagnostics).mockRejectedValue(new Error('runtime diagnostics'));
    jest.mocked(collectDiagnosticLogs).mockRejectedValue('compose diagnostics');
    const dependencies = createWorkflowDependencies(config, state);
    await expect(dependencies.collectDiagnosticLogs!(config.workDir))
      .rejects.toThrow('runtime diagnostics; compose diagnostics');
    expect(backend.collectDiagnostics).toHaveBeenCalledTimes(1);
    expect(collectDiagnosticLogs).toHaveBeenCalledWith(config.workDir);
  });

  it('requires same-run primary preflight evidence before enclave preparation', async () => {
    addBackend();
    config.containerRuntime = 'cloud-hypervisor';
    config.enclaves = { enabled: true } as NonNullable<typeof config.enclaves>;
    jest.mocked(prepareEnclaves).mockImplementation(async (candidate, dependencies) => {
      await dependencies!.assertCloudHypervisorPrimaryPreflight!(candidate);
    });
    const dependencies = createWorkflowDependencies(config, state);
    await expect(dependencies.prepareEnclaves!({ ...config })).rejects.toThrow('preflight evidence');
    await expect(dependencies.prepareEnclaves!(config)).rejects.toThrow('preflight evidence');
    state.cloudHypervisorPrimaryPreflightPassed = true;
    await expect(dependencies.prepareEnclaves!(config)).resolves.toBeUndefined();
    state.externalRuntimeBackend = undefined;
    await expect(dependencies.prepareEnclaves!(config)).rejects.toThrow('preflight evidence');
  });

  it('reads the effective runtime and cleanup at signal time after fallback', async () => {
    const backend = addBackend();
    registerRuntimeSignalHandlers(config, state);
    const signals = jest.mocked(registerSignalHandlers).mock.calls[0][0];
    state.externalRuntimeBackend = undefined;
    state.containersStarted = true;
    const cleanup = jest.fn().mockResolvedValue(undefined);
    state.performCleanup = cleanup;
    expect(signals.getContainersStarted()).toBe(true);
    await signals.fastKillAgentContainer();
    await signals.performCleanup('SIGTERM');
    expect(backend.stop).not.toHaveBeenCalled();
    expect(fastKillAgentContainer).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith('SIGTERM');
  });
});
