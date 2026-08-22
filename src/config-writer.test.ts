// Hoisted jest.mock() registrations live in the shared helper — this import must remain first.
import './test-helpers/config-writer-dependency-mocks.test-utils';

jest.mock('execa', () => ({
  __esModule: true,
  default: { sync: jest.fn(() => ({ exitCode: 0, stdout: '', stderr: '' })) },
}));

import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { writeConfigs } from './config-writer';
import { isOpenSslAvailable } from './ssl-bump';
import { getRealUserHome, isNativeRootWithoutSudo } from './host-identity';
import {
  buildWriteConfig,
  setupConfigWriterTempDir,
  cleanupConfigWriterTempDir,
} from './test-helpers/config-writer-test-harness.test-utils';

describe('writeConfigs', () => {
  let tempDir: string;
  const originalGetuid = process.getuid;
  const originalEnv = process.env;

  beforeEach(() => {
    // getRealUserHome is used to locate host home subdirectories; point it at
    // tempDir so mkdirSync calls stay within the temp tree.
    tempDir = setupConfigWriterTempDir('config-writer-test-');
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'getuid', { value: originalGetuid, configurable: true });
  });

  afterEach(() => {
    // Clean up tempDir and the chroot-home sibling directory that writeConfigs creates.
    cleanupConfigWriterTempDir(tempDir);
    Object.defineProperty(process, 'getuid', { value: originalGetuid, configurable: true });
    process.env = originalEnv;
  });

  describe('SSL Bump preflight guard', () => {
    it('should throw when sslBump is enabled and OpenSSL is unavailable', async () => {
      (isOpenSslAvailable as jest.Mock).mockResolvedValue(false);

      await expect(
        writeConfigs(
          buildWriteConfig(tempDir, {
            sslBump: true,
          })
        )
      ).rejects.toThrow('SSL Bump initialization failed: openssl is not available on this system');
    });

    it('should check OpenSSL availability before calling generateSessionCa', async () => {
      (isOpenSslAvailable as jest.Mock).mockResolvedValue(false);
      const { generateSessionCa } = jest.requireMock('./ssl-bump');

      await expect(
        writeConfigs(
          buildWriteConfig(tempDir, {
            sslBump: true,
          })
        )
      ).rejects.toThrow();

      expect(isOpenSslAvailable).toHaveBeenCalledTimes(1);
      expect(generateSessionCa).not.toHaveBeenCalled();
    });

    it('should not check OpenSSL availability when sslBump is not enabled', async () => {
      await writeConfigs(buildWriteConfig(tempDir));

      expect(isOpenSslAvailable).not.toHaveBeenCalled();
    });
  });

  describe('directory setup', () => {
    it('throws when workDir is a symlink', async () => {
      const realWorkDir = path.join(tempDir, 'real-workdir');
      const symlinkWorkDir = path.join(tempDir, 'symlink-workdir');
      fs.mkdirSync(realWorkDir, { recursive: true });
      fs.symlinkSync(realWorkDir, symlinkWorkDir);

      await expect(
        writeConfigs(
          buildWriteConfig(tempDir, {
            workDir: symlinkWorkDir,
          })
        )
      ).rejects.toThrow(`Refusing to use symlink as directory: ${symlinkWorkDir}`);
    });

    it('falls back to world-writable squid logs when squid chown fails', async () => {
      const proxyLogsDir = path.join(tempDir, 'proxy-logs');
      (fs.chownSync as unknown as jest.Mock).mockImplementation((targetPath: fs.PathLike) => {
        if (String(targetPath) === proxyLogsDir) {
          throw new Error('chown failed');
        }
      });

      await writeConfigs(
        buildWriteConfig(tempDir, {
          proxyLogsDir,
        })
      );

      const squidLogsDirMode = fs.statSync(proxyLogsDir).mode & 0o777;
      expect(squidLogsDirMode).toBe(0o777);
    });

    it('forces pre-existing mcp logs directory to mode 0o777', async () => {
      const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
      fs.mkdirSync(mcpLogsDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(mcpLogsDir, 0o700);

      await writeConfigs(buildWriteConfig(tempDir));

      const mcpLogsDirMode = fs.statSync(mcpLogsDir).mode & 0o777;
      expect(mcpLogsDirMode).toBe(0o777);
    });

    it('chowns RUNNER_TEMP gh-aw tree host-side when running as root', async () => {
      Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
      process.env.RUNNER_TEMP = tempDir;
      const ghAwRoot = path.join(tempDir, 'gh-aw');
      const mcpConfigDir = path.join(ghAwRoot, 'mcp-config');
      const mcpConfigPath = path.join(mcpConfigDir, 'mcp-servers.json');
      fs.mkdirSync(mcpConfigDir, { recursive: true });
      fs.writeFileSync(mcpConfigPath, '{}', { mode: 0o600 });

      await writeConfigs(buildWriteConfig(tempDir));

      expect(execa.sync).toHaveBeenCalledWith(
        'chown',
        ['-h', '-P', '-R', '--', '1000:1000', ghAwRoot],
        expect.objectContaining({ reject: false })
      );
    });

    it('chowns the host workspace on native-root runners', async () => {
      Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
      (isNativeRootWithoutSudo as jest.Mock).mockReturnValue(true);
      const workspaceDir = path.join(tempDir, 'workspace');
      process.env.GITHUB_WORKSPACE = workspaceDir;
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.chmodSync(workspaceDir, 0o777);
      const canonicalWorkspaceDir = fs.realpathSync(workspaceDir);

      await writeConfigs(buildWriteConfig(tempDir, { containerWorkDir: workspaceDir }));

      expect(execa.sync).toHaveBeenCalledWith(
        'chown',
        ['-h', '-P', '-R', '--', '1000:1000', canonicalWorkspaceDir],
        expect.objectContaining({ reject: false })
      );
    });

    it('chowns the host workspace when the container workdir is beneath it', async () => {
      Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
      (isNativeRootWithoutSudo as jest.Mock).mockReturnValue(true);
      const workspaceDir = path.join(tempDir, 'workspace');
      const containerWorkDir = path.join(workspaceDir, 'packages', 'app');
      process.env.GITHUB_WORKSPACE = workspaceDir;
      fs.mkdirSync(containerWorkDir, { recursive: true });
      fs.chmodSync(workspaceDir, 0o777);
      const canonicalWorkspaceDir = fs.realpathSync(workspaceDir);

      await writeConfigs(buildWriteConfig(tempDir, { containerWorkDir }));

      expect(execa.sync).toHaveBeenCalledWith(
        'chown',
        ['-h', '-P', '-R', '--', '1000:1000', canonicalWorkspaceDir],
        expect.objectContaining({ reject: false })
      );
    });

    it('throws when the host workspace stays unwritable by the sandbox identity', async () => {
      Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
      (isNativeRootWithoutSudo as jest.Mock).mockReturnValue(true);
      const workspaceDir = path.join(tempDir, 'workspace');
      process.env.GITHUB_WORKSPACE = workspaceDir;
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.chmodSync(workspaceDir, 0o755);
      const canonicalWorkspaceDir = fs.realpathSync(workspaceDir);
      const actualStatSync = jest.requireActual<typeof import('fs')>('fs').statSync;
      (fs.statSync as jest.Mock).mockImplementation((targetPath: fs.PathLike) => {
        const stat = actualStatSync(targetPath);
        return String(targetPath) === canonicalWorkspaceDir
          ? Object.assign(stat, { uid: 0, gid: 0 })
          : stat;
      });

      await expect(
        writeConfigs(buildWriteConfig(tempDir, { containerWorkDir: workspaceDir }))
      ).rejects.toThrow(
        `Host workspace is not writable by the sandbox identity (1000:1000): ${canonicalWorkspaceDir}`
      );
    });

    it.each(['/tmp', '/etc', '/'])(
      'does not chown an unrelated custom container workdir (%s)',
      async containerWorkDir => {
        Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
        (isNativeRootWithoutSudo as jest.Mock).mockReturnValue(true);
        const workspaceDir = path.join(tempDir, 'workspace');
        process.env.GITHUB_WORKSPACE = workspaceDir;
        fs.mkdirSync(workspaceDir, { recursive: true });

        await writeConfigs(buildWriteConfig(tempDir, { containerWorkDir }));

        expect(execa.sync).not.toHaveBeenCalledWith(
          'chown',
          expect.arrayContaining([containerWorkDir]),
          expect.anything()
        );
      }
    );

    it('rejects a filesystem root as the host workspace', async () => {
      Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
      (isNativeRootWithoutSudo as jest.Mock).mockReturnValue(true);
      process.env.GITHUB_WORKSPACE = '/';

      await expect(
        writeConfigs(buildWriteConfig(tempDir, { containerWorkDir: '/' }))
      ).rejects.toThrow('Refusing to repair ownership of filesystem root: /');

      expect(execa.sync).not.toHaveBeenCalledWith(
        'chown',
        expect.arrayContaining(['/']),
        expect.anything()
      );
    });

    it('rejects a host workspace symlink that resolves to a filesystem root', async () => {
      Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
      (isNativeRootWithoutSudo as jest.Mock).mockReturnValue(true);
      const workspaceDir = path.join(tempDir, 'workspace-root');
      fs.symlinkSync('/', workspaceDir);
      process.env.GITHUB_WORKSPACE = workspaceDir;

      await expect(
        writeConfigs(buildWriteConfig(tempDir, { containerWorkDir: workspaceDir }))
      ).rejects.toThrow('Refusing to repair ownership of filesystem root: /');

      expect(execa.sync).not.toHaveBeenCalledWith(
        'chown',
        expect.arrayContaining(['/']),
        expect.anything()
      );
    });

    it('does not touch the host workspace when not running as native root', async () => {
      (isNativeRootWithoutSudo as jest.Mock).mockReturnValue(false);
      const workspaceDir = path.join(tempDir, 'workspace');
      process.env.GITHUB_WORKSPACE = workspaceDir;
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.chmodSync(workspaceDir, 0o755);

      await writeConfigs(buildWriteConfig(tempDir, { containerWorkDir: workspaceDir }));

      expect(execa.sync).not.toHaveBeenCalledWith(
        'chown',
        ['-h', '-P', '-R', '--', '1000:1000', workspaceDir],
        expect.anything()
      );
    });

    it('throws when workDir path exists but is not a directory', async () => {
      const filePath = path.join(tempDir, 'not-a-directory');
      fs.writeFileSync(filePath, 'content');

      await expect(
        writeConfigs(
          buildWriteConfig(tempDir, {
            workDir: filePath,
          })
        )
      ).rejects.toThrow(/EEXIST|ENOTDIR/);
    });

    it('creates chroot home directory when it does not exist', async () => {
      const emptyHomeDir = `${tempDir}-chroot-home`;
      expect(fs.existsSync(emptyHomeDir)).toBe(false);

      await writeConfigs(buildWriteConfig(tempDir));

      expect(fs.existsSync(emptyHomeDir)).toBe(true);
      expect(fs.statSync(emptyHomeDir).isDirectory()).toBe(true);
    });

    it('uses existing chroot home directory if already present', async () => {
      const emptyHomeDir = `${tempDir}-chroot-home`;
      fs.mkdirSync(emptyHomeDir, { recursive: true });
      const statBefore = fs.statSync(emptyHomeDir);

      await writeConfigs(buildWriteConfig(tempDir));

      const statAfter = fs.statSync(emptyHomeDir);
      expect(statAfter.ino).toBe(statBefore.ino); // Same directory
    });

    it('creates missing home subdirectories with correct ownership', async () => {
      const homeDir = tempDir;
      (getRealUserHome as jest.Mock).mockReturnValue(homeDir);

      // Delete .copilot if it exists
      const copilotDir = path.join(homeDir, '.copilot');
      if (fs.existsSync(copilotDir)) {
        fs.rmSync(copilotDir, { recursive: true, force: true });
      }

      await writeConfigs(buildWriteConfig(tempDir));

      expect(fs.existsSync(copilotDir)).toBe(true);
      expect(fs.chownSync).toHaveBeenCalledWith(copilotDir, 1000, 1000);
    });

    it('creates .gemini directory when geminiApiKey is provided', async () => {
      const homeDir = tempDir;
      (getRealUserHome as jest.Mock).mockReturnValue(homeDir);

      const geminiDir = path.join(homeDir, '.gemini');
      if (fs.existsSync(geminiDir)) {
        fs.rmSync(geminiDir, { recursive: true, force: true });
      }

      await writeConfigs(
        buildWriteConfig(tempDir, {
          geminiApiKey: 'test-key',
        })
      );

      expect(fs.existsSync(geminiDir)).toBe(true);
    });

    it('creates configured runner tool cache directory segments with correct ownership', async () => {
      const runnerToolCacheParent = path.join(tempDir, 'runner-work');
      const runnerToolCachePath = path.join(runnerToolCacheParent, '_tool');
      expect(fs.existsSync(runnerToolCachePath)).toBe(false);

      await writeConfigs(
        buildWriteConfig(tempDir, {
          runnerToolCachePath,
        })
      );

      expect(fs.existsSync(runnerToolCachePath)).toBe(true);
      expect(fs.statSync(runnerToolCachePath).isDirectory()).toBe(true);
      expect(fs.chownSync).toHaveBeenCalledWith(runnerToolCacheParent, 1000, 1000);
      expect(fs.chmodSync).toHaveBeenCalledWith(runnerToolCacheParent, 0o755);
      expect(fs.chownSync).toHaveBeenCalledWith(runnerToolCachePath, 1000, 1000);
      expect(fs.chmodSync).toHaveBeenCalledWith(runnerToolCachePath, 0o755);
    });

    it('throws when runnerToolCachePath contains a pre-existing non-root-owned intermediate symlink', async () => {
      const realDir = path.join(tempDir, 'real-dir');
      const symlinkDir = path.join(tempDir, 'link-to-real');
      fs.mkdirSync(realDir, { recursive: true });
      fs.symlinkSync(realDir, symlinkDir);
      const runnerToolCachePath = path.join(symlinkDir, 'child');
      (getRealUserHome as jest.Mock).mockReturnValue(tempDir);

      await expect(
        writeConfigs(buildWriteConfig(tempDir, { runnerToolCachePath }))
      ).rejects.toThrow(`Refusing to use symlink as directory: ${symlinkDir}`);
    });

    it('allows pre-existing root-owned intermediate symlinks in runnerToolCachePath', async () => {
      const actualDir = path.join(tempDir, 'real-dir');
      const symlinkDir = path.join(tempDir, 'root-symlink');
      fs.mkdirSync(actualDir, { recursive: true });
      fs.symlinkSync(actualDir, symlinkDir);

      const lstatSyncMock = fs.lstatSync as jest.MockedFunction<typeof fs.lstatSync>;
      const actualLstatSync = jest.requireActual<typeof import('fs')>('fs').lstatSync;
      lstatSyncMock.mockImplementation((...args) => {
        const p = typeof args[0] === 'string' ? args[0] : args[0].toString();
        if (p === symlinkDir) {
          // Simulate a root-owned symlink (e.g. /var → /private/var on macOS)
          return { isSymbolicLink: () => true, uid: 0 } as unknown as fs.Stats;
        }
        return actualLstatSync(...args);
      });

      const runnerToolCachePath = path.join(symlinkDir, 'child');
      (getRealUserHome as jest.Mock).mockReturnValue(tempDir);

      try {
        await expect(
          writeConfigs(buildWriteConfig(tempDir, { runnerToolCachePath }))
        ).resolves.toBeUndefined();
      } finally {
        lstatSyncMock.mockImplementation(actualLstatSync);
      }
    });

    it('prepares chroot mountpoint for fallback runner tool cache under home', async () => {
      const runnerToolCachePath = path.join(tempDir, 'work', '_tool');
      fs.mkdirSync(runnerToolCachePath, { recursive: true });

      // Unset RUNNER_TOOL_CACHE so resolveRunnerToolCachePath falls through to the
      // home-relative fallback (work/_tool). Restore after the test.
      const savedRunnerToolCache = process.env.RUNNER_TOOL_CACHE;
      delete process.env.RUNNER_TOOL_CACHE;
      try {
        await writeConfigs(buildWriteConfig(tempDir));
      } finally {
        if (savedRunnerToolCache !== undefined) {
          process.env.RUNNER_TOOL_CACHE = savedRunnerToolCache;
        }
      }

      const chrootWorkDir = path.join(`${tempDir}-chroot-home`, 'work');
      const chrootToolCacheDir = path.join(chrootWorkDir, '_tool');
      expect(fs.existsSync(chrootToolCacheDir)).toBe(true);
      expect(fs.statSync(chrootToolCacheDir).isDirectory()).toBe(true);
      expect(fs.chownSync).toHaveBeenCalledWith(chrootWorkDir, 1000, 1000);
      expect(fs.chmodSync).toHaveBeenCalledWith(chrootWorkDir, 0o755);
      expect(fs.chownSync).toHaveBeenCalledWith(chrootToolCacheDir, 1000, 1000);
      expect(fs.chmodSync).toHaveBeenCalledWith(chrootToolCacheDir, 0o755);
    });

    it('does not create .gemini directory when geminiApiKey is not provided', async () => {
      const homeDir = tempDir;
      (getRealUserHome as jest.Mock).mockReturnValue(homeDir);

      const geminiDir = path.join(homeDir, '.gemini');
      if (fs.existsSync(geminiDir)) {
        fs.rmSync(geminiDir, { recursive: true, force: true });
      }

      await writeConfigs(buildWriteConfig(tempDir));

      expect(fs.existsSync(geminiDir)).toBe(false);
    });

    it('creates audit directory when it does not exist', async () => {
      const auditDir = path.join(tempDir, 'custom-audit');

      await writeConfigs(
        buildWriteConfig(tempDir, {
          auditDir,
        })
      );

      expect(fs.existsSync(auditDir)).toBe(true);
      expect(fs.existsSync(path.join(auditDir, 'squid.conf'))).toBe(true);
      expect(fs.existsSync(path.join(auditDir, 'docker-compose.redacted.yml'))).toBe(true);
      expect(fs.existsSync(path.join(auditDir, 'policy-manifest.json'))).toBe(true);
    });
  });

  describe('seccomp profile', () => {
    it('throws error when seccomp profile is not found', async () => {
      const existsSyncMock = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
      const originalImpl = existsSyncMock.getMockImplementation()!;
      existsSyncMock.mockImplementation((filePath: fs.PathLike) => {
        const normalizedPath =
          typeof filePath === 'string' ? filePath : filePath.toString();

        if (
          normalizedPath === 'seccomp-profile.json' ||
          normalizedPath.endsWith(`${path.sep}seccomp-profile.json`)
        ) {
          return false;
        }

        return originalImpl(filePath);
      });

      try {
        await expect(
          writeConfigs(buildWriteConfig(tempDir))
        ).rejects.toThrow(/Seccomp profile not found/);
      } finally {
        existsSyncMock.mockImplementation(originalImpl);
      }
    });
  });

  describe('URL patterns and API proxy', () => {
    beforeEach(() => {
      const { parseUrlPatterns } = jest.requireMock('./domain-matchers');
      parseUrlPatterns.mockReturnValue(['https://example\\.com/.*']);
    });

    it('parses URL patterns when allowedUrls is provided', async () => {
      const { parseUrlPatterns } = jest.requireMock('./domain-matchers');
      const { generateSquidConfig } = jest.requireMock('./squid-config');

      await writeConfigs(
        buildWriteConfig(tempDir, {
          allowedDomains: ['example.com'],
          allowedUrls: ['https://example.com/api/*'],
        })
      );

      expect(parseUrlPatterns).toHaveBeenCalledWith(['https://example.com/api/*']);
      expect(generateSquidConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          urlPatterns: ['https://example\\.com/.*'],
        })
      );
    });

    it('does not parse URL patterns when allowedUrls is empty', async () => {
      const { parseUrlPatterns } = jest.requireMock('./domain-matchers');
      const { generateSquidConfig } = jest.requireMock('./squid-config');

      await writeConfigs(
        buildWriteConfig(tempDir, {
          allowedDomains: ['example.com'],
          allowedUrls: [],
        })
      );

      expect(parseUrlPatterns).not.toHaveBeenCalled();
      expect(generateSquidConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          urlPatterns: undefined,
        })
      );
    });

    it('includes API proxy configuration when enableApiProxy is true', async () => {
      const { generateSquidConfig } = jest.requireMock('./squid-config');
      const { generatePolicyManifest } = jest.requireMock('./squid-config');

      await writeConfigs(
        buildWriteConfig(tempDir, {
          allowedDomains: ['example.com'],
          enableApiProxy: true,
        })
      );

      expect(generateSquidConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          apiProxyIp: '172.30.0.30',
          apiProxyPorts: expect.arrayContaining([10000, 10001, 10002, 10003]),
        })
      );
      expect(generatePolicyManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          apiProxyIp: '172.30.0.30',
        })
      );
    });

    it('does not include API proxy configuration when enableApiProxy is false', async () => {
      const { generateSquidConfig } = jest.requireMock('./squid-config');

      await writeConfigs(
        buildWriteConfig(tempDir, {
          allowedDomains: ['example.com'],
          enableApiProxy: false,
        })
      );

      expect(generateSquidConfig).toHaveBeenCalledWith(
        expect.not.objectContaining({
          apiProxyIp: expect.anything(),
        })
      );
    });

    it('scopes artifact storage egress to the CLI proxy', async () => {
      const { generateSquidConfig } = jest.requireMock('./squid-config');

      await writeConfigs(
        buildWriteConfig(tempDir, {
          allowedDomains: ['github.com'],
          difcProxyHost: 'host.docker.internal:18443',
        })
      );

      expect(generateSquidConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          cliProxyIp: '172.30.0.50',
        })
      );
    });
  });
});
