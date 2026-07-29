/**
 * Branch-coverage tests for container-lifecycle.ts gVisor-specific paths.
 *
 * Covered here:
 *   1. isGvisorStartupCrash – docker inspect returns output with wrong number of parts (not 2)
 *   2. isGvisorStartupCrash – docker inspect stdout is empty
 *   3. isGvisorStartupCrash – docker inspect throws (exception in try/catch)
 *   4. isGvisorStartupCrash – runtimeMs is NOT within startup window (long-running agent)
 *   5. runAgentCommand gVisor – retry skipped when crash is NOT a startup crash
 */

import { runAgentCommand } from './container-lifecycle';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
import { logger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

const ok = (stdout = '', exitCode = 0) => ({ stdout, stderr: '', exitCode });

beforeEach(() => {
  mockExecaFn.mockReset();
  containerLifecycleTestHelpers.resetAgentExternallyKilled();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── isGvisorStartupCrash – inspect returns wrong token count ─────────────────

describe('runAgentCommand – gVisor retry skipped when inspect output has wrong parts', () => {
  const { getDir } = useTempDir();

  it('does not retry when docker inspect returns unexpected output format (1 part)', async () => {
    // docker logs -f (attempt 1)
    mockExecaFn.mockResolvedValueOnce(ok() as any);
    // docker wait → exit 134 (retryable gVisor crash code)
    mockExecaFn.mockResolvedValueOnce(ok('134') as any);
    // docker inspect → unexpected: only 1 token, not 2
    mockExecaFn.mockResolvedValueOnce(ok('only-one-token') as any);
    // No docker start expected — retry should be skipped
    // docker logs -f NOT called for attempt 2
    // post-run: squid log check (no squid-logs dir → empty result)

    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    const result = await runAgentCommand(getDir(), ['github.com'], undefined, undefined, 'gvisor');

    // Exit code 134 passes through unchanged (no retry performed)
    expect(result.exitCode).toBe(134);

    // docker start must NOT have been called
    const startCalls = mockExecaFn.mock.calls.filter(
      (c: unknown[]) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'start'
    );
    expect(startCalls).toHaveLength(0);

    debugSpy.mockRestore();
  });

  it('does not retry when docker inspect returns empty output', async () => {
    mockExecaFn.mockResolvedValueOnce(ok() as any);        // docker logs -f
    mockExecaFn.mockResolvedValueOnce(ok('134') as any);   // docker wait
    mockExecaFn.mockResolvedValueOnce(ok('') as any);      // docker inspect → empty

    const result = await runAgentCommand(getDir(), ['github.com'], undefined, undefined, 'gvisor');

    expect(result.exitCode).toBe(134);
    const startCalls = mockExecaFn.mock.calls.filter(
      (c: unknown[]) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'start'
    );
    expect(startCalls).toHaveLength(0);
  });
});

// ─── isGvisorStartupCrash – inspect throws ────────────────────────────────────

describe('runAgentCommand – gVisor retry skipped when docker inspect throws', () => {
  const { getDir } = useTempDir();

  it('does not retry when docker inspect rejects', async () => {
    mockExecaFn.mockResolvedValueOnce(ok() as any);                           // docker logs -f
    mockExecaFn.mockResolvedValueOnce(ok('139') as any);                      // docker wait (retryable)
    mockExecaFn.mockRejectedValueOnce(new Error('docker: no such container')); // docker inspect throws

    const result = await runAgentCommand(getDir(), ['github.com'], undefined, undefined, 'gvisor');

    // exit 139 passes through — no retry
    expect(result.exitCode).toBe(139);
    const startCalls = mockExecaFn.mock.calls.filter(
      (c: unknown[]) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'start'
    );
    expect(startCalls).toHaveLength(0);
  });
});

// ─── isGvisorStartupCrash – long-running agent (not a startup crash) ──────────

describe('runAgentCommand – gVisor retry skipped when agent ran beyond startup window', () => {
  const { getDir } = useTempDir();

  it('does not retry when runtime exceeds the 30-second startup window', async () => {
    const baseTime = 1_700_000_000_000;
    // Agent ran for 45 seconds — well beyond the 30s startup window
    const startedAt = new Date(baseTime).toISOString();
    const finishedAt = new Date(baseTime + 45_000).toISOString();

    mockExecaFn.mockResolvedValueOnce(ok() as any);                                      // docker logs -f
    mockExecaFn.mockResolvedValueOnce(ok('134') as any);                                 // docker wait
    mockExecaFn.mockResolvedValueOnce(ok(`${startedAt} ${finishedAt}`) as any);          // docker inspect

    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {});

    const result = await runAgentCommand(getDir(), ['github.com'], undefined, undefined, 'gvisor');

    expect(result.exitCode).toBe(134);

    // Verify the "not retrying" debug message was emitted
    const debugMessages = debugSpy.mock.calls.map(([m]) => m as string).join('\n');
    expect(debugMessages).toContain('not retrying');

    const startCalls = mockExecaFn.mock.calls.filter(
      (c: unknown[]) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'start'
    );
    expect(startCalls).toHaveLength(0);

    debugSpy.mockRestore();
  });
});

// ─── gVisor – non-retryable exit code skips retry immediately ─────────────────

describe('runAgentCommand – gVisor does not retry non-retryable exit codes', () => {
  const { getDir } = useTempDir();

  it('does not call docker inspect or docker start for exit code 1 (not in retryable set)', async () => {
    mockExecaFn.mockResolvedValueOnce(ok() as any);     // docker logs -f
    mockExecaFn.mockResolvedValueOnce(ok('1') as any);  // docker wait → exit 1

    const result = await runAgentCommand(getDir(), ['github.com'], undefined, undefined, 'gvisor');

    expect(result.exitCode).toBe(1);

    const inspectCalls = mockExecaFn.mock.calls.filter(
      (c: unknown[]) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'inspect'
    );
    expect(inspectCalls).toHaveLength(0);
  });

  it('does not retry for exit code 0 (success)', async () => {
    mockExecaFn.mockResolvedValueOnce(ok() as any);     // docker logs -f
    mockExecaFn.mockResolvedValueOnce(ok('0') as any);  // docker wait → exit 0

    const result = await runAgentCommand(getDir(), ['github.com'], undefined, undefined, 'gvisor');

    expect(result.exitCode).toBe(0);

    const inspectCalls = mockExecaFn.mock.calls.filter(
      (c: unknown[]) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'inspect'
    );
    expect(inspectCalls).toHaveLength(0);
  });
});
