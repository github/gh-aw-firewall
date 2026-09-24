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

  async function createLayer(allowWrite?: string[]) {
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
    }, dependencies);
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

  it('merges guest creations, modifications, and whiteout deletions back to the host', async () => {
    const { layer, calls } = await createLayer();
    await layer.stage();

    const guestWorkspace = await guestUpper();
    await fs.writeFile(path.join(guestWorkspace, 'generated.txt'), 'from guest\n');
    await fs.mkdir(path.join(guestWorkspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(guestWorkspace, 'src', 'main.ts'), 'rewritten\n');
    // Overlay records a deletion as a 0/0 character device in the upper layer;
    // a plain file stands in for it here since mknod requires privileges.
    await fs.writeFile(path.join(guestWorkspace, 'README.md'), '');

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
});
