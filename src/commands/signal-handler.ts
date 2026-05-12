/**
 * Dependencies injected into {@link registerSignalHandlers}.
 */
export interface SignalHandlerDependencies {
  /** Returns whether containers have been started; read at signal time. */
  getContainersStarted: () => boolean;
  /** Whether to preserve containers on exit (--keep-containers flag). */
  keepContainers: boolean;
  /** Fast-kills the agent container before the slower compose-down cleanup. */
  fastKillAgentContainer: () => Promise<void>;
  /** Runs the full cleanup sequence (stop containers, remove host iptables rules, etc.). */
  performCleanup: (signal?: string) => Promise<void>;
}

/**
 * Registers SIGINT and SIGTERM handlers for graceful shutdown.
 *
 * The agent container is fast-killed immediately so it cannot outlive the
 * `awf` process. GitHub Actions sends SIGTERM then SIGKILL ~10 s later;
 * the full `docker compose down` in `performCleanup` is too slow to finish
 * in that window and would leave the container running as an orphan.
 */
/* istanbul ignore next -- signal handlers cannot be unit-tested */
export function registerSignalHandlers({
  getContainersStarted,
  keepContainers,
  fastKillAgentContainer,
  performCleanup,
}: SignalHandlerDependencies): void {
  process.on('SIGINT', async () => {
    if (getContainersStarted() && !keepContainers) {
      await fastKillAgentContainer();
    }
    await performCleanup('SIGINT');
    console.error(`Process exiting with code: 130`);
    process.exit(130); // Standard exit code for SIGINT
  });

  process.on('SIGTERM', async () => {
    if (getContainersStarted() && !keepContainers) {
      await fastKillAgentContainer();
    }
    await performCleanup('SIGTERM');
    console.error(`Process exiting with code: 143`);
    process.exit(143); // Standard exit code for SIGTERM
  });
}
