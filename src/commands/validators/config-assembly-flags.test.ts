import {
  callAssembleWith,
  getMockExit,
  logger,
  mockBuildConfigOnce,
  setupConfigAssemblyTestSuite,
  validateEnableTokenSteeringFlag,
  validateSkipPullWithBuildLocal,
} from './config-assembly.test-utils';

describe('config-assembly', () => {
  setupConfigAssemblyTestSuite();

  describe('feature flag validation', () => {
    it('should exit if --enable-token-steering is used without --enable-api-proxy', () => {
      (validateEnableTokenSteeringFlag as jest.Mock).mockReturnValueOnce({
        valid: false,
        error: '--enable-token-steering requires --enable-api-proxy',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        '--enable-token-steering requires --enable-api-proxy',
      );
    });
  });

  describe('environment variable warnings', () => {
    it('should warn when --env-all is used', () => {
      mockBuildConfigOnce({
        envAll: true,
      });

      callAssembleWith();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Using --env-all'),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('may expose sensitive credentials'),
      );
    });

    it('should log debug message when --env-file is used', () => {
      mockBuildConfigOnce({
        envFile: '/tmp/test.env',
      });

      callAssembleWith();

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Loading environment variables from file'),
      );
    });
  });

  describe('skip-pull validation', () => {
    it('should exit if --skip-pull is used with --build-local', () => {
      (validateSkipPullWithBuildLocal as jest.Mock).mockReturnValueOnce({
        valid: false,
        error: '--skip-pull and --build-local are incompatible',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--skip-pull and --build-local are incompatible'),
      );
    });
  });

  describe('successful config assembly', () => {
    it('should return assembled config when all validations pass', () => {
      const config = callAssembleWith();

      expect(config).toBeDefined();
      expect(config.agentCommand).toBe('echo test');
      expect(config.logLevel).toBe('info');
      expect(getMockExit()).not.toHaveBeenCalled();
    });
  });
});
