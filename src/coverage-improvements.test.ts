/**
 * Targeted branch-coverage tests for files identified as below 90% branch coverage:
 *
 * 1. src/logs/log-parser.ts
 *    - extractDomain: non-numeric port suffix in CONNECT URL (line 115 false branch)
 *    - extractDomain: non-numeric port suffix in Host header (line 127 false branch)
 *    - parseAuditJsonlLine: obj.method absent (line 162 false branch)
 *    - parseAuditJsonlLine: obj.decision non-string (line 167 false branch)
 *    - parseAuditJsonlLine: IPv4 dest with non-numeric "port" (lines 199-210)
 *    - parseAuditJsonlLine: timestamp ISO string that fails Date.parse + ts fallback (lines 218-222)
 *    - parseAuditJsonlLine: timestamp as plain obj.ts number without obj.timestamp (lines 222-224)
 *    - parseAuditJsonlLine: neither obj.timestamp nor obj.ts (stays 0)
 *
 * 2. src/workdir-setup.ts
 *    - ensureDirectory: symlink detected → throws (line 24)
 *    - ensureDirectory: non-directory path → throws (line 29)
 *    - assertRealDirectory: symlink → throws (line 45)
 *    - assertRealDirectory: non-directory → throws (line 50)
 *    - createMissingOwnedDirectorySegments: non-directory segment → throws (line 76)
 *    - prepareLogDirectories: /tmp/gh-aw/mcp-logs already exists (lines 194-195 else branch)
 *    - prepareChrootHomeMounts: runnerToolCachePath outside effective home → warn (line 262)
 *
 * 3. src/commands/network-setup.ts
 *    - resolveNetworkConfig: no_proxy env is set with content (line 58-59)
 *    - resolveNetworkConfig: parseDnsServers throws non-Error (line 33)
 *    - resolveNetworkConfig: detectUpstreamProxy throws non-Error (lines 63-71)
 *
 * 4. src/commands/preflight.ts
 *    - resolveAllowedDomains: validateAllowedDomains called with non-Error (line 100)
 *    - resolveBlockedDomains: blockDomains option provided (lines 194-196)
 *    - resolveBlockedDomains: blockDomainsFile throws non-Error (lines 204-207)
 *    - resolveBlockedDomains: blockDomainsFile throws Error (lines 204-207)
 *    - resolveBlockedDomains: domain validation fails (lines 213-218)
 */

// ─── log-parser.ts ────────────────────────────────────────────────────────────

import { parseLogLine, parseAuditJsonlLine } from './logs/log-parser';

describe('log-parser – extractDomain branch coverage', () => {
  describe('CONNECT URL with non-numeric port suffix (line 115 false branch)', () => {
    it('returns the full URL when the part after the last colon is not a number', () => {
      // Construct a synthetic log line where the URL field for a CONNECT request
      // ends with a non-numeric segment (e.g. "host:svcname"). The code falls
      // through the `if (/^\d+$/.test(possiblePort))` guard and returns the URL
      // unchanged.
      const line =
        '1761074374.646 172.30.0.20:39748 host.example.com:svc 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT host.example.com:svc "-"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      // Port suffix is "svc" (non-numeric), so the domain is the whole URL string
      expect(result!.domain).toBe('host.example.com:svc');
    });

    it('returns the full URL when there is no colon at all', () => {
      const line =
        '1761074374.646 172.30.0.20:39748 hostnameonly 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT hostnameonly "-"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.domain).toBe('hostnameonly');
    });
  });

  describe('Host header with non-numeric port suffix (line 127 false branch)', () => {
    it('returns the full host when the port segment is non-numeric', () => {
      // For non-CONNECT methods, the Host header is used. If the part after the
      // last colon is not numeric, the code returns the entire host string.
      const line =
        '1761074374.646 172.30.0.20:39748 example.com:http 93.184.216.34:80 1.1 GET 200 TCP_MISS:HIER_DIRECT http://example.com/ "-"';
      const result = parseLogLine(line);

      expect(result).not.toBeNull();
      expect(result!.domain).toBe('example.com:http');
    });
  });
});

