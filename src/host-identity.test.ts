import * as fs from 'fs';
import { getSafeHostUid, getSafeHostGid, getRealUserHome, ACT_PRESET_BASE_IMAGE } from './host-identity';

jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('ACT_PRESET_BASE_IMAGE', () => {
  it('is a non-empty string pointing to an Ubuntu act image', () => {
    expect(typeof ACT_PRESET_BASE_IMAGE).toBe('string');
    expect(ACT_PRESET_BASE_IMAGE).toContain('ubuntu');
    expect(ACT_PRESET_BASE_IMAGE).toContain('act');
  });
});

describe('getSafeHostUid', () => {
  const originalGetuid = process.getuid;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.SUDO_UID;
  });

  afterEach(() => {
    Object.defineProperty(process, 'getuid', { value: originalGetuid, configurable: true });
    process.env = originalEnv;
  });

  it('returns the current UID when it is a regular user (≥1000)', () => {
    Object.defineProperty(process, 'getuid', { value: () => 1500, configurable: true });
    expect(getSafeHostUid()).toBe('1500');
  });

  it('returns "1000" when UID is 0 (root) and no SUDO_UID', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    expect(getSafeHostUid()).toBe('1000');
  });

  it('uses SUDO_UID when running as root', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    process.env.SUDO_UID = '1234';
    expect(getSafeHostUid()).toBe('1234');
  });

  it('returns "1000" when SUDO_UID is an invalid number', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    process.env.SUDO_UID = 'invalid';
    expect(getSafeHostUid()).toBe('1000');
  });

  it('clamps SUDO_UID below 1000 to "1000"', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    process.env.SUDO_UID = '500';
    expect(getSafeHostUid()).toBe('1000');
  });

  it('clamps system UID (e.g. 999) to "1000"', () => {
    Object.defineProperty(process, 'getuid', { value: () => 999, configurable: true });
    expect(getSafeHostUid()).toBe('1000');
  });

  it('returns "1000" when getuid is not available', () => {
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    expect(getSafeHostUid()).toBe('1000');
  });
});

describe('getSafeHostGid', () => {
  const originalGetgid = process.getgid;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.SUDO_GID;
  });

  afterEach(() => {
    Object.defineProperty(process, 'getgid', { value: originalGetgid, configurable: true });
    process.env = originalEnv;
  });

  it('returns the current GID when it is a regular group (≥1000)', () => {
    Object.defineProperty(process, 'getgid', { value: () => 2000, configurable: true });
    expect(getSafeHostGid()).toBe('2000');
  });

  it('returns "1000" when GID is 0 and no SUDO_GID', () => {
    Object.defineProperty(process, 'getgid', { value: () => 0, configurable: true });
    expect(getSafeHostGid()).toBe('1000');
  });

  it('uses SUDO_GID when running as root', () => {
    Object.defineProperty(process, 'getgid', { value: () => 0, configurable: true });
    process.env.SUDO_GID = '1234';
    expect(getSafeHostGid()).toBe('1234');
  });

  it('returns "1000" when SUDO_GID is an invalid number', () => {
    Object.defineProperty(process, 'getgid', { value: () => 0, configurable: true });
    process.env.SUDO_GID = 'not-a-number';
    expect(getSafeHostGid()).toBe('1000');
  });

  it('clamps SUDO_GID in system range to "1000"', () => {
    Object.defineProperty(process, 'getgid', { value: () => 0, configurable: true });
    process.env.SUDO_GID = '100';
    expect(getSafeHostGid()).toBe('1000');
  });

  it('returns "1000" when getgid is not available', () => {
    Object.defineProperty(process, 'getgid', { value: undefined, configurable: true });
    expect(getSafeHostGid()).toBe('1000');
  });
});

describe('getRealUserHome', () => {
  const originalGetuid = process.getuid;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.SUDO_USER;
    delete process.env.HOME;
  });

  afterEach(() => {
    Object.defineProperty(process, 'getuid', { value: originalGetuid, configurable: true });
    process.env = originalEnv;
  });

  it('returns HOME when running as a regular user', () => {
    Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
    process.env.HOME = '/home/myuser';
    expect(getRealUserHome()).toBe('/home/myuser');
  });

  it('falls back to /root when HOME is not set', () => {
    Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
    expect(getRealUserHome()).toBe('/root');
  });

  it('uses SUDO_USER to look up home from /etc/passwd', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    process.env.SUDO_USER = 'alice';
    process.env.HOME = '/root';
    mockFs.readFileSync.mockReturnValue('root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000:Alice:/home/alice:/bin/bash\n');
    expect(getRealUserHome()).toBe('/home/alice');
  });

  it('falls back to HOME when SUDO_USER is not found in /etc/passwd', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    process.env.SUDO_USER = 'bob';
    process.env.HOME = '/root';
    mockFs.readFileSync.mockReturnValue('root:x:0:0:root:/root:/bin/bash\n');
    expect(getRealUserHome()).toBe('/root');
  });

  it('falls back to HOME when /etc/passwd is unreadable', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    process.env.SUDO_USER = 'alice';
    process.env.HOME = '/root';
    mockFs.readFileSync.mockImplementation(() => { throw new Error('EACCES'); });
    expect(getRealUserHome()).toBe('/root');
  });

  it('falls back to HOME when SUDO_USER is not set but running as root', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    process.env.HOME = '/root';
    expect(getRealUserHome()).toBe('/root');
  });

  it('returns /root when HOME is not set and running as root without SUDO_USER', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    expect(getRealUserHome()).toBe('/root');
  });

  it('falls back to HOME when passwd line has fewer than 6 fields', () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    process.env.SUDO_USER = 'alice';
    process.env.HOME = '/home/fallback';
    mockFs.readFileSync.mockReturnValue('alice:x:1000:1000\n');
    expect(getRealUserHome()).toBe('/home/fallback');
  });

  it('returns /root as ultimate fallback when no HOME env', () => {
    Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
    expect(getRealUserHome()).toBe('/root');
  });
});
