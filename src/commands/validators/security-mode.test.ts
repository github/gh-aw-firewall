import { WrapperConfig } from '../../types';
import { applySecurityMode } from './security-mode';

// Suppress logger output in tests
jest.mock('../../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { logger } from '../../logger';

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    agentCommand: 'echo test',
    logLevel: 'info',
    allowedDomains: ['github.com'],
    blockedDomains: [],
    proxyLogsDir: '/tmp/logs',
    dnsServers: ['8.8.8.8'],
    enableHostAccess: false,
    networkIsolation: false,
    enableApiProxy: false,
    enableDind: false,
    sslBump: false,
    enableDlp: false,
    envAll: false,
    buildLocal: false,
    skipPull: false,
    keepContainers: false,
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    localhostDetected: false,
    ...overrides,
  } as WrapperConfig;
}

describe('applySecurityMode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('strict mode (default)', () => {
    it('should force networkIsolation on', () => {
      const config = makeConfig({ securityMode: 'strict', networkIsolation: false });
      applySecurityMode(config);
      expect(config.networkIsolation).toBe(true);
    });

    it('should force enableApiProxy on', () => {
      const config = makeConfig({ securityMode: 'strict', enableApiProxy: false });
      applySecurityMode(config);
      expect(config.enableApiProxy).toBe(true);
    });

    it('should be the default when securityMode is undefined', () => {
      const config = makeConfig({ securityMode: undefined, networkIsolation: false, enableApiProxy: false });
      applySecurityMode(config);
      expect(config.networkIsolation).toBe(true);
      expect(config.enableApiProxy).toBe(true);
    });

    it('should override enableHostAccess with warning', () => {
      const config = makeConfig({ enableHostAccess: true });
      applySecurityMode(config);
      expect(config.enableHostAccess).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--enable-host-access was ignored'),
      );
    });

    it('should override enableDind with warning', () => {
      const config = makeConfig({ enableDind: true });
      applySecurityMode(config);
      expect(config.enableDind).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--enable-dind was ignored'),
      );
    });

    it('should override dnsOverHttps with warning', () => {
      const config = makeConfig({ dnsOverHttps: 'https://dns.google/dns-query' });
      applySecurityMode(config);
      expect(config.dnsOverHttps).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--dns-over-https was ignored'),
      );
    });

    it('should warn that --security-mode compat is required for overridden options', () => {
      const config = makeConfig({ enableHostAccess: true, enableDind: true });
      applySecurityMode(config);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--security-mode compat'),
      );
    });

    it('should not warn when compatible options are already set', () => {
      const config = makeConfig({
        securityMode: 'strict',
        networkIsolation: true,
        enableApiProxy: true,
        enableHostAccess: false,
        enableDind: false,
      });
      applySecurityMode(config);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('compat mode', () => {
    it('should not modify any config values', () => {
      const config = makeConfig({
        securityMode: 'compat',
        networkIsolation: false,
        enableApiProxy: false,
        enableHostAccess: true,
        enableDind: true,
      });
      applySecurityMode(config);
      expect(config.networkIsolation).toBe(false);
      expect(config.enableApiProxy).toBe(false);
      expect(config.enableHostAccess).toBe(true);
      expect(config.enableDind).toBe(true);
    });

    it('should log info about compat mode', () => {
      const config = makeConfig({ securityMode: 'compat' });
      applySecurityMode(config);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('compat security mode'),
      );
    });
  });
});
