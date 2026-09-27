import { isSbxAvailable, removeSandbox } from './sbx-manager';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { logger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());

const mockedLogger = jest.mocked(logger);

describe('sbx lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('removeSandbox', () => {
    it('warns when sbx rm exits non-zero', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // stop
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'still running' }); // rm

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove sandbox "awf-agent-test"'),
      );
    });

    it('warns when sbx stop exits non-zero', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' }) // stop
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // rm

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to stop sandbox "awf-agent-test"'),
      );
    });

    it('handles stop throwing (sandbox may already be stopped)', async () => {
      mockExecaFn
        .mockRejectedValueOnce(new Error('stop threw')) // stop throws
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // rm

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('removed'),
      );
    });

    it('logs success when stop and rm both succeed', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('"awf-agent-test" removed'),
      );
    });

    it('warns (not throws) when rm exits null', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ exitCode: null, stdout: '', stderr: 'null exit' });

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove sandbox'),
      );
    });
  });

  describe('isSbxAvailable', () => {
    it('returns true when sbx version succeeds', async () => {
      mockExecaFn.mockResolvedValueOnce({ exitCode: 0, stdout: 'sbx 1.0.0', stderr: '' });

      const result = await isSbxAvailable();
      expect(result).toBe(true);
    });

    it('returns false when sbx version throws (not installed)', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('command not found: sbx'));

      const result = await isSbxAvailable();
      expect(result).toBe(false);
    });
  });
});
