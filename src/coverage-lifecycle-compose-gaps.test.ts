/**
 * Coverage tests for uncovered branches in:
 *   - container-lifecycle.ts: handleRetryStartupFailure return (line 175),
 *     runAgentCommand error path (lines 313-314)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';
import { logger } from './logger';

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

describe('startContainers – retry path (line 175)', () => {
  const { getDir } = useTempDir();

  it('returns at line 175 when retry fails and handleRetryStartupFailure does not throw', async () => {
    const { didContainerFailStartup } = jest.requireMock('./container-startup-diagnostics');

    // First-attempt api-proxy failure triggers the retry path.
    // The retry also fails, but all handleRetryStartupFailure diagnostics return false,
    // so handleHealthcheckError (mocked to resolve) is called, handleRetryStartupFailure
    // returns without throwing, and execution reaches the return at line 175.
    didContainerFailStartup
      .mockResolvedValueOnce(true)   // handleStartupFailure: api-proxy → triggers retry
      .mockResolvedValueOnce(false)  // handleRetryStartupFailure: api-proxy → no throw
      .mockResolvedValueOnce(false)  // handleRetryStartupFailure: squid → no log
      .mockResolvedValueOnce(false); // handleRetryStartupFailure: cli-proxy → no throw

    // 1. docker rm (initial cleanup)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // 2. docker compose up (first attempt – api-proxy identified as culprit)
    mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-api-proxy is unhealthy'));
    // runComposeDown is mocked; no execa call needed for cleanup
    // 3. docker compose up (retry – also fails, entering handleRetryStartupFailure)
    mockExecaFn.mockRejectedValueOnce(new Error('retry also failed'));

    await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();
  });
});

describe('runAgentCommand – error path (lines 313-314)', () => {
  const { getDir } = useTempDir();

  it('logs and rethrows when docker wait throws an unexpected error', async () => {
    const fatalError = new Error('docker daemon connection refused');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    // docker logs -f (resolves immediately with reject:false)
    mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // docker wait — throws
    mockExecaFn.mockRejectedValueOnce(fatalError);

    await expect(runAgentCommand(getDir(), ['github.com'])).rejects.toThrow(
      'docker daemon connection refused'
    );
    expect(errorSpy).toHaveBeenCalledWith('Failed to run agent command:', fatalError);

    errorSpy.mockRestore();
  });
});

