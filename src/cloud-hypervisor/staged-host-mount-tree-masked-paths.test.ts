import { cache, mountTable, plan, ROOT, stats, tools, tree, workspace } from './mount-tree.test-utils';

describe('StagedHostMountTree', () => {
  describe('masked paths', () => {
    it('masks a path without forcing the rest of a read-write export read-only', async () => {
      const fake = mountTable();
      const staged = tree(
        fake,
        plan([], 'workspace', [{ destination: '/host/workspace/mcp-logs' }]),
      );
      await staged.stage();
      expect(fake.commands).toEqual([
        [tools.mount, '--rbind', '/host/workspace', ROOT],
        [tools.mount, '--make-rprivate', ROOT],
        [tools.mount, '-o', 'remount,bind,nosuid,nodev', `${ROOT}/nested`],
        [tools.mount, '-o', 'remount,bind,nosuid,nodev', ROOT],
        [
          tools.mount,
          '-t',
          'tmpfs',
          '-o',
          'ro,nosuid,nodev,size=0,mode=000',
          'none',
          `${ROOT}/mcp-logs`,
        ],
      ]);
      expect(staged.isStaged).toBe(true);
      expect(fake.table.get(ROOT)?.options).toContain('rw');
      expect(fake.table.get(`${ROOT}/nested`)?.options).toContain('rw');
      expect(fake.table.get(`${ROOT}/mcp-logs`)?.options).toEqual(
        expect.arrayContaining(['ro', 'nosuid', 'nodev']),
      );
    });

    it('preserves read-only nested mounts in a masks-only writable export', async () => {
      const fake = mountTable({ nestedReadOnly: true });
      const staged = tree(
        fake,
        plan([], 'workspace', [{ destination: '/host/workspace/mcp-logs' }]),
      );
      await staged.stage();
      expect(fake.commands.slice(2, 4)).toEqual([
        [tools.mount, '-o', 'remount,bind,nosuid,nodev', `${ROOT}/nested`],
        [tools.mount, '-o', 'remount,bind,nosuid,nodev', ROOT],
      ]);
      expect(fake.table.get(ROOT)?.options).toContain('rw');
      expect(fake.table.get(`${ROOT}/nested`)?.options).toContain('ro');
      expect(fake.table.get(`${ROOT}/nested`)?.options).toContain('nosuid');
      expect(fake.table.get(`${ROOT}/nested`)?.options).toContain('nodev');
    });

    it('unmounts a masks-only writable root deepest-first', async () => {
      const fake = mountTable();
      const staged = tree(
        fake,
        plan([], 'workspace', [{ destination: '/host/workspace/mcp-logs' }]),
      );
      await staged.stage();
      await staged.unmount();
      expect(fake.commands.slice(-2)).toEqual([
        [tools.umount, `${ROOT}/mcp-logs`],
        [tools.umount, '-R', ROOT],
      ]);
      expect(staged.hasResidue).toBe(false);
      expect(fake.table.size).toBe(0);
    });

    it('applies masks after writable overlays on an otherwise read-only export', async () => {
      const fake = mountTable();
      const staged = tree(
        fake,
        plan(
          [{ source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' }],
          'workspace',
          [{ destination: '/host/workspace/mcp-logs' }],
        ),
      );
      await staged.stage();
      expect(fake.commands.slice(-4)).toEqual([
        [tools.mount, '--bind', '/host/workspace/out', `${ROOT}/out`],
        [tools.mount, '--make-rprivate', `${ROOT}/out`],
        [tools.mount, '-o', 'remount,bind,rw,nosuid,nodev', `${ROOT}/out`],
        [
          tools.mount,
          '-t',
          'tmpfs',
          '-o',
          'ro,nosuid,nodev,size=0,mode=000',
          'none',
          `${ROOT}/mcp-logs`,
        ],
      ]);
      expect(fake.table.get(ROOT)?.options).toContain('ro');
      expect(fake.table.get(`${ROOT}/out`)?.options).toContain('rw');
      expect(fake.table.get(`${ROOT}/mcp-logs`)?.options).toContain('ro');
    });

    it('masks a path on an already read-only export', async () => {
      const fake = mountTable();
      const staged = tree(fake, plan([], 'cache', [{ destination: '/host/cache/mcp-logs' }]), cache);
      await staged.stage();
      expect(fake.table.get(`${ROOT}/mcp-logs`)?.options).toContain('ro');
    });

    it('rejects a masked path overlapping a writable overlay', async () => {
      const fake = mountTable();
      const staged = tree(
        fake,
        plan(
          [{ source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' }],
          'workspace',
          [{ destination: '/host/workspace/out' }],
        ),
      );
      await expect(staged.stage()).rejects.toThrow(/overlaps a writable overlay/);
      expect(fake.commands).toEqual([]);
    });

    it('rejects duplicate and overlapping masked path destinations', async () => {
      const fake = mountTable();
      const duplicate = tree(
        fake,
        plan([], 'workspace', [
          { destination: '/host/workspace/mcp-logs' },
          { destination: '/host/workspace/mcp-logs' },
        ]),
      );
      await expect(duplicate.stage()).rejects.toThrow(/Duplicate .* destination/);

      const overlapping = tree(
        fake,
        plan([], 'workspace', [
          { destination: '/host/workspace/sandbox' },
          { destination: '/host/workspace/sandbox/logs' },
        ]),
      );
      await expect(overlapping.stage()).rejects.toThrow(/Overlapping .* destinations/);
    });

    it('rejects more masked paths than the supported maximum', async () => {
      const fake = mountTable();
      const maskedPaths = Array.from({ length: 17 }, (_value, index) => ({
        destination: `/host/workspace/mask${index}`,
      }));
      const staged = tree(fake, plan([], 'workspace', maskedPaths));
      await expect(staged.stage()).rejects.toThrow(/exceeds 16 masked paths/);
      expect(fake.commands).toEqual([]);
    });

    it('rejects a masked path outside the export source', async () => {
      const fake = mountTable();
      const staged = tree(
        fake,
        plan([], 'workspace', [{ destination: '/host/other/mcp-logs' }]),
      );
      await expect(staged.stage()).rejects.toThrow(/mask destination must stay inside/);
      expect(fake.commands).toEqual([]);
    });

    it('requires the masked destination to already exist as a directory', async () => {
      const fake = mountTable();
      const staged = tree(
        fake,
        plan([], 'workspace', [{ destination: '/host/workspace/mcp-logs' }]),
        workspace,
        { statPath: jest.fn(async () => stats('file')) },
      );
      await expect(staged.stage()).rejects.toThrow(/must be an existing directory/);
    });

    it('rejects a masked destination reached through a symlink', async () => {
      const fake = mountTable();
      const staged = tree(
        fake,
        plan([], 'workspace', [{ destination: '/host/workspace/mcp-logs' }]),
        workspace,
        {
          realpath: jest.fn(async (filePath: string) =>
            filePath === `${ROOT}/mcp-logs` ? '/etc' : filePath,
          ),
        },
      );
      await expect(staged.stage()).rejects.toThrow(/destination must be canonical/);
      expect(fake.commands.flat()).not.toContain('-t');
    });

    it('fails closed when a masked mount is not applied', async () => {
      const fake = mountTable();
      const staged = tree(
        fake,
        plan([], 'workspace', [{ destination: '/host/workspace/mcp-logs' }]),
        workspace,
        {
          runTool: jest.fn(async (command: string, args: readonly string[]) => {
            if (args[0] === '-t') return; // pretend the tmpfs mount silently no-ops
            return fake.runTool(command, args);
          }),
        },
      );
      await expect(staged.stage()).rejects.toThrow(/Masked path was not applied/);
    });
  });
});
