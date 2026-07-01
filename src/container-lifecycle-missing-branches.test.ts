/**
 * Branch-coverage tests for container-lifecycle.ts paths not exercised by
 * the main container-start.test.ts and run-agent-command.test.ts suites.
 *
 * Covered here:
 *   1. fastKillAgentContainer – custom stop-timeout propagated to docker stop
 *   2. fastKillAgentContainer – docker stop throws; error is swallowed (best-effort)
 *   3. runAgentCommand – externally-killed agent whose docker-wait returns 0;
 *      the `exitCode || 143` fallback normalises 0 → 143
 *   4. startContainers – compose-down cleanup before retry throws;
 *      the catch block is hit and the retry still proceeds successfully
 *   5. startContainers – cli-proxy fails during the retry attempt (after an
 *      api-proxy first-attempt failure triggers the one-shot retry); the
 *      specific cli-proxy error is surfaced rather than falling through to
 *      Squid diagnostics
 */

import { startContainers, runAgentCommand, fastKillAgentContainer } from './container-lifecycle';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';
import { expectComposeUpAttempts } from './test-helpers/startup-retry.test-utils';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

// ─── fastKillAgentContainer ──────────────────────────────────────────────────

describe('fastKillAgentContainer – stop timeout', () => {
  beforeEach(() => {
    containerLifecycleTestHelpers.resetAgentExternallyKilled();
  });

  it('passes the default 3-second grace period to docker stop', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await fastKillAgentContainer();

    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      ['stop', '-t', '3', 'awf-agent'],
      expect.objectContaining({ reject: false })
    );
  });

  it('passes a custom stop timeout to docker stop', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await fastKillAgentContainer(7);

    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      ['stop', '-t', '7', 'awf-agent'],
      expect.objectContaining({ reject: false, timeout: 12_000 })
    );
  });

  it('encodes the hard deadline as (stopTimeoutSeconds + 5) * 1000 ms', async () => {
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await fastKillAgentContainer(10);

    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      ['stop', '-t', '10', 'awf-agent'],
      expect.objectContaining({ timeout: 15_000 })
    );
  });
});

describe('fastKillAgentContainer – docker stop failure is swallowed', () => {
  beforeEach(() => {
    containerLifecycleTestHelpers.resetAgentExternallyKilled();
  });

  it('resolves without throwing when docker stop rejects', async () => {
    mockExecaFn.mockRejectedValueOnce(new Error('docker: connection refused'));

    await expect(fastKillAgentContainer()).resolves.toBeUndefined();
  });

  it('still marks the agent as externally killed even if docker stop fails', async () => {
    mockExecaFn.mockRejectedValueOnce(new Error('No such container: awf-agent'));

    await fastKillAgentContainer();

    expect(containerLifecycleTestHelpers.isAgentExternallyKilled()).toBe(true);
  });
});

// ─── runAgentCommand – externally killed with docker wait returning 0 ─────────

describe('runAgentCommand – externally killed, docker wait returns 0', () => {
  const { getDir } = useTempDir();

  beforeEach(() => {
    containerLifecycleTestHelpers.resetAgentExternallyKilled();
  });

  it('normalises exit code to 143 when the killed container exits with 0', async () => {
    // Simulate fastKillAgentContainer being called first
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker stop
    await fastKillAgentContainer();

    // docker logs -f
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // docker wait — container exits 0 (race condition: killed before agent ran anything)
    mockExecaFn.mockResolvedValueOnce({ stdout: '0', stderr: '', exitCode: 0 } as any);

    const result = await runAgentCommand(getDir(), ['github.com']);

    // `exitCode || 143` must map 0 → 143
    expect(result.exitCode).toBe(143);
    expect(result.blockedDomains).toEqual([]);
  });
});

// ─── startContainers – compose-down cleanup throws before retry ──────────────

