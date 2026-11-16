import execa from 'execa';
import { logger } from './logger';
import { AGENT_CONTAINER_NAME } from './constants';
import { getLocalDockerEnv } from './docker-host';
import { isAgentExternallyKilled, markAgentExternallyKilled } from './container-lifecycle-state';
import { isGvisorRuntime } from './container-runtime';
import { reportSquidBlocks } from './squid-block-report';
import type { ProtectedCommandOutputCapture, CapturedOutputStream, CommandAttemptOutcome } from './protected-command-output-capture';
import { CredentialRedactingStream } from './credential-redactor';

const GVISOR_RETRYABLE_AGENT_EXIT_CODES = new Set([134, 139]);
const MAX_GVISOR_AGENT_RETRIES = 1;
// Containers that exit within this window are assumed to have crashed during
// Node/V8 initialisation (before any agent work began) and are safe to restart.
const GVISOR_STARTUP_CRASH_WINDOW_MS = 30_000;

interface AgentAttemptResult {
  exitCode: number;
  outcome: Exclude<CommandAttemptOutcome, 'running'>;
}

/**
 * Returns `true` when a container's measured runtime is short enough to
 * indicate a Node/V8 startup crash (i.e. no agent work was performed yet).
 * Uses `docker inspect` to obtain the container's start/finish timestamps.
 * Returns `false` conservatively when the timing cannot be determined.
 */
async function isGvisorStartupCrash(containerName: string): Promise<boolean> {
  try {
    const { stdout } = await execa(
      'docker',
      ['inspect', '--format', '{{.State.StartedAt}} {{.State.FinishedAt}}', containerName],
      { reject: false, env: getLocalDockerEnv() }
    );
    const parts = stdout.trim().split(' ');
    if (parts.length !== 2) return false;
    const runtimeMs = new Date(parts[1]).getTime() - new Date(parts[0]).getTime();
    return runtimeMs >= 0 && runtimeMs < GVISOR_STARTUP_CRASH_WINDOW_MS;
  } catch {
    // Cannot determine — do not retry
    return false;
  }
}

function streamAgentLogs(
  currentAttempt: number,
  commandOutputCapture?: ProtectedCommandOutputCapture,
  logsSince?: string,
): (result: AgentAttemptResult) => Promise<AgentAttemptResult> {
  // Stream logs in real-time using docker logs -f (follow mode)
  // Run this in the background and wait for the container to exit separately
  const logArgs = ['logs', ...(logsSince ? ['--since', logsSince] : []), '-f', AGENT_CONTAINER_NAME];
  commandOutputCapture?.beginAttempt(currentAttempt);
  const logsProcess = execa('docker', logArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: null,
    buffer: false,
    reject: false,
    env: getLocalDockerEnv(),
  });
  let credentialStopPromise: Promise<unknown> | undefined;
  const stopOnCredentialDisclosure = (): void => {
    if (credentialStopPromise) return;
    logger.error('Suspected credential disclosure detected in agent output; stopping the agent container');
    credentialStopPromise = execa(
      'docker',
      ['stop', '-t', '10', AGENT_CONTAINER_NAME],
      { reject: false, env: getLocalDockerEnv() },
    );
  };
  const redactOutput = (source: NodeJS.ReadableStream | null): NodeJS.ReadableStream | null =>
    source && typeof (source as { pipe?: unknown }).pipe === 'function'
      ? source.pipe(new CredentialRedactingStream(stopOnCredentialDisclosure))
      : null;
  let outputStreamFailed = false;
  const forwardOutput = (
    source: NodeJS.ReadableStream | null,
    destination: NodeJS.WriteStream,
    stream: CapturedOutputStream,
  ): Promise<void> => new Promise(resolve => {
    if (!source) {
      outputStreamFailed = true;
      resolve();
      return;
    }
    let destinationUnavailable = false;
    let sourceEnded = false;
    let pendingWrites = 0;
    let settled = false;
    const presentationFailures = new Set<'error' | 'closed' | 'backpressure'>();
    const cleanupDestinationListeners = (): void => {
      if (!sourceEnded || pendingWrites !== 0) return;
      destination.off('error', onDestinationError);
      destination.off('close', onDestinationClose);
    };
    const settle = (): void => {
      cleanupDestinationListeners();
      if (sourceEnded && (pendingWrites === 0 || destinationUnavailable) && !settled) {
        settled = true;
        resolve();
      }
    };
    const markDestinationUnavailable = (reason: 'error' | 'closed' | 'backpressure'): void => {
      if (presentationFailures.has(reason)) return;
      presentationFailures.add(reason);
      destinationUnavailable = true;
      commandOutputCapture?.recordPresentationFailure(stream, reason);
      settle();
    };
    const onDestinationError = (): void => markDestinationUnavailable('error');
    const onDestinationClose = (): void => {
      if (!destination.writableFinished) markDestinationUnavailable('closed');
    };
    destination.on('error', onDestinationError);
    destination.once('close', onDestinationClose);
    source.once('end', () => {
      sourceEnded = true;
      settle();
    });
    source.once('close', () => {
      if (!(source as NodeJS.ReadableStream & { readableEnded?: boolean }).readableEnded) {
        outputStreamFailed = true;
      }
      sourceEnded = true;
      settle();
    });
    source.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      commandOutputCapture?.recordOutput(currentAttempt, stream, chunk);
      if (destinationUnavailable) return;
      if (destination.destroyed || !destination.writable) {
        markDestinationUnavailable('closed');
        return;
      }
      try {
        pendingWrites++;
        const writeCompleted = (error?: Error | null): void => {
          if (error) markDestinationUnavailable('error');
          pendingWrites--;
          settle();
        };
        const canContinue = destination.write(chunk, writeCompleted);
        if (!canContinue && !destinationUnavailable) {
          markDestinationUnavailable('backpressure');
        }
      } catch {
        markDestinationUnavailable('error');
        pendingWrites = Math.max(0, pendingWrites - 1);
        settle();
      }
    });
    source.on('error', () => {
      outputStreamFailed = true;
      sourceEnded = true;
      settle();
    });
  });
  const outputDrainPromises = [
    forwardOutput(redactOutput(logsProcess.stdout), process.stdout, 'stdout'),
    forwardOutput(redactOutput(logsProcess.stderr), process.stderr, 'stderr'),
  ];
  return async ({ exitCode, outcome }) => {
    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    const drainResult = await Promise.race([
      Promise.all([logsProcess, ...outputDrainPromises]).then(([logsResult]) => ({
        completed: true as const,
        logsDrained: !outputStreamFailed && logsResult.exitCode === 0,
      })),
      new Promise<{ completed: false; logsDrained: false }>(resolve => {
        drainTimeout = setTimeout(() => resolve({ completed: false, logsDrained: false }), 5_000);
      }),
    ]);
    if (drainTimeout) clearTimeout(drainTimeout);
    if (!drainResult.completed) {
      const processWithKill = logsProcess as typeof logsProcess & { kill?: (signal?: string) => void };
      processWithKill.kill?.('SIGTERM');
      logsProcess.stdout?.destroy();
      logsProcess.stderr?.destroy();
    }
    const logsDrained = drainResult.logsDrained;
    await credentialStopPromise;
    commandOutputCapture?.finishAttempt(currentAttempt, { exitCode, outcome, logsDrained });
    return { exitCode, outcome };
  };
}

