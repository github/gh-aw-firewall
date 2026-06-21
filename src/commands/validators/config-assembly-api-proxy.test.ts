import {
  buildRateLimitConfig,
  callAssembleWith,
  logger,
  mockBuildConfigOnce,
  setupConfigAssemblyTestSuite,
  validateRateLimitFlags,
} from './config-assembly.test-utils';

describe('config-assembly', () => {
  setupConfigAssemblyTestSuite();

  describe('rate limit validation', () => {
    it('should exit if rate limit config build fails', () => {
      mockBuildConfigOnce({
        enableApiProxy: true,
      });

      (buildRateLimitConfig as jest.Mock).mockReturnValueOnce({
        error: 'Invalid rate limit configuration',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid rate limit configuration'),
      );
    });

    it('should exit if rate limit flags are used without --enable-api-proxy', () => {
      (validateRateLimitFlags as jest.Mock).mockReturnValueOnce({
        valid: false,
        error: 'Rate limit flags require --enable-api-proxy',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        'Rate limit flags require --enable-api-proxy',
      );
    });

    it('should set rate limit config when API proxy is enabled', () => {
      mockBuildConfigOnce({
        enableApiProxy: true,
      });

      const mockRateLimitConfig = {
        enabled: true,
        rpm: 100,
        rph: 1000,
        bytesPm: 10000,
      };

      (buildRateLimitConfig as jest.Mock).mockReturnValueOnce({
        config: mockRateLimitConfig,
      });

      const result = callAssembleWith();

      expect(result.rateLimitConfig).toEqual(mockRateLimitConfig);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Rate limiting: enabled=true'),
      );
    });
  });

  describe('API proxy configuration', () => {
    it('should log API proxy status when enabled', () => {
      mockBuildConfigOnce({
        enableApiProxy: true,
        openaiApiKey: 'sk-test',
        anthropicApiKey: 'test-key',
      });

      (buildRateLimitConfig as jest.Mock).mockReturnValueOnce({
        config: { enabled: false },
      });

      callAssembleWith();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('API proxy enabled: OpenAI=true, Anthropic=true'),
      );
    });
  });
});
