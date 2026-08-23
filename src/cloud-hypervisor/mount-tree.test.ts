import type { CloudHypervisorDirectoryExport } from './exports';
import {
  StagedHostMountTree,
  assertMountToolSupported,
  parseMountInfo,
  selectMountPlan,
  type MountTreeDependencies,
  type VirtiofsdExportMountPlan,
} from './mount-tree';

const workspace: CloudHypervisorDirectoryExport = {
  tag: 'workspace',
  source: '/host/workspace',
  target: '/workspace',
  mode: 'rw',
};
const cache: CloudHypervisorDirectoryExport = {
  tag: 'cache',
  source: '/host/cache',
  target: '/host/cache',
  mode: 'ro',
};
const ROOT = '/run/awf-shares/run/0-workspace';
const tools = { mount: '/usr/bin/mount', umount: '/usr/bin/umount' };

interface MountRecord {
  options: string[];
  optionalFields: string[];
}

/**
 * Fake host mount table modelled on observed util-linux 2.39.3 behaviour:
 * records every mount/umount invocation, applies remounts to a single mount at a
 * time, and synthesises the matching /proc/self/mountinfo so the manager's
 * fail-closed verification is exercised for real.
 */
function mountTable(options: { ineffectiveRemount?: boolean; shared?: boolean } = {}) {
  const table = new Map<string, MountRecord>();
  const commands: string[][] = [];
  const childrenOf = (target: string): string[] =>
    [...table.keys()].filter((key) => key === target || key.startsWith(`${target}/`));
  const runTool = jest.fn(async (command: string, args: readonly string[]) => {
    commands.push([command, ...args]);
    if (command === tools.umount) {
      const recursive = args[0] === '-R';
      const target = args[args.length - 1];
      const affected = childrenOf(target);
      if (!recursive && affected.length > 1) throw new Error(`target is busy: ${target}`);
      for (const key of recursive ? affected : [target]) table.delete(key);
      return;
    }
    if (args[0] === '--rbind') {
      const [, source, target] = args;
      expect(source.startsWith('/')).toBe(true);
      table.set(target, {
        options: ['rw', 'relatime'],
        optionalFields: options.shared === false ? [] : ['shared:21'],
      });
      // Submount carried in by the recursive bind.
      table.set(`${target}/nested`, {
        options: ['rw', 'relatime'],
        optionalFields: options.shared === false ? [] : ['shared:22'],
      });
      return;
    }
    if (args[0] === '--bind') {
      // A new bind mount joins the *source's* peer group, so binding from a
      // shared host mount yields a shared mount even when the destination's
      // parent is already private. Modelling that is what makes the overlay's
      // explicit `--make-rprivate` observable here instead of only on a real
      // kernel.
      table.set(args[2], {
        options: ['rw', 'relatime'],
        optionalFields: options.shared === false ? [] : ['shared:23'],
      });
      return;
    }
    if (args[0] === '--make-rprivate') {
      for (const key of childrenOf(args[1])) {
        table.set(key, { ...(table.get(key) as MountRecord), optionalFields: [] });
      }
      return;
    }
    if (args[0] === '-o') {
      const requested = args[1].split(',');
      const target = args[2];
      if (!requested.includes('remount')) {
        throw new Error(`unexpected mount invocation: ${args.join(' ')}`);
      }
      const current = table.get(target);
      if (!current) throw new Error(`not mounted: ${target}`);
      // Simulates a mount tool that reports success without changing anything.
      if (options.ineffectiveRemount) return;
      table.set(target, {
        ...current,
        options: [requested.includes('ro') ? 'ro' : 'rw', 'nosuid', 'nodev', 'relatime'],
      });
      return;
    }
    throw new Error(`unexpected mount invocation: ${args.join(' ')}`);
  });
  const readMountInfo = jest.fn(async () =>
    [...table.entries()]
      .map(([mountPoint, record], index) =>
        [
          `${30 + index}`,
          '29',
          '0:42',
          '/',
          mountPoint,
          record.options.join(','),
          ...record.optionalFields,
          '-',
          'ext4',
          '/dev/root',
          record.options.join(','),
        ].join(' '),
      )
      .join('\n'),
  );
  return { table, commands, runTool, readMountInfo };
}

