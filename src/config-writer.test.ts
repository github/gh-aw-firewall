import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// jest.mock() calls are hoisted before imports — keep them at the top.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./test-helpers/fs-mock-factory.test-utils').fsMockFactory());

jest.mock('./ssl-bump', () => ({
  isOpenSslAvailable: jest.fn(),
  generateSessionCa: jest.fn(),
  initSslDb: jest.fn(),
}));

jest.mock('./domain-matchers', () => ({
  parseUrlPatterns: jest.fn().mockReturnValue([]),
}));

jest.mock('./host-env', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ...require('./test-helpers/fs-mock-factory.test-utils').hostEnvMockFactory({
    SQUID_PORT: 3128,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./host-identity', () => require('./test-helpers/fs-mock-factory.test-utils').hostIdentityMockFactory());

jest.mock('./squid-config', () => ({
  generateSquidConfig: jest.fn().mockReturnValue('# mock squid config'),
  generatePolicyManifest: jest.fn().mockReturnValue({}),
}));

jest.mock('./compose-generator', () => ({
  generateDockerCompose: jest.fn().mockReturnValue({ services: {}, version: '3' }),
  redactDockerComposeSecrets: jest.fn().mockReturnValue({ services: {}, version: '3' }),
}));

import { writeConfigs } from './config-writer';
import { isOpenSslAvailable } from './ssl-bump';
import { getRealUserHome } from './host-identity';

describe('writeConfigs', () => {
  let tempDir: string;
  const buildWriteConfig = (
    overrides: Partial<Parameters<typeof writeConfigs>[0]> = {}
  ): Parameters<typeof writeConfigs>[0] => ({
    workDir: tempDir,
    sslBump: false,
    allowedDomains: [],
    agentCommand: 'echo test',
    logLevel: 'info',
    keepContainers: false,
    buildLocal: false,
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    ...overrides,
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-writer-test-'));
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    // getRealUserHome is used to locate host home subdirectories; point it at
    // tempDir so mkdirSync calls stay within the temp tree.
    (getRealUserHome as jest.Mock).mockReturnValue(tempDir);
  });

  afterEach(() => {
    // Clean up tempDir and the chroot-home sibling directory that writeConfigs creates.
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(`${tempDir}-chroot-home`, { recursive: true, force: true });
  });

  describe('SSL Bump preflight guard', () => {
    it('should throw when sslBump is enabled and OpenSSL is unavailable', async () => {
      (isOpenSslAvailable as jest.Mock).mockResolvedValue(false);

      await expect(
        writeConfigs(
          buildWriteConfig({
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
          buildWriteConfig({
            sslBump: true,
          })
        )
      ).rejects.toThrow();

      expect(isOpenSslAvailable).toHaveBeenCalledTimes(1);
      expect(generateSessionCa).not.toHaveBeenCalled();
    });

    it('should not check OpenSSL availability when sslBump is not enabled', async () => {
      await writeConfigs(buildWriteConfig());

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
          buildWriteConfig({
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
        buildWriteConfig({
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

      await writeConfigs(buildWriteConfig());

      const mcpLogsDirMode = fs.statSync(mcpLogsDir).mode & 0o777;
      expect(mcpLogsDirMode).toBe(0o777);
    });

    it('throws when workDir path exists but is not a directory', async () => {
      const filePath = path.join(tempDir, 'not-a-directory');
      fs.writeFileSync(filePath, 'content');

      await expect(
        writeConfigs(
          buildWriteConfig({
            workDir: filePath,
          })
        )
      ).rejects.toThrow(/EEXIST|ENOTDIR/);
    });

    it('creates chroot home directory when it does not exist', async () => {
      const emptyHomeDir = `${tempDir}-chroot-home`;
      expect(fs.existsSync(emptyHomeDir)).toBe(false);

      await writeConfigs(buildWriteConfig());

      expect(fs.existsSync(emptyHomeDir)).toBe(true);
      expect(fs.statSync(emptyHomeDir).isDirectory()).toBe(true);
    });

    it('uses existing chroot home directory if already present', async () => {
      const emptyHomeDir = `${tempDir}-chroot-home`;
      fs.mkdirSync(emptyHomeDir, { recursive: true });
      const statBefore = fs.statSync(emptyHomeDir);

      await writeConfigs(buildWriteConfig());

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

      await writeConfigs(buildWriteConfig());

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
        buildWriteConfig({
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
        buildWriteConfig({
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
        writeConfigs(buildWriteConfig({ runnerToolCachePath }))
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
          writeConfigs(buildWriteConfig({ runnerToolCachePath }))
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
        await writeConfigs(buildWriteConfig());
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

      await writeConfigs(buildWriteConfig());

      expect(fs.existsSync(geminiDir)).toBe(false);
    });

    it('creates audit directory when it does not exist', async () => {
      const auditDir = path.join(tempDir, 'custom-audit');

      await writeConfigs(
        buildWriteConfig({
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
          writeConfigs(buildWriteConfig())
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
        buildWriteConfig({
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
        buildWriteConfig({
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
        buildWriteConfig({
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
        buildWriteConfig({
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
  });
});
