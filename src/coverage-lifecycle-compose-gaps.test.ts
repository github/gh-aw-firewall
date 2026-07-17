/**
 * Coverage tests for uncovered branches in:
 *   - container-lifecycle.ts: onNetworkReady path, skipPull in topology mode,
 *     handleRetryStartupFailure return after retry, runAgentCommand error path,
 *     startContainers success log
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';

// ─── container-lifecycle.ts ──────────────────────────────────────────────────

import { startContainers, runAgentCommand } from './container-lifecycle';

jest.mock('./container-startup-diagnostics', () => ({
  didContainerFailStartup: jest.fn().mockResolvedValue(false),
  handleHealthcheckError: jest.fn().mockResolvedValue(undefined),
  logContainerLogsToStderr: jest.fn().mockResolvedValue(undefined),
  reportBlockedDomains: jest.fn(),
}));

jest.mock('./squid-log-reader', () => ({
  checkSquidLogs: jest.fn().mockResolvedValue({ hasDenials: false, blockedTargets: [] }),
}));

jest.mock('./container-stop', () => ({
  runComposeDown: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  mockExecaFn.mockReset();
  containerLifecycleTestHelpers.resetAgentExternallyKilled();
  jest.clearAllMocks();
});

describe('startContainers – onNetworkReady topology path', () => {
  const { getDir } = useTempDir();

  it('invokes onNetworkReady callback after squid-proxy starts (no skipPull)', async () => {
    const onNetworkReady = jest.fn().mockResolvedValue(undefined);

    // docker rm
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // docker compose up -d --no-deps squid-proxy (topology phase 1)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // docker compose up -d (full bring-up, phase 3)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await startContainers(getDir(), ['github.com'], undefined, undefined, onNetworkReady);

    expect(onNetworkReady).toHaveBeenCalledTimes(1);

    // Verify squid-only phase 1 args (no --pull never)
    const squidOnlyCall = mockExecaFn.mock.calls.find(
      (c: any[]) => Array.isArray(c[1]) && c[1].includes('--no-deps') && c[1].includes('squid-proxy')
    );
    expect(squidOnlyCall).toBeDefined();
    expect(squidOnlyCall[1]).not.toContain('never');
  });

  it('invokes onNetworkReady callback after squid-proxy starts (with skipPull)', async () => {
    const onNetworkReady = jest.fn().mockResolvedValue(undefined);

    // docker rm
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // docker compose up -d --no-deps --pull never squid-proxy
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // docker compose up -d --pull never
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await startContainers(getDir(), ['github.com'], undefined, true, onNetworkReady);

    expect(onNetworkReady).toHaveBeenCalledTimes(1);

    // Verify squid-only phase 1 includes --pull never
    const squidOnlyCall = mockExecaFn.mock.calls.find(
      (c: any[]) => Array.isArray(c[1]) && c[1].includes('--no-deps') && c[1].includes('squid-proxy')
    );
    expect(squidOnlyCall).toBeDefined();
    expect(squidOnlyCall[1]).toContain('never');
  });
});

describe('startContainers – retry path return (line 175)', () => {
  const { getDir } = useTempDir();

  it('returns after retry succeeds (handleRetryStartupFailure return path)', async () => {
    const { didContainerFailStartup, logContainerLogsToStderr } =
      jest.requireMock('./container-startup-diagnostics');

    // First attempt: api-proxy fails
    didContainerFailStartup
      .mockResolvedValueOnce(true)   // first call: api-proxy (handleStartupFailure)
      .mockResolvedValueOnce(false)  // squid check skipped
      .mockResolvedValueOnce(false)  // cli-proxy check skipped
      .mockResolvedValueOnce(false); // retry: api-proxy check (handleRetryStartupFailure)

    // docker rm
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // docker compose up (first attempt — fails)
    mockExecaFn.mockRejectedValueOnce(new Error('awf-api-proxy exited with code 1'));
    // docker compose up (retry — succeeds)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();
    expect(logContainerLogsToStderr).toHaveBeenCalled();
  });
});

describe('runAgentCommand – error path (lines 313-314)', () => {
  const { getDir } = useTempDir();

  it('rethrows when docker wait throws an unexpected error', async () => {
    const fatalError = new Error('docker daemon connection refused');

    // docker logs -f (resolves immediately with reject:false)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // docker wait — throws
    mockExecaFn.mockRejectedValueOnce(fatalError);

    await expect(runAgentCommand(getDir(), ['github.com'])).rejects.toThrow(
      'docker daemon connection refused'
    );
  });
});