describe('parseAuditJsonlLine – branch coverage for absent/non-string fields', () => {
  describe('obj.method absent (line 162 false branch)', () => {
    it('uses empty string for method when method is not present', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        client: '172.30.0.20',
        host: 'example.com',
        dest: '93.184.216.34:80',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.method).toBe('');
      expect(entry!.isHttps).toBe(false); // CONNECT not present
    });
  });

  describe('obj.decision non-string (line 167 false branch)', () => {
    it('treats non-string decision as empty string (neither allowed nor denied)', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        client: '172.30.0.20',
        host: 'example.com',
        dest: '93.184.216.34:80',
        method: 'GET',
        status: 200,
        decision: 42, // number, not string
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.decision).toBe('');
      expect(entry!.isAllowed).toBe(false);
    });
  });

  describe('IPv4 dest with non-numeric port (lines 199-203 else branch)', () => {
    it('uses entire dest string as destIp when port is alphabetic', () => {
      const line = JSON.stringify({
        timestamp: '2024-01-01T00:00:00.000Z',
        client: '172.30.0.20',
        host: 'example.com',
        dest: '93.184.216.34:http',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.destIp).toBe('93.184.216.34:http');
      expect(entry!.destPort).toBe('-');
    });
  });

  describe('timestamp parsing branches (lines 218-235)', () => {
    it('falls back to obj.ts when obj.timestamp is a string that fails Date.parse', () => {
      // An invalid ISO string that is still of type string triggers the
      // `Number.isNaN(parsed)` guard and falls back to `obj.ts`.
      const line = JSON.stringify({
        timestamp: 'not-a-valid-date',
        ts: 1761074374.646,
        client: '172.30.0.20',
        host: 'example.com',
        dest: '-:-',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      // Falls back to the legacy `ts` epoch field
      expect(entry!.timestamp).toBe(1761074374.646);
    });

    it('uses obj.ts directly when obj.timestamp is absent', () => {
      // No `timestamp` key → falls into the `else if (typeof obj.ts === "number")` branch.
      const line = JSON.stringify({
        ts: 1761074374.646,
        client: '172.30.0.20',
        host: 'example.com',
        dest: '-:-',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.timestamp).toBe(1761074374.646);
    });

    it('leaves timestamp as 0 when neither obj.timestamp nor obj.ts are present', () => {
      const line = JSON.stringify({
        client: '172.30.0.20',
        host: 'example.com',
        dest: '-:-',
        method: 'GET',
        status: 200,
        decision: 'TCP_MISS',
        url: 'http://example.com/',
      });

      const entry = parseAuditJsonlLine(line);

      expect(entry).not.toBeNull();
      expect(entry!.timestamp).toBe(0);
    });
  });
});

// ─── workdir-setup.ts ─────────────────────────────────────────────────────────

// Uses the fs mock factory (wraps real fs with spies) for symlink/non-dir setup.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./test-helpers/fs-mock-factory.test-utils').fsMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./host-env', () => require('./test-helpers/fs-mock-factory.test-utils').hostEnvMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./host-identity', () => require('./test-helpers/fs-mock-factory.test-utils').hostIdentityMockFactory());

import { workdirSetupTestHelpers, prepareWorkDirectories } from './workdir-setup';
import { resolveLogPaths } from './log-paths';
import { getRealUserHome } from './host-identity';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-branch-test-'));
}

describe('workdir-setup – ensureDirectory symlink/non-directory error branches', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws when a symlink exists where a directory is expected (line 24)', () => {
    // Create a real target and a symlink pointing to it, then pass the symlink path
    // to ensureDirectory so it triggers the "Refusing to use symlink" error.
    const realTarget = path.join(tempDir, 'real-target');
    fs.mkdirSync(realTarget);
    const symlinkPath = path.join(tempDir, 'my-symlink');
    fs.symlinkSync(realTarget, symlinkPath);

    expect(() => workdirSetupTestHelpers.ensureDirectory(symlinkPath)).toThrow(
      `Refusing to use symlink as directory: ${symlinkPath}`
    );
  });

  it('calls onCreate callback when a new directory is created', () => {
    const newDir = path.join(tempDir, 'fresh-dir');
    const onCreate = jest.fn();

    workdirSetupTestHelpers.ensureDirectory(newDir, { onCreate });

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(newDir)).toBe(true);
  });

  it('calls onExists callback when the directory already exists', () => {
    const existingDir = path.join(tempDir, 'existing-dir');
    fs.mkdirSync(existingDir);
    const onExists = jest.fn();

    workdirSetupTestHelpers.ensureDirectory(existingDir, { onExists });

    expect(onExists).toHaveBeenCalledTimes(1);
  });

  it('calls onAfterEnsure callback regardless of creation state', () => {
    const dirPath = path.join(tempDir, 'after-ensure-dir');
    const onAfterEnsure = jest.fn();

    workdirSetupTestHelpers.ensureDirectory(dirPath, { onAfterEnsure });

    expect(onAfterEnsure).toHaveBeenCalledTimes(1);
  });
});

