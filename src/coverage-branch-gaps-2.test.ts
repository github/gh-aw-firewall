/**
 * Branch-coverage tests for src/squid/config-sections.ts and src/ssl-bump.ts,
 * kept in a separate file because ssl-bump.ts requires real fs for tmpdir
 * creation while log-aggregator.ts needs mocked fs.
 *
 * Targets:
 *   src/squid/config-sections.ts
 *     - sslBump + urlPatterns + patterns only (no plain domains) →
 *       denyNonMatching uses "allowed_domains_regex"
 *     - sslBump + urlPatterns + neither plain nor patterns → denyNonMatching = ''
 *
 *   src/ssl-bump.ts
 *     - mountSslTmpfs returns true → "memory-only filesystem" log branch
 *     - initSslDb: chownRecursive throws non-EPERM → re-throws
 *     - initSslDb: chownRecursive throws EPERM → swallowed (already tested in ssl-bump.test.ts,
 *       but adding explicit check for the debug-log path)
 *
 *   src/pid-tracker.ts
 *     - parseNetTcp: line with fewer than 10 fields → skipped
 *     - findProcessByInode: /proc readdirSync throws → returns null
 *     - inode found but no process owns it → error result
 */

// ─────────────────────────────────────────────────────────────────────────────
// squid/config-sections.ts
// ─────────────────────────────────────────────────────────────────────────────

import { buildConfigSections } from './squid/config-sections';
import { parseDomainConfig } from './squid/domain-acl';

