import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockGetRealUserHome = jest.fn();

// jest.mock() calls are hoisted before imports — keep them at the top.

// fs.chownSync is non-configurable and cannot be overridden with jest.spyOn.
// Use a module-level mock that replaces only chownSync, keeping all other
// fs functions real so directory/file creation in writeConfigs works normally.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, chownSync: jest.fn() };
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
});