describe('workdir-setup – assertRealDirectory error branches', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws when assertRealDirectory receives a symlink path (line 45)', () => {
    const realTarget = path.join(tempDir, 'real-dir');
    fs.mkdirSync(realTarget);
    const symlinkPath = path.join(tempDir, 'link-to-dir');
    fs.symlinkSync(realTarget, symlinkPath);

    expect(() => workdirSetupTestHelpers.assertRealDirectory(symlinkPath)).toThrow(
      `Refusing to use symlink as directory: ${symlinkPath}`
    );
  });

  it('throws when assertRealDirectory receives a file path (line 50)', () => {
    const filePath = path.join(tempDir, 'plain-file.txt');
    fs.writeFileSync(filePath, 'content');

    expect(() => workdirSetupTestHelpers.assertRealDirectory(filePath)).toThrow(
      `Expected directory but found non-directory path: ${filePath}`
    );
  });
});

describe('workdir-setup – createMissingOwnedDirectorySegments non-directory segment (line 76)', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws when a path segment is a regular file rather than a directory', () => {
    // Create a file at an intermediate path segment so the loop hits a non-dir.
    const fileSegment = path.join(tempDir, 'file-segment');
    fs.writeFileSync(fileSegment, 'I am a file');
    // Now request a child path through that file segment.
    const childPath = path.join(fileSegment, 'child');

    expect(() =>
      workdirSetupTestHelpers.createMissingOwnedDirectorySegments(childPath, 1000, 1000)
    ).toThrow(`Expected directory but found non-directory path: ${fileSegment}`);
  });
});

describe('workdir-setup – prepareLogDirectories mcp-logs already-exists branch (lines 194-195)', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    tempDir = makeTempDir();
    (getRealUserHome as jest.Mock).mockReturnValue(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('calls chmodSync on /tmp/gh-aw/mcp-logs when directory already exists (else branch)', () => {
    // Pre-create the mcp-logs directory so ensureDirectory returns false
    // and the "Fix permissions" else branch is taken.
    const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
    fs.mkdirSync(mcpLogsDir, { recursive: true });

    const buildConfig = () => ({
      workDir: tempDir,
      sslBump: false,
      allowedDomains: [] as string[],
      agentCommand: 'echo test',
      logLevel: 'info' as const,
      keepContainers: false,
      buildLocal: false,
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    });

    const config = buildConfig();
    const logPaths = resolveLogPaths(config);

    prepareWorkDirectories(config, logPaths);

    // The else branch always calls chmodSync to fix permissions
    expect(fs.chmodSync).toHaveBeenCalledWith(mcpLogsDir, 0o777);
  });
});

describe('workdir-setup – prepareChrootHomeMounts runnerToolCachePath outside home (line 262)', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    tempDir = makeTempDir();
    (getRealUserHome as jest.Mock).mockReturnValue(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('logs a warning and skips creation when runnerToolCachePath is outside effectiveHome', () => {
    // A path that does not start with tempDir (our mocked effectiveHome)
    const outsidePath = path.join(os.tmpdir(), `outside-home-${Date.now()}`);

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

    // Path does not exist yet, so the `!fs.existsSync` branch is entered,
    // but since it is outside effectiveHome, the warning branch (line 262) fires.
    const config = buildConfig({ runnerToolCachePath: outsidePath });
    const logPaths = resolveLogPaths(config);

    expect(() => prepareWorkDirectories(config, logPaths)).not.toThrow();
    // The outside-home directory must NOT have been created
    expect(fs.existsSync(outsidePath)).toBe(false);
  });
});

