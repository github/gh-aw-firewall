import * as fs from 'fs';
import { parseVolumeMounts } from './volume-parsers';

jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('parseVolumeMounts', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Default: host paths exist
    mockFs.existsSync.mockReturnValue(true);
  });

  it('returns empty success for empty array', () => {
    const result = parseVolumeMounts([]);
    expect(result).toEqual({ success: true, mounts: [] });
  });

  it('parses a valid read-only mount', () => {
    const result = parseVolumeMounts(['/host/src:/container/dst:ro']);
    expect(result).toEqual({ success: true, mounts: ['/host/src:/container/dst:ro'] });
  });

  it('parses a valid read-write mount', () => {
    const result = parseVolumeMounts(['/host/src:/container/dst:rw']);
    expect(result).toEqual({ success: true, mounts: ['/host/src:/container/dst:rw'] });
  });

  it('parses a mount without mode', () => {
    const result = parseVolumeMounts(['/host/src:/container/dst']);
    expect(result).toEqual({ success: true, mounts: ['/host/src:/container/dst'] });
  });

  it('parses multiple valid mounts', () => {
    const result = parseVolumeMounts(['/host/a:/cnt/a:ro', '/host/b:/cnt/b']);
    expect(result).toEqual({ success: true, mounts: ['/host/a:/cnt/a:ro', '/host/b:/cnt/b'] });
  });

  it('returns error for a mount with only one path segment', () => {
    const result = parseVolumeMounts(['/only-one-path']);
    expect(result).toEqual({
      success: false,
      invalidMount: '/only-one-path',
      reason: 'Mount must be in format host_path:container_path[:mode]',
    });
  });

  it('returns error for a mount with too many segments (4 parts)', () => {
    const result = parseVolumeMounts(['/a:/b:ro:extra']);
    expect(result).toEqual({
      success: false,
      invalidMount: '/a:/b:ro:extra',
      reason: 'Mount must be in format host_path:container_path[:mode]',
    });
  });

  it('returns error for empty host path', () => {
    const result = parseVolumeMounts([':/container/dst']);
    expect(result).toEqual({
      success: false,
      invalidMount: ':/container/dst',
      reason: 'Host path cannot be empty',
    });
  });

  it('returns error for empty container path', () => {
    const result = parseVolumeMounts(['/host/src:']);
    expect(result).toEqual({
      success: false,
      invalidMount: '/host/src:',
      reason: 'Container path cannot be empty',
    });
  });

  it('returns error for relative host path', () => {
    const result = parseVolumeMounts(['relative/path:/container/dst']);
    expect(result).toEqual({
      success: false,
      invalidMount: 'relative/path:/container/dst',
      reason: 'Host path must be absolute (start with /)',
    });
  });

  it('returns error for relative container path', () => {
    const result = parseVolumeMounts(['/host/src:relative/container']);
    expect(result).toEqual({
      success: false,
      invalidMount: '/host/src:relative/container',
      reason: 'Container path must be absolute (start with /)',
    });
  });

  it('returns error for invalid mount mode', () => {
    const result = parseVolumeMounts(['/host/src:/container/dst:invalid']);
    expect(result).toEqual({
      success: false,
      invalidMount: '/host/src:/container/dst:invalid',
      reason: 'Mount mode must be either "ro" or "rw"',
    });
  });

  it('returns error when host path does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    const result = parseVolumeMounts(['/nonexistent:/container/dst']);
    expect(result).toEqual({
      success: false,
      invalidMount: '/nonexistent:/container/dst',
      reason: 'Host path does not exist: /nonexistent',
    });
  });

  it('returns error when existsSync throws', () => {
    mockFs.existsSync.mockImplementation(() => { throw new Error('permission denied'); });
    const result = parseVolumeMounts(['/forbidden:/container/dst']);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toMatch(/Failed to check host path/);
    }
  });

  it('returns error on the first invalid mount in a list', () => {
    const result = parseVolumeMounts(['/host/a:/cnt/a', 'bad-path:/cnt/b']);
    expect(result).toEqual({
      success: false,
      invalidMount: 'bad-path:/cnt/b',
      reason: 'Host path must be absolute (start with /)',
    });
  });
});
