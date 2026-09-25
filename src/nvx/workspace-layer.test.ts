import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planNvxFilesystemWrites } from './filesystem-write-policy';
import {
  NVX_GUEST_WORKSPACE,
  NVX_SCRATCH_UPPER_DIRECTORY,
  type NvxDirectoryExport,
} from './workspace-export';
import {
  NvxWorkspaceLayer,
  testHelpers,
  type NvxWorkspaceLayerDependencies,
} from './workspace-layer';

/**
 * The real copy-back shells out to `e2fsck`/`debugfs` to pull the guest overlay
 * upper layer out of the scratch image. The tests replace that with a stub that
 * materializes a prepared upper tree, which keeps the merge semantics under
 * test without requiring a real ext4 image or root.
 */
function stubTools(upperFixture: string, extractionDirectory: string) {
  const calls: Array<{ tool: string; args: readonly string[] }> = [];
  const dependencies: NvxWorkspaceLayerDependencies = {
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'debugfs') {
        await fs.cp(
          upperFixture,
          path.join(extractionDirectory, NVX_SCRATCH_UPPER_DIRECTORY),
          { recursive: true },
        );
      }
      return { exitCode: 0, stderr: '' };
    },
    chown: async () => {},
    lchown: async () => {},
  };
  return { dependencies, calls };
}

async function restoreWritable(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  await fs.chmod(target, (stat.mode & 0o7777) | 0o700).catch(() => undefined);
  if (!stat.isDirectory()) return;
  for (const entry of await fs.readdir(target)) {
    await restoreWritable(path.join(target, entry));
  }
}

