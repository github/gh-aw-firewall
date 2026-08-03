import * as fs from 'fs';
import { parseVolumeMounts, volumeParsersTestHelpers } from './volume-parsers';

jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;
const { expandEnvVarsInMount } = volumeParsersTestHelpers;

describe('expandEnvVarsInMount', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns the string unchanged when there are no variables', () => {
    const result = expandEnvVarsInMount('/usr/local/bin:/container/bin:ro');
    expect(result).toEqual({ expanded: '/usr/local/bin:/container/bin:ro', undefinedVar: null });
  });

  it('expands a ${VAR_NAME} reference', () => {
    process.env.TERRAFORM_CLI_PATH = '/opt/terraform';
    const result = expandEnvVarsInMount('${TERRAFORM_CLI_PATH}/terraform:/container/terraform:ro');
    expect(result).toEqual({ expanded: '/opt/terraform/terraform:/container/terraform:ro', undefinedVar: null });
  });

  it('expands a $VAR_NAME reference', () => {
    process.env.MY_TOOL_DIR = '/opt/my-tool';
    const result = expandEnvVarsInMount('$MY_TOOL_DIR/bin:/container/bin:ro');
    expect(result).toEqual({ expanded: '/opt/my-tool/bin:/container/bin:ro', undefinedVar: null });
  });

  it('expands multiple variable references in one mount spec', () => {
    process.env.HOST_DIR = '/mnt/data';
    process.env.CNT_DIR = '/data';
    const result = expandEnvVarsInMount('${HOST_DIR}:${CNT_DIR}:rw');
    expect(result).toEqual({ expanded: '/mnt/data:/data:rw', undefinedVar: null });
  });

  it('returns undefinedVar for an unset ${VAR_NAME}', () => {
    delete process.env.UNSET_VAR;
    const result = expandEnvVarsInMount('${UNSET_VAR}/bin:/container/bin:ro');
    expect(result).toEqual({ expanded: null, undefinedVar: 'UNSET_VAR' });
  });

  it('returns undefinedVar for an unset $VAR_NAME', () => {
    delete process.env.MISSING_VAR;
    const result = expandEnvVarsInMount('$MISSING_VAR/bin:/container/bin:ro');
    expect(result).toEqual({ expanded: null, undefinedVar: 'MISSING_VAR' });
  });
});

describe('parseVolumeMounts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    // Default: host paths exist
    mockFs.existsSync.mockReturnValue(true);
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
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

  it('expands ${VAR_NAME} in a mount spec before validation', () => {
    process.env.TERRAFORM_CLI_PATH = '/opt/terraform';
    const result = parseVolumeMounts(['${TERRAFORM_CLI_PATH}/terraform:/container/terraform:ro']);
    expect(result).toEqual({
      success: true,
      mounts: ['/opt/terraform/terraform:/container/terraform:ro'],
    });
  });

  it('expands $VAR_NAME in a mount spec before validation', () => {
    process.env.TOOL_DIR = '/usr/local/tools';
    const result = parseVolumeMounts(['$TOOL_DIR/bin:/container/bin:rw']);
    expect(result).toEqual({
      success: true,
      mounts: ['/usr/local/tools/bin:/container/bin:rw'],
    });
  });

  it('returns error with original mount spec when env var is not set', () => {
    delete process.env.MISSING_VAR;
    const result = parseVolumeMounts(['${MISSING_VAR}/bin:/container/bin:ro']);
    expect(result).toEqual({
      success: false,
      invalidMount: '${MISSING_VAR}/bin:/container/bin:ro',
      reason: 'Environment variable is not set: ${MISSING_VAR}',
    });
  });

  it('returns expanded mount spec in results (not the original with variables)', () => {
    process.env.MY_PATH = '/resolved/path';
    const result = parseVolumeMounts(['${MY_PATH}:/container/path:ro']);
    expect(result).toEqual({ success: true, mounts: ['/resolved/path:/container/path:ro'] });
    if (result.success) {
      expect(result.mounts[0]).not.toContain('${MY_PATH}');
    }
  });
});
