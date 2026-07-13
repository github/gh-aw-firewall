/**
 * Additional branch coverage for container-stop.ts.
 *
 * Covers the fixSquidLogPermissionsBeforeShutdown exit-code branches not
 * exercised by container-stop.test.ts:
 *   - exitCode !== 0 with non-empty stderr  (BRDA:46,2,0 true / BRDA:48,3,1 true)
 *   - exitCode !== 0 with empty stderr  →  '(no stderr)' fallback  (BRDA:48,3,0)
 */

import { stopContainers } from './container-stop';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
import { logger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());

const mockedLogger = logger as jest.Mocked<typeof logger>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('fixSquidLogPermissionsBeforeShutdown – non-zero exit code branches', () => {
  const { getDir } = useTempDir();

  it('logs exit code and stderr when chmod returns non-zero with stderr output', async () => {
    mockExecaFn.mockResolvedValueOnce({
      stdout: '',
      stderr: 'Operation not permitted',
      exitCode: 1,
    } as any);
    mockExecaFn.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: 0,
    } as any);

    await stopContainers(getDir(), false);

    expect(mockedLogger.debug).toHaveBeenCalledWith(
      'Pre-shutdown squid log chmod exited with code 1: Operation not permitted',
    );
  });

  it('uses "(no stderr)" fallback in log message when exit is non-zero and stderr is empty', async () => {
    mockExecaFn.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: 126,
    } as any);
    mockExecaFn.mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      exitCode: 0,
    } as any);

    await stopContainers(getDir(), false);

    expect(mockedLogger.debug).toHaveBeenCalledWith(
      'Pre-shutdown squid log chmod exited with code 126: (no stderr)',
    );
  });
});
