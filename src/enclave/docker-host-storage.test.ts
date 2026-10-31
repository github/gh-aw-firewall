import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFile, type ChildProcess } from 'child_process';
import {
  assertDockerHostPath, cleanupDockerHostStorage, dockerMemoryBytes, dockerWritableBudget, inspectDockerHostTmpfs,
  resolveDockerHostTool, mountDockerHostStorage,
} from './docker-host-storage';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));

const linuxIt = process.platform === 'linux' ? it : it.skip;

describe('Docker host enclave writable storage', () => {
  test('counts host exports, both script tmpfs mounts and implicit shm', () => {
    expect(dockerWritableBudget('script', undefined, 64 * 1024 ** 2, 1200 * 1024 ** 2))
      .toEqual({ hostBytes: 64 * 1024 ** 2, containerBytes: 1104 * 1024 ** 2, aggregateBytes: 1200 * 1024 ** 2 });
    expect(dockerWritableBudget('script', '96m', 64 * 1024 ** 2, 320 * 1024 ** 2).containerBytes)
      .toBe(256 * 1024 ** 2);
    expect(() => dockerWritableBudget('script', '96m', 64 * 1024 ** 2, 319 * 1024 ** 2))
      .toThrow('aggregate budget');
  });

  test('preserves configured agent tmpfs and shm without VM resource defaults', () => {
    expect(dockerWritableBudget('agent', '96m', 64 * 1024 ** 2, 256 * 1024 ** 2).containerBytes)
      .toBe(192 * 1024 ** 2);
    expect(() => dockerWritableBudget('agent', '96m', 64 * 1024 ** 2, 255 * 1024 ** 2))
      .toThrow('aggregate budget');
    expect(() => dockerWritableBudget('agent', '96m', 1025, 300 * 1024 ** 2)).toThrow();
  });

  test.each(['0', '-1', '1.5g', '4tb', 'unlimited', '9007199254740992'])('rejects invalid storage limit %s', (value) => {
    expect(() => dockerMemoryBytes(value)).toThrow();
  });

  const mount = '53 24 0:34 / /private/enclave rw,nosuid,nodev,noexec,relatime - tmpfs awf-enclave-run-invocation rw,size=65536k';
  test('verifies exact tmpfs identity, source, restrictive options and capacity', () => {
    expect(inspectDockerHostTmpfs('/private/enclave', 'awf-enclave-run-invocation', 64 * 1024 ** 2, mount))
      .toEqual({
        mountId: '53', device: '0:34', root: '/', source: 'awf-enclave-run-invocation',
        target: '/private/enclave', bytes: 64 * 1024 ** 2,
      });
  });

  test.each([
    mount.replace('tmpfs ', 'ext4 '),
    mount.replace('awf-enclave-run-invocation', 'foreign'),
    mount.replace('noexec,', ''),
    mount.replace('nosuid,', ''),
    mount.replace('nodev,', ''),
    mount.replace('65536k', '131072k'),
    mount.replace(' / /private', ' /subtree /private'),
    `${mount}\n${mount}`,
    '',
  ])('refuses unproven mounts', (line) => {
    expect(() => inspectDockerHostTmpfs('/private/enclave', 'awf-enclave-run-invocation', 64 * 1024 ** 2, line)).toThrow();
  });

  test('rejects symlink mount roots rather than translating unsupported paths', () => {
    const root = path.join(process.cwd(), `.docker-host-storage-${randomBytes(8).toString('hex')}`);
    fs.mkdirSync(root, { mode: 0o700 });
    try {
      fs.symlinkSync(root, path.join(root, 'alias'));
      expect(() => assertDockerHostPath(path.join(root, 'alias', 'invocation'))).toThrow('ancestor');
      expect(() => assertDockerHostPath('/host/path:ro')).toThrow('absolute paths');
      expect(() => assertDockerHostPath('relative')).toThrow('absolute paths');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  linuxIt('absent mount does not settle an interrupted mount operation', async () => {
    const root = path.join(process.cwd(), `.docker-host-storage-${randomBytes(8).toString('hex')}`);
    fs.mkdirSync(root, { mode: 0o700 });
    try {
      await expect(cleanupDockerHostStorage({
        storageTarget: root, storageSource: 'awf-private', storageBytes: 64 * 1024 ** 2, mountPending: true,
      })).rejects.toThrow('completion remains uncertain');
      expect(fs.existsSync(root)).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('privileged helpers cannot be selected from writable PATH entries', () => {
    const root = path.join(process.cwd(), `.docker-host-storage-${randomBytes(8).toString('hex')}`);
    fs.mkdirSync(root, { mode: 0o700 });
    const executable = path.join(root, 'docker');
    try {
      fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(executable, 0o777);
      expect(() => resolveDockerHostTool([executable])).toThrow('root-owned immutable');
      expect(() => resolveDockerHostTool(['docker'])).toThrow('root-owned immutable');
      expect(path.isAbsolute(resolveDockerHostTool(['/usr/bin/true', '/bin/true']))).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  linuxIt('legacy privileged mount commands receive no inherited repository credentials', async () => {
    const root = path.join(process.cwd(), `.docker-host-storage-${randomBytes(8).toString('hex')}`);
    fs.mkdirSync(root, { mode: 0o700 });
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'synthetic-repository-credential';
    jest.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error) => void;
      callback(new Error('stop before mounting'));
      return {} as ChildProcess;
    });
    try {
      await expect(mountDockerHostStorage(root, 'awf-test', 65536)).rejects.toThrow('storage operation failed');
      expect(jest.mocked(execFile).mock.calls[0][2]).toEqual({
        timeout: 30_000, maxBuffer: 4096,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      });
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
      jest.mocked(execFile).mockReset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