// ─── commands/network-setup.ts ────────────────────────────────────────────────

// Mock only the deps, not the module under test
jest.mock('./logger', () => jest.requireActual('./test-helpers/mock-logger.test-utils').loggerMockFactory());
jest.mock('./dns-resolver');
jest.mock('./upstream-proxy');
jest.mock('./option-parsers');

import { resolveNetworkConfig } from './commands/network-setup';
import { logger } from './logger';
import * as dnsResolver from './dns-resolver';
import * as upstreamProxy from './upstream-proxy';
import * as optionParsers from './option-parsers';

const mockedNetworkLogger = logger as jest.Mocked<typeof logger>;
const mockedDnsResolver = dnsResolver as jest.Mocked<typeof dnsResolver>;
const mockedUpstreamProxy = upstreamProxy as jest.Mocked<typeof upstreamProxy>;
const mockedOptionParsers = optionParsers as jest.Mocked<typeof optionParsers>;

describe('resolveNetworkConfig – uncovered branches', () => {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockedDnsResolver.detectHostDnsServers.mockReturnValue(['8.8.8.8']);
    mockedUpstreamProxy.detectUpstreamProxy.mockReturnValue(undefined);
    mockedOptionParsers.parseDnsServers.mockReturnValue(['1.1.1.1']);
    mockedOptionParsers.parseDnsOverHttps.mockReturnValue(undefined);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('includes non-Error string in message when parseDnsServers throws a non-Error (line 33)', () => {
    (mockedOptionParsers.parseDnsServers as jest.Mock).mockImplementation(() => {
      throw 'bad input string';
    });

    expect(() => resolveNetworkConfig({ dnsServers: 'bad' })).toThrow('process.exit called');
    expect(mockedNetworkLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('bad input string')
    );
  });

  it('sets noProxy when no_proxy env var is set and non-empty (lines 58-60)', () => {
    mockedUpstreamProxy.parseProxyUrl.mockReturnValue({ host: 'proxy.corp', port: 8080 });
    mockedUpstreamProxy.parseNoProxy.mockReturnValue(['internal.corp', '10.0.0.0/8']);

    const origEnv = process.env;
    process.env = { ...origEnv, no_proxy: 'internal.corp,10.0.0.0/8', NO_PROXY: '' };
    try {
      const result = resolveNetworkConfig({ upstreamProxy: 'http://proxy.corp:8080' });
      expect(result.upstreamProxy).toEqual({
        host: 'proxy.corp',
        port: 8080,
        noProxy: ['internal.corp', '10.0.0.0/8'],
      });
      expect(mockedUpstreamProxy.parseNoProxy).toHaveBeenCalledWith('internal.corp,10.0.0.0/8');
    } finally {
      process.env = origEnv;
    }
  });

  it('includes non-Error string in message when detectUpstreamProxy throws a non-Error (lines 68-72)', () => {
    mockedUpstreamProxy.detectUpstreamProxy.mockImplementation(() => {
      throw 'env detection failure';
    });

    expect(() => resolveNetworkConfig({})).toThrow('process.exit called');
    expect(mockedNetworkLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('env detection failure')
    );
  });

  it('includes non-Error string in message when parseProxyUrl throws a non-Error (lines 63-64)', () => {
    mockedUpstreamProxy.parseProxyUrl.mockImplementation(() => {
      throw 'malformed proxy url';
    });

    expect(() => resolveNetworkConfig({ upstreamProxy: 'garbage' })).toThrow('process.exit called');
    expect(mockedNetworkLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('malformed proxy url')
    );
  });
});

// ─── commands/preflight.ts ────────────────────────────────────────────────────