async function waitForAgentExit(
  overallDeadlineMs?: number,
  agentTimeoutMinutes?: number,
): Promise<AgentAttemptResult> {
  let exitCode: number;
  let outcome: AgentAttemptResult['outcome'] = 'exited';

  if (overallDeadlineMs !== undefined) {
    const remainingMs = overallDeadlineMs - Date.now();

    if (remainingMs <= 0) {
      // No time left (budget exhausted by a previous attempt).
      logger.warn(`Agent command timed out after ${agentTimeoutMinutes} minutes, stopping container...`);
      await execa('docker', ['stop', '-t', '10', AGENT_CONTAINER_NAME], { reject: false, env: getLocalDockerEnv() });
      return { exitCode: 124, outcome: 'timed_out' };
    }

    logger.info(`Agent timeout: ${agentTimeoutMinutes} minutes`);

    // Race docker wait against the remaining budget.
    const waitPromise = execa('docker', ['wait', AGENT_CONTAINER_NAME], { env: getLocalDockerEnv() }).then(result => ({
      type: 'completed' as const,
      exitCodeStr: result.stdout,
    }));

    let timeoutTimer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<{ type: 'timeout' }>(resolve => {
      timeoutTimer = setTimeout(() => resolve({ type: 'timeout' }), remainingMs);
    });

    const raceResult = await Promise.race([waitPromise, timeoutPromise]);

    if (raceResult.type === 'timeout') {
      outcome = 'timed_out';
      logger.warn(`Agent command timed out after ${agentTimeoutMinutes} minutes, stopping container...`);
      // Stop the container gracefully (10 second grace period before SIGKILL)
      await execa('docker', ['stop', '-t', '10', AGENT_CONTAINER_NAME], { reject: false, env: getLocalDockerEnv() });
      exitCode = 124; // Standard timeout exit code (same as coreutils timeout)
    } else {
      // Clear the timeout timer so it doesn't keep the event loop alive
      clearTimeout(timeoutTimer!);
      exitCode = parseInt(raceResult.exitCodeStr.trim(), 10);
    }
  } else {
    // No timeout - wait indefinitely
    const { stdout: exitCodeStr } = await execa('docker', ['wait', AGENT_CONTAINER_NAME], { env: getLocalDockerEnv() });
    exitCode = parseInt(exitCodeStr.trim(), 10);
  }

  return { exitCode, outcome };
}

/**
 * Runs the agent command in the container and reports any blocked domains
 */
