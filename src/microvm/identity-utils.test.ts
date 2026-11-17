import {
  formatError,
  parsePositiveInteger,
  parseProcessStatStartTime,
  readProcessStartTime,
} from './identity-utils';

describe('shared identity utilities', () => {
  it('formats errors and other thrown values', () => {
    expect(formatError(new Error('failure'))).toBe('failure');
    expect(formatError('failure')).toBe('failure');
    expect(formatError(null)).toBe('null');
  });

  it('parses trimmed, safe positive account identifiers', () => {
    expect(parsePositiveInteger('42\n', 'uid')).toBe(42);
    expect(parsePositiveInteger(String(Number.MAX_SAFE_INTEGER), 'gid'))
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(['', '0', '-1', '+1', '01', '1.5', '1e3', 'abc'])(
    'rejects invalid positive integers %j', (value) => {
      expect(() => parsePositiveInteger(value, 'uid')).toThrow('invalid uid');
    },
  );

  it('rejects unsafe positive integers', () => {
    expect(() => parsePositiveInteger('9007199254740992', 'gid')).toThrow('unsafe gid');
  });

  it('parses stat records with spaces and parentheses in the command', async () => {
    const fields = Array.from({ length: 20 }, (_, index) => String(index));
    fields[19] = '777';
    const stat = `123 (command (with) spaces) ${fields.join(' ')}\n`;
    expect(parseProcessStatStartTime(stat)).toBe('777');
    const readFile = jest.fn().mockResolvedValue(stat);
    await expect(readProcessStartTime(123, readFile)).resolves.toBe('777');
    expect(readFile).toHaveBeenCalledWith('/proc/123/stat', 'utf8');
  });

  it.each(['', '123 command 1 2', '123 (command) 1 2'])(
    'fails closed for malformed process stat %j', async (stat) => {
      await expect(readProcessStartTime(123, async () => stat))
        .rejects.toThrow('Malformed process stat start time');
    },
  );

  it.each(['ENOENT', 'EACCES', 'EIO'])('only treats ENOENT as a dead process: %s', async (code) => {
    const error = Object.assign(new Error(code), { code });
    const result = readProcessStartTime(123, async () => { throw error; });
    if (code === 'ENOENT') await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toBe(error);
  });
});
