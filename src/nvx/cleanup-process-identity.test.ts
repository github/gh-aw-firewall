import { promises as fs } from 'fs';
import { captureProcessIdentity, parseStatusIdentity, sameProcess } from './cleanup-process-identity';
import type { NvxCleanupProcessIdentity } from './cleanup-record';

const identity: NvxCleanupProcessIdentity = {
  pid: 4242,
  startTimeTicks: '1000',
  executable: '/usr/bin/node',
  executableDevice: '8',
  executableInode: '9',
  uid: 23001,
  gid: 23002,
  networkNamespace: 'net:[4026531840]',
};

describe('cleanup process identity', () => {
  it('captures proc identity with a parenthesized name and a deleted executable', async () => {
    const readFile = jest.fn(async (filePath) => String(filePath).endsWith('/stat')
      ? `4242 (node (worker)) ${['S', ...Array(18).fill('0'), '1000'].join(' ')}`
      : 'Uid:\t23001 23001 23001 23001\r\nGid:\t23002 23002 23002 23002\r\n');
    const readlink = jest.fn(async (filePath) => String(filePath).endsWith('/exe')
      ? '/usr/bin/node (deleted)'
      : 'net:[4026531840]');
    const stat = jest.fn().mockResolvedValue({ dev: 8n, ino: 9n });

    await expect(captureProcessIdentity(4242, {
      readFile: readFile as unknown as typeof fs.readFile,
      readlink: readlink as unknown as typeof fs.readlink,
      stat: stat as unknown as typeof fs.stat,
    })).resolves.toEqual(identity);
    expect(readFile).toHaveBeenCalledWith('/proc/4242/stat', 'utf8');
    expect(readFile).toHaveBeenCalledWith('/proc/4242/status', 'utf8');
    expect(stat).toHaveBeenCalledWith('/proc/4242/exe', { bigint: true });
    expect(readlink).toHaveBeenCalledWith('/proc/4242/ns/net');
  });

  it.each([0, 1, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe PID %s before reading proc',
    async (pid) => {
      const readFile = jest.fn();
      await expect(captureProcessIdentity(pid, { ...fs, readFile })).rejects.toThrow(
        /Unsafe NVX process id/,
      );
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  it.each(['Uid', 'Gid'] as const)('requires four equal %s identities', (field) => {
    expect(parseStatusIdentity(`${field}:\t0 0 0 0\n`, field)).toBe(0);
    for (const status of ['', `${field}: 1 1 1`, `${field}: 1 2 1 1`]) {
      expect(() => parseStatusIdentity(status, field)).toThrow(/identities are unstable/);
    }
  });

  it('matches only when every process identity field is unchanged', () => {
    expect(sameProcess(identity, { ...identity })).toBe(true);
    for (const key of Object.keys(identity) as Array<keyof NvxCleanupProcessIdentity>) {
      const value = identity[key];
      expect(sameProcess(identity, {
        ...identity,
        [key]: typeof value === 'number' ? value + 1 : `${value}-changed`,
      })).toBe(false);
    }
  });
});
