import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockGetRealUserHome = jest.fn();

// jest.mock() calls are hoisted before imports — keep them at the top.

// fs.chownSync and fs.existsSync are non-configurable and cannot be overridden
// with jest.spyOn. Use a module-level mock that replaces them with jest.fn()
// wrappers, keeping all other fs functions real so directory/file creation in
// writeConfigs works normally.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    chownSync: jest.fn(),
    existsSync: jest.fn((...args: Parameters<typeof actual.existsSync>) =>
      actual.existsSync(...args)
    ),
  };
});

jest.mock('./ssl-bump', () => ({
  isOpenSslAvailable: jest.fn(),
  generateSessionCa: jest.fn(),
  initSslDb: jest.fn(),
  parseUrlPatterns: jest.fn().mockReturnValue([]),
}));

jest.mock('./host-env', () => ({
  SQUID_PORT: 3128,
  getSafeHostUid: jest.fn().mockReturnValue('1000'),
  getSafeHostGid: jest.fn().mockReturnValue('1000'),
  getRealUserHome: mockGetRealUserHome,
}));

jest.mock('./host-identity', () => ({
  getRealUserHome: mockGetRealUserHome,
}));

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
        writeConfigs({
          workDir: tempDir,
          sslBump: true,
          allowedDomains: [],
          agentCommand: 'echo test',
          logLevel: 'info',
          keepContainers: false,
          buildLocal: false,
          imageRegistry: 'ghcr.io/github/gh-aw-firewall',
          imageTag: 'latest',
        })
      ).rejects.toThrow('SSL Bump initialization failed: openssl is not available on this system');
    });

    it('should check OpenSSL availability before calling generateSessionCa', async () => {
      (isOpenSslAvailable as jest.Mock).mockResolvedValue(false);
      const { generateSessionCa } = jest.requireMock('./ssl-bump');

      await expect(
        writeConfigs({
          workDir: tempDir,
          sslBump: true,
          allowedDomains: [],
          agentCommand: 'echo test',
          logLevel: 'info',
          keepContainers: false,
          buildLocal: false,
          imageRegistry: 'ghcr.io/github/gh-aw-firewall',
          imageTag: 'latest',
        })
      ).rejects.toThrow();

      expect(isOpenSslAvailable).toHaveBeenCalledTimes(1);
      expect(generateSessionCa).not.toHaveBeenCalled();
    });

    it('should not check OpenSSL availability when sslBump is not enabled', async () => {
      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: [],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
      });

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
        writeConfigs({
          workDir: symlinkWorkDir,
          sslBump: false,
          allowedDomains: [],
          agentCommand: 'echo test',
          logLevel: 'info',
          keepContainers: false,
          buildLocal: false,
          imageRegistry: 'ghcr.io/github/gh-aw-firewall',
          imageTag: 'latest',
        })
      ).rejects.toThrow(`Refusing to use symlink as directory: ${symlinkWorkDir}`);
    });

    it('falls back to world-writable squid logs when squid chown fails', async () => {
      const proxyLogsDir = path.join(tempDir, 'proxy-logs');
      (fs.chownSync as unknown as jest.Mock).mockImplementation((targetPath: fs.PathLike) => {
        if (String(targetPath) === proxyLogsDir) {
          throw new Error('chown failed');
        }
      });

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: [],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
        proxyLogsDir,
      });

      const squidLogsDirMode = fs.statSync(proxyLogsDir).mode & 0o777;
      expect(squidLogsDirMode).toBe(0o777);
    });

    it('forces pre-existing mcp logs directory to mode 0o777', async () => {
      const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
      fs.mkdirSync(mcpLogsDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(mcpLogsDir, 0o700);

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: [],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
      });

      const mcpLogsDirMode = fs.statSync(mcpLogsDir).mode & 0o777;
      expect(mcpLogsDirMode).toBe(0o777);
    });

    it('throws when workDir path exists but is not a directory', async () => {
      const filePath = path.join(tempDir, 'not-a-directory');
      fs.writeFileSync(filePath, 'content');

      await expect(
        writeConfigs({
          workDir: filePath,
          sslBump: false,
          allowedDomains: [],
          agentCommand: 'echo test',
          logLevel: 'info',
          keepContainers: false,
          buildLocal: false,
          imageRegistry: 'ghcr.io/github/gh-aw-firewall',
          imageTag: 'latest',
        })
      ).rejects.toThrow(/EEXIST|ENOTDIR/);
    });

    it('creates chroot home directory when it does not exist', async () => {
      const emptyHomeDir = `${tempDir}-chroot-home`;
      expect(fs.existsSync(emptyHomeDir)).toBe(false);

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: [],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
      });

      expect(fs.existsSync(emptyHomeDir)).toBe(true);
      expect(fs.statSync(emptyHomeDir).isDirectory()).toBe(true);
    });

    it('uses existing chroot home directory if already present', async () => {
      const emptyHomeDir = `${tempDir}-chroot-home`;
      fs.mkdirSync(emptyHomeDir, { recursive: true });
      const statBefore = fs.statSync(emptyHomeDir);

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: [],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
      });

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

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: [],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
      });

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

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: [],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
        geminiApiKey: 'test-key',
      });

      expect(fs.existsSync(geminiDir)).toBe(true);
    });

    it('does not create .gemini directory when geminiApiKey is not provided', async () => {
      const homeDir = tempDir;
      (getRealUserHome as jest.Mock).mockReturnValue(homeDir);

      const geminiDir = path.join(homeDir, '.gemini');
      if (fs.existsSync(geminiDir)) {
        fs.rmSync(geminiDir, { recursive: true, force: true });
      }

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: [],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
      });

      expect(fs.existsSync(geminiDir)).toBe(false);
    });

    it('creates audit directory when it does not exist', async () => {
      const auditDir = path.join(tempDir, 'custom-audit');

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: [],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
        auditDir,
      });

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
          writeConfigs({
            workDir: tempDir,
            sslBump: false,
            allowedDomains: [],
            agentCommand: 'echo test',
            logLevel: 'info',
            keepContainers: false,
            buildLocal: false,
            imageRegistry: 'ghcr.io/github/gh-aw-firewall',
            imageTag: 'latest',
          })
        ).rejects.toThrow(/Seccomp profile not found/);
      } finally {
        existsSyncMock.mockImplementation(originalImpl);
      }
    });
  });

  describe('URL patterns and API proxy', () => {
    beforeEach(() => {
      const { parseUrlPatterns } = jest.requireMock('./ssl-bump');
      parseUrlPatterns.mockReturnValue(['https://example\\.com/.*']);
    });

    it('parses URL patterns when allowedUrls is provided', async () => {
      const { parseUrlPatterns } = jest.requireMock('./ssl-bump');
      const { generateSquidConfig } = jest.requireMock('./squid-config');

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: ['example.com'],
        allowedUrls: ['https://example.com/api/*'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
      });

      expect(parseUrlPatterns).toHaveBeenCalledWith(['https://example.com/api/*']);
      expect(generateSquidConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          urlPatterns: ['https://example\\.com/.*'],
        })
      );
    });

    it('does not parse URL patterns when allowedUrls is empty', async () => {
      const { parseUrlPatterns } = jest.requireMock('./ssl-bump');
      const { generateSquidConfig } = jest.requireMock('./squid-config');

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: ['example.com'],
        allowedUrls: [],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
      });

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

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: ['example.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
        enableApiProxy: true,
      });

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

      await writeConfigs({
        workDir: tempDir,
        sslBump: false,
        allowedDomains: ['example.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        buildLocal: false,
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
        enableApiProxy: false,
      });

      expect(generateSquidConfig).toHaveBeenCalledWith(
        expect.not.objectContaining({
          apiProxyIp: expect.anything(),
        })
      );
    });
  });
});