export async function runAgentCommand(
  workDir: string,
  allowedDomains: string[],
  proxyLogsDir?: string,
  agentTimeoutMinutes?: number,
  containerRuntime?: string,
  commandOutputCapture?: ProtectedCommandOutputCapture,
): Promise<{ exitCode: number; blockedDomains: string[] }> {
  logger.info('Executing agent command...');

  try {
    // Keep timeout enforcement on a host-controlled clock; the agent can write
    // the shared runtime marker used for advisory API-proxy steering.
    const agentStartTimeMs = Date.now();
    const overallDeadlineMs = agentTimeoutMinutes
      ? agentStartTimeMs + agentTimeoutMinutes * 60 * 1000
      : undefined;

    let attemptNumber = 0;
    const executeAgentAttempt = async (logsSince?: string): Promise<AgentAttemptResult> => {
      const currentAttempt = commandOutputCapture ? ++attemptNumber : 0;
      const recordAttemptCompletion = streamAgentLogs(currentAttempt, commandOutputCapture, logsSince);
      const result = await waitForAgentExit(overallDeadlineMs, agentTimeoutMinutes);
      // Wait for the logs process to finish (it should exit automatically when container stops)
      return recordAttemptCompletion(result);
    };

    let attemptResult = await executeAgentAttempt();
    let exitCode = attemptResult.exitCode;

    if (isGvisorRuntime(containerRuntime) && !isAgentExternallyKilled()) {
      for (let attempt = 1; attempt <= MAX_GVISOR_AGENT_RETRIES; attempt++) {
        if (isAgentExternallyKilled()) break;
        if (!GVISOR_RETRYABLE_AGENT_EXIT_CODES.has(exitCode)) {
          break;
        }

        // Only retry when there is concrete evidence that the crash occurred
        // before the agent began any work (i.e. it was a pure startup crash).
        const startupCrash = await isGvisorStartupCrash(AGENT_CONTAINER_NAME);
        if (!startupCrash) {
          logger.debug(
            `gVisor agent exited with code ${exitCode} but ran longer than the startup window (${GVISOR_STARTUP_CRASH_WINDOW_MS / 1000}s); not retrying`
          );
          break;
        }
        if (isAgentExternallyKilled()) break;

        logger.warn(
          `gVisor agent exited with code ${exitCode} before startup completed; retrying container launch (${attempt}/${MAX_GVISOR_AGENT_RETRIES})...`
        );
        const logsSince = new Date().toISOString();
        await execa('docker', ['start', AGENT_CONTAINER_NAME], {
          stdout: process.stderr,
          stderr: 'inherit',
          env: getLocalDockerEnv(),
        });
        if (isAgentExternallyKilled()) {
          await execa('docker', ['stop', '-t', '3', AGENT_CONTAINER_NAME], {
            reject: false,
            env: getLocalDockerEnv(),
          });
          if (commandOutputCapture) {
            attemptResult = await executeAgentAttempt(logsSince);
            exitCode = attemptResult.exitCode;
          }
          break;
        }
        attemptResult = await executeAgentAttempt(logsSince);
        exitCode = attemptResult.exitCode;
      }
    }

    // If the container was killed externally (e.g. by fastKillAgentContainer in a
    // signal handler), skip the remaining log analysis — the container state is
    // unreliable and the signal handler will drive the rest of the shutdown.
    if (isAgentExternallyKilled()) {
      logger.debug('Agent was externally killed, skipping post-run analysis');
      commandOutputCapture?.finishCommand(exitCode || 143, 'cancelled');
      return { exitCode: exitCode || 143, blockedDomains: [] };
    }

    commandOutputCapture?.finishCommand(
      exitCode,
      attemptResult.outcome,
    );
    logger.debug(`Agent exit code: ${exitCode}`);

    const blockedDomains = await reportSquidBlocks(workDir, allowedDomains, exitCode, proxyLogsDir);
    return { exitCode, blockedDomains };
  } catch (error) {
    logger.error('Failed to run agent command:', error);
    throw error;
  }
}

/**
 * Fast-kills the agent container with a short grace period.
 * Used in signal handlers (SIGTERM/SIGINT) to ensure the agent cannot outlive
 * the awf process — e.g. when GH Actions sends SIGTERM followed by SIGKILL
 * after ~10 seconds. The full `docker compose down -v` in stopContainers() is
 * too slow to reliably complete in that window.
 *
 * @param stopTimeoutSeconds - Grace period before SIGKILL (default: 3)
 */
export async function fastKillAgentContainer(stopTimeoutSeconds = 3): Promise<void> {
  markAgentExternallyKilled();
  try {
    await execa('docker', ['stop', '-t', String(stopTimeoutSeconds), AGENT_CONTAINER_NAME], {
      reject: false,
      timeout: (stopTimeoutSeconds + 5) * 1000, // hard deadline on the stop command itself
      env: getLocalDockerEnv(),
    });
  } catch {
    // Best-effort — if docker CLI is unavailable or hangs, we still proceed
    // to performCleanup which will attempt docker compose down.
  }
}