function dependencies(
  fake: ReturnType<typeof mountTable>,
  overrides: Partial<MountTreeDependencies> = {},
): MountTreeDependencies {
  return {
    mkdir: jest.fn().mockResolvedValue(undefined),
    rmdir: jest.fn().mockResolvedValue(undefined),
    runTool: fake.runTool,
    captureTool: jest.fn().mockResolvedValue('mount from util-linux 2.39.3 (libmount 2.39.0)'),
    statPath: jest.fn(async (filePath: string) => stats(filePath.endsWith('.json') ? 'file' : 'directory')),
    realpath: jest.fn(async (filePath: string) => filePath),
    readMountInfo: fake.readMountInfo,
    ...overrides,
  };
}

function stats(kind: 'file' | 'directory' | 'symlink') {
  return {
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  };
}

function plan(
  overlays: VirtiofsdExportMountPlan['writableOverlays'],
  tag = 'workspace',
): VirtiofsdExportMountPlan {
  return { tag, writableOverlays: overlays };
}

function tree(
  fake: ReturnType<typeof mountTable>,
  mountPlan: VirtiofsdExportMountPlan,
  directoryExport = workspace,
  overrides: Partial<MountTreeDependencies> = {},
): StagedHostMountTree {
  return new StagedHostMountTree({
    directoryExport,
    rootPath: ROOT,
    plan: mountPlan,
    tools,
    dependencies: dependencies(fake, overrides),
  });
}

describe('selectMountPlan', () => {
  it('returns undefined without enforcement or a matching tag', () => {
    expect(selectMountPlan(undefined, 'workspace')).toBeUndefined();
    expect(selectMountPlan({ plans: [plan([], 'cache')] }, 'workspace')).toBeUndefined();
  });

  it('rejects duplicate plans for one export tag', () => {
    expect(() => selectMountPlan({ plans: [plan([]), plan([])] }, 'workspace')).toThrow(
      /Duplicate Cloud Hypervisor mount plan/,
    );
  });
});

