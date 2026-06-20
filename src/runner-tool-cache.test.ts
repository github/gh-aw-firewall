import * as fs from 'fs';
import { resolveRunnerToolCachePath } from './runner-tool-cache';
import { WrapperConfig } from './types';

jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;

const baseConfig: Partial<WrapperConfig> = {
  allowedDomains: ['example.com'],
  agentCommand: 'echo hi',
  logLevel: 'info',
  keepContainers: false,
  workDir: '/tmp/test',
  imageRegistry: 'ghcr.io',
  imageTag: 'latest',
  buildLocal: false,
};

describe('resolveRunnerToolCachePath', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.RUNNER_TOOL_CACHE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns config.runnerToolCachePath when it is a directory', () => {
    mockFs.lstatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
    const config = { ...baseConfig, runnerToolCachePath: '/custom/tool/cache' } as WrapperConfig;
    expect(resolveRunnerToolCachePath(config, '/home/user')).toBe('/custom/tool/cache');
  });

  it('returns RUNNER_TOOL_CACHE env var path when config has no override and it is a directory', () => {
    process.env.RUNNER_TOOL_CACHE = '/runner/tool/cache';
    // config.runnerToolCachePath is undefined → skipped without calling lstatSync
    // First lstatSync call is for RUNNER_TOOL_CACHE
    mockFs.lstatSync.mockReturnValueOnce({ isDirectory: () => true } as fs.Stats);
    const config = { ...baseConfig } as WrapperConfig;
    expect(resolveRunnerToolCachePath(config, '/home/user')).toBe('/runner/tool/cache');
  });

  it('returns the effectiveHome/work/_tool fallback when it is a directory', () => {
    // Invalid RUNNER_TOOL_CACHE (or non-directory) should fall back to effectiveHome/work/_tool when that path is a directory
    mockFs.lstatSync
      .mockImplementationOnce(() => { throw new Error('not found'); }) // env var path fails
      .mockReturnValueOnce({ isDirectory: () => true } as fs.Stats);   // fallback is a dir
    process.env.RUNNER_TOOL_CACHE = '/nonexistent/path';
    const config = { ...baseConfig } as WrapperConfig;
    expect(resolveRunnerToolCachePath(config, '/home/user')).toBe('/home/user/work/_tool');
  });

  it('returns undefined when no candidate is a directory', () => {
    mockFs.lstatSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const config = { ...baseConfig } as WrapperConfig;
    expect(resolveRunnerToolCachePath(config, '/home/user')).toBeUndefined();
  });

  it('returns undefined when all lstatSync calls return non-directory', () => {
    mockFs.lstatSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
    process.env.RUNNER_TOOL_CACHE = '/some/path';
    const config = { ...baseConfig, runnerToolCachePath: '/custom/path' } as WrapperConfig;
    expect(resolveRunnerToolCachePath(config, '/home/user')).toBeUndefined();
  });

  it('skips undefined/null candidates and moves to next', () => {
    process.env.RUNNER_TOOL_CACHE = '/env/tool/cache';
    mockFs.lstatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
    const config = { ...baseConfig } as WrapperConfig; // runnerToolCachePath is undefined
    expect(resolveRunnerToolCachePath(config, '/home/user')).toBe('/env/tool/cache');
  });

  it('prefers config.runnerToolCachePath over RUNNER_TOOL_CACHE env', () => {
    process.env.RUNNER_TOOL_CACHE = '/env/cache';
    mockFs.lstatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
    const config = { ...baseConfig, runnerToolCachePath: '/config/cache' } as WrapperConfig;
    expect(resolveRunnerToolCachePath(config, '/home/user')).toBe('/config/cache');
  });
});
