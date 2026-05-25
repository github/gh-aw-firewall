import { generateDockerCompose, WrapperConfig, baseConfig, mockNetworkConfig, useTempWorkDir } from './service-test-setup.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('agent service', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

  describe('proxyLogsDir option', () => {
    it('should use proxyLogsDir when specified', () => {
      const config: WrapperConfig = {
        ...mockConfig,
        proxyLogsDir: '/custom/proxy/logs',
      };
      const result = generateDockerCompose(config, mockNetworkConfig);
      const squid = result.services['squid-proxy'];

      expect(squid.volumes).toContain('/custom/proxy/logs:/var/log/squid:rw');
    });

    it('should use workDir/squid-logs when proxyLogsDir is not specified', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const squid = result.services['squid-proxy'];

      expect(squid.volumes).toContain(`${mockConfig.workDir}/squid-logs:/var/log/squid:rw`);
    });

    it('should use api-proxy-logs subdirectory inside proxyLogsDir when specified', () => {
      const config: WrapperConfig = {
        ...mockConfig,
        proxyLogsDir: '/custom/proxy/logs',
        enableApiProxy: true,
        openaiApiKey: 'sk-test-key',
      };
      const result = generateDockerCompose(config, {
        ...mockNetworkConfig,
        proxyIp: '172.30.0.30',
      });
      const apiProxy = result.services['api-proxy'];

      expect(apiProxy.volumes).toContain('/custom/proxy/logs/api-proxy-logs:/var/log/api-proxy:rw');
    });

    it('should use workDir/api-proxy-logs when proxyLogsDir is not specified', () => {
      const config: WrapperConfig = {
        ...mockConfig,
        enableApiProxy: true,
        openaiApiKey: 'sk-test-key',
      };
      const result = generateDockerCompose(config, {
        ...mockNetworkConfig,
        proxyIp: '172.30.0.30',
      });
      const apiProxy = result.services['api-proxy'];

      expect(apiProxy.volumes).toContain(`${mockConfig.workDir}/api-proxy-logs:/var/log/api-proxy:rw`);
    });
  });
});
