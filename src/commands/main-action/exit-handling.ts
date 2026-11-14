import { logger } from '../../logger';
import type { WrapperConfig } from '../../types';
import type { ExternalAgentRuntimeBackend } from '../../external-runtime-backend';
import type { ProtectedCommandOutputCapture } from '../../protected-command-output-capture';
import { cleanupRoutingState, RoutingFailureExitError } from '../../routing/bootstrap';
import {
  emitStartupExitMarker,
  writeStartupFailureDiagnostic,
  type StartupDiagnosticWriteOutcome,
  type StartupDiagnosticWriteReason,
  type StartupExitState,
} from '../main-action-startup-diagnostics';

/** Mutable lifecycle state owned by the action; callbacks read it at invocation time. */
export interface MainActionLifecycleState {
  exitCode: number;
  containersStarted: boolean;
  agentCommandStarted: boolean;
  hostIptablesSetup: boolean;
  externalRuntimeBackend?: ExternalAgentRuntimeBackend;
  commandOutputCapture?: ProtectedCommandOutputCapture;
  cloudHypervisorPrimaryPreflightPassed: boolean;
  performCleanup: (signal?: string) => Promise<void>;
  startupExitState: StartupExitState;
}

function findRoutingFailure(error: unknown): RoutingFailureExitError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof RoutingFailureExitError) return current;
    seen.add(current);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return undefined;
}

export function emitWorkflowExitMarker(
  config: WrapperConfig,
  state: MainActionLifecycleState,
  exitCode: number,
  cleanup: 'pending' | 'completed',
): void {
  if (exitCode !== 0) {
    emitStartupExitMarker(config, state.startupExitState, {
      path: 'workflow-return', exitCode, containersStarted: state.containersStarted,
      agentStarted: state.agentCommandStarted, recordWrite: 'not-attempted', cleanup,
    });
  }
}

export function handleWorkflowExit(config: WrapperConfig, state: MainActionLifecycleState): void {
  emitWorkflowExitMarker(config, state, state.exitCode, 'completed');
  state.commandOutputCapture?.close();
  console.error(`Process exiting with code: ${state.exitCode}`);
  process.exit(state.exitCode);
}

export async function handleFatalExit(
  config: WrapperConfig,
  state: MainActionLifecycleState,
  error: unknown,
): Promise<void> {
  logger.error('Fatal error:', error);
  let recordWriteReason: StartupDiagnosticWriteReason | null = null;
  const recordWrite: StartupDiagnosticWriteOutcome = state.agentCommandStarted
    ? 'not-attempted'
    : writeStartupFailureDiagnostic(config, error, 'startup', reason => { recordWriteReason = reason; });
  const plannedExitCode = findRoutingFailure(error)?.exitCode ?? 1;
  const exitMarker = {
    path: 'fatal' as const, exitCode: plannedExitCode, containersStarted: state.containersStarted,
    agentStarted: state.agentCommandStarted, recordWrite, recordWriteReason,
  };
  // Emit before cleanup too, so a hung or crashing teardown still leaves evidence.
  emitStartupExitMarker(config, state.startupExitState, { ...exitMarker, cleanup: 'pending' });
  let cleanupOutcome: 'completed' | 'failed' = 'completed';
  try {
    await state.performCleanup();
  } catch (cleanupError) {
    cleanupOutcome = 'failed';
    logger.warn('Cleanup after a fatal error failed.', cleanupError);
  }
  if (state.commandOutputCapture) {
    state.commandOutputCapture.finishCommand(undefined, 'failed');
    state.commandOutputCapture.setTeardown(cleanupOutcome === 'completed' ? 'complete' : 'failed');
    state.commandOutputCapture.close();
  }
  emitStartupExitMarker(config, state.startupExitState, { ...exitMarker, cleanup: cleanupOutcome });
  cleanupRoutingState(config);
  const fatalExitCode = findRoutingFailure(error)?.exitCode ?? 1;
  console.error(`Process exiting with code: ${fatalExitCode}`);
  process.exit(fatalExitCode);
}
