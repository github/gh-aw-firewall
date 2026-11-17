import execa = require('execa');
import * as fs from 'fs/promises';
import glob = require('glob');
import { Cleanup } from '../fixtures/cleanup';

jest.mock('execa');
jest.mock('fs/promises', () => ({
  rm: jest.fn(),
}));
jest.mock('glob', () => ({
  sync: jest.fn(),
}));

describe('integration cleanup fixture', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('removes the shared gh-aw work directory with the per-run work directories', async () => {
    jest.mocked(glob.sync).mockReturnValue(['/tmp/awf-one', '/tmp/awf-two']);
    const rm = jest.mocked(fs.rm).mockResolvedValue();

    await new Cleanup().removeWorkDirectories();

    expect(rm.mock.calls).toEqual([
      ['/tmp/awf-one', { recursive: true, force: true }],
      ['/tmp/awf-two', { recursive: true, force: true }],
      ['/tmp/gh-aw', { recursive: true, force: true }],
    ]);
    expect(execa).not.toHaveBeenCalled();
  });

  it('uses non-interactive sudo when a stale root-owned gh-aw directory blocks removal', async () => {
    jest.mocked(glob.sync).mockReturnValue([]);
    jest.mocked(fs.rm).mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );
    jest.mocked(execa).mockResolvedValue({} as never);

    await new Cleanup().removeWorkDirectories();

    expect(execa).toHaveBeenCalledWith(
      'sudo',
      ['-n', 'rm', '-rf', '--', '/tmp/gh-aw'],
    );
  });
});