describe('NvxWorkspaceLayer', () => {
  let root: string;
  let workspace: string;
  let stagingRoot: string;
  let upperFixture: string;
  let workspaceExport: NvxDirectoryExport;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nvx-layer-')));
    workspace = path.join(root, 'workspace');
    stagingRoot = path.join(root, 'staging');
    upperFixture = path.join(root, 'upper-fixture');
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src', 'main.ts'), 'original\n');
    await fs.writeFile(path.join(workspace, 'README.md'), 'readme\n');
    await fs.mkdir(upperFixture, { recursive: true });
    workspaceExport = {
      tag: 'workspace',
      source: workspace,
      target: NVX_GUEST_WORKSPACE,
      mode: 'rw',
    };
  });

  afterEach(async () => {
    // Read-only staged subtrees intentionally have their write bits cleared,
    // which an unprivileged test process cannot remove without restoring them.
    await restoreWritable(root);
    await fs.rm(root, { recursive: true, force: true });
  });

  async function guestUpper(): Promise<string> {
    const guestWorkspace = path.join(upperFixture, NVX_GUEST_WORKSPACE.slice(1));
    await fs.mkdir(guestWorkspace, { recursive: true });
    return guestWorkspace;
  }

  async function createLayer(
    allowWrite?: string[],
    homePath?: string,
    dependenciesOverrides: Partial<NvxWorkspaceLayerDependencies> = {},
  ) {
    const writePlan = await planNvxFilesystemWrites([workspaceExport], allowWrite);
    const { dependencies, calls } = stubTools(
      upperFixture,
      path.join(stagingRoot, 'extracted'),
    );
    const layer = new NvxWorkspaceLayer({
      runId: 'a'.repeat(32),
      stagingRoot,
      exports: [workspaceExport],
      writePlan,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
      runScript: '#!/bin/sh\nexec /bin/sh -c true\n',
      homePath,
    }, { ...dependencies, ...dependenciesOverrides });
    return { layer, calls };
  }

  it('stages the workspace and the run script into the custom layer source tree', async () => {
    const { layer } = await createLayer();
    const layerSource = await layer.stage();

    expect(layerSource).toBe(path.join(stagingRoot, 'custom-layer'));
    await expect(fs.readFile(path.join(layerSource, 'workspace/src/main.ts'), 'utf8'))
      .resolves.toBe('original\n');
    await expect(fs.readFile(path.join(layerSource, 'etc/awf/nvx-run.sh'), 'utf8'))
      .resolves.toContain('exec /bin/sh -c true');
    const scriptStat = await fs.lstat(path.join(layerSource, 'etc/awf/nvx-run.sh'));
    expect(scriptStat.mode & 0o222).toBe(0);
  });

  it('refuses to stage twice', async () => {
    const { layer } = await createLayer();
    await layer.stage();
    await expect(layer.stage()).rejects.toThrow(/already staged/);
  });

  it('merges guest creations and modifications back to the host', async () => {
    const { layer, calls } = await createLayer();
    await layer.stage();

    const guestWorkspace = await guestUpper();
    await fs.writeFile(path.join(guestWorkspace, 'generated.txt'), 'from guest\n');
    await fs.mkdir(path.join(guestWorkspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(guestWorkspace, 'src', 'main.ts'), 'rewritten\n');
    const result = await layer.extractAfterStop(path.join(root, 'scratch.img'));

    expect(calls.map((call) => call.tool)).toEqual(['e2fsck', 'debugfs']);
    expect(result.rejected).toEqual([]);
    expect(result.applied).toEqual(expect.arrayContaining([
      '/workspace/generated.txt',
      '/workspace/src/main.ts',
    ]));
    await expect(fs.readFile(path.join(workspace, 'generated.txt'), 'utf8'))
      .resolves.toBe('from guest\n');
    await expect(fs.readFile(path.join(workspace, 'src', 'main.ts'), 'utf8'))
      .resolves.toBe('rewritten\n');
  });

  it('removes host entries represented by an overlay whiteout', async () => {
    const { layer } = await createLayer();
    await layer.stage();

    const guestWorkspace = await guestUpper();
    const whiteout = path.join(guestWorkspace, 'README.md');
    await fs.writeFile(whiteout, '');
    const realLstat = fs.lstat.bind(fs);
    const lstat = jest.spyOn(fs, 'lstat');
    lstat.mockImplementation(async (candidate) => {
      if (candidate === path.join(stagingRoot, 'extracted', 'upper', 'workspace', 'README.md')) {
        return {
          isCharacterDevice: () => true,
          isDirectory: () => false,
          rdev: 0,
        } as Awaited<ReturnType<typeof fs.lstat>>;
      }
      return realLstat(candidate);
    });

    try {
      const result = await layer.extractAfterStop(path.join(root, 'scratch.img'));
      expect(result.removed).toEqual(['/workspace/README.md']);
      await expect(fs.access(path.join(workspace, 'README.md'))).rejects.toThrow();
    } finally {
      lstat.mockRestore();
    }
  });

  it('rejects guest writes outside filesystem.allowWrite instead of applying them', async () => {
    const { layer } = await createLayer(['/workspace/src']);
    await layer.stage();

    const guestWorkspace = await guestUpper();
    await fs.mkdir(path.join(guestWorkspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(guestWorkspace, 'src', 'main.ts'), 'allowed\n');
    await fs.writeFile(path.join(guestWorkspace, 'escaped.txt'), 'denied\n');

    const result = await layer.extractAfterStop(path.join(root, 'scratch.img'));

    expect(result.rejected).toEqual(['/workspace/escaped.txt']);
    expect(result.applied).toEqual(['/workspace/src/main.ts']);
    await expect(fs.access(path.join(workspace, 'escaped.txt'))).rejects.toThrow();
  });

  it('traverses policy-disallowed parent directories to persist nested allowed files', async () => {
    const { layer } = await createLayer(['/workspace/src/main.ts']);
    await layer.stage();

    const guestWorkspace = await guestUpper();
    await fs.mkdir(path.join(guestWorkspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(guestWorkspace, 'src', 'main.ts'), 'allowed\n');

    const result = await layer.extractAfterStop(path.join(root, 'scratch.img'));

    expect(result.applied).toEqual(['/workspace/src/main.ts']);
    await expect(fs.readFile(path.join(workspace, 'src', 'main.ts'), 'utf8'))
      .resolves.toBe('allowed\n');
  });

  it('excludes credentials below each exported guest home tool directory', async () => {
    const home = path.join(root, 'home');
    await fs.mkdir(path.join(home, '.config', 'gh'), { recursive: true });
    await fs.writeFile(path.join(home, '.config', 'gh', 'hosts.yml'), 'token: secret');
    const { layer } = await createLayer(undefined, home);

    const layerSource = await layer.stage();

    await expect(fs.access(path.join(layerSource, 'home/awf/.config/gh/hosts.yml')))
      .rejects.toThrow();
  });

  it('refuses copy-back when the host changed the same entry during the run', async () => {
    const { layer } = await createLayer();
    await layer.stage();

    await fs.writeFile(path.join(workspace, 'README.md'), 'changed on the host\n');
    const guestWorkspace = await guestUpper();
    await fs.writeFile(path.join(guestWorkspace, 'README.md'), 'changed in the guest\n');

    await expect(layer.extractAfterStop(path.join(root, 'scratch.img')))
      .rejects.toThrow(/the host changed \/workspace\/README\.md while the microVM was running/);
  });

  it('rejects a scratch image path debugfs would re-interpret', async () => {
    const { layer } = await createLayer();
    await layer.stage();
    await expect(layer.extractAfterStop('/tmp/awf run/scratch.img'))
      .rejects.toThrow(/Unsafe NVX scratch image path for debugfs/);
  });

  it('requires staging before copy-back and removes the staging root on cleanup', async () => {
    const { layer } = await createLayer();
    await expect(layer.extractAfterStop(path.join(root, 'scratch.img')))
      .rejects.toThrow(/has not been staged/);

    await layer.stage();
    await layer.cleanup();
    await expect(fs.access(stagingRoot)).rejects.toThrow();
  });

  it('continues copy-back after e2fsck reports both successful repair flags', async () => {
    const calls: string[] = [];
    const { layer } = await createLayer(undefined, undefined, {
      runTool: async (tool) => {
        calls.push(tool);
        if (tool === 'e2fsck') return { exitCode: 3, stderr: '' };
        await fs.cp(upperFixture, path.join(stagingRoot, 'extracted', NVX_SCRATCH_UPPER_DIRECTORY), {
          recursive: true,
        });
        return { exitCode: 0, stderr: '' };
      },
    });
    await layer.stage();
    await expect(layer.extractAfterStop(path.join(root, 'scratch.img'))).resolves.toBeDefined();
    expect(calls).toEqual(['e2fsck', 'debugfs']);
  });
});

describe('overlay whiteout classification', () => {
  function fakeStat(overrides: Partial<{
    characterDevice: boolean;
    rdev: number;
  }>): Parameters<typeof testHelpers.isOverlayWhiteout>[0] {
    return {
      isCharacterDevice: () => overrides.characterDevice === true,
      rdev: overrides.rdev ?? 0,
    } as Parameters<typeof testHelpers.isOverlayWhiteout>[0];
  }

  it('treats a 0/0 character device as a deletion', () => {
    expect(testHelpers.isOverlayWhiteout(fakeStat({ characterDevice: true, rdev: 0 })))
      .toBe(true);
  });

  it('does not treat a regular file or a real device node as a deletion', () => {
    expect(testHelpers.isOverlayWhiteout(fakeStat({ characterDevice: false })))
      .toBe(false);
    expect(testHelpers.isOverlayWhiteout(fakeStat({ characterDevice: true, rdev: 259 })))
      .toBe(false);
  });
});

describe('e2fsck exit code tolerance', () => {
  it('treats both repair exit codes as success', () => {
    expect([...testHelpers.E2FSCK_REPAIR_EXIT_CODES].sort()).toEqual([1, 2, 3]);
  });
});
