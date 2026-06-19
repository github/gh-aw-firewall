/**
 * Test helpers for Docker container startup-retry scenarios.
 *
 * Provides mock-setup and assertion helpers that eliminate boilerplate in
 * tests that exercise the one-retry logic in `startContainers()`.
 *
 * Usage:
 *   import { mockStartupRetry, expectComposeUpAttempts } from './test-helpers/startup-retry.test-utils';
 *   import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
 */

import { mockExecaFn } from './mock-execa.test-utils';

/**
 * Options for `mockStartupRetry`.
 */
export interface MockStartupRetryOptions {
  /** Error message thrown by the first `docker compose up` attempt. */
  firstError: string;
  /**
   * If defined, a `docker inspect` call is mocked to return this stdout
   * immediately after the failed compose-up and before the logs call.
   * Used for squid-startup and generic-error scenarios where the implementation
   * runs an inspect-based fallback diagnosis.
   */
  inspectBeforeLogs?: string;
  /** Stdout returned by the `docker logs` diagnostic call. Defaults to `''`. */
  logs?: string;
}

/**
 * Queues the standard execa mock sequence for a successful one-retry startup:
 *
 *   1. `docker rm`   — resolves (initial cleanup)
 *   2. `docker compose up` — rejects with `firstError`
 *   3. (optional) `docker inspect` — resolves with `inspectBeforeLogs` stdout
 *   4. `docker logs`          — resolves with `logs`
 *   5. `docker compose down`  — resolves (cleanup before retry)
 *   6. `docker compose up`    — resolves (retry succeeds)
 *
 * Call this before invoking `startContainers()` in tests that verify the
 * retry path completes without error.
 */
export function mockStartupRetry({
  firstError,
  inspectBeforeLogs,
  logs = '',
}: MockStartupRetryOptions): void {
  // 1. docker rm (initial cleanup)
  mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
  // 2. docker compose up (first attempt — fails)
  mockExecaFn.mockRejectedValueOnce(new Error(firstError));
  if (inspectBeforeLogs !== undefined) {
    // 3. docker inspect (fallback diagnosis)
    mockExecaFn.mockResolvedValueOnce({ stdout: inspectBeforeLogs, stderr: '', exitCode: 0 } as any);
  }
  // 4. docker logs (get container logs for diagnosis)
  mockExecaFn.mockResolvedValueOnce({ stdout: logs, stderr: '', exitCode: 0 } as any);
  // 5. docker compose down (cleanup before retry)
  mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
  // 6. docker compose up (retry — succeeds)
  mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
}

/**
 * Asserts that `docker compose up` was invoked exactly `count` times across
 * all recorded `mockExecaFn` calls.
 */
export function expectComposeUpAttempts(count: number): void {
  const upCalls = mockExecaFn.mock.calls.filter(
    (call: any[]) => call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('up')
  );
  expect(upCalls).toHaveLength(count);
}
