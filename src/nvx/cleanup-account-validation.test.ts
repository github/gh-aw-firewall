import { promises as fs } from 'fs';
import {
  exists,
  validatePendingAccountGroup,
  validatePendingAccountPasswd,
} from './cleanup-account-validation';

const runId = 'c'.repeat(32);
const name = `awfnvx-${'d'.repeat(20)}`;
const passwdFields = [
  name, 'x', '23001', '23002', `AWF NVX ${runId}`, '/nonexistent', '/usr/sbin/nologin',
];

describe('cleanup account validation', () => {
  it('accepts a passwd entry bound to the exact run', () => {
    expect(validatePendingAccountPasswd(`${passwdFields.join(':')}\n`, name, runId)).toEqual({
      uid: 23001, gid: 23002,
    });
  });

  it.each([
    [0, 'other'], [2, 'uid'], [3, 'gid'], [4, 'AWF NVX other'],
    [5, '/home/other'], [6, '/bin/sh'],
  ] as const)('rejects a changed passwd field %s', (index, value) => {
    const fields = [...passwdFields];
    fields[index] = value;
    expect(() => validatePendingAccountPasswd(fields.join(':'), name, runId)).toThrow(
      /unverified pending NVX account/,
    );
  });

  it('rejects additional passwd fields or entries', () => {
    for (const contents of [
      `${passwdFields.join(':')}:extra`,
      `${passwdFields.join(':')}\n${passwdFields.join(':')}`,
    ]) {
      expect(() => validatePendingAccountPasswd(contents, name, runId)).toThrow(
        /unverified pending NVX account/,
      );
    }
  });

  it('accepts only an empty group with the expected name and GID', () => {
    expect(() => validatePendingAccountGroup(`${name}:x:23002:\n`, name, 23002)).not.toThrow();
    for (const contents of [
      'other:x:23002:', `${name}:x:invalid:`, `${name}:x:23003:`,
      `${name}:x:23002:member`, `${name}:x:23002::extra`,
    ]) {
      expect(() => validatePendingAccountGroup(contents, name, 23002)).toThrow(
        /unverified pending NVX group/,
      );
    }
    expect(() => validatePendingAccountGroup(`${name}:x:23002:`, name, undefined)).toThrow(
      /unverified pending NVX group/,
    );
  });

  it('treats only ENOENT as a missing file and propagates other failures', async () => {
    const lstat = jest.fn().mockResolvedValue({});
    await expect(exists('/resource', lstat as unknown as typeof fs.lstat)).resolves.toBe(true);
    expect(lstat).toHaveBeenCalledWith('/resource');
    lstat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(exists('/resource', lstat as unknown as typeof fs.lstat)).resolves.toBe(false);
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    lstat.mockRejectedValueOnce(error);
    await expect(exists('/resource', lstat as unknown as typeof fs.lstat)).rejects.toBe(error);
  });
});
