import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./test-helpers/fs-mock-factory.test-utils').fsMockFactory());

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./host-env', () => require('./test-helpers/fs-mock-factory.test-utils').hostEnvMockFactory());

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./host-identity', () => require('./test-helpers/fs-mock-factory.test-utils').hostIdentityMockFactory());

const actualFs = jest.requireActual<typeof import('fs')>('fs');

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
    // Restore chmodSync to its default passthrough (clearAllMocks doesn't reset implementations)
    (fs.chmodSync as jest.Mock).mockImplementation(
      (...args: Parameters<typeof actualFs.chmodSync>) => actualFs.chmodSync(...args),
    );
    (fs.mkdirSync as jest.Mock).mockImplementation(
      (...args: Parameters<typeof actualFs.mkdirSync>) => actualFs.mkdirSync(...args),
    );
    (fs.accessSync as jest.Mock).mockImplementation(
      (...args: Parameters<typeof actualFs.accessSync>) => actualFs.accessSync(...args),
    );
    (getRealUserHome as jest.Mock).mockReturnValue(tempDir);
  });

  afterEach(() => {
    if (!tempDir) {
      return;
    }

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

    it('does not throw when chmod on pre-existing mcp-logs dir fails with EPERM', () => {
      const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
      fs.mkdirSync(mcpLogsDir, { recursive: true, mode: 0o700 });

      // Simulate EPERM: directory owned by another user (e.g., MCP gateway)
      const eperm = new Error("EPERM: operation not permitted, chmod '/tmp/gh-aw/mcp-logs'") as NodeJS.ErrnoException;
      eperm.code = 'EPERM';
      (fs.chmodSync as jest.Mock).mockImplementation((target: fs.PathLike, mode: fs.Mode) => {
        if (target === mcpLogsDir) throw eperm;
        actualFs.chmodSync(target, mode);
      });

      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      expect(() => prepareWorkDirectories(config, logPaths)).not.toThrow();
    });

    it('does not throw when chmod on pre-existing mcp-logs dir fails with EROFS', () => {
      const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
      fs.mkdirSync(mcpLogsDir, { recursive: true, mode: 0o700 });

      const erofs = new Error("EROFS: read-only file system, chmod '/tmp/gh-aw/mcp-logs'") as NodeJS.ErrnoException;
      erofs.code = 'EROFS';
      (fs.chmodSync as jest.Mock).mockImplementation((target: fs.PathLike, mode: fs.Mode) => {
        if (target === mcpLogsDir) throw erofs;
        actualFs.chmodSync(target, mode);
      });

      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      expect(() => prepareWorkDirectories(config, logPaths)).not.toThrow();
    });

    it('rethrows non-EPERM/EROFS errors when chmod on pre-existing mcp-logs dir fails', () => {
      const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
      fs.mkdirSync(mcpLogsDir, { recursive: true, mode: 0o700 });

      const eio = new Error("EIO: i/o error, chmod '/tmp/gh-aw/mcp-logs'") as NodeJS.ErrnoException;
      eio.code = 'EIO';
      (fs.chmodSync as jest.Mock).mockImplementation((target: fs.PathLike, mode: fs.Mode) => {
        if (target === mcpLogsDir) throw eio;
        actualFs.chmodSync(target, mode);
      });

      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      expect(() => prepareWorkDirectories(config, logPaths)).toThrow(eio);
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

    it('repairs squid logs ownership even when directory pre-exists', () => {
      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      // Pre-create the squid logs directory (simulates leftover from crashed run)
      fs.mkdirSync(logPaths.squidLogs, { recursive: true });

      prepareWorkDirectories(config, logPaths);

      // chown should still be called (onAfterEnsure, not just onCreate)
      expect(fs.chownSync).toHaveBeenCalledWith(logPaths.squidLogs, 13, 13);
    });

    it('tolerates both chown and chmod failure on squid logs (best-effort)', () => {
      const config = buildConfig();
      const logPaths = resolveLogPaths(config);

      (fs.chownSync as unknown as jest.Mock).mockImplementation((targetPath: fs.PathLike) => {
        if (String(targetPath) === logPaths.squidLogs) {
          throw new Error('chown failed');
        }
      });
      (fs.chmodSync as jest.Mock).mockImplementation((targetPath: fs.PathLike) => {
        if (String(targetPath) === logPaths.squidLogs) {
          throw new Error('chmod failed');
        }
        actualFs.chmodSync(targetPath as string, 0o777);
      });

      // Should not throw — container entrypoint preflight will handle it
      expect(() => prepareWorkDirectories(config, logPaths)).not.toThrow();
    });
  });

  describe('MCP log pruning', () => {
    it('removes subdirectories older than 24 hours', () => {
      const mcpLogsDir = path.join(fixture.tempDir, 'mcp-logs');
      fs.mkdirSync(mcpLogsDir, { recursive: true });

      // Create a "stale" subdir and set its mtime to 25 hours ago
      const staleDir = path.join(mcpLogsDir, 'stale-session');
      fs.mkdirSync(staleDir);
      const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
      fs.utimesSync(staleDir, oldTime, oldTime);

      // Create a "fresh" subdir (mtime is now)
      const freshDir = path.join(mcpLogsDir, 'fresh-session');
      fs.mkdirSync(freshDir);

      workdirSetupTestHelpers.pruneStaleMcpLogDirs(mcpLogsDir);

      expect(fs.existsSync(staleDir)).toBe(false);
      expect(fs.existsSync(freshDir)).toBe(true);
    });

    it('skips files (only prunes directories)', () => {
      const mcpLogsDir = path.join(fixture.tempDir, 'mcp-logs');
      fs.mkdirSync(mcpLogsDir, { recursive: true });

      const staleFile = path.join(mcpLogsDir, 'old-file.log');
      fs.writeFileSync(staleFile, 'data');
      const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
      fs.utimesSync(staleFile, oldTime, oldTime);

      workdirSetupTestHelpers.pruneStaleMcpLogDirs(mcpLogsDir);

      expect(fs.existsSync(staleFile)).toBe(true);
    });

    it('tolerates unreadable directory without throwing', () => {
      expect(() => {
        workdirSetupTestHelpers.pruneStaleMcpLogDirs('/nonexistent/path');
      }).not.toThrow();
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

    it('creates .gemini directory when googleApiKey is provided', () => {
      const geminiDir = path.join(fixture.tempDir, '.gemini');
      if (fs.existsSync(geminiDir)) {
        fs.rmSync(geminiDir, { recursive: true, force: true });
      }

      const config = buildConfig({ googleApiKey: 'test-key' });
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.existsSync(geminiDir)).toBe(true);
    });

    it('repairs ownership on existing .gemini directory for vertex runs', () => {
      const geminiDir = path.join(fixture.tempDir, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });

      const config = buildConfig({ googleApiKey: 'test-key' });
      const logPaths = resolveLogPaths(config);

      prepareWorkDirectories(config, logPaths);

      expect(fs.chownSync).toHaveBeenCalledWith(geminiDir, 1000, 1000);
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

describe('ensureDirectory EACCES diagnostic', () => {
  const fixture = setupWorkdirFixture({ cleanupChrootHome: false });

  it('throws a diagnostic error naming the nearest existing ancestor as blocker', () => {
    const parentDir = path.join(fixture.tempDir, 'stale-parent');
    const targetDir = path.join(parentDir, 'new-child');
    actualFs.mkdirSync(parentDir, { recursive: true });

    const eacces = Object.assign(
      new Error(`EACCES: permission denied, mkdir '${targetDir}'`),
      { code: 'EACCES' }
    );
    (fs.mkdirSync as jest.Mock).mockImplementationOnce(() => { throw eacces; });
    (fs.accessSync as jest.Mock).mockImplementationOnce(() => { throw new Error('EACCES'); });

    expect(() => workdirSetupTestHelpers.ensureDirectory(targetDir)).toThrow(
      new RegExp(`Blocked by: .*stale-parent`)
    );
  });

  it('falls back to nearest existing ancestor when no ancestor fails the access check', () => {
    const parentDir = path.join(fixture.tempDir, 'existing-parent');
    const targetDir = path.join(parentDir, 'new-child');
    actualFs.mkdirSync(parentDir, { recursive: true });

    const eacces = Object.assign(
      new Error(`EACCES: permission denied, mkdir '${targetDir}'`),
      { code: 'EACCES' }
    );
    (fs.mkdirSync as jest.Mock).mockImplementationOnce(() => { throw eacces; });
    // Mock accessSync to always pass so no ancestor fails the check and the code
    // falls back to the nearest existing ancestor. Without this, system directories
    // (e.g. /var/folders on macOS) may fail W_OK|X_OK and become the blocker.
    (fs.accessSync as jest.Mock).mockImplementation(() => undefined);

    expect(() => workdirSetupTestHelpers.ensureDirectory(targetDir)).toThrow(
      new RegExp(`Blocked by: .*existing-parent`)
    );
  });

  it('reports the first ancestor that fails the access check, not the nearest existing ancestor', () => {
    const grandparentDir = path.join(fixture.tempDir, 'grandparent');
    const parentDir = path.join(grandparentDir, 'parent');
    const targetDir = path.join(parentDir, 'new-child');
    actualFs.mkdirSync(parentDir, { recursive: true });

    const eacces = Object.assign(
      new Error(`EACCES: permission denied, mkdir '${targetDir}'`),
      { code: 'EACCES' }
    );
    (fs.mkdirSync as jest.Mock).mockImplementationOnce(() => { throw eacces; });
    // parentDir exists and passes the access check; grandparentDir exists but fails it.
    (fs.accessSync as jest.Mock).mockImplementation((p: string, mode: number) => {
      if (p === grandparentDir) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return actualFs.accessSync(p, mode);
    });

    try {
      expect(() => workdirSetupTestHelpers.ensureDirectory(targetDir)).toThrow(
        new RegExp(`Blocked by: .*grandparent`)
      );
    } finally {
      (fs.accessSync as jest.Mock).mockImplementation(
        (...args: Parameters<typeof actualFs.accessSync>) => actualFs.accessSync(...args)
      );
    }
  });

  it('falls back to dirPath in Blocked by when no existing ancestor is found', () => {
    const targetDir = path.join(fixture.tempDir, 'deep', 'nonexistent', 'dir');

    const eacces = Object.assign(
      new Error(`EACCES: permission denied, mkdir '${targetDir}'`),
      { code: 'EACCES' }
    );
    (fs.mkdirSync as jest.Mock).mockImplementationOnce(() => { throw eacces; });
    (fs.existsSync as jest.Mock).mockImplementation(() => false);

    try {
      expect(() => workdirSetupTestHelpers.ensureDirectory(targetDir)).toThrow(
        new RegExp(`Blocked by: ${targetDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      );
    } finally {
      (fs.existsSync as jest.Mock).mockImplementation(
        (...args: Parameters<typeof actualFs.existsSync>) => actualFs.existsSync(...args)
      );
    }
  });

  it('checks W_OK | X_OK when probing the blocking ancestor', () => {
    const parentDir = path.join(fixture.tempDir, 'stale-parent');
    const targetDir = path.join(parentDir, 'new-child');
    actualFs.mkdirSync(parentDir, { recursive: true });

    const eacces = Object.assign(
      new Error(`EACCES: permission denied, mkdir '${targetDir}'`),
      { code: 'EACCES' }
    );
    (fs.mkdirSync as jest.Mock).mockImplementationOnce(() => { throw eacces; });

    expect(() => workdirSetupTestHelpers.ensureDirectory(targetDir)).toThrow(/EACCES/);
    expect(fs.accessSync as jest.Mock).toHaveBeenCalledWith(
      expect.any(String),
      actualFs.constants.W_OK | actualFs.constants.X_OK
    );
  });

  it('rethrows non-EACCES errors from mkdirSync unchanged', () => {
    const targetDir = path.join(fixture.tempDir, 'some-dir');
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    (fs.mkdirSync as jest.Mock).mockImplementationOnce(() => { throw enoent; });

    expect(() => workdirSetupTestHelpers.ensureDirectory(targetDir)).toThrow(enoent);
  });
});
