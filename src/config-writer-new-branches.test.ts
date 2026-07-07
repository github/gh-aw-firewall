/**
 * Branch and line coverage for previously-uncovered paths in src/config-writer.ts:
 *  - validateAndPrepareWorkDir: workDir is not a directory (line 58)
 *  - copySeccompProfile: alt-path seccomp fallback (lines 95-97), neither path found
 *  - writeAuditArtifacts: auditDir is not a directory (line 162)
 *
 * This file sets up its own complete fs mock to gain control over statSync and
 * copyFileSync (which are not provided by the shared fsMockFactory).
 */

// Full fs mock — must be hoisted before any imports that use fs
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: jest.fn(),
    chmodSync: jest.fn(),
    chownSync: jest.fn(),
    existsSync: jest.fn(),
    lstatSync: jest.fn(),
    statSync: jest.fn(),
    writeFileSync: jest.fn(),
    copyFileSync: jest.fn(),
    readFileSync: jest.fn(),
    readdirSync: jest.fn(),
    mkdtempSync: jest.fn(),
    rmSync: jest.fn(),
  };
});

jest.mock('./ssl-bump', () => ({
  isOpenSslAvailable: jest.fn(),
  generateSessionCa: jest.fn(),
  initSslDb: jest.fn(),
  cleanupSslKeyMaterial: jest.fn(),
  unmountSslTmpfs: jest.fn(),
}));

jest.mock('./host-env', () => ({
  SQUID_PORT: 3128,
  stripScheme: jest.fn((v: string) => v),
  getSafeHostUid: jest.fn().mockReturnValue('1000'),
  getSafeHostGid: jest.fn().mockReturnValue('1000'),
  getRealUserHome: jest.fn().mockReturnValue('/home/test'),
}));

jest.mock('./host-identity', () => ({
  getSafeHostUid: jest.fn().mockReturnValue('1000'),
  getSafeHostGid: jest.fn().mockReturnValue('1000'),
  getRealUserHome: jest.fn().mockReturnValue('/home/test'),
}));

jest.mock('./squid-config', () => ({
  generateSquidConfig: jest.fn().mockReturnValue('# mock squid config'),
  generatePolicyManifest: jest.fn().mockReturnValue({}),
}));

jest.mock('./compose-generator', () => ({
  generateDockerCompose: jest.fn().mockReturnValue({ services: {}, version: '3' }),
  redactDockerComposeSecrets: jest.fn().mockReturnValue({ services: {}, version: '3' }),
}));

jest.mock('./domain-matchers', () => ({
  parseUrlPatterns: jest.fn().mockReturnValue([]),
}));

import * as fs from 'fs';
import * as path from 'path';
import { configWriterTestHelpers } from './config-writer';

const { validateAndPrepareWorkDir, copySeccompProfile, writeAuditArtifacts } =
  configWriterTestHelpers;

const fsMock = fs as jest.Mocked<typeof fs>;

function makeConfig(workDir = '/tmp/test-workdir', overrides = {}) {
  return {
    workDir,
    sslBump: false,
    allowedDomains: [],
    agentCommand: 'echo test',
    logLevel: 'info' as const,
    keepContainers: false,
    buildLocal: false,
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: mkdirSync returns undefined (dir already existed → workDirCreated=false)
  fsMock.mkdirSync.mockReturnValue(undefined);
  // Default: not a symlink, is a directory
  fsMock.lstatSync.mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);
  fsMock.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
});

// ─── validateAndPrepareWorkDir — non-directory guard ─────────────────────────

describe('config-writer: validateAndPrepareWorkDir — non-directory workDir (line 58)', () => {
  it('throws when workDir exists but is not a directory', () => {
    fsMock.lstatSync.mockReturnValueOnce({ isSymbolicLink: () => false } as fs.Stats);
    fsMock.statSync.mockReturnValueOnce({ isDirectory: () => false } as fs.Stats);

    const workDir = '/tmp/test-workdir';
    expect(() =>
      validateAndPrepareWorkDir(makeConfig(workDir))
    ).toThrow(`Expected directory but found non-directory path: ${workDir}`);
  });

  it('does not throw when workDir is a valid directory', () => {
    fsMock.lstatSync.mockReturnValueOnce({ isSymbolicLink: () => false } as fs.Stats);
    fsMock.statSync.mockReturnValueOnce({ isDirectory: () => true } as fs.Stats);

    expect(() => validateAndPrepareWorkDir(makeConfig())).not.toThrow();
    expect(fsMock.chmodSync).toHaveBeenCalled();
  });
});

// ─── copySeccompProfile — alt-path and missing branches ──────────────────────

describe('config-writer: copySeccompProfile — alt-path fallback (lines 95-97)', () => {
  it('copies from the alt path when primary path does not exist', () => {
    fsMock.existsSync
      .mockReturnValueOnce(false)  // primary containers/ path
      .mockReturnValueOnce(true);  // dist/../containers/ alt path

    const config = makeConfig();
    copySeccompProfile(config);

    expect(fsMock.copyFileSync).toHaveBeenCalledTimes(1);
    expect(fsMock.copyFileSync).toHaveBeenCalledWith(
      expect.stringContaining('seccomp-profile.json'),
      expect.stringContaining('seccomp-profile.json'),
    );
  });

  it('throws when neither primary nor alt seccomp path exists', () => {
    fsMock.existsSync
      .mockReturnValueOnce(false)  // primary path
      .mockReturnValueOnce(false); // alt path

    expect(() => copySeccompProfile(makeConfig())).toThrow('Seccomp profile not found');
    expect(fsMock.copyFileSync).not.toHaveBeenCalled();
  });

  it('copies from the primary path when it exists', () => {
    fsMock.existsSync.mockReturnValueOnce(true); // primary path exists

    copySeccompProfile(makeConfig());

    expect(fsMock.copyFileSync).toHaveBeenCalledTimes(1);
  });
});

// ─── writeAuditArtifacts — non-directory auditDir guard ──────────────────────

describe('config-writer: writeAuditArtifacts — non-directory auditDir (line 162)', () => {
  it('throws when auditDir exists but is not a directory', () => {
    fsMock.lstatSync.mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);
    fsMock.statSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);

    const workDir = '/tmp/test-workdir';
    const auditPath = path.join(workDir, 'audit');

    expect(() =>
      writeAuditArtifacts(makeConfig(workDir), {} as any, {} as any, '# squid')
    ).toThrow(`Expected directory but found non-directory path: ${auditPath}`);
  });

  it('writes audit artifacts when auditDir is valid', () => {
    fsMock.lstatSync.mockReturnValue({ isSymbolicLink: () => false } as fs.Stats);
    fsMock.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

    expect(() =>
      writeAuditArtifacts(makeConfig(), {} as any, { services: {}, version: '3' } as any, '# squid')
    ).not.toThrow();

    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });
});
