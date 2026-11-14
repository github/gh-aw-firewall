import { parseMountInfo, readExactMounts, readTreeMountInfo } from './mount-tree-parse';
import type { MountInfoEntry } from './mount-tree-parse';

function record(mountPoint: string, options = 'ro,nosuid,nodev', optionalFields = ''): string {
  return `31 29 0:42 / ${mountPoint} ${options} ${optionalFields ? `${optionalFields} ` : ''}- ext4 /dev/root rw`;
}

describe('mount-tree mountinfo parsing', () => {
  it('decodes octal path escapes without changing options or optional fields', () => {
    const entries: MountInfoEntry[] = parseMountInfo(record(
      '/run/a\\040b\\011c\\012d\\134e',
      'ro,nosuid,nodev,relatime',
      'shared:21 master:2 propagate_from:3',
    ));
    expect(entries).toEqual([{
      mountPoint: '/run/a b\tc\nd\\e',
      options: ['ro', 'nosuid', 'nodev', 'relatime'],
      optionalFields: ['shared:21', 'master:2', 'propagate_from:3'],
    }]);
  });

  it('ignores empty/malformed records and retains the existing separator boundary', () => {
    expect(parseMountInfo([
      '', 'invalid', '31 29 0:42 / /bad - ext4 /dev/root rw',
      '31 29 0:42 / /missing ro ext4 /dev/root rw',
      '31 29 0:42 / /valid ro -',
      record('/run/good'),
    ].join('\n'))).toEqual([
      { mountPoint: '/valid', options: ['ro'], optionalFields: [] },
      { mountPoint: '/run/good', options: ['ro', 'nosuid', 'nodev'], optionalFields: [] },
    ]);
  });

  it('does not recursively decode an escaped backslash into a second escape', () => {
    expect(parseMountInfo(record('/run/\\134040'))[0].mountPoint).toBe('/run/\\040');
  });

  it('reads only exact decoded targets and preserves stacked records in order', async () => {
    const dependencies = {
      readMountInfo: jest.fn().mockResolvedValue([
        record('/run/a\\040b', 'ro'),
        record('/run/a\\040b/child'),
        record('/run/a\\040b-other'),
        record('/run/a\\040b', 'rw'),
      ].join('\n')),
    };
    expect(await readExactMounts(dependencies, '/run/a b')).toEqual([
      { mountPoint: '/run/a b', options: ['ro'], optionalFields: [] },
      { mountPoint: '/run/a b', options: ['rw'], optionalFields: [] },
    ]);
    expect(await readExactMounts(dependencies, '/run/missing')).toEqual([]);
    expect(dependencies.readMountInfo).toHaveBeenCalledTimes(2);
  });

  it('reads root and descendants, excluding parents, prefix siblings and traversal escapes', async () => {
    const dependencies = {
      readMountInfo: jest.fn().mockResolvedValue([
        record('/run/tree'), record('/run/tree/child'), record('/run/tree/child/deeper'),
        record('/run'), record('/run/tree-other'), record('/run/tree/../outside'),
      ].join('\n')),
    };
    expect((await readTreeMountInfo(dependencies, '/run/tree')).map((entry) => entry.mountPoint))
      .toEqual(['/run/tree', '/run/tree/child', '/run/tree/child/deeper']);
  });

  it('propagates mount-table read errors', async () => {
    const dependencies = { readMountInfo: jest.fn().mockRejectedValue(new Error('unreadable')) };
    await expect(readExactMounts(dependencies, '/run/tree')).rejects.toThrow('unreadable');
    await expect(readTreeMountInfo(dependencies, '/run/tree')).rejects.toThrow('unreadable');
  });
});