describe('startContainers – retry cleanup failure is handled gracefully', () => {
  const { getDir } = useTempDir();

  it('proceeds with retry even when compose-down cleanup throws', async () => {
    // 1. docker rm (initial cleanup)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // 2. docker compose up (first attempt — api-proxy unhealthy; triggers retry)
    mockExecaFn.mockRejectedValueOnce(
      new Error('dependency failed to start: container awf-api-proxy is unhealthy')
    );
    // 3. docker logs awf-api-proxy (pre-retry diagnosis)
    mockExecaFn.mockResolvedValueOnce({ stdout: 'api-proxy startup logs', stderr: '', exitCode: 0 } as any);
    // 4. docker compose down (cleanup before retry — THROWS; catch block must swallow this)
    mockExecaFn.mockRejectedValueOnce(new Error('compose down failed: connection timeout'));
    // 5. docker compose up (retry — succeeds)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();

    // Both compose-up attempts happened despite the cleanup failure
    expectComposeUpAttempts(2);
  });
});

// ─── startContainers – cli-proxy failure during the retry attempt ─────────────

describe('startContainers – cli-proxy fails during the one-shot retry', () => {
  const { getDir } = useTempDir();

  it('throws the specific cli-proxy error when cli-proxy fails on retry', async () => {
    // 1. docker rm (initial cleanup)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // 2. docker compose up (first attempt — api-proxy unhealthy; triggers one-shot retry)
    mockExecaFn.mockRejectedValueOnce(
      new Error('dependency failed to start: container awf-api-proxy is unhealthy')
    );
    // 3. docker logs awf-api-proxy (pre-retry diagnosis)
    mockExecaFn.mockResolvedValueOnce({ stdout: 'api-proxy logs', stderr: '', exitCode: 0 } as any);
    // 4. docker compose down (cleanup before retry)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // 5. docker compose up (retry — fails with cli-proxy unhealthy)
    mockExecaFn.mockRejectedValueOnce(
      new Error('dependency failed to start: container awf-cli-proxy is unhealthy')
    );
    // 6. docker inspect awf-api-proxy (retry error handler: confirm api-proxy is not the cause)
    mockExecaFn.mockResolvedValueOnce({ stdout: 'running|healthy', stderr: '', exitCode: 0 } as any);
    // 7. docker inspect awf-squid (retry error handler: confirm squid is not the cause)
    mockExecaFn.mockResolvedValueOnce({ stdout: 'running|healthy', stderr: '', exitCode: 0 } as any);
    // 8. docker logs awf-cli-proxy (diagnostics dumped before fail-fast throw)
    mockExecaFn.mockResolvedValueOnce({ stdout: 'cli-proxy startup logs', stderr: '', exitCode: 0 } as any);

    await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow(
      'AWF firewall failed to start: awf-cli-proxy could not connect to the external DIFC proxy'
    );

    // Only the initial attempt and the one-shot retry; no further compose-up calls
    expectComposeUpAttempts(2);
  });

  it('does not retry a second time after the cli-proxy retry failure', async () => {
    // 1. docker rm
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // 2. docker compose up (first attempt — squid unhealthy; triggers retry)
    mockExecaFn.mockRejectedValueOnce(
      new Error('dependency failed to start: container awf-squid is unhealthy')
    );
    // 3. docker inspect awf-api-proxy (pre-retry fallback: not api-proxy failure)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // 4. docker logs awf-squid (pre-retry diagnosis)
    mockExecaFn.mockResolvedValueOnce({ stdout: 'squid logs', stderr: '', exitCode: 0 } as any);
    // 5. docker compose down (cleanup before retry)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // 6. docker compose up (retry — fails with cli-proxy unhealthy)
    mockExecaFn.mockRejectedValueOnce(
      new Error('dependency failed to start: container awf-cli-proxy is unhealthy')
    );
    // 7. docker inspect awf-api-proxy (retry handler: not api-proxy)
    mockExecaFn.mockResolvedValueOnce({ stdout: 'running|healthy', stderr: '', exitCode: 0 } as any);
    // 8. docker inspect awf-squid (retry handler: not squid)
    mockExecaFn.mockResolvedValueOnce({ stdout: 'running|healthy', stderr: '', exitCode: 0 } as any);
    // 9. docker logs awf-cli-proxy (diagnostics before throw)
    mockExecaFn.mockResolvedValueOnce({ stdout: 'cli-proxy retry logs', stderr: '', exitCode: 0 } as any);

    await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow(
      'AWF firewall failed to start: awf-cli-proxy could not connect to the external DIFC proxy'
    );

    // Exactly two compose-up calls: initial + one retry (no third attempt)
    expectComposeUpAttempts(2);
  });
});
