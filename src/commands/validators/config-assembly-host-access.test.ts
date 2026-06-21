import {
  applyHostServicePortsConfig,
  assembleAndValidateConfig,
  createMinimalAgentOptions,
  createMinimalLogAndLimits,
  createMinimalNetworkOptions,
  logger,
  mockBuildConfigOnce,
  setupConfigAssemblyTestSuite,
  validateAllowHostPorts,
} from './config-assembly.test-utils';

describe('config-assembly', () => {
  setupConfigAssemblyTestSuite();

  describe('host service ports validation', () => {
    it('should exit if service ports validation fails', () => {
      (applyHostServicePortsConfig as jest.Mock).mockReturnValueOnce({
        valid: false,
        error: 'Invalid port format',
      });

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          createMinimalLogAndLimits(),
          createMinimalNetworkOptions(),
          createMinimalAgentOptions(),
        );
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid port format'),
      );
    });

    it('should apply enableHostAccess from service ports result', () => {
      (applyHostServicePortsConfig as jest.Mock).mockReturnValueOnce({
        valid: true,
        enableHostAccess: true,
      });

      const result = assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        createMinimalNetworkOptions(),
        createMinimalAgentOptions(),
      );

      expect(result.enableHostAccess).toBe(true);
    });
  });

  describe('host ports validation', () => {
    it('should exit if --allow-host-ports is used without --enable-host-access', () => {
      (validateAllowHostPorts as jest.Mock).mockReturnValueOnce({
        valid: false,
        error: '--allow-host-ports requires --enable-host-access',
      });

      expect(() => {
        assembleAndValidateConfig(
          {},
          'echo test',
          createMinimalLogAndLimits(),
          createMinimalNetworkOptions(),
          createMinimalAgentOptions(),
        );
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--allow-host-ports requires --enable-host-access'),
      );
    });
  });

  describe('host access warnings', () => {
    it('should warn when host access is enabled with host.docker.internal', () => {
      mockBuildConfigOnce({
        enableHostAccess: true,
      });

      (applyHostServicePortsConfig as jest.Mock).mockReturnValueOnce({
        valid: true,
        enableHostAccess: true,
      });

      const networkOptions = createMinimalNetworkOptions();
      networkOptions.allowedDomains = ['host.docker.internal'];

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        networkOptions,
        createMinimalAgentOptions(),
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Host access enabled with host.docker.internal'),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Containers can access ANY service'),
      );
    });

    it('should warn when host access is enabled with subdomain of host.docker.internal', () => {
      mockBuildConfigOnce({
        enableHostAccess: true,
      });

      (applyHostServicePortsConfig as jest.Mock).mockReturnValueOnce({
        valid: true,
        enableHostAccess: true,
      });

      const networkOptions = createMinimalNetworkOptions();
      networkOptions.allowedDomains = ['api.host.docker.internal'];

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        networkOptions,
        createMinimalAgentOptions(),
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Host access enabled with host.docker.internal'),
      );
    });

    it('should not warn when host access is enabled without host.docker.internal', () => {
      mockBuildConfigOnce({
        enableHostAccess: true,
      });

      (applyHostServicePortsConfig as jest.Mock).mockReturnValueOnce({
        valid: true,
        enableHostAccess: true,
      });

      const networkOptions = createMinimalNetworkOptions();
      networkOptions.allowedDomains = ['example.com'];

      assembleAndValidateConfig(
        {},
        'echo test',
        createMinimalLogAndLimits(),
        networkOptions,
        createMinimalAgentOptions(),
      );

      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Host access enabled with host.docker.internal'),
      );
    });
  });
});
