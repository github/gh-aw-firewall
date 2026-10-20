import {
  startHostExecutorServer,
  type HostEnclaveExecutorBackend,
  type HostExecutorRunState,
  type HostExecutorServer,
} from './host-executor-server';

export interface HostExecutorServiceOptions {
  readonly runtimeDir: string;
  readonly runState: HostExecutorRunState;
  /** Includes backend-specific recovery and acceptance checks before listener publication. */
  readonly createBackend: () => Promise<HostEnclaveExecutorBackend>;
  readonly onListening?: () => void;
  readonly startupFailureMessage: string;
}

/**
 * Readiness here means authenticated host-service readiness, not a persistent
 * workload instance. Backends may execute atomically or own a container lifecycle.
 */
export async function startHostExecutorService(
  options: HostExecutorServiceOptions,
): Promise<HostExecutorServer> {
  const backend = await options.createBackend();
  try {
    options.onListening?.();
    return await startHostExecutorServer({
      runtimeDir: options.runtimeDir,
      runState: options.runState,
      backend,
    });
  } catch {
    await backend.close?.().catch(() => undefined);
    throw new Error(options.startupFailureMessage);
  }
}
