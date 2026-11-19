import { assertMountToolSupported, parseMountInfo, selectMountPlan } from './mount-tree';

describe('selectMountPlan', () => {
  it('returns undefined without enforcement or a matching tag', () => {
    expect(selectMountPlan(undefined, 'workspace')).toBeUndefined();
    expect(
      selectMountPlan({ plans: [{ tag: 'cache', writableOverlays: [] }] }, 'workspace'),
    ).toBeUndefined();
  });

  it('rejects duplicate plans for one export tag', () => {
    expect(() =>
      selectMountPlan({
        plans: [
          { tag: 'workspace', writableOverlays: [] },
          { tag: 'workspace', writableOverlays: [] },
        ],
      }, 'workspace'),
    ).toThrow(/Duplicate Cloud Hypervisor mount plan/);
  });
});

describe('assertMountToolSupported', () => {
  const tools = { mount: '/usr/bin/mount', umount: '/usr/bin/umount' };

  it.each([
    ['mount from util-linux 2.39.3 (libmount 2.39.0)', true],
    ['mount from util-linux 2.41 (libmount 2.41)', true],
    ['mount from util-linux 3.1 (libmount 3.1)', true],
    ['mount from util-linux 2.23 (libmount 2.23)', true],
    ['mount from util-linux 2.22.2 (libmount 2.22)', false],
    ['mount from util-linux 1.99 (libmount 1.99)', false],
  ])('accepts %s: %s', async (version, supported) => {
    const deps = {
      captureTool: jest.fn().mockResolvedValue(version),
    };
    const assertion = assertMountToolSupported(tools, deps);
    if (supported) {
      await expect(assertion).resolves.toBeUndefined();
    } else {
      await expect(assertion).rejects.toThrow(/requires util-linux >= 2\.23/);
    }
  });

  it('fails closed when the version cannot be parsed', async () => {
    const deps = {
      captureTool: jest.fn().mockResolvedValue('mount from busybox'),
    };
    await expect(assertMountToolSupported(tools, deps)).rejects.toThrow(
      /Unable to determine util-linux version/,
    );
  });
});

describe('parseMountInfo', () => {
  it('parses mount points, options, and optional fields with octal escapes', () => {
    const entries = parseMountInfo(
      [
        '30 29 0:42 / /run/awf\\040shares ro,nosuid shared:21 master:2 - ext4 /dev/root ro',
        '',
        'malformed line',
        '31 30 0:43 / /run/awf/child rw - ext4 /dev/root rw',
      ].join('\n'),
    );
    expect(entries).toEqual([
      {
        mountPoint: '/run/awf shares',
        options: ['ro', 'nosuid'],
        optionalFields: ['shared:21', 'master:2'],
      },
      { mountPoint: '/run/awf/child', options: ['rw'], optionalFields: [] },
    ]);
  });
});
