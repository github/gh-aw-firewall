import type { CloudHypervisorDirectoryExport } from './exports';
import {
  StagedHostMountTree,
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
function mountTable(options: {
  ineffectiveRemount?: boolean;
  nestedReadOnly?: boolean;
  shared?: boolean;
} = {}) {
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
        options: [options.nestedReadOnly ? 'ro' : 'rw', 'relatime'],
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
    if (args[0] === '-t' && args[1] === 'tmpfs') {
      const optionsIndex = args.indexOf('-o');
      const requested = args[optionsIndex + 1].split(',');
      const target = args[args.length - 1];
      table.set(target, { options: [...requested, 'relatime'], optionalFields: [] });
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
      const mode = requested.includes('ro')
        ? 'ro'
        : requested.includes('rw')
          ? 'rw'
          : current.options.includes('ro')
            ? 'ro'
            : 'rw';
      table.set(target, {
        ...current,
        options: [
          mode,
          ...current.options.filter((option) =>
            !['ro', 'rw', 'nosuid', 'nodev'].includes(option),
          ),
          'nosuid',
          'nodev',
        ],
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
    sleep: jest.fn().mockResolvedValue(undefined),
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
  maskedPaths?: VirtiofsdExportMountPlan['maskedPaths'],
): VirtiofsdExportMountPlan {
  return { tag, writableOverlays: overlays, ...(maskedPaths ? { maskedPaths } : {}) };
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

export { cache, dependencies, mountTable, plan, ROOT, stats, tools, tree, workspace };
