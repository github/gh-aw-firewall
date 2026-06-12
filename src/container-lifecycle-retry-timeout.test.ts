/**
 * Targeted tests for uncovered branches in container-lifecycle.ts:
 *   - startContainers retry failure when api-proxy fails on both attempts
 *   - startContainers cli-proxy first-attempt failure (no retry)
 *   - startContainers cli-proxy failure on the retry attempt
 *   - startContainers graceful handling of runComposeDown failure before retry
 *   - runAgentCommand agentTimeoutMinutes path (exitCode 124, docker stop called)
 *   - runAgentCommand isAgentExternallyKilled short-circuit path
 *   - fastKillAgentContainer silent error handling
 *   - fastKillAgentContainer default and custom stop-timeout
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
jest.mock('./container-startup-diagnostics');
jest.mock('./squid-log-reader', () => ({
  checkSquidLogs: jest.fn().mockResolvedValue({ hasDenials: false, blockedTargets: [] }),
}));

import { startContainers, runAgentCommand, fastKillAgentContainer } from './container-lifecycle';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';
import { markAgentExternallyKilled } from './container-lifecycle-state';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
import {
  didContainerFailStartup,
  handleHealthcheckError,
  logContainerLogsToStderr,
} from './container-startup-diagnostics';

const mockDidContainerFailStartup = jest.mocked(didContainerFailStartup);
const mockHandleHealthcheckError = jest.mocked(handleHealthcheckError);
const mockLogContainerLogsToStderr = jest.mocked(logContainerLogsToStderr);

function ok(stdout = '', stderr = '', exitCode = 0): { stdout: string; stderr: string; exitCode: number } {
  return { stdout, stderr, exitCode };
}

describe('container-lifecycle retry and timeout branches', () => {
  const { getDir } = useTempDir();

  beforeEach(() => {
    mockExecaFn.mockReset();
    containerLifecycleTestHelpers.resetAgentExternallyKilled();

    // Default mock behaviours — individual tests override with mockResolvedValueOnce as needed
    mockDidContainerFailStartup.mockResolvedValue(false);
    mockHandleHealthcheckError.mockRejectedValue(new Error('healthcheck failed'));
    mockLogContainerLogsToStderr.mockResolvedValue(undefined);
  });

  // ─── startContainers retry failure: api-proxy fails both attempts ────────────

  describe('startContainers – api-proxy fails on first attempt and on retry', () => {
    it('throws with an api-proxy-specific message when the retry also fails', async () => {
      mockExecaFn
        .mockResolvedValueOnce(ok() as any) // docker rm -f (cleanup)
        .mockRejectedValueOnce(new Error('compose up first attempt failed')) // first compose up
        .mockResolvedValueOnce(ok() as any) // docker compose down (runComposeDown before retry)
        .mockRejectedValueOnce(new Error('compose up retry failed')); // retry compose up

      // First attempt: api-proxy flagged as failed
      mockDidContainerFailStartup
        .mockResolvedValueOnce(true) // first attempt: awf-api-proxy → true
        // Retry attempt checks:
        .mockResolvedValueOnce(true); // retry: awf-api-proxy → true (fails again)

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow(
        'awf-api-proxy failed to start on both attempts'
      );

      // logContainerLogsToStderr called twice: once before retry, once on retry failure
      expect(mockLogContainerLogsToStderr).toHaveBeenCalledTimes(2);
    });
  });

  // ─── startContainers: squid fails on first attempt, retry fails ─────────────

  describe('startContainers – squid fails on first attempt, retry fails with squid error', () => {
    it('logs squid container and falls through to handleHealthcheckError on retry failure', async () => {
      mockExecaFn
        .mockResolvedValueOnce(ok() as any) // docker rm -f
        .mockRejectedValueOnce(new Error('compose up first attempt failed'))
        .mockResolvedValueOnce(ok() as any) // docker compose down
        .mockRejectedValueOnce(new Error('compose up retry failed'));

      // First attempt: squid flagged as failed (api-proxy check returns false)
      mockDidContainerFailStartup
        .mockResolvedValueOnce(false) // first: api-proxy → false
        .mockResolvedValueOnce(true)  // first: squid → true
        // Retry attempt checks:
        .mockResolvedValueOnce(false) // retry: api-proxy → false
        .mockResolvedValueOnce(true)  // retry: squid → true (logs dumped, but no throw)
        .mockResolvedValueOnce(false); // retry: cli-proxy → false (falls through)

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow('healthcheck failed');

      // handleHealthcheckError was invoked because squid failure doesn't throw directly on retry
      expect(mockHandleHealthcheckError).toHaveBeenCalledTimes(1);
    });
  });

  // ─── startContainers: cli-proxy fails on first attempt (no retry) ───────────

  describe('startContainers – cli-proxy fails on first attempt', () => {
    it('throws with a cli-proxy-specific message without retrying', async () => {
      mockExecaFn
        .mockResolvedValueOnce(ok() as any) // docker rm -f
        .mockRejectedValueOnce(new Error('compose up failed'));

      // All three container checks: only cli-proxy returns true
      mockDidContainerFailStartup
        .mockResolvedValueOnce(false) // api-proxy → false
        .mockResolvedValueOnce(false) // squid → false
        .mockResolvedValueOnce(true); // cli-proxy → true

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow(
        'awf-cli-proxy could not connect to the external DIFC proxy'
      );

      // No retry: compose up called only once
      const upCalls = mockExecaFn.mock.calls.filter(
        (call: unknown[]) => call[0] === 'docker' && Array.isArray(call[1]) && (call[1] as string[]).includes('up')
      );
      expect(upCalls).toHaveLength(1);
    });

    it('includes the "agent was never invoked" note in the error', async () => {
      mockExecaFn
        .mockResolvedValueOnce(ok() as any)
        .mockRejectedValueOnce(new Error('compose up failed'));

      mockDidContainerFailStartup
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow(
        'The agent was never invoked'
      );
    });
  });

  // ─── startContainers: cli-proxy fails on the retry attempt ──────────────────

  describe('startContainers – cli-proxy fails during the retry attempt', () => {
    it('throws with a cli-proxy-specific message when cli-proxy fails on retry', async () => {
      mockExecaFn
        .mockResolvedValueOnce(ok() as any) // docker rm -f
        .mockRejectedValueOnce(new Error('compose up first failed'))
        .mockResolvedValueOnce(ok() as any) // docker compose down
        .mockRejectedValueOnce(new Error('compose up retry failed'));

      mockDidContainerFailStartup
        // First attempt: api-proxy triggers the retry
        .mockResolvedValueOnce(true)  // first: api-proxy → true (triggers retry)
        // Retry attempt checks:
        .mockResolvedValueOnce(false) // retry: api-proxy → false
        .mockResolvedValueOnce(false) // retry: squid → false
        .mockResolvedValueOnce(true); // retry: cli-proxy → true

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow(
        'awf-cli-proxy could not connect to the external DIFC proxy'
      );
    });
  });

  // ─── startContainers: cleanup before retry can fail gracefully ───────────────

  describe('startContainers – runComposeDown failure before retry', () => {
    it('proceeds with retry even when the compose-down teardown throws', async () => {
      mockExecaFn
        .mockResolvedValueOnce(ok() as any) // docker rm -f
        .mockRejectedValueOnce(new Error('compose up first failed'))
        .mockRejectedValueOnce(new Error('compose down also failed')) // runComposeDown throws
        .mockResolvedValueOnce(ok() as any); // retry compose up succeeds

      mockDidContainerFailStartup.mockResolvedValueOnce(true); // first: api-proxy → true (retry path)

      // The compose-down failure should be silently ignored; retry succeeds
      await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();
    });
  });

  // ─── runAgentCommand: timeout path ──────────────────────────────────────────

  describe('runAgentCommand – agentTimeoutMinutes', () => {
    it('returns exit code 124 when the container exceeds the timeout', async () => {
      jest.useFakeTimers();
      try {
        mockExecaFn
          .mockResolvedValueOnce(ok() as any) // docker logs -f (logsProcess)
          .mockReturnValueOnce(new Promise<never>(() => {})) // docker wait (never resolves)
          .mockResolvedValueOnce(ok() as any); // docker stop -t 10

        const resultPromise = runAgentCommand(getDir(), ['github.com'], undefined, 1);

        // Fire the 1-minute timeout (1 * 60 * 1000 ms)
        await jest.advanceTimersByTimeAsync(60_001);
        // Fire the 200 ms Squid-log flush delay
        await jest.advanceTimersByTimeAsync(300);

        const result = await resultPromise;

        expect(result.exitCode).toBe(124);
        expect(mockExecaFn).toHaveBeenCalledWith(
          'docker',
          ['stop', '-t', '10', 'awf-agent'],
          expect.objectContaining({ reject: false }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('uses the docker-wait exit code when the container exits before the timeout', async () => {
      jest.useFakeTimers();
      try {
        mockExecaFn
          .mockResolvedValueOnce(ok() as any) // docker logs -f
          .mockResolvedValueOnce(ok('42') as any); // docker wait → exit code 42

        const resultPromise = runAgentCommand(getDir(), ['github.com'], undefined, 5);

        // The docker-wait mock resolves immediately (before the 5-minute timeout)
        // but we still need to advance past the 200 ms squid-log flush delay
        await jest.advanceTimersByTimeAsync(300);

        const result = await resultPromise;

        expect(result.exitCode).toBe(42);
        // docker stop should NOT have been called
        const stopCalls = mockExecaFn.mock.calls.filter(
          (call: unknown[]) =>
            call[0] === 'docker' && Array.isArray(call[1]) && (call[1] as string[])[0] === 'stop'
        );
        expect(stopCalls).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ─── runAgentCommand: externally-killed path ─────────────────────────────────

  describe('runAgentCommand – isAgentExternallyKilled', () => {
    it('skips squid-log analysis and returns the docker-wait exit code when externally killed', async () => {
      markAgentExternallyKilled();

      mockExecaFn
        .mockResolvedValueOnce(ok() as any) // docker logs -f
        .mockResolvedValueOnce(ok('143') as any); // docker wait

      const result = await runAgentCommand(getDir(), ['github.com']);

      expect(result.exitCode).toBe(143);
      expect(result.blockedDomains).toEqual([]);
    });

    it('falls back to exit code 143 when docker wait reports 0 and agent was externally killed', async () => {
      markAgentExternallyKilled();

      mockExecaFn
        .mockResolvedValueOnce(ok() as any) // docker logs -f
        .mockResolvedValueOnce(ok('0') as any); // docker wait returns 0

      const result = await runAgentCommand(getDir(), ['github.com']);

      // exitCode 0 is falsy → 0 || 143 === 143
      expect(result.exitCode).toBe(143);
    });
  });

  // ─── fastKillAgentContainer ──────────────────────────────────────────────────

  describe('fastKillAgentContainer', () => {
    it('calls docker stop with the default 3-second timeout', async () => {
      mockExecaFn.mockResolvedValueOnce(ok() as any);

      await fastKillAgentContainer();

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['stop', '-t', '3', 'awf-agent'],
        expect.objectContaining({ reject: false }),
      );
    });

    it('calls docker stop with the provided timeout', async () => {
      mockExecaFn.mockResolvedValueOnce(ok() as any);

      await fastKillAgentContainer(7);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['stop', '-t', '7', 'awf-agent'],
        expect.any(Object),
      );
    });

    it('silently swallows errors from docker stop', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('docker daemon not responding'));

      // Must not throw
      await expect(fastKillAgentContainer()).resolves.toBeUndefined();
    });

    it('marks the agent as externally killed even when docker stop fails', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('docker CLI unavailable'));

      await fastKillAgentContainer();

      // Verify the flag was set: a subsequent runAgentCommand call should skip squid analysis
      mockExecaFn
        .mockResolvedValueOnce(ok() as any)   // docker logs -f
        .mockResolvedValueOnce(ok('137') as any); // docker wait

      const result = await runAgentCommand(getDir(), ['github.com']);
      expect(result.blockedDomains).toEqual([]);
    });
  });
});
