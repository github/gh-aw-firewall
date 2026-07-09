/**
 * Targeted branch-coverage tests for src/domain-validation.ts / src/domain-utils.ts
 * (exercised via src/commands/preflight.ts):
 *
 * - resolveAllowedDomains: validateAllowedDomains called with non-Error (line 100)
 * - resolveBlockedDomains: blockDomains option provided (lines 194-196)
 * - resolveBlockedDomains: blockDomainsFile throws non-Error (lines 204-207)
 * - resolveBlockedDomains: blockDomainsFile throws Error (lines 204-207)
 * - resolveBlockedDomains: domain validation fails (lines 213-218)
 */

jest.mock('./config-file');
jest.mock('./config-mapper');
jest.mock('./config-precedence');
jest.mock('./domain-utils');
jest.mock('./rules');
jest.mock('./domain-validation');
jest.mock('./copilot-api-resolver');
jest.mock('./api-proxy-config');
jest.mock('./logger', () => jest.requireActual('./test-helpers/mock-logger.test-utils').loggerMockFactory());

import {
  resolveBlockedDomains,
  validateAllowedDomains,
} from './commands/preflight';
import { logger } from './logger';
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