jest.mock('./config-file');
jest.mock('./config-mapper');
jest.mock('./config-precedence');
jest.mock('./domain-utils');
jest.mock('./rules');
jest.mock('./domain-validation');
jest.mock('./copilot-api-resolver');
jest.mock('./api-proxy-config');

import {
  resolveBlockedDomains,
  validateAllowedDomains,
} from './commands/preflight';
import * as domainUtils from './domain-utils';
import * as domainValidation from './domain-validation';

const mockedPreflightLogger = logger as jest.Mocked<typeof logger>;
const mockedDomainUtils = domainUtils as jest.Mocked<typeof domainUtils>;
const mockedDomainValidation = domainValidation as jest.Mocked<typeof domainValidation>;

describe('validateAllowedDomains – non-Error thrown in validation (line 100)', () => {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('includes the thrown string when validateDomainOrPattern throws a non-Error', () => {
    mockedDomainValidation.validateDomainOrPattern.mockImplementation(() => {
      throw 'non-Error rejection string';
    });

    expect(() => validateAllowedDomains(['bad-domain'])).toThrow('process.exit called');
    expect(mockedPreflightLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('non-Error rejection string')
    );
  });
});

describe('resolveBlockedDomains – branch coverage', () => {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockedDomainUtils.parseDomains.mockReturnValue([]);
    mockedDomainUtils.parseDomainsFile.mockReturnValue([]);
    mockedDomainValidation.validateDomainOrPattern.mockImplementation(() => undefined);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('parses blockDomains option when provided (lines 194-196)', () => {
    mockedDomainUtils.parseDomains.mockReturnValue(['evil.com', 'malware.net']);

    const result = resolveBlockedDomains({ blockDomains: 'evil.com,malware.net' });

    expect(mockedDomainUtils.parseDomains).toHaveBeenCalledWith('evil.com,malware.net');
    expect(result).toEqual(['evil.com', 'malware.net']);
  });

  it('returns empty array when neither blockDomains nor blockDomainsFile are provided', () => {
    const result = resolveBlockedDomains({});
    expect(result).toEqual([]);
  });

  it('parses blocked domains from file when blockDomainsFile is set', () => {
    mockedDomainUtils.parseDomainsFile.mockReturnValue(['file-blocked.com']);

    const result = resolveBlockedDomains({ blockDomainsFile: '/path/to/blocklist.txt' });

    expect(mockedDomainUtils.parseDomainsFile).toHaveBeenCalledWith('/path/to/blocklist.txt');
    expect(result).toContain('file-blocked.com');
  });

  it('exits when blockDomainsFile read fails with an Error (lines 204-207)', () => {
    mockedDomainUtils.parseDomainsFile.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    expect(() => resolveBlockedDomains({ blockDomainsFile: '/nonexistent.txt' })).toThrow(
      'process.exit called'
    );
    expect(mockedPreflightLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('ENOENT: no such file or directory')
    );
  });

  it('exits when blockDomainsFile read fails with a non-Error (lines 204-207)', () => {
    mockedDomainUtils.parseDomainsFile.mockImplementation(() => {
      throw 'read error string';
    });

    expect(() => resolveBlockedDomains({ blockDomainsFile: '/bad.txt' })).toThrow(
      'process.exit called'
    );
    expect(mockedPreflightLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('read error string')
    );
  });

  it('exits when blocked domain validation fails (lines 213-218)', () => {
    mockedDomainUtils.parseDomains.mockReturnValue(['invalid!!domain']);
    mockedDomainValidation.validateDomainOrPattern.mockImplementation(() => {
      throw new Error('Validation failed');
    });

    expect(() => resolveBlockedDomains({ blockDomains: 'invalid!!domain' })).toThrow(
      'process.exit called'
    );
    expect(mockedPreflightLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid blocked domain or pattern')
    );
  });

  it('deduplicates blocked domains before returning (line 210)', () => {
    mockedDomainUtils.parseDomains.mockReturnValue(['dup.com', 'dup.com', 'other.com']);

    const result = resolveBlockedDomains({ blockDomains: 'dup.com,dup.com,other.com' });

    expect(result).toEqual(['dup.com', 'other.com']);
  });
});
