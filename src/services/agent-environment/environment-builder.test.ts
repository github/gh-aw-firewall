import { buildAgentEnvironment } from './environment-builder';
import { AgentEnvironmentParams } from './types';
import { ENV_SIZE_WARNING_THRESHOLD } from '../../constants';

// Mock the logger
jest.mock('../../logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock all sub-builders to avoid deep dependency chains
jest.mock('./api-proxy-environment', () => ({
  buildApiProxyEnvironment: jest.fn(),
}));
jest.mock('./core-environment', () => ({
  buildCoreEnvironment: jest.fn(() => ({})),
}));
jest.mock('./env-passthrough', () => ({
  passthroughHostEnvironment: jest.fn(),
}));
jest.mock('./excluded-vars', () => ({
  buildExclusionSet: jest.fn(() => new Set<string>()),
}));
jest.mock('./github-actions-environment', () => ({
  buildGitHubActionsEnvironment: jest.fn(),
}));
jest.mock('./host-path-recovery', () => ({
  recoverHostPaths: jest.fn(),
}));
jest.mock('./observability-environment', () => ({
  buildOtelEnvironment: jest.fn(),
  buildSslEnvironment: jest.fn(),
}));
jest.mock('./proxy-environment', () => ({
  buildProxyEnvironment: jest.fn(),
}));
jest.mock('./tool-specific-environment', () => ({
  buildToolEnvironment: jest.fn(),
}));

import { logger } from '../../logger';
import { buildCoreEnvironment } from './core-environment';
import { buildExclusionSet } from './excluded-vars';
import { withEnv } from '../service-test-setup.test-utils';

const mockBuildCoreEnvironment = buildCoreEnvironment as jest.Mock;

function makeParams(overrides: Partial<AgentEnvironmentParams['config']> = {}): AgentEnvironmentParams {
  return {
    config: {
      allowDomains: 'example.com',
      agentCommand: 'echo test',
      workDir: '/tmp/awf-test',
      ...overrides,
    } as AgentEnvironmentParams['config'],
    networkConfig: {
      subnet: '172.30.0.0/24',
      squidIp: '172.30.0.10',
      agentIp: '172.30.0.20',
    } as AgentEnvironmentParams['networkConfig'],
    dnsServers: ['8.8.8.8'],
  };
}

describe('buildAgentEnvironment', () => {
  let originalTmpDir: string | undefined;

  beforeAll(() => {
    originalTmpDir = process.env.TMPDIR;
    delete process.env.TMPDIR;
  });

  afterAll(() => {
    if (originalTmpDir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpDir;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: core environment returns empty object
    mockBuildCoreEnvironment.mockReturnValue({});
    jest.mocked(buildExclusionSet).mockReturnValue(new Set<string>());
  });

  describe('host TMPDIR warning', () => {
    it.each([
      { hostTmpDir: '/tmp/gh-aw-runtime-private', envAll: true, excluded: false, explicit: undefined, warns: true },
      { hostTmpDir: undefined, envAll: true, excluded: false, explicit: undefined, warns: false },
      { hostTmpDir: '', envAll: true, excluded: false, explicit: undefined, warns: false },
      { hostTmpDir: '/tmp', envAll: true, excluded: false, explicit: undefined, warns: false },
      { hostTmpDir: '/tmp/gh-aw-runtime-private', envAll: false, excluded: false, explicit: undefined, warns: false },
      { hostTmpDir: '/tmp/gh-aw-runtime-private', envAll: true, excluded: true, explicit: undefined, warns: false },
      { hostTmpDir: '/tmp/gh-aw-runtime-private', envAll: true, excluded: false, explicit: '/tmp/gh-aw/temp', warns: false },
    ])('warns=$warns for host=$hostTmpDir, envAll=$envAll, excluded=$excluded, explicit=$explicit',
      ({ hostTmpDir, envAll, excluded, explicit, warns }) => {
        if (excluded) jest.mocked(buildExclusionSet).mockReturnValue(new Set(['TMPDIR']));
        if (explicit !== undefined) mockBuildCoreEnvironment.mockReturnValue({ TMPDIR: explicit });

        withEnv({ TMPDIR: hostTmpDir }, () => {
          const result = buildAgentEnvironment(makeParams({ envAll }));
          expect(result.TMPDIR).toBe(explicit ?? '/tmp');
          expect(process.env.TMPDIR).toBe(hostTmpDir);
        });

        if (warns) {
          expect(logger.warn).toHaveBeenCalledTimes(1);
          expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Host TMPDIR is not forwarded by --env-all'));
          expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining(hostTmpDir!));
        } else {
          expect(logger.warn).not.toHaveBeenCalled();
        }
      });
  });

  describe('warnLargeEnvironmentIfNeeded', () => {
    it('does not warn when envAll is falsy', () => {
      const params = makeParams({ envAll: false });
      mockBuildCoreEnvironment.mockReturnValue({ LARGE: 'x'.repeat(2_000_000) });

      buildAgentEnvironment(params);

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not warn when envAll is undefined', () => {
      const params = makeParams({ envAll: undefined });
      mockBuildCoreEnvironment.mockReturnValue({ LARGE: 'x'.repeat(2_000_000) });

      buildAgentEnvironment(params);

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not warn when envAll is true but environment is small', () => {
      const params = makeParams({ envAll: true });
      mockBuildCoreEnvironment.mockReturnValue({ SMALL: 'value' });

      buildAgentEnvironment(params);

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('warns when envAll=true and environment exceeds ENV_SIZE_WARNING_THRESHOLD (lines 39-43)', () => {
      const params = makeParams({ envAll: true });
      // Build an environment that exceeds the 1.5 MB threshold
      const largeValue = 'x'.repeat(ENV_SIZE_WARNING_THRESHOLD + 1000);
      mockBuildCoreEnvironment.mockReturnValue({ LARGE_VAR: largeValue });

      buildAgentEnvironment(params);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Total container environment size'),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--exclude-env'),
      );
    });

    it('warning message includes size in KB', () => {
      const params = makeParams({ envAll: true });
      const sizeBytes = ENV_SIZE_WARNING_THRESHOLD + 500_000;
      mockBuildCoreEnvironment.mockReturnValue({ BIG: 'x'.repeat(sizeBytes) });

      buildAgentEnvironment(params);

      const warnCall = (logger.warn as jest.Mock).mock.calls.find(
        (c: string[]) => c[0].includes('Total container environment size')
      );
      expect(warnCall).toBeDefined();
      expect(warnCall[0]).toMatch(/\d+ KB/);
    });
  });

  describe('return value', () => {
    it('returns the environment object assembled by core builder', () => {
      const params = makeParams();
      mockBuildCoreEnvironment.mockReturnValue({ MY_VAR: 'hello' });

      const result = buildAgentEnvironment(params);

      expect(result).toMatchObject({ MY_VAR: 'hello' });
    });
  });
});
