import { validateNetworkOptions } from './network-options';

// Mock the logger
jest.mock('../../logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock option-parsers for checkDockerHost and resolveDockerHostPathPrefix
jest.mock('../../option-parsers', () => ({
  checkDockerHost: jest.fn(),
  resolveDockerHostPathPrefix: jest.fn(),
}));

// Mock preflight for domain resolution
jest.mock('../preflight', () => ({
  resolveAllowedDomains: jest.fn(),
  resolveBlockedDomains: jest.fn(),
}));

// Mock network-setup for network config
jest.mock('../network-setup', () => ({
  resolveNetworkConfig: jest.fn(),
}));

import { logger } from '../../logger';
import { checkDockerHost, resolveDockerHostPathPrefix } from '../../option-parsers';
import { resolveAllowedDomains, resolveBlockedDomains } from '../preflight';
import { resolveNetworkConfig } from '../network-setup';

const mockCheckDockerHost = checkDockerHost as jest.Mock;
const mockResolveDockerHostPathPrefix = resolveDockerHostPathPrefix as jest.Mock;
const mockResolveAllowedDomains = resolveAllowedDomains as jest.Mock;
const mockResolveBlockedDomains = resolveBlockedDomains as jest.Mock;
const mockResolveNetworkConfig = resolveNetworkConfig as jest.Mock;

function makeDefaultMocks() {
  mockCheckDockerHost.mockReturnValue({ valid: true });
  mockResolveDockerHostPathPrefix.mockReturnValue({
    dockerHostPathPrefix: undefined,
    autoApplied: false,
    dindHint: false,
  });
  mockResolveAllowedDomains.mockReturnValue({
    allowedDomains: ['example.com'],
    localhostResult: { enableHostAccess: false, hostPorts: [] },
    resolvedCopilotApiTarget: undefined,
    resolvedCopilotApiBasePath: undefined,
  });
  mockResolveBlockedDomains.mockReturnValue([]);
  mockResolveNetworkConfig.mockReturnValue({
    upstreamProxy: undefined,
    dnsServers: ['8.8.8.8'],
    dnsOverHttps: undefined,
  });
}

describe('validateNetworkOptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    makeDefaultMocks();
  });

  describe('happy path', () => {
    it('returns all resolved values from dependencies', () => {
      const result = validateNetworkOptions({ allowDomains: 'example.com' });

      expect(result.dockerHostCheck).toEqual({ valid: true });
      expect(result.allowedDomains).toEqual(['example.com']);
      expect(result.blockedDomains).toEqual([]);
      expect(result.dnsServers).toEqual(['8.8.8.8']);
      expect(result.upstreamProxy).toBeUndefined();
      expect(result.dnsOverHttps).toBeUndefined();
      expect(result.localhostResult).toBeDefined();
    });

    it('passes options to resolveAllowedDomains and resolveNetworkConfig', () => {
      const options = { allowDomains: 'github.com', dnsServers: '1.1.1.1' };
      validateNetworkOptions(options);

      expect(mockResolveAllowedDomains).toHaveBeenCalledWith(options);
      expect(mockResolveNetworkConfig).toHaveBeenCalledWith(options);
    });

    it('passes dockerHostCheck and dockerHostPathPrefix to resolveDockerHostPathPrefix', () => {
      const options = { dockerHostPathPrefix: '/host' };
      mockResolveDockerHostPathPrefix.mockReturnValue({
        dockerHostPathPrefix: '/host',
        autoApplied: false,
        dindHint: false,
      });

      const result = validateNetworkOptions(options);

      expect(mockResolveDockerHostPathPrefix).toHaveBeenCalledWith(
        { valid: true },
        '/host',
      );
      expect(result.dockerHostPathPrefixResolution.dockerHostPathPrefix).toBe('/host');
    });
  });

  describe('external DOCKER_HOST warnings (lines 50-53)', () => {
    it('emits two warnings when DOCKER_HOST is external (checkDockerHost valid=false)', () => {
      mockCheckDockerHost.mockReturnValue({
        valid: false,
        error: 'DOCKER_HOST is set to an external daemon',
      });
      mockResolveDockerHostPathPrefix.mockReturnValue({
        dockerHostPathPrefix: '/host',
        autoApplied: false,
        dindHint: false,
      });

      validateNetworkOptions({});

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('External DOCKER_HOST detected'),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('original DOCKER_HOST'),
      );
    });

    it('does not emit external-host warnings when DOCKER_HOST is valid', () => {
      validateNetworkOptions({});

      const warnCalls = (logger.warn as jest.Mock).mock.calls.map((c: string[]) => c[0]);
      expect(warnCalls.some((m: string) => m.includes('External DOCKER_HOST'))).toBe(false);
    });
  });

  describe('missing path-prefix warning (line 62)', () => {
    it('emits split-filesystem warning when external host and no prefix', () => {
      mockCheckDockerHost.mockReturnValue({ valid: false, error: 'external daemon' });
      mockResolveDockerHostPathPrefix.mockReturnValue({
        dockerHostPathPrefix: undefined,
        autoApplied: false,
        dindHint: false,
      });

      validateNetworkOptions({});

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('split runner/daemon filesystem'),
      );
    });

    it('does not emit split-filesystem warning when prefix is provided', () => {
      mockCheckDockerHost.mockReturnValue({ valid: false, error: 'external daemon' });
      mockResolveDockerHostPathPrefix.mockReturnValue({
        dockerHostPathPrefix: '/host',
        autoApplied: false,
        dindHint: false,
      });

      validateNetworkOptions({});

      const warnCalls = (logger.warn as jest.Mock).mock.calls.map((c: string[]) => c[0]);
      expect(warnCalls.some((m: string) => m.includes('split runner/daemon filesystem'))).toBe(false);
    });

    it('does not emit split-filesystem warning when docker host is valid', () => {
      // valid=true AND no prefix: should NOT warn about split filesystem
      mockResolveDockerHostPathPrefix.mockReturnValue({
        dockerHostPathPrefix: undefined,
        autoApplied: false,
        dindHint: false,
      });

      validateNetworkOptions({});

      const warnCalls = (logger.warn as jest.Mock).mock.calls.map((c: string[]) => c[0]);
      expect(warnCalls.some((m: string) => m.includes('split runner/daemon filesystem'))).toBe(false);
    });
  });

  describe('DinD hint warnings (lines 66-78)', () => {
    it('emits four DinD hint warnings when dindHint=true and no prefix', () => {
      mockResolveDockerHostPathPrefix.mockReturnValue({
        dockerHostPathPrefix: undefined,
        autoApplied: false,
        dindHint: true,
      });

      validateNetworkOptions({});

      const warnCalls = (logger.warn as jest.Mock).mock.calls.map((c: string[]) => c[0]);
      expect(warnCalls.some((m: string) => m.includes('Non-standard DOCKER_HOST unix socket'))).toBe(true);
      expect(warnCalls.some((m: string) => m.includes('runner and Docker daemon have separate root filesystems'))).toBe(true);
      expect(warnCalls.some((m: string) => m.includes('docker-host-path-prefix'))).toBe(true);
    });

    it('does not emit DinD hint warnings when dindHint=false', () => {
      mockResolveDockerHostPathPrefix.mockReturnValue({
        dockerHostPathPrefix: undefined,
        autoApplied: false,
        dindHint: false,
      });

      validateNetworkOptions({});

      const warnCalls = (logger.warn as jest.Mock).mock.calls.map((c: string[]) => c[0]);
      expect(warnCalls.some((m: string) => m.includes('Non-standard DOCKER_HOST'))).toBe(false);
    });

    it('does not emit DinD hint warnings when prefix is provided despite dindHint=true', () => {
      mockResolveDockerHostPathPrefix.mockReturnValue({
        dockerHostPathPrefix: '/tmp/gh-aw',
        autoApplied: false,
        dindHint: true,
      });

      validateNetworkOptions({});

      const warnCalls = (logger.warn as jest.Mock).mock.calls.map((c: string[]) => c[0]);
      expect(warnCalls.some((m: string) => m.includes('Non-standard DOCKER_HOST'))).toBe(false);
    });
  });

  describe('return value shape', () => {
    it('includes resolvedCopilotApiTarget and resolvedCopilotApiBasePath', () => {
      mockResolveAllowedDomains.mockReturnValue({
        allowedDomains: ['api.github.com'],
        localhostResult: { enableHostAccess: false, hostPorts: [] },
        resolvedCopilotApiTarget: 'https://api.github.com',
        resolvedCopilotApiBasePath: '/v1',
      });

      const result = validateNetworkOptions({});

      expect(result.resolvedCopilotApiTarget).toBe('https://api.github.com');
      expect(result.resolvedCopilotApiBasePath).toBe('/v1');
    });

    it('includes upstream proxy configuration', () => {
      mockResolveNetworkConfig.mockReturnValue({
        upstreamProxy: { host: 'proxy.corp.example.com', port: 3128 },
        dnsServers: ['8.8.8.8'],
        dnsOverHttps: undefined,
      });

      const result = validateNetworkOptions({});

      expect(result.upstreamProxy).toEqual({ host: 'proxy.corp.example.com', port: 3128 });
    });

    it('includes DNS-over-HTTPS when configured', () => {
      mockResolveNetworkConfig.mockReturnValue({
        upstreamProxy: undefined,
        dnsServers: ['8.8.8.8'],
        dnsOverHttps: 'https://1.1.1.1/dns-query',
      });

      const result = validateNetworkOptions({});

      expect(result.dnsOverHttps).toBe('https://1.1.1.1/dns-query');
    });
  });
});
