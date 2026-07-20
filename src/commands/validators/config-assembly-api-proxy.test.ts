import {
  assembleAndValidateConfig,
  buildConfig,
  buildRateLimitConfig,
  callAssembleWith,
  createMinimalAgentOptions,
  createMinimalLogAndLimits,
  createMinimalNetworkOptions,
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

    // Note: "rate limit flags without --enable-api-proxy" scenario cannot occur
    // in production (API proxy is always enabled), but we test the validation
    // path for completeness.
    it('should exit if rate limit flags are invalid', () => {
      mockBuildConfigOnce({
        enableApiProxy: true,
      });

      (validateRateLimitFlags as jest.Mock).mockReturnValueOnce({
        valid: false,
        error: '--rate-limit-rpm requires --enable-api-proxy',
      });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--rate-limit-rpm requires --enable-api-proxy'),
      );
    });

    it('should set rate limit config when API proxy is enabled', () => {
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

  describe('model policy config assembly handoff', () => {
    it('passes allowedModels and disallowedModels from logAndLimits into buildConfig', () => {
      const logAndLimits = {
        ...createMinimalLogAndLimits(),
        allowedModels: ['gpt-5.6-sol', 'claude-sonnet-*'],
        disallowedModels: ['gpt-4*'],
      };

      assembleAndValidateConfig(
        {},
        'echo test',
        logAndLimits,
        createMinimalNetworkOptions(),
        createMinimalAgentOptions(),
      );

      const buildConfigArgs = (buildConfig as jest.Mock).mock.calls[0][0];
      expect(buildConfigArgs.allowedModels).toEqual(['gpt-5.6-sol', 'claude-sonnet-*']);
      expect(buildConfigArgs.disallowedModels).toEqual(['gpt-4*']);
    });
  });
});
