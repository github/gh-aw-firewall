import { captureFile, tryCaptureInterface } from './cleanup-capture';
import type { NvxCleanupRegistryDependencies } from './cleanup-registry';

describe('NVX cleanup capture helpers', () => {
  it('captures exact file identity without losing bigint precision', async () => {
    const lstat = jest.fn().mockResolvedValue({
      dev: 9007199254740993n,
      ino: 9007199254740995n,
    });

    await expect(captureFile('/run/nvx-resource', {
      lstat: lstat as NvxCleanupRegistryDependencies['lstat'],
    })).resolves.toEqual({
      path: '/run/nvx-resource',
      device: '9007199254740993',
      inode: '9007199254740995',
    });
    expect(lstat).toHaveBeenCalledWith('/run/nvx-resource', { bigint: true });
  });

  it.each([undefined, 'awf-nvx-test'])(
    'captures an interface in namespace %s using the supplied ip tool',
    async (namespace) => {
      const run = jest.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '[{"ifname":"tap0","ifindex":17}]',
        stderr: '',
      });

      await expect(
        tryCaptureInterface('tap0', namespace, '/custom/ip', { run }),
      ).resolves.toEqual({ name: 'tap0', namespace, ifindex: 17 });
      expect(run).toHaveBeenCalledWith('/custom/ip', namespace
        ? ['netns', 'exec', namespace, '/custom/ip', '-json', 'link', 'show', 'dev', 'tap0']
        : ['-json', 'link', 'show', 'dev', 'tap0']);
    },
  );

  it('returns no identity when the interface is absent', async () => {
    const run = jest.fn().mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Device "tap0" does not exist.',
    });
    await expect(
      tryCaptureInterface('tap0', undefined, '/custom/ip', { run }),
    ).resolves.toBeUndefined();
  });

  it('propagates interface inspection errors', async () => {
    const run = jest.fn().mockResolvedValue({
      exitCode: 2,
      stdout: '',
      stderr: 'RTNETLINK answers: Operation not permitted',
    });
    await expect(
      tryCaptureInterface('tap0', undefined, '/custom/ip', { run }),
    ).rejects.toThrow(/Could not inspect NVX interface tap0/);
  });

  it.each([
    { entries: [] },
    { entries: [{ ifname: 'other', ifindex: 17 }] },
    { entries: [{ ifname: 'tap0', ifindex: 17 }, { ifname: 'tap0', ifindex: 18 }] },
    { entries: [{ ifname: 'tap0' }] },
    { entries: [{ ifname: 'tap0', ifindex: 1.5 }] },
    { entries: [{ ifname: 'tap0', ifindex: Number.MAX_SAFE_INTEGER + 1 }] },
  ])('rejects ambiguous or invalid interface identity: $entries', async ({ entries }) => {
    const run = jest.fn().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(entries),
      stderr: '',
    });
    await expect(
      tryCaptureInterface('tap0', undefined, '/custom/ip', { run }),
    ).rejects.toThrow(/Invalid NVX interface identity/);
  });
});
