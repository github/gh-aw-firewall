import { handleFatalExit, handleWorkflowExit, type MainActionLifecycleState } from './exit-handling';
import { MAIN_ACTION_STUB_CONFIG } from '../main-action.test-utils';
import { emitStartupExitMarker, writeStartupFailureDiagnostic } from '../main-action-startup-diagnostics';
import { cleanupRoutingState, RoutingFailureExitError } from '../../routing/bootstrap';
import type { ProtectedCommandOutputCapture } from '../../protected-command-output-capture';

jest.mock('../main-action-startup-diagnostics');
jest.mock('../../routing/bootstrap', () => ({
  ...jest.requireActual('../../routing/bootstrap'),
  cleanupRoutingState: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../../logger', () => require('../../test-helpers/mock-logger.test-utils').loggerMockFactory());

describe('main action exit handling', () => {
  let state: MainActionLifecycleState;
  const config = { ...MAIN_ACTION_STUB_CONFIG };
  const markers = jest.mocked(emitStartupExitMarker);
  const diagnostic = jest.mocked(writeStartupFailureDiagnostic);
  const events: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    events.length = 0;
    state = {
      exitCode: 0,
      containersStarted: false,
      agentCommandStarted: false,
      hostIptablesSetup: false,
      cloudHypervisorPrimaryPreflightPassed: false,
      performCleanup: jest.fn(async () => { events.push('cleanup'); }),
      startupExitState: { startedAt: 0, lastProgressWrite: 'not-attempted', progressWriteFailures: 0 },
    };
    diagnostic.mockReturnValue('written');
    markers.mockImplementation((_config, _startup, marker) => { events.push(marker.cleanup); });
    jest.mocked(cleanupRoutingState).mockImplementation(() => { events.push('routing'); });
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(process, 'exit').mockImplementation(() => {
      events.push('exit');
      return undefined as never;
    });
  });

  afterEach(() => jest.restoreAllMocks());

  function addCapture(): void {
    state.commandOutputCapture = {
      finishCommand: jest.fn(() => { events.push('finish'); }),
      setTeardown: jest.fn(() => { events.push('teardown'); }),
      close: jest.fn(() => { events.push('close'); }),
    } as unknown as ProtectedCommandOutputCapture;
  }

  it('records startup failure before cleanup and closes capture before exiting', async () => {
    addCapture();
    const error = new Error('startup failed');
    await handleFatalExit(config, state, error);
    expect(diagnostic).toHaveBeenCalledWith(config, error, 'startup', expect.any(Function));
    expect(events).toEqual(['pending', 'cleanup', 'finish', 'teardown', 'close', 'completed', 'routing', 'exit']);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('does not overwrite startup evidence after the agent has started', async () => {
    state.agentCommandStarted = true;
    state.containersStarted = true;
    await handleFatalExit(config, state, new Error('command failed'));
    expect(diagnostic).not.toHaveBeenCalled();
    expect(markers).toHaveBeenLastCalledWith(config, state.startupExitState, expect.objectContaining({
      agentStarted: true, containersStarted: true, recordWrite: 'not-attempted',
    }));
  });

  it('preserves a nested routing exit code when cleanup fails', async () => {
    addCapture();
    state.performCleanup = jest.fn().mockRejectedValue(new Error('cleanup failed'));
    const error = Object.assign(new Error('wrapped'), { cause: new RoutingFailureExitError('routing failed') });
    await handleFatalExit(config, state, error);
    expect(markers).toHaveBeenLastCalledWith(config, state.startupExitState, expect.objectContaining({
      cleanup: 'failed', exitCode: 78,
    }));
    expect(state.commandOutputCapture?.setTeardown).toHaveBeenCalledWith('failed');
    expect(cleanupRoutingState).toHaveBeenCalledWith(config);
    expect(process.exit).toHaveBeenCalledWith(78);
  });

  it('terminates cause traversal for a cycle', async () => {
    const error = new Error('cyclic') as Error & { cause?: unknown };
    error.cause = error;
    await handleFatalExit(config, state, error);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('includes diagnostic write rejection in both fatal markers', async () => {
    diagnostic.mockImplementation((_config, _error, _phase, onRejected) => {
      onRejected?.('unsafe-symlink');
      return 'unsafe-target';
    });
    await handleFatalExit(config, state, new Error('startup failed'));
    for (const call of markers.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({
        recordWrite: 'unsafe-target', recordWriteReason: 'unsafe-symlink',
      }));
    }
  });

  it.each([0, 7])('closes capture and propagates workflow exit code %i without repeating cleanup', (exitCode) => {
    addCapture();
    state.exitCode = exitCode;
    handleWorkflowExit(config, state);
    expect(markers).toHaveBeenCalledTimes(exitCode === 0 ? 0 : 1);
    expect(state.performCleanup).not.toHaveBeenCalled();
    expect(events).toEqual(exitCode === 0 ? ['close', 'exit'] : ['completed', 'close', 'exit']);
    expect(process.exit).toHaveBeenCalledWith(exitCode);
  });
});
