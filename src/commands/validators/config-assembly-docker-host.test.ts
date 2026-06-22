import {
  callAssembleWith,
  getMockExit,
  logger,
  mockBuildConfigOnce,
  setupConfigAssemblyTestSuite,
} from './config-assembly.test-utils';

describe('config-assembly', () => {
  setupConfigAssemblyTestSuite();

  describe('docker-host validation', () => {
    it('should reject non-loopback tcp:// docker host URIs', () => {
      mockBuildConfigOnce({
        awfDockerHost: 'tcp://192.168.1.100:2375',
        dockerHostPathPrefix: undefined,
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--docker-host must be a unix:// socket URI or a loopback TCP URI'),
      );
    });

    it('should accept loopback tcp:// docker host URIs (ARC/DinD)', () => {
      mockBuildConfigOnce({
        awfDockerHost: 'tcp://localhost:2375',
        dockerHostPathPrefix: undefined,
      });

      const result = callAssembleWith();

      expect(result).toBeDefined();
      expect(getMockExit()).not.toHaveBeenCalled();
    });

    it('should accept tcp://127.0.0.1 docker host URIs (ARC/DinD)', () => {
      mockBuildConfigOnce({
        awfDockerHost: 'tcp://127.0.0.1:2375',
        dockerHostPathPrefix: undefined,
      });

      const result = callAssembleWith();

      expect(result).toBeDefined();
      expect(getMockExit()).not.toHaveBeenCalled();
    });

    it('should accept unix:// docker host URIs', () => {
      mockBuildConfigOnce({
        awfDockerHost: 'unix:///var/run/docker.sock',
        dockerHostPathPrefix: undefined,
      });

      const result = callAssembleWith();

      expect(result).toBeDefined();
      expect(getMockExit()).not.toHaveBeenCalled();
    });

    it('should reject relative docker-host-path-prefix', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: 'relative/path',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--docker-host-path-prefix must be an absolute path'),
      );
    });

    it('should accept absolute docker-host-path-prefix', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: '/host',
      });

      const result = callAssembleWith();

      expect(result).toBeDefined();
      expect(getMockExit()).not.toHaveBeenCalled();
    });

    it('should reject relative chroot binaries source path', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: undefined,
        chrootBinariesSourcePath: 'relative/path',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('chroot.binariesSourcePath must be an absolute path'),
      );
    });

    it('should accept absolute chroot binaries source path', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: undefined,
        chrootBinariesSourcePath: '/tmp/gh-aw/runner-bin',
      });

      const result = callAssembleWith();

      expect(result).toBeDefined();
      expect(getMockExit()).not.toHaveBeenCalled();
    });

    it('should reject chroot binaries source path set to root', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: undefined,
        chrootBinariesSourcePath: '/',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('chroot.binariesSourcePath cannot be "/"'),
      );
    });

    it('should reject chroot binaries source path containing a colon', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: undefined,
        chrootBinariesSourcePath: '/tmp/bin:/extra',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('chroot.binariesSourcePath must not contain ":" or newline characters'),
      );
    });

    it('should reject chroot binaries source path containing a newline', () => {
      mockBuildConfigOnce({
        awfDockerHost: undefined,
        dockerHostPathPrefix: undefined,
        chrootBinariesSourcePath: '/tmp/bin\n/extra',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('chroot.binariesSourcePath must not contain ":" or newline characters'),
      );
    });
  });
});
