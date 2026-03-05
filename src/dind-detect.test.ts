import { isDinDEnvironment } from './dind-detect';

// Create mock function
const mockExecaFn = jest.fn();

// Mock execa module (same pattern as docker-manager.test.ts)
jest.mock('execa', () => {
  const fn = (...args: any[]) => mockExecaFn(...args);
  fn.sync = jest.fn();
  return fn;
});

const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
}));

jest.mock('./logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
}));

describe('dind-detect', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('DOCKER_HOST fast path', () => {
    it('should return true when DOCKER_HOST is tcp://', async () => {
      process.env.DOCKER_HOST = 'tcp://localhost:2375';

      const result = await isDinDEnvironment();

      expect(result).toBe(true);
      expect(mockExecaFn).not.toHaveBeenCalled();
    });

    it('should run probe when DOCKER_HOST is unix socket', async () => {
      process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';

      mockExecaFn.mockImplementation(async () => {
        // Return the token that was written to the probe file
        const token = mockWriteFileSync.mock.calls[0]?.[1] as string;
        return { stdout: token, stderr: '', exitCode: 0 };
      });

      const result = await isDinDEnvironment();

      expect(result).toBe(false);
      expect(mockExecaFn).toHaveBeenCalledWith('docker', expect.arrayContaining(['run', '--rm', 'busybox', 'cat', '/probe']));
    });

    it('should run probe when DOCKER_HOST is unset', async () => {
      delete process.env.DOCKER_HOST;

      mockExecaFn.mockImplementation(async () => {
        const token = mockWriteFileSync.mock.calls[0]?.[1] as string;
        return { stdout: token, stderr: '', exitCode: 0 };
      });

      const result = await isDinDEnvironment();

      expect(result).toBe(false);
      expect(mockExecaFn).toHaveBeenCalled();
    });
  });

  describe('probe results', () => {
    beforeEach(() => {
      delete process.env.DOCKER_HOST;
    });

    it('should return false when probe output matches token (native Docker)', async () => {
      mockExecaFn.mockImplementation(async () => {
        const token = mockWriteFileSync.mock.calls[0]?.[1] as string;
        return { stdout: token, stderr: '', exitCode: 0 };
      });

      const result = await isDinDEnvironment();

      expect(result).toBe(false);
    });

    it('should return true when probe output does not match token (DinD)', async () => {
      mockExecaFn.mockResolvedValue({ stdout: 'wrong-content', stderr: '', exitCode: 0 });

      const result = await isDinDEnvironment();

      expect(result).toBe(true);
    });

    it('should return false when probe errors (safe default)', async () => {
      mockExecaFn.mockRejectedValue(new Error('docker: command not found'));

      const result = await isDinDEnvironment();

      expect(result).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should clean up probe file even on error', async () => {
      delete process.env.DOCKER_HOST;

      mockExecaFn.mockRejectedValue(new Error('docker failed'));

      await isDinDEnvironment();

      expect(mockUnlinkSync).toHaveBeenCalled();
    });
  });
});
