import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./test-helpers/fs-mock-factory.test-utils').fsMockFactory());

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./host-env', () => require('./test-helpers/fs-mock-factory.test-utils').hostEnvMockFactory());

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./host-identity', () => require('./test-helpers/fs-mock-factory.test-utils').hostIdentityMockFactory());

import { prepareWorkDirectories, workdirSetupTestHelpers } from './workdir-setup';
import { resolveLogPaths } from './log-paths';
import { getRealUserHome } from './host-identity';

function setupWorkdirFixture({ cleanupChrootHome = true } = {}) {
  let tempDir = '';

  const buildConfig = (overrides: Record<string, unknown> = {}) => ({
    workDir: tempDir,
    sslBump: false,
    allowedDomains: [] as string[],
    agentCommand: 'echo test',
    logLevel: 'info' as const,
    keepContainers: false,
    buildLocal: false,
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    ...overrides,
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-setup-test-'));
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    (getRealUserHome as jest.Mock).mockReturnValue(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (cleanupChrootHome) {
      fs.rmSync(`${tempDir}-chroot-home`, { recursive: true, force: true });
    }
  });

  return {
    buildConfig,
    get tempDir() {
      return tempDir;
    },
  };
}

describe('prepareWorkDirectories', () => {
  const fixture = setupWorkdirFixture();
  const { buildConfig } = fixture;

  describe('log/state directory setup', () => {
    it('creates agent logs directory', () => {
      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(logPaths.agentLogs)).toBe(true);
      expect(fs.statSync(logPaths.agentLogs).isDirectory()).toBe(true);
    });

    it('creates session-state directory', () => {
      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(logPaths.sessionState)).toBe(true);
      expect(fs.statSync(logPaths.sessionState).isDirectory()).toBe(true);
    });

    it('creates squid logs directory', () => {
      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(logPaths.squidLogs)).toBe(true);
      expect(fs.statSync(logPaths.squidLogs).isDirectory()).toBe(true);
    });

    it('creates api-proxy logs directory', () => {
      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(logPaths.apiProxyLogs)).toBe(true);
      expect(fs.statSync(logPaths.apiProxyLogs).isDirectory()).toBe(true);
    });

    it('creates cli-proxy logs directory', () => {
      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(logPaths.cliProxyLogs)).toBe(true);
      expect(fs.statSync(logPaths.cliProxyLogs).isDirectory()).toBe(true);
    });

    it('creates /tmp/gh-aw/mcp-logs with mode 0o777', () => {
      const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(mcpLogsDir)).toBe(true);
      const mode = fs.statSync(mcpLogsDir).mode & 0o777;
      expect(mode).toBe(0o777);
    });

    it('forces pre-existing mcp logs directory to mode 0o777', () => {
      const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
      fs.mkdirSync(mcpLogsDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(mcpLogsDir, 0o700);

      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      const mode = fs.statSync(mcpLogsDir).mode & 0o777;
      expect(mode).toBe(0o777);
    });

    it('falls back to world-writable squid logs when squid chown fails', () => {
      const proxyLogsDir = path.join(fixture.tempDir, 'proxy-logs');
      (fs.chownSync as unknown as jest.Mock).mockImplementation((targetPath: fs.PathLike) => {
        if (String(targetPath) === proxyLogsDir) {
          throw new Error('chown failed');
        }
      });

      const config = buildConfig({ proxyLogsDir });
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      const mode = fs.statSync(proxyLogsDir).mode & 0o777;
      expect(mode).toBe(0o777);
    });
  });

  describe('chroot home bind-mount preparation', () => {
    it('creates chroot home directory when it does not exist', () => {
      const emptyHomeDir = `${fixture.tempDir}-chroot-home`;
      expect(fs.existsSync(emptyHomeDir)).toBe(false);

      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(emptyHomeDir)).toBe(true);
      expect(fs.statSync(emptyHomeDir).isDirectory()).toBe(true);
    });

    it('uses existing chroot home directory if already present', () => {
      const emptyHomeDir = `${fixture.tempDir}-chroot-home`;
      fs.mkdirSync(emptyHomeDir, { recursive: true });
      const statBefore = fs.statSync(emptyHomeDir);

      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      const statAfter = fs.statSync(emptyHomeDir);
      expect(statAfter.ino).toBe(statBefore.ino);
    });

    it('creates missing home subdirectories with correct ownership', () => {
      const copilotDir = path.join(fixture.tempDir, '.copilot');
      if (fs.existsSync(copilotDir)) {
        fs.rmSync(copilotDir, { recursive: true, force: true });
      }

      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(copilotDir)).toBe(true);
      expect(fs.chownSync).toHaveBeenCalledWith(copilotDir, 1000, 1000);
    });

    it('creates .gemini directory when geminiApiKey is provided', () => {
      const geminiDir = path.join(fixture.tempDir, '.gemini');
      if (fs.existsSync(geminiDir)) {
        fs.rmSync(geminiDir, { recursive: true, force: true });
      }

      const config = buildConfig({ geminiApiKey: 'test-key' });
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(geminiDir)).toBe(true);
    });

    it('does not create .gemini directory when geminiApiKey is not provided', () => {
      const geminiDir = path.join(fixture.tempDir, '.gemini');
      if (fs.existsSync(geminiDir)) {
        fs.rmSync(geminiDir, { recursive: true, force: true });
      }

      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(geminiDir)).toBe(false);
    });

    it('creates configured runner tool cache directory segments with correct ownership', () => {
      const runnerToolCacheParent = path.join(fixture.tempDir, 'runner-work');
      const runnerToolCachePath = path.join(runnerToolCacheParent, '_tool');
      expect(fs.existsSync(runnerToolCachePath)).toBe(false);

      const config = buildConfig({ runnerToolCachePath });
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(runnerToolCachePath)).toBe(true);
      expect(fs.statSync(runnerToolCachePath).isDirectory()).toBe(true);
      expect(fs.chownSync).toHaveBeenCalledWith(runnerToolCacheParent, 1000, 1000);
      expect(fs.chmodSync).toHaveBeenCalledWith(runnerToolCacheParent, 0o755);
      expect(fs.chownSync).toHaveBeenCalledWith(runnerToolCachePath, 1000, 1000);
      expect(fs.chmodSync).toHaveBeenCalledWith(runnerToolCachePath, 0o755);
    });

    it('throws when runnerToolCachePath contains a pre-existing non-root-owned intermediate symlink', () => {
      const realDir = path.join(fixture.tempDir, 'real-dir');
      const symlinkDir = path.join(fixture.tempDir, 'link-to-real');
      fs.mkdirSync(realDir, { recursive: true });
      fs.symlinkSync(realDir, symlinkDir);
      const runnerToolCachePath = path.join(symlinkDir, 'child');

      const config = buildConfig({ runnerToolCachePath });
      const logPaths = resolveLogPaths(config);

      expect(() => prepareWorkDirectories(config, logPaths)).toThrow(
        `Refusing to use symlink as directory: ${symlinkDir}`
      );
    });

    it('prepares chroot mountpoint for fallback runner tool cache under home', () => {
      const runnerToolCachePath = path.join(fixture.tempDir, 'work', '_tool');
      fs.mkdirSync(runnerToolCachePath, { recursive: true });

      const savedRunnerToolCache = process.env.RUNNER_TOOL_CACHE;
      delete process.env.RUNNER_TOOL_CACHE;
      try {
        const config = buildConfig();
        const logPaths = resolveLogPaths(config);

        prepareWorkDirectories(config, logPaths);
      } finally {
        if (savedRunnerToolCache !== undefined) {
          process.env.RUNNER_TOOL_CACHE = savedRunnerToolCache;
        }
      }

      const chrootWorkDir = path.join(`${fixture.tempDir}-chroot-home`, 'work');
      const chrootToolCacheDir = path.join(chrootWorkDir, '_tool');
      expect(fs.existsSync(chrootToolCacheDir)).toBe(true);
      expect(fs.statSync(chrootToolCacheDir).isDirectory()).toBe(true);
      expect(fs.chownSync).toHaveBeenCalledWith(chrootWorkDir, 1000, 1000);
      expect(fs.chmodSync).toHaveBeenCalledWith(chrootWorkDir, 0o755);
      expect(fs.chownSync).toHaveBeenCalledWith(chrootToolCacheDir, 1000, 1000);
      expect(fs.chmodSync).toHaveBeenCalledWith(chrootToolCacheDir, 0o755);
    });
  });
});

