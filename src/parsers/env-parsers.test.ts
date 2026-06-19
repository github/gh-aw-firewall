import * as fs from 'fs';
import * as path from 'path';
import { readEnvVarFromEnvFiles, parseEnvironmentVariables } from './env-parsers';

jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('readEnvVarFromEnvFiles', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns undefined when envFile is null', () => {
    expect(readEnvVarFromEnvFiles(null, 'MY_KEY')).toBeUndefined();
  });

  it('returns undefined when envFile is undefined', () => {
    expect(readEnvVarFromEnvFiles(undefined, 'MY_KEY')).toBeUndefined();
  });

  it('returns undefined when envFile is false', () => {
    expect(readEnvVarFromEnvFiles(false, 'MY_KEY')).toBeUndefined();
  });

  it('returns undefined when envFile is an empty array', () => {
    expect(readEnvVarFromEnvFiles([], 'MY_KEY')).toBeUndefined();
  });

  it('returns undefined when envFile is a blank string', () => {
    expect(readEnvVarFromEnvFiles('  ', 'MY_KEY')).toBeUndefined();
  });

  it('returns the value for a simple KEY=VALUE line', () => {
    mockFs.readFileSync.mockReturnValue('MY_KEY=hello');
    const result = readEnvVarFromEnvFiles('/some/.env', 'MY_KEY');
    expect(result).toBe('hello');
  });

  it('returns undefined when key is not found in file', () => {
    mockFs.readFileSync.mockReturnValue('OTHER_KEY=value');
    const result = readEnvVarFromEnvFiles('/some/.env', 'MY_KEY');
    expect(result).toBeUndefined();
  });

  it('supports export prefix syntax', () => {
    mockFs.readFileSync.mockReturnValue('export MY_KEY=exported_value');
    const result = readEnvVarFromEnvFiles('/some/.env', 'MY_KEY');
    expect(result).toBe('exported_value');
  });

  it('ignores comment lines', () => {
    mockFs.readFileSync.mockReturnValue('# MY_KEY=comment_value\nOTHER=x');
    const result = readEnvVarFromEnvFiles('/some/.env', 'MY_KEY');
    expect(result).toBeUndefined();
  });

  it('ignores empty lines', () => {
    mockFs.readFileSync.mockReturnValue('\n\nMY_KEY=found\n\n');
    const result = readEnvVarFromEnvFiles('/some/.env', 'MY_KEY');
    expect(result).toBe('found');
  });

  it('last file wins when multiple files define the same key', () => {
    mockFs.readFileSync
      .mockReturnValueOnce('MY_KEY=first_value')
      .mockReturnValueOnce('MY_KEY=second_value');
    const result = readEnvVarFromEnvFiles(['/file1.env', '/file2.env'], 'MY_KEY');
    expect(result).toBe('second_value');
  });

  it('returns value from first file when second file does not define key', () => {
    mockFs.readFileSync
      .mockReturnValueOnce('MY_KEY=from_first')
      .mockReturnValueOnce('OTHER=nope');
    const result = readEnvVarFromEnvFiles(['/file1.env', '/file2.env'], 'MY_KEY');
    expect(result).toBe('from_first');
  });

  it('silently ignores unreadable files', () => {
    mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const result = readEnvVarFromEnvFiles('/missing.env', 'MY_KEY');
    expect(result).toBeUndefined();
  });

  it('skips non-string entries in array', () => {
    mockFs.readFileSync.mockReturnValue('MY_KEY=found');
    const result = readEnvVarFromEnvFiles([42, null, '/valid.env'] as unknown as string[], 'MY_KEY');
    expect(result).toBe('found');
    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('handles empty value (KEY=)', () => {
    mockFs.readFileSync.mockReturnValue('MY_KEY=');
    const result = readEnvVarFromEnvFiles('/some/.env', 'MY_KEY');
    expect(result).toBe('');
  });

  it('handles value with spaces', () => {
    mockFs.readFileSync.mockReturnValue('MY_KEY=  hello world  ');
    const result = readEnvVarFromEnvFiles('/some/.env', 'MY_KEY');
    expect(result).toBe('hello world');
  });

  it('handles Windows-style CRLF line endings', () => {
    mockFs.readFileSync.mockReturnValue('MY_KEY=crlf_value\r\nOTHER=x');
    const result = readEnvVarFromEnvFiles('/some/.env', 'MY_KEY');
    expect(result).toBe('crlf_value');
  });

  it('escapes regex special characters in key names', () => {
    mockFs.readFileSync.mockReturnValue('MY_KEYxDOT=wrong\nMY_KEY.DOT=correct');
    const result = readEnvVarFromEnvFiles('/some/.env', 'MY_KEY.DOT');
    expect(result).toBe('correct');
  });

  it('resolves relative paths against cwd', () => {
    mockFs.readFileSync.mockReturnValue('MY_KEY=relative_value');
    readEnvVarFromEnvFiles('.env', 'MY_KEY');
    expect(mockFs.readFileSync).toHaveBeenCalledWith(
      path.resolve(process.cwd(), '.env'),
      'utf8'
    );
  });
});

describe('parseEnvironmentVariables', () => {
  it('returns empty env for empty array', () => {
    const result = parseEnvironmentVariables([]);
    expect(result).toEqual({ success: true, env: {} });
  });

  it('parses a single KEY=VALUE pair', () => {
    const result = parseEnvironmentVariables(['FOO=bar']);
    expect(result).toEqual({ success: true, env: { FOO: 'bar' } });
  });

  it('parses multiple KEY=VALUE pairs', () => {
    const result = parseEnvironmentVariables(['A=1', 'B=2', 'C=3']);
    expect(result).toEqual({ success: true, env: { A: '1', B: '2', C: '3' } });
  });

  it('allows empty values (KEY=)', () => {
    const result = parseEnvironmentVariables(['MY_VAR=']);
    expect(result).toEqual({ success: true, env: { MY_VAR: '' } });
  });

  it('allows values containing = signs', () => {
    const result = parseEnvironmentVariables(['URL=http://x.com?a=1&b=2']);
    expect(result).toEqual({ success: true, env: { URL: 'http://x.com?a=1&b=2' } });
  });

  it('returns failure for an entry without = sign', () => {
    const result = parseEnvironmentVariables(['NO_EQUALS_HERE']);
    expect(result).toEqual({ success: false, invalidVar: 'NO_EQUALS_HERE' });
  });

  it('returns failure on the first invalid entry', () => {
    const result = parseEnvironmentVariables(['VALID=ok', 'INVALID', 'ALSO_VALID=yes']);
    expect(result).toEqual({ success: false, invalidVar: 'INVALID' });
  });
});