describe('assertMountToolSupported', () => {
  it.each([
    ['mount from util-linux 2.39.3 (libmount 2.39.0)', true],
    ['mount from util-linux 2.41 (libmount 2.41)', true],
    ['mount from util-linux 3.1 (libmount 3.1)', true],
    ['mount from util-linux 2.23 (libmount 2.23)', true],
    ['mount from util-linux 2.22.2 (libmount 2.22)', false],
    ['mount from util-linux 1.99 (libmount 1.99)', false],
  ])('accepts %s: %s', async (version, supported) => {
    const deps = dependencies(mountTable(), {
      captureTool: jest.fn().mockResolvedValue(version),
    });
    const assertion = assertMountToolSupported(tools, deps);
    if (supported) {
      await expect(assertion).resolves.toBeUndefined();
    } else {
      await expect(assertion).rejects.toThrow(/requires util-linux >= 2\.23/);
    }
  });

  it('fails closed when the version cannot be parsed', async () => {
    const deps = dependencies(mountTable(), {
      captureTool: jest.fn().mockResolvedValue('mount from busybox'),
    });
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

describe('StagedHostMountTree', () => {
  it('stages a recursively read-only tree, remounting each mount deepest-first', async () => {
    const fake = mountTable();
    const staged = tree(fake, plan([]));
    await staged.stage();
    expect(fake.commands).toEqual([
      [tools.mount, '--rbind', '/host/workspace', ROOT],
      [tools.mount, '--make-rprivate', ROOT],
      [tools.mount, '-o', 'remount,bind,ro,nosuid,nodev', `${ROOT}/nested`],
      [tools.mount, '-o', 'remount,bind,ro,nosuid,nodev', ROOT],
    ]);
    expect(staged.isStaged).toBe(true);
    expect(staged.rootPath).toBe(ROOT);
  });

  it('stages a read-only export without overlays', async () => {
    const fake = mountTable();
    const staged = tree(fake, plan([], 'cache'), cache);
    await staged.stage();
    expect(fake.commands[0]).toEqual([tools.mount, '--rbind', '/host/cache', ROOT]);
  });

  it('rejects writable overlays on an originally read-only export', async () => {
    const fake = mountTable();
    const staged = tree(
      fake,
      plan(
        [{ source: '/host/cache/out', destination: '/host/cache/out', kind: 'directory' }],
        'cache',
      ),
      cache,
    );
    await expect(staged.stage()).rejects.toThrow(/cannot receive writable overlays/);
    expect(fake.commands).toEqual([]);
  });

  it('binds selective directory and file overlays after the read-only root', async () => {
    const fake = mountTable();
    const staged = tree(
      fake,
      plan([
        {
          source: '/host/workspace/deep/nested/state.json',
          destination: '/host/workspace/deep/nested/state.json',
          kind: 'file',
        },
        { source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' },
      ]),
    );
    await staged.stage();
    expect(fake.commands.slice(4)).toEqual([
      [tools.mount, '--bind', '/host/workspace/out', `${ROOT}/out`],
      [tools.mount, '--make-rprivate', `${ROOT}/out`],
      [tools.mount, '-o', 'remount,bind,rw,nosuid,nodev', `${ROOT}/out`],
      [
        tools.mount,
        '--bind',
        '/host/workspace/deep/nested/state.json',
        `${ROOT}/deep/nested/state.json`,
      ],
      [tools.mount, '--make-rprivate', `${ROOT}/deep/nested/state.json`],
      [
        tools.mount,
        '-o',
        'remount,bind,rw,nosuid,nodev',
        `${ROOT}/deep/nested/state.json`,
      ],
    ]);
    expect(fake.table.get(`${ROOT}/out`)?.options).toContain('rw');
    expect(fake.table.get(`${ROOT}/out`)?.options).toContain('nosuid');
    expect(fake.table.get(ROOT)?.options).toContain('ro');
    expect(fake.table.get(`${ROOT}/nested`)?.options).toContain('ro');
  });

  it('makes each writable overlay privately propagated so it cannot leak to the host', async () => {
    // Regression: overlays were previously bound without being made private.
    // A bind mount joins the source's peer group, so on any host where the
    // workspace lives under a shared mount -- the default under systemd, and
    // what GitHub-hosted runners provide -- every selective `allowWrite` run
    // aborted with "Staged mount tree propagation would leak".
    const fake = mountTable();
    const staged = tree(
      fake,
      plan([
        { source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' },
      ]),
    );
    await expect(staged.stage()).resolves.toBeUndefined();
    expect(fake.commands).toContainEqual([tools.mount, '--make-rprivate', `${ROOT}/out`]);
    expect(fake.table.get(`${ROOT}/out`)?.optionalFields).toEqual([]);
    expect(fake.table.get(`${ROOT}/out`)?.options).toContain('rw');
    expect(fake.table.get(ROOT)?.options).toContain('ro');
  });

  it('unmounts children deepest-first and the staged root last', async () => {
    const fake = mountTable();
    const staged = tree(
      fake,
      plan([
        { source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' },
        {
          source: '/host/workspace/deep/nested/state.json',
          destination: '/host/workspace/deep/nested/state.json',
          kind: 'file',
        },
      ]),
    );
    await staged.stage();
    expect(staged.cleanupOrder()).toEqual([
      `${ROOT}/deep/nested/state.json`,
      `${ROOT}/out`,
      ROOT,
    ]);
    await staged.unmount();
    // Sliced from the end so the assertion stays about unmount ordering rather
    // than the exact number of staging commands that preceded it.
    expect(fake.commands.slice(-3)).toEqual([
      [tools.umount, `${ROOT}/deep/nested/state.json`],
      [tools.umount, `${ROOT}/out`],
      [tools.umount, '-R', ROOT],
    ]);
    expect(staged.hasResidue).toBe(false);
  });

  it('retains residue when an unmount fails so a later attempt can retry', async () => {
    const fake = mountTable();
    const staged = tree(fake, plan([]));
    await staged.stage();
    const real = fake.runTool.getMockImplementation() as (
      command: string,
      args: readonly string[],
    ) => Promise<void>;
    fake.runTool.mockImplementationOnce(async () => {
      throw new Error('target is busy');
    });
    await expect(staged.unmount()).rejects.toThrow(/target is busy/);
    expect(staged.hasResidue).toBe(true);
    expect(staged.cleanupOrder()).toEqual([ROOT]);
    fake.runTool.mockImplementation(real);
    await expect(staged.unmount()).resolves.toBeUndefined();
    expect(staged.hasResidue).toBe(false);
    expect(fake.table.size).toBe(0);
  });

  it('fails closed when a remount silently leaves the tree writable', async () => {
    const fake = mountTable({ ineffectiveRemount: true });
    const staged = tree(fake, plan([]));
    await expect(staged.stage()).rejects.toThrow(/not recursively read-only/);
    expect(staged.hasResidue).toBe(false);
    expect(fake.table.size).toBe(0);
  });

  it('fails closed when propagation would leak', async () => {
    const fake = mountTable();
    fake.runTool.mockImplementation(async (command: string, args: readonly string[]) => {
      if (args[0] === '--make-rprivate') return;
      return undefined;
    });
    const deps = dependencies(fake, {
      readMountInfo: jest
        .fn()
        .mockResolvedValue(`30 29 0:42 / ${ROOT} ro,nosuid,nodev shared:21 - ext4 /dev/root ro`),
    });
    const staged = new StagedHostMountTree({
      directoryExport: workspace,
      rootPath: ROOT,
      plan: plan([]),
      tools,
      dependencies: deps,
    });
    await expect(staged.stage()).rejects.toThrow(/propagation would leak/);
  });

  it.each(['master:21', 'propagate_from:21'])(
    'fails closed when the staged tree retains %s propagation',
    async (propagation) => {
      const fake = mountTable();
      fake.runTool.mockImplementation(async (command: string, args: readonly string[]) => {
        if (args[0] === '--make-rprivate') return;
        return undefined;
      });
      const deps = dependencies(fake, {
        readMountInfo: jest
          .fn()
          .mockResolvedValue(`30 29 0:42 / ${ROOT} ro,nosuid,nodev ${propagation} - ext4 /dev/root ro`),
      });
      const staged = new StagedHostMountTree({
        directoryExport: workspace,
        plan: plan([]),
        rootPath: ROOT,
        tools,
        dependencies: deps,
      });
      await expect(staged.stage()).rejects.toThrow(/propagation would leak/);
    },
  );

  it('fails closed when the staged root mount is missing', async () => {
    const fake = mountTable();
    const staged = tree(fake, plan([]), workspace, {
      readMountInfo: jest.fn().mockResolvedValue(''),
    });
    await expect(staged.stage()).rejects.toThrow(/missing its root mount/);
  });

  it('fails closed on a mount tool too old for private propagation', async () => {
    const fake = mountTable();
    const staged = tree(fake, plan([]), workspace, {
      captureTool: jest.fn().mockResolvedValue('mount from util-linux 2.22.2'),
    });
    await expect(staged.stage()).rejects.toThrow(/requires util-linux >= 2\.23/);
    expect(fake.commands).toEqual([]);
  });

  it.each([
    ['relative source', { source: 'out', destination: '/host/workspace/out' }],
    ['unnormalized source', { source: '/host/workspace/../etc', destination: '/host/workspace/out' }],
    ['outside source', { source: '/host/other/out', destination: '/host/workspace/out' }],
    ['export root source', { source: '/host/workspace', destination: '/host/workspace/out' }],
    ['outside destination', { source: '/host/workspace/out', destination: '/host/other/out' }],
    ['export root destination', { source: '/host/workspace/out', destination: '/host/workspace' }],
    ['nul byte', { source: '/host/workspace/o\0ut', destination: '/host/workspace/out' }],
  ])('rejects an overlay with a %s', async (_label, overlay) => {
    const fake = mountTable();
    const staged = tree(fake, plan([{ ...overlay, kind: 'directory' as const }]));
    await expect(staged.stage()).rejects.toThrow(/Cloud Hypervisor export "workspace" overlay/);
    expect(fake.commands).toEqual([]);
  });

  it('rejects duplicate and overlapping overlay destinations', async () => {
    const fake = mountTable();
    const duplicate = tree(
      fake,
      plan([
        { source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' },
        { source: '/host/workspace/out2', destination: '/host/workspace/out', kind: 'directory' },
      ]),
    );
    await expect(duplicate.stage()).rejects.toThrow(/Duplicate .* destination/);
    const overlapping = tree(
      fake,
      plan([
        { source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' },
        {
          source: '/host/workspace/out/inner',
          destination: '/host/workspace/out/inner',
          kind: 'directory',
        },
      ]),
    );
    await expect(overlapping.stage()).rejects.toThrow(/Overlapping .* destinations/);
  });

  it('rejects an overlay source that resolves through a symlink', async () => {
    const fake = mountTable();
    const staged = tree(
      fake,
      plan([{ source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' }]),
      workspace,
      {
        realpath: jest.fn(async (filePath: string) =>
          filePath === '/host/workspace/out' ? '/host/other/out' : filePath,
        ),
      },
    );
    await expect(staged.stage()).rejects.toThrow(/source must be canonical/);
    expect(fake.table.size).toBe(0);
  });

  it('rejects a destination whose final component is a symlink out of the tree', async () => {
    const fake = mountTable();
    const escaped = `${ROOT}/out`;
    const staged = tree(
      fake,
      plan([{ source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' }]),
      workspace,
      {
        realpath: jest.fn(async (filePath: string) =>
          filePath === escaped ? '/etc' : filePath,
        ),
      },
    );
    await expect(staged.stage()).rejects.toThrow(/destination must be canonical/);
    // The escaped path must never reach the kernel.
    expect(fake.commands.flat()).not.toContain('--bind');
    expect(fake.table.size).toBe(0);
  });

  it('rejects a destination reached through an intermediate symlink', async () => {
    // `<root>/tools` is a symlink to /etc, so lstat of `<root>/tools/sudoers`
    // reports an ordinary file while the kernel would bind over /etc/sudoers.
    const fake = mountTable();
    const staged = tree(
      fake,
      plan([
        {
          source: '/host/workspace/tools/sudoers',
          destination: '/host/workspace/tools/sudoers',
          kind: 'file',
        },
      ]),
      workspace,
      {
        realpath: jest.fn(async (filePath: string) =>
          filePath === `${ROOT}/tools/sudoers` ? '/etc/sudoers' : filePath,
        ),
        statPath: jest.fn(async () => stats('file')),
      },
    );
    await expect(staged.stage()).rejects.toThrow(/destination must be canonical/);
    expect(fake.commands.flat()).not.toContain('--bind');
    expect(fake.table.size).toBe(0);
  });

  it('rejects a staged root that is not canonical', async () => {
    const fake = mountTable();
    const staged = tree(fake, plan([]), workspace, {
      realpath: jest.fn(async (filePath: string) =>
        filePath === ROOT ? '/var/lib/elsewhere' : filePath,
      ),
    });
    await expect(staged.stage()).rejects.toThrow(/root must be canonical/);
    expect(fake.table.size).toBe(0);
  });

  it('rejects an overlay source that is a symbolic link', async () => {
    const fake = mountTable();
    const staged = tree(
      fake,
      plan([{ source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' }]),
      workspace,
      { statPath: jest.fn(async () => stats('symlink')) },
    );
    await expect(staged.stage()).rejects.toThrow(/must not be a symbolic link/);
  });

  it('requires the overlay destination to already exist with the declared kind', async () => {
    const fake = mountTable();
    const missing = new Error('ENOENT') as NodeJS.ErrnoException;
    missing.code = 'ENOENT';
    const staged = tree(
      fake,
      plan([{ source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' }]),
      workspace,
      {
        statPath: jest.fn(async (filePath: string) => {
          if (filePath.startsWith(ROOT)) throw missing;
          return stats('directory');
        }),
      },
    );
    await expect(staged.stage()).rejects.toThrow('ENOENT');

    const wrongKind = tree(
      fake,
      plan([
        { source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'file' },
      ]),
    );
    await expect(wrongKind.stage()).rejects.toThrow(/must be an existing regular file/);
  });

  it('rolls back every staged mount when an overlay bind fails', async () => {
    const fake = mountTable();
    const real = fake.runTool.getMockImplementation() as (
      command: string,
      args: readonly string[],
    ) => Promise<void>;
    fake.runTool.mockImplementation(async (command: string, args: readonly string[]) => {
      if (args[0] === '--bind') {
        fake.commands.push([command, ...args]);
        throw new Error('overlay bind failed');
      }
      return real(command, args);
    });
    const staged = tree(
      fake,
      plan([{ source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' }]),
    );
    await expect(staged.stage()).rejects.toThrow('overlay bind failed');
    expect(fake.commands[fake.commands.length - 1]).toEqual([tools.umount, '-R', ROOT]);
    expect(staged.hasResidue).toBe(false);
    expect(staged.isStaged).toBe(false);
    expect(fake.table.size).toBe(0);
  });

  it('reports both failures when rollback cannot complete', async () => {
    const fake = mountTable();
    const real = fake.runTool.getMockImplementation() as (
      command: string,
      args: readonly string[],
    ) => Promise<void>;
    fake.runTool.mockImplementation(async (command: string, args: readonly string[]) => {
      if (command === tools.umount) throw new Error('target is busy');
      return real(command, args);
    });
    const staged = tree(
      fake,
      plan([{ source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' }]),
      workspace,
      { statPath: jest.fn(async () => stats('symlink')) },
    );
    await expect(staged.stage()).rejects.toThrow(
      /must not be a symbolic link; staged mount cleanup failed: target is busy/,
    );
    expect(staged.hasResidue).toBe(true);
  });

  it('refuses to stage twice', async () => {
    const fake = mountTable();
    const staged = tree(fake, plan([]));
    await staged.stage();
    await expect(staged.stage()).rejects.toThrow(/already staged/);
  });

  it('rejects a plan whose tag does not match the export', async () => {
    const fake = mountTable();
    const staged = tree(fake, plan([], 'cache'));
    await expect(staged.stage()).rejects.toThrow(/does not match export tag/);
  });

  it.each([
    ['staged root inside the export', '/host/workspace/.awf-stage'],
    ['staged root equal to the export', '/host/workspace'],
    ['staged root containing the export', '/host'],
  ])('rejects a %s so the recursive bind cannot nest itself', async (_label, rootPath) => {
    const fake = mountTable();
    const staged = new StagedHostMountTree({
      directoryExport: workspace,
      rootPath,
      plan: plan([]),
      tools,
      dependencies: dependencies(fake),
    });
    await expect(staged.stage()).rejects.toThrow(/must be disjoint from export/);
    expect(fake.commands).toEqual([]);
  });

  it('rejects more overlays than the supported maximum', async () => {
    const fake = mountTable();
    const overlays = Array.from({ length: 65 }, (_value, index) => ({
      source: `/host/workspace/out${index}`,
      destination: `/host/workspace/out${index}`,
      kind: 'directory' as const,
    }));
    const staged = tree(fake, plan(overlays));
    await expect(staged.stage()).rejects.toThrow(/exceeds 64 writable overlays/);
  });

  it('rejects an invalid overlay kind', async () => {
    const fake = mountTable();
    const staged = tree(
      fake,
      plan([
        {
          source: '/host/workspace/out',
          destination: '/host/workspace/out',
          kind: 'socket' as unknown as 'file',
        },
      ]),
    );
    await expect(staged.stage()).rejects.toThrow(/Invalid export "workspace" overlay kind: socket/);
  });

  it('fails closed when a writable mount appears that no overlay requested', async () => {
    const fake = mountTable();
    const staged = tree(fake, plan([]), workspace, {
      readMountInfo: jest
        .fn()
        .mockResolvedValueOnce(`30 29 0:42 / ${ROOT} ro,nosuid,nodev - ext4 /dev/root ro`)
        .mockResolvedValueOnce(`30 29 0:42 / ${ROOT} ro,nosuid,nodev - ext4 /dev/root ro`)
        .mockResolvedValue(
          [
            `30 29 0:42 / ${ROOT} ro,nosuid,nodev - ext4 /dev/root ro`,
            `31 30 0:43 / ${ROOT}/rogue rw,nosuid,nodev - ext4 /dev/root rw`,
          ].join('\n'),
        ),
    });
    await expect(staged.stage()).rejects.toThrow(/Unexpected writable mount in staged tree/);
  });

  it('fails closed when a requested overlay never became writable', async () => {
    const fake = mountTable();
    const staged = tree(
      fake,
      plan([{ source: '/host/workspace/out', destination: '/host/workspace/out', kind: 'directory' }]),
      workspace,
      {
        readMountInfo: jest
          .fn()
          .mockResolvedValue(`30 29 0:42 / ${ROOT} ro,nosuid,nodev - ext4 /dev/root ro`),
      },
    );
    await expect(staged.stage()).rejects.toThrow(/Writable overlay was not applied/);
  });
});