describe('prepareLogDirectories (sub-function)', () => {
  const fixture = setupWorkdirFixture({ cleanupChrootHome: false });
  const { buildConfig } = fixture;

  it('creates all log directories without touching chroot home', () => {
    const config = buildConfig();
    const logPaths = resolveLogPaths(config);
    workdirSetupTestHelpers.prepareLogDirectories(logPaths);

    expect(fs.existsSync(logPaths.agentLogs)).toBe(true);
    expect(fs.existsSync(logPaths.sessionState)).toBe(true);
    expect(fs.existsSync(logPaths.squidLogs)).toBe(true);
    expect(fs.existsSync(logPaths.apiProxyLogs)).toBe(true);
    expect(fs.existsSync(logPaths.cliProxyLogs)).toBe(true);
    // chroot home must NOT have been created
    expect(fs.existsSync(`${fixture.tempDir}-chroot-home`)).toBe(false);
  });
});

describe('prepareChrootHomeMounts (sub-function)', () => {
  const fixture = setupWorkdirFixture();
  const { buildConfig } = fixture;

  it('creates chroot home directory without touching log directories', () => {
    const config = buildConfig();
    const logPaths = resolveLogPaths(config);
    workdirSetupTestHelpers.prepareChrootHomeMounts(config);

    expect(fs.existsSync(`${fixture.tempDir}-chroot-home`)).toBe(true);
    // log directories must NOT have been created
    expect(fs.existsSync(logPaths.agentLogs)).toBe(false);
    expect(fs.existsSync(logPaths.sessionState)).toBe(false);
    expect(fs.existsSync(logPaths.squidLogs)).toBe(false);
    expect(fs.existsSync(logPaths.apiProxyLogs)).toBe(false);
    expect(fs.existsSync(logPaths.cliProxyLogs)).toBe(false);
  });

  it('creates .gemini directory only when geminiApiKey is provided', () => {
    const geminiDir = path.join(fixture.tempDir, '.gemini');

    workdirSetupTestHelpers.prepareChrootHomeMounts(buildConfig({ geminiApiKey: 'key' }));
    expect(fs.existsSync(geminiDir)).toBe(true);

    fs.rmSync(geminiDir, { recursive: true, force: true });

    workdirSetupTestHelpers.prepareChrootHomeMounts(buildConfig());
    expect(fs.existsSync(geminiDir)).toBe(false);
  });
});
