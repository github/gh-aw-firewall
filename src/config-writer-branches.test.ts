/**
 * Branch coverage for config-writer.ts paths not reached by config-writer.test.ts:
 *   - writeAuditArtifacts: auditDir symlink guard
 *   - copySeccompProfile: alternate seccomp-profile.json fallback path
 *   - initializeSslBump: non-Error rejection propagation
 */

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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeConfigs } from './config-writer';
import { isOpenSslAvailable, generateSessionCa } from './ssl-bump';
import { getRealUserHome } from './host-identity';

describe('config-writer additional branches', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-branches-test-'));
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    (getRealUserHome as jest.Mock).mockReturnValue(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(`${tempDir}-chroot-home`, { recursive: true, force: true });
  });

  // ─── writeAuditArtifacts symlink guard ─────────────────────────────────

  describe('audit directory symlink guard', () => {
    it('throws when auditDir resolves to a symlink', async () => {
      const realAuditDir = path.join(tempDir, 'real-audit');
      const symlinkAuditDir = path.join(tempDir, 'symlink-audit');
      fs.mkdirSync(realAuditDir, { recursive: true });
      fs.symlinkSync(realAuditDir, symlinkAuditDir);

      await expect(
        writeConfigs(buildWriteConfig({ auditDir: symlinkAuditDir }))
      ).rejects.toThrow(`Refusing to use symlink as directory: ${symlinkAuditDir}`);
    });
  });

  // ─── copySeccompProfile alternate path ──────────────────────────────────

  describe('seccomp profile alternate-path fallback', () => {
    it('copies the profile from the dist-relative alt path when the src path is missing', async () => {
      const existsSyncMock = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
      const originalImpl = existsSyncMock.getMockImplementation()!;

      // Intercept only the primary containers/ path so the alt path is tried next.
      existsSyncMock.mockImplementation((filePath: fs.PathLike) => {
        const p = typeof filePath === 'string' ? filePath : filePath.toString();
        // Primary source path ends with containers/agent/seccomp-profile.json.
        // We target the specific segment after src/ (not dist/).
        if (
          p.includes(`src${path.sep}..${path.sep}containers`) ||
          p.includes(`src/../containers`)
        ) {
          return false;
        }
        return originalImpl(filePath);
      });

      try {
        // Should succeed — the alt path resolves via dist/../../containers/...
        // and the real file exists at containers/agent/seccomp-profile.json.
        await expect(writeConfigs(buildWriteConfig())).resolves.toBeUndefined();
      } finally {
        existsSyncMock.mockImplementation(originalImpl);
      }
    });
  });

  // ─── initializeSslBump non-Error propagation ───────────────────────────

  describe('SSL Bump initialization with non-Error rejection', () => {
    it('wraps a non-Error thrown by generateSessionCa in an Error', async () => {
      (isOpenSslAvailable as jest.Mock).mockResolvedValue(true);
      (generateSessionCa as jest.Mock).mockRejectedValue('string rejection');

      await expect(
        writeConfigs(buildWriteConfig({ sslBump: true }))
      ).rejects.toThrow('SSL Bump initialization failed: string rejection');
    });
  });
});
