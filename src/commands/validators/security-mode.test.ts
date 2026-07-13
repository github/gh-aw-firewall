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
    // networkIsolation and enableApiProxy are intentionally left undefined here
    // to match the CLI default behaviour — users who do not explicitly pass
    // --network-isolation or --enable-api-proxy will have undefined, not false.
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
    (runtimeUsesComposeAgent as jest.Mock).mockReturnValue(true);
  });

  describe('strict mode (default)', () => {
    it('should force networkIsolation on when undefined (not explicitly set)', () => {
      const config = makeConfig({ securityMode: 'strict', networkIsolation: undefined });
      applySecurityMode(config);
      expect(config.networkIsolation).toBe(true);
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('--no-network-isolation'),
      );
    });

    it('should force networkIsolation on and warn when explicitly disabled', () => {
      const config = makeConfig({ securityMode: 'strict', networkIsolation: false });
      applySecurityMode(config);
      expect(config.networkIsolation).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--no-network-isolation was ignored'),
      );
    });

    it('should force enableApiProxy on when undefined (not explicitly set)', () => {
      const config = makeConfig({ securityMode: 'strict', enableApiProxy: undefined });
      applySecurityMode(config);
      expect(config.enableApiProxy).toBe(true);
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('--no-enable-api-proxy'),
      );
    });

    it('should force enableApiProxy on and warn when explicitly disabled', () => {
      const config = makeConfig({ securityMode: 'strict', enableApiProxy: false });
      applySecurityMode(config);
      expect(config.enableApiProxy).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--no-enable-api-proxy was ignored'),
      );
    });

    it('should be the default when securityMode is undefined', () => {
      const config = makeConfig({ securityMode: undefined });
      applySecurityMode(config);
      expect(config.networkIsolation).toBe(true);
      expect(config.enableApiProxy).toBe(true);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should override enableHostAccess with warning', () => {
      const config = makeConfig({ enableHostAccess: true });
      applySecurityMode(config);
      expect(config.enableHostAccess).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--enable-host-access was ignored'),
      );
    });

    it('should clear allowHostServicePorts when set (prevents downstream re-enable of host access)', () => {
      const config = makeConfig({ allowHostServicePorts: '5432,6379' });
      applySecurityMode(config);
      expect(config.allowHostServicePorts).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--allow-host-service-ports was ignored'),
      );
    });

    it('should clear allowHostServicePorts and allowHostPorts set alongside enableHostAccess', () => {
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

    describe('microVM runtime (sbx)', () => {
      beforeEach(() => {
        (runtimeUsesComposeAgent as jest.Mock).mockReturnValue(false);
      });

      it('should skip network-isolation enforcement for microVM runtimes', () => {
        const config = makeConfig({ securityMode: 'strict', containerRuntime: 'sbx' });
        applySecurityMode(config);
        expect(config.networkIsolation).toBeUndefined();
        expect(logger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('network-isolation'),
        );
      });

      it('should still enforce api-proxy for microVM runtimes', () => {
        const config = makeConfig({ securityMode: 'strict', containerRuntime: 'sbx' });
        applySecurityMode(config);
        expect(config.enableApiProxy).toBe(true);
      });
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
