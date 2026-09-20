import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deriveNvxLayerUuid,
  normalizeScratchBytes,
  NvxFilesystemBuilder,
  NVX_MIN_SCRATCH_BYTES,
  type NvxFilesystemBuilderDependencies,
} from './filesystem-builder';

const linuxIt = process.platform === 'linux' ? it : it.skip;

describe('NVX deterministic filesystem builder', () => {
  linuxIt('builds ordered deterministic EROFS layers and a private ext4 scratch image', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-nvx-images-'));
    const distro = path.join(root, 'distro-source');
    const custom = path.join(root, 'custom-source');
    await fs.mkdir(path.join(distro, 'bin'), { recursive: true });
    await fs.writeFile(path.join(distro, 'bin', 'tool'), 'binary');
    await fs.chmod(path.join(distro, 'bin', 'tool'), 0o4755);
    await fs.symlink('bin/tool', path.join(distro, 'tool'));
    await fs.mkdir(path.join(custom, '.config', 'gh'), { recursive: true });
    await fs.writeFile(path.join(custom, '.config', 'gh', 'hosts.yml'), 'secret');
    await fs.mkdir(path.join(custom, '.ssh'), { recursive: true });
    await fs.writeFile(path.join(custom, '.ssh', 'deploy_key'), 'secret');
    await fs.writeFile(path.join(custom, 'README'), 'safe');

    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const dependencies: NvxFilesystemBuilderDependencies = {
      runTool: jest.fn(async (command, args) => {
        commands.push({ command, args: [...args] });
        if (command === 'mkfs.erofs') {
          await fs.writeFile(args[args.length - 2], `${command}\n${args.join('\n')}`);
        }
      }),
      randomUuid: () => '11111111-2222-4333-8444-555555555555',
      sha256: jest.fn(async (filePath) => `digest:${path.basename(filePath)}`),
    };
    const builder = new NvxFilesystemBuilder({
      runId: 'phase-2',
      workDir: root,
      layers: [
        { role: 'custom', sourcePath: custom },
        { role: 'distro', sourcePath: distro },
      ],
      sourceDateEpoch: 1_700_000_000,
    }, dependencies);

    try {
      const bundle = await builder.prepare();

      expect(bundle.layers.map(({ role }) => role)).toEqual(['distro', 'custom']);
      expect(bundle.scratch).toMatchObject({
        uuid: '11111111-2222-4333-8444-555555555555',
        sizeBytes: NVX_MIN_SCRATCH_BYTES,
      });
      expect(commands[0]).toEqual({
        command: 'mkfs.erofs',
        args: expect.arrayContaining([
          '--workers=1',
          '--sort=path',
          '--all-root',
          '-T',
          '1700000000',
          '-U',
          bundle.layers[0].uuid,
        ]),
      });
      expect(commands.map(({ command }) => command)).toEqual([
        'mkfs.erofs',
        'mkfs.erofs',
        'mke2fs',
      ]);
      expect(commands[2].args).toEqual(expect.arrayContaining([
        '-O',
        '^has_journal',
        '-E',
        'lazy_itable_init=0,lazy_journal_init=0,root_owner=65534:65534',
      ]));
      expect((await fs.stat(bundle.layers[0].path)).mode & 0o777).toBe(0o400);
      expect((await fs.stat(bundle.scratch.path)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(
        path.join(builder.stagingDirectory, 'distro', 'tool'),
        'utf8',
      )).toBe('binary');
      expect((await fs.stat(
        path.join(builder.stagingDirectory, 'distro', 'bin', 'tool'),
      )).mode & 0o777).toBe(0o755);
      await expect(fs.access(
        path.join(builder.stagingDirectory, 'custom', '.config', 'gh', 'hosts.yml'),
      )).rejects.toThrow();
      await expect(fs.access(
        path.join(builder.stagingDirectory, 'custom', '.ssh', 'deploy_key'),
      )).rejects.toThrow();
      expect(await fs.readFile(
        path.join(builder.stagingDirectory, 'custom', 'README'),
        'utf8',
      )).toBe('safe');

      const manifest = JSON.parse(await fs.readFile(bundle.manifestPath, 'utf8'));
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        sourceDateEpoch: 1_700_000_000,
        layers: [
          { role: 'distro', file: 'distro.erofs' },
          { role: 'custom', file: 'custom.erofs' },
        ],
        scratch: {
          file: 'scratch.ext4',
          uuid: '11111111-2222-4333-8444-555555555555',
          uid: 65534,
          gid: 65534,
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('derives stable role-bound UUIDs and enforces scratch limits', () => {
    const digest = 'a'.repeat(64);
    expect(deriveNvxLayerUuid('distro', digest))
      .toBe(deriveNvxLayerUuid('distro', digest));
    expect(deriveNvxLayerUuid('distro', digest))
      .not.toBe(deriveNvxLayerUuid('runtime', digest));
    expect(normalizeScratchBytes(1)).toBe(NVX_MIN_SCRATCH_BYTES);
    expect(normalizeScratchBytes(NVX_MIN_SCRATCH_BYTES + 1) % 4096).toBe(0);
    expect(() => normalizeScratchBytes(
      NVX_MIN_SCRATCH_BYTES * 2,
      NVX_MIN_SCRATCH_BYTES,
    )).toThrow(/exceeding cap/);
  });

  linuxIt('rejects escaping symlinks, duplicate roles, and unsafe run identifiers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-nvx-images-'));
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    await fs.symlink('../outside', path.join(source, 'escape'));
    const dependencies: NvxFilesystemBuilderDependencies = {
      runTool: jest.fn(),
      randomUuid: () => '11111111-2222-4333-8444-555555555555',
      sha256: jest.fn(),
    };
    try {
      await expect(new NvxFilesystemBuilder({
        runId: 'safe',
        workDir: root,
        layers: [{ role: 'distro', sourcePath: source }],
      }, dependencies).prepare()).rejects.toThrow(/symlink target.*escapes/);
      expect(() => new NvxFilesystemBuilder({
        runId: '../unsafe',
        workDir: root,
        layers: [{ role: 'distro', sourcePath: source }],
      }, dependencies)).toThrow(/Unsafe NVX run id/);
      expect(() => new NvxFilesystemBuilder({
        runId: 'duplicate',
        workDir: root,
        layers: [
          { role: 'distro', sourcePath: source },
          { role: 'distro', sourcePath: source },
        ],
      }, dependencies)).toThrow(/Duplicate NVX layer role/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  linuxIt('excludes credential paths nested below a rootfs home directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-nvx-images-'));
    const source = path.join(root, 'source');
    const nestedHome = path.join(source, 'home', 'runner');
    await fs.mkdir(path.join(nestedHome, '.config', 'gh'), { recursive: true });
    await fs.writeFile(path.join(nestedHome, '.config', 'gh', 'hosts.yml'), 'secret');
    await fs.writeFile(path.join(nestedHome, 'safe'), 'visible');
    const dependencies: NvxFilesystemBuilderDependencies = {
      runTool: jest.fn(async (command, args) => {
        if (command === 'mkfs.erofs') {
          await fs.writeFile(args[args.length - 2], 'layer');
        }
      }),
      randomUuid: () => '11111111-2222-4333-8444-555555555555',
      sha256: jest.fn(async () => 'a'.repeat(64)),
    };
    const builder = new NvxFilesystemBuilder({
      runId: 'nested-credentials',
      workDir: root,
      layers: [{ role: 'distro', sourcePath: source }],
    }, dependencies);
    try {
      await builder.prepare();
      await expect(fs.access(path.join(
        builder.stagingDirectory,
        'distro',
        'home',
        'runner',
        '.config',
        'gh',
      ))).rejects.toThrow();
      await expect(fs.readFile(path.join(
        builder.stagingDirectory,
        'distro',
        'home',
        'runner',
        'safe',
      ), 'utf8')).resolves.toBe('visible');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('never removes a pre-existing run directory it does not own', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-nvx-images-'));
    const source = path.join(root, 'source');
    const existingRun = path.join(root, 'nvx-images', 'collision');
    await fs.mkdir(source);
    await fs.mkdir(existingRun, { recursive: true });
    await fs.writeFile(path.join(existingRun, 'owned-by-other-run'), 'keep');
    const dependencies: NvxFilesystemBuilderDependencies = {
      runTool: jest.fn(),
      randomUuid: () => '11111111-2222-4333-8444-555555555555',
      sha256: jest.fn(),
    };
    try {
      await expect(new NvxFilesystemBuilder({
        runId: 'collision',
        workDir: root,
        layers: [{ role: 'distro', sourcePath: source }],
      }, dependencies).prepare()).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(fs.readFile(path.join(existingRun, 'owned-by-other-run'), 'utf8'))
        .resolves.toBe('keep');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
