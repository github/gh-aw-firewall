import type { WorkflowDependencies } from './cli-workflow';

/**
 * Lifecycle contract for agent runtimes managed outside Docker Compose.
 *
 * Infrastructure services remain owned by the existing compose implementation;
 * the backend owns the external agent's preflight, startup, execution,
 * diagnostics, and teardown state.
 */
export interface ExternalAgentRuntimeBackend {
  readonly runtime: string;
  preflight(): Promise<void>;
  start: WorkflowDependencies['startContainers'];
  exec: WorkflowDependencies['runAgentCommand'];
  collectDiagnostics(): Promise<void>;
  stop(): Promise<void>;
  /** Safely quiesces the runtime while retaining inspectable state. */
  preserve?(): Promise<void>;
}

type ExternalRuntimeWorkflowDependencies = Pick<
  WorkflowDependencies,
  'startContainers' | 'runAgentCommand'
>;

/**
 * Adapts an external backend to the existing workflow dependency seam.
 */
export function adaptExternalRuntimeBackend(
  backend: ExternalAgentRuntimeBackend,
): ExternalRuntimeWorkflowDependencies {
  return {
    startContainers: backend.start.bind(backend),
    runAgentCommand: backend.exec.bind(backend),
  };
}