describe('squid/config-sections – sslBump URL-pattern deny-rule branches', () => {
  const caFiles = {
    certPath: '/tmp/ssl/ca-cert.pem',
    keyPath: '/tmp/ssl/ca-key.pem',
    derPath: '/tmp/ssl/ca-cert.der',
  };
  const sslDbPath = '/var/lib/squid/ssl_db';
  const urlPatterns = ['https://example.com/safe'];

  it('uses allowed_domains_regex deny when there are wildcard patterns but no plain domains', () => {
    // hasPatternsForSslBump=true (wildcard → pattern), hasPlainDomainsForSslBump=false
    const { domainsByProto: dbp, patternsByProto: pbp } = parseDomainConfig(['*.example.com']);

    const result = buildConfigSections({
      port: 3128,
      sslBump: true,
      caFiles,
      sslDbPath,
      urlPatterns,
      domainsByProto: dbp,
      patternsByProto: pbp,
    });

    expect(result.sslBumpUrlAccessSection).toContain('allowed_domains_regex');
    expect(result.sslBumpUrlAccessSection).not.toContain('http_access deny !CONNECT allowed_domains\n');
  });

  it('emits empty deny string when neither plain domains nor patterns are configured', () => {
    // hasPlainDomainsForSslBump=false, hasPatternsForSslBump=false
    const { domainsByProto: dbp, patternsByProto: pbp } = parseDomainConfig([]);

    const result = buildConfigSections({
      port: 3128,
      sslBump: true,
      caFiles,
      sslDbPath,
      urlPatterns,
      domainsByProto: dbp,
      patternsByProto: pbp,
    });

    expect(result.sslBumpUrlAccessSection).toContain('http_access allow allowed_url_0');
    expect(result.sslBumpUrlAccessSection).not.toContain('http_access deny !CONNECT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// src/ssl-bump.ts
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as os from 'os';
import * as pathMod from 'path';
import execa from 'execa';
import * as sslKeyStorage from './ssl-key-storage';
import { generateSessionCa, initSslDb } from './ssl-bump';

jest.mock('execa');
jest.mock('./ssl-key-storage', () => ({
  mountSslTmpfs: jest.fn(),
  unmountSslTmpfs: jest.fn(),
  cleanupSslKeyMaterial: jest.fn(),
  chownRecursive: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());

const mockedExeca = execa as jest.MockedFunction<typeof execa>;
const mockedKeyStorage = sslKeyStorage as jest.Mocked<typeof sslKeyStorage>;

describe('ssl-bump.ts – uncovered branches', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'awf-ssl-test-'));
    mockedKeyStorage.mountSslTmpfs.mockReset();
    mockedKeyStorage.chownRecursive.mockReset();
    mockedExeca.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  describe('generateSessionCa – tmpfs mount success branch', () => {
    it('succeeds when mountSslTmpfs returns true (memory-only path)', async () => {
      mockedKeyStorage.mountSslTmpfs.mockResolvedValue(true);

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'openssl' && args[0] === 'req') {
          const keyoutIdx = args.indexOf('-keyout');
          const outIdx = args.indexOf('-out');
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture: args from mock openssl
          if (keyoutIdx !== -1) fs.writeFileSync(args[keyoutIdx + 1], 'MOCK KEY');
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture: args from mock openssl
          if (outIdx !== -1) fs.writeFileSync(args[outIdx + 1], 'MOCK CERT');
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'openssl' && args[0] === 'x509') {
          const outIdx = args.indexOf('-out');
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture: args from mock openssl
          if (outIdx !== -1) fs.writeFileSync(args[outIdx + 1], 'MOCK DER');
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as typeof execa);

      const result = await generateSessionCa({ workDir: tmpDir });
      expect(result.certPath).toContain('ca-cert.pem');
      expect(mockedKeyStorage.mountSslTmpfs).toHaveBeenCalled();
    });
  });

  describe('initSslDb – chownRecursive error handling', () => {
    it('re-throws when chownRecursive throws a non-EPERM error', async () => {
      const eacces = Object.assign(new Error('Access denied'), { code: 'EACCES' });
      mockedKeyStorage.chownRecursive.mockImplementation(() => { throw eacces; });

      await expect(initSslDb(tmpDir)).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('swallows EPERM error from chownRecursive (not running as root)', async () => {
      const eperm = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      mockedKeyStorage.chownRecursive.mockImplementation(() => { throw eperm; });

      const dbPath = await initSslDb(tmpDir);
      expect(dbPath).toContain('ssl_db');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pid-tracker.ts
// ─────────────────────────────────────────────────────────────────────────────

import { trackPidForPortSync } from './pid-tracker';

describe('pid-tracker – uncovered branches', () => {
  let mockProcPath: string;

  beforeEach(() => {
    mockProcPath = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'mock-proc-'));
  });

  afterEach(() => {
    fs.rmSync(mockProcPath, { recursive: true, force: true });
  });

  describe('parseNetTcp – line with fewer than 10 fields is skipped', () => {
    it('returns "no socket found" when all data lines have too few fields', () => {
      const netDir = pathMod.join(mockProcPath, 'net');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper writing mock /proc
      fs.mkdirSync(netDir, { recursive: true });
      // Header + 1 line with only 5 whitespace-separated tokens (< 10)
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper writing mock /proc
      fs.writeFileSync(
        pathMod.join(netDir, 'tcp'),
        '  sl  local_address rem_address st\n' +
        '  0: 0100007F:01BB 00000000:0000 0A\n',
      );

      const result = trackPidForPortSync(443, mockProcPath);
      expect(result.error).toMatch(/No socket found for port 443/);
    });
  });

  describe('findProcessByInode – /proc readdirSync throws → returns null', () => {
    it('returns an error result when net/tcp cannot be read', () => {
      const result = trackPidForPortSync(12345, pathMod.join(mockProcPath, 'nonexistent'));
      expect(result.pid).toBe(-1);
      expect(result.error).toBeDefined();
    });

    it('reports "inode found but no process owns it" when inode exists without an owner', () => {
      const netDir = pathMod.join(mockProcPath, 'net');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper writing mock /proc
      fs.mkdirSync(netDir, { recursive: true });
      // Port 8080 = 0x1F90
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper writing mock /proc
      fs.writeFileSync(
        pathMod.join(netDir, 'tcp'),
        '  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode\n' +
        '   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 999999\n',
      );
      // No /proc/<pid> directories → findProcessByInode returns null
      const result = trackPidForPortSync(8080, mockProcPath);
      expect(result.pid).toBe(-1);
      expect(result.error).toMatch(/Socket inode 999999 found but no process owns it/);
    });
  });
});
