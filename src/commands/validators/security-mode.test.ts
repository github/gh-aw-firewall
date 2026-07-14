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

jest.mock('../../container-runtime', () => ({
  runtimeUsesComposeAgent: jest.fn().mockReturnValue(true),
}));

import { logger } from '../../logger';
import { runtimeUsesComposeAgent } from '../../container-runtime';

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    agentCommand: 'echo test',
    logLevel: 'info',
    allowedDomains: ['github.com'],
    blockedDomains: [],
    proxyLogsDir: '/tmp/logs',
    dnsServers: ['8.8.8.8'],
    enableHostAccess: false,
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
  let mockExit: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (runtimeUsesComposeAgent as jest.Mock).mockReturnValue(true);
    mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    mockExit.mockRestore();
  });

  describe('strict security (default)', () => {
    it('should force networkIsolation on when undefined', () => {
      const config = makeConfig({ networkIsolation: undefined });
      applySecurityMode(config);
      expect(config.networkIsolation).toBe(true);
    });

    it('should force networkIsolation on and warn when explicitly disabled', () => {
      const config = makeConfig({ networkIsolation: false });
      applySecurityMode(config);
      expect(config.networkIsolation).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--no-network-isolation was ignored'),
      );
    });

    it('should always force enableApiProxy on', () => {
      const config = makeConfig({ enableApiProxy: undefined });
      applySecurityMode(config);
      expect(config.enableApiProxy).toBe(true);
    });

    it('should exit when --no-enable-api-proxy is passed', () => {
      const config = makeConfig({ enableApiProxy: false });
      expect(() => applySecurityMode(config)).toThrow('process.exit(1)');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--no-enable-api-proxy is not allowed'),
      );
    });

    it('should warn when --enable-api-proxy is explicitly passed', () => {
      const config = makeConfig({ enableApiProxy: true });
      applySecurityMode(config);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--enable-api-proxy is deprecated'),
      );
      expect(config.enableApiProxy).toBe(true);
    });

    it('should be the default when legacySecurity is undefined', () => {
      const config = makeConfig({ legacySecurity: undefined });
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

    it('should clear allowHostServicePorts when set', () => {
      const config = makeConfig({ allowHostServicePorts: '5432,6379' });
      applySecurityMode(config);
      expect(config.allowHostServicePorts).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--allow-host-service-ports was ignored'),
      );
    });

    it('should clear allowHostServicePorts and allowHostPorts alongside enableHostAccess', () => {
      const config = makeConfig({
        enableHostAccess: true,
        allowHostPorts: '3000,8080',
        allowHostServicePorts: '5432',
      });
      applySecurityMode(config);
      expect(config.enableHostAccess).toBe(false);
      expect(config.allowHostPorts).toBeUndefined();
      expect(config.allowHostServicePorts).toBeUndefined();
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

    it('should warn that --legacy-security is required for overridden options', () => {
      const config = makeConfig({ enableHostAccess: true, enableDind: true });
      applySecurityMode(config);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--legacy-security'),
      );
    });

    it('should not warn when compatible options are already set', () => {
      const config = makeConfig({
        networkIsolation: true,
        enableHostAccess: false,
        enableDind: false,
      });
      applySecurityMode(config);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    describe('microVM runtime (sbx)', () => {
      beforeEach(() => {
        (runtimeUsesComposeAgent as jest.Mock).mockReturnValue(false);
      });

      it('should skip network-isolation enforcement for microVM runtimes', () => {
        const config = makeConfig({ containerRuntime: 'sbx' });
        applySecurityMode(config);
        expect(config.networkIsolation).toBeUndefined();
      });

      it('should still enforce api-proxy for microVM runtimes', () => {
        const config = makeConfig({ containerRuntime: 'sbx' });
        applySecurityMode(config);
        expect(config.enableApiProxy).toBe(true);
      });
    });
  });

  describe('legacy security mode', () => {
    it('should not override host-access or dind', () => {
      const config = makeConfig({
        legacySecurity: true,
        networkIsolation: false,
        enableHostAccess: true,
        enableDind: true,
      });
      applySecurityMode(config);
      expect(config.networkIsolation).toBe(false);
      expect(config.enableHostAccess).toBe(true);
      expect(config.enableDind).toBe(true);
    });

    it('should still force api-proxy on in legacy mode', () => {
      const config = makeConfig({ legacySecurity: true });
      applySecurityMode(config);
      expect(config.enableApiProxy).toBe(true);
    });

    it('should log info about legacy security mode', () => {
      const config = makeConfig({ legacySecurity: true });
      applySecurityMode(config);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('legacy security mode'),
      );
    });
  });
});
