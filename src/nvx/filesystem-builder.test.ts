import { promises as fs } from 'fs';
import * as path from 'path';
import {
  deriveNvxLayerUuid,
  normalizeNvxLayerSymlinkTarget,
  normalizeScratchBytes,
  NvxFilesystemBuilder,
  NVX_MIN_SCRATCH_BYTES,
  type NvxFilesystemBuilderDependencies,
} from './filesystem-builder';

const linuxIt = process.platform === 'linux' ? it : it.skip;

function imageDependencies(): NvxFilesystemBuilderDependencies {
  return {
    runTool: jest.fn(async (command, args) => {
      if (command === 'mkfs.erofs') await fs.writeFile(args[args.length - 2], 'image');
    }),
    randomUuid: () => '11111111-2222-4333-8444-555555555555',
    sha256: async () => 'a'.repeat(64),
  };
}

describe('NVX deterministic filesystem builder', () => {
  beforeEach(() => {
    jest.spyOn(fs, 'chown').mockResolvedValue(undefined);
    jest.spyOn(fs, 'lchown').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('rewrites absolute guest-root symlinks without changing relative targets', () => {
    expect(normalizeNvxLayerSymlinkTarget('bin/arch', '/bin/busybox'))
      .toBe('busybox');
    expect(normalizeNvxLayerSymlinkTarget('usr/bin/tool', '/bin/busybox'))
      .toBe('../../bin/busybox');
    expect(normalizeNvxLayerSymlinkTarget('bin/tool', '../lib/tool'))
      .toBe('../lib/tool');
  });

  linuxIt('merges ordered sources into one distro image and a private ext4 scratch image', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'awf-nvx-images-'));
    const distro = path.join(root, 'distro-source');
    const custom = path.join(root, 'custom-source');
    await fs.mkdir(path.join(distro, 'bin'), { recursive: true });
    await fs.writeFile(path.join(distro, 'bin', 'tool'), 'binary');
    await fs.chmod(path.join(distro, 'bin', 'tool'), 0o4755);
    await fs.symlink('/bin/tool', path.join(distro, 'bin', 'arch'));
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

      expect(bundle.layers.map(({ role }) => role)).toEqual(['distro']);
      expect(bundle.scratch).toMatchObject({
        uuid: '11111111-2222-4333-8444-555555555555',
        sizeBytes: NVX_MIN_SCRATCH_BYTES,
      });
      expect(commands[0]).toEqual({
        command: 'mkfs.erofs',
        args: expect.arrayContaining([
          '-T',
          '1700000000',
          '-U',
          bundle.layers[0].uuid,
        ]),
      });
      expect(commands[0].args).not.toContain('--all-root');
      expect(commands.map(({ command }) => command)).toEqual([
        'mkfs.erofs',
        'mke2fs',
      ]);
      expect(commands[1].args).toEqual(expect.arrayContaining([
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
      expect(await fs.readlink(
        path.join(builder.stagingDirectory, 'distro', 'bin', 'arch'),
      )).toBe('tool');
      await expect(fs.access(
        path.join(builder.stagingDirectory, 'distro', '.config', 'gh', 'hosts.yml'),
      )).rejects.toThrow();
      await expect(fs.access(
        path.join(builder.stagingDirectory, 'distro', '.ssh', 'deploy_key'),
      )).rejects.toThrow();
      expect(await fs.readFile(
        path.join(builder.stagingDirectory, 'distro', 'README'),
        'utf8',
      )).toBe('safe');

      const manifest = JSON.parse(await fs.readFile(bundle.manifestPath, 'utf8'));
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        sourceDateEpoch: 1_700_000_000,
        layers: [
          { role: 'distro', file: 'distro.erofs' },
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

  linuxIt('merges legacy sources deterministically and preserves only overlay ownership', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'awf-nvx-images-'));
    const distro = path.join(root, 'distro');
    const runtime = path.join(root, 'runtime');
    const custom = path.join(root, 'custom');
    for (const source of [distro, runtime, custom]) {
      await fs.mkdir(path.join(source, 'etc'), { recursive: true });
      await fs.writeFile(path.join(source, 'etc/value'), path.basename(source));
    }
    await fs.mkdir(path.join(distro, 'home'), { recursive: true });
    await fs.chmod(path.join(distro, 'home'), 0o755);
    await fs.mkdir(path.join(custom, 'home/awf'), { recursive: true, mode: 0o700 });
    await fs.chmod(path.join(custom, 'home'), 0o755);
    await fs.chmod(path.join(custom, 'home/awf'), 0o700);
    await fs.writeFile(path.join(distro, 'tool'), 'toolchain');
    await fs.symlink('/etc/value', path.join(distro, 'link'));
    await fs.writeFile(path.join(custom, 'link'), 'replaces symlink');
    const sources = [
      { role: 'custom' as const, sourcePath: custom, preserveOwnership: true },
      { role: 'distro' as const, sourcePath: distro },
      { role: 'runtime' as const, sourcePath: runtime },
    ];
    const builders: NvxFilesystemBuilder[] = [];
    async function prepare(runId: string, reverse = false) {
      const builder = new NvxFilesystemBuilder({
        runId, workDir: root, layers: reverse ? [...sources].reverse() : sources,
      }, imageDependencies());
      builders.push(builder);
      return builder.prepare();
    }
    try {
      const first = await prepare('first');
      const second = await prepare('second', true);
      expect(first.layers).toHaveLength(1);
      expect(second.layers[0].uuid).toBe(first.layers[0].uuid);
      expect(second.layers[0].sourceManifestSha256).toBe(first.layers[0].sourceManifestSha256);
      const staged = path.join(builders[0].stagingDirectory, 'distro');
      expect(await fs.readFile(path.join(staged, 'etc/value'), 'utf8')).toBe('custom');
      expect(await fs.readFile(path.join(staged, 'link'), 'utf8')).toBe('replaces symlink');
      expect((await fs.stat(path.join(staged, 'home'))).mode & 0o777).toBe(0o755);
      expect((await fs.stat(path.join(staged, 'home/awf'))).mode & 0o777).toBe(0o700);
      expect(fs.chown).toHaveBeenCalledWith(path.join(staged, 'tool'), 0, 0);
      const owner = await fs.stat(path.join(custom, 'etc/value'));
      expect(fs.chown).toHaveBeenCalledWith(path.join(staged, 'etc/value'), owner.uid, owner.gid);
      expect(fs.lchown).toHaveBeenCalledWith(path.join(staged, 'link'), 0, 0);
      await fs.writeFile(path.join(custom, 'etc/value'), 'changed configuration');
      const changed = await prepare('changed');
      expect(changed.layers[0].uuid).not.toBe(first.layers[0].uuid);
      await fs.writeFile(path.join(distro, 'tool'), 'changed toolchain');
      const changedToolchain = await prepare('changed-toolchain');
      expect(changedToolchain.layers[0].uuid).not.toBe(changed.layers[0].uuid);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  linuxIt('rejects overlay traversal through a distro symlink without touching its target', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'awf-nvx-images-'));
    const distro = path.join(root, 'distro');
    const custom = path.join(root, 'custom');
    await fs.mkdir(path.join(distro, 'target'), { recursive: true });
    await fs.writeFile(path.join(distro, 'target/keep'), 'unchanged');
    await fs.symlink('target', path.join(distro, 'etc'));
    await fs.mkdir(path.join(custom, 'etc'), { recursive: true });
    await fs.writeFile(path.join(custom, 'etc/keep'), 'overwrite');
    const dependencies = imageDependencies();
    const builder = new NvxFilesystemBuilder({
      runId: 'symlink-overlay', workDir: root,
      layers: [
        { role: 'distro', sourcePath: distro },
        { role: 'custom', sourcePath: custom, preserveOwnership: true },
      ],
    }, dependencies);
    try {
      await expect(builder.prepare()).rejects.toThrow(/overlay directory conflicts/);
      expect(dependencies.runTool).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(distro, 'target/keep'), 'utf8')).toBe('unchanged');
      await expect(fs.lstat(builder.runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  linuxIt('rejects a source file that changes while being opened', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'awf-nvx-images-'));
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    const file = path.join(source, 'file');
    await fs.writeFile(file, 'original');
    const lstat = fs.lstat.bind(fs);
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (String(args[0]).endsWith('/file')) {
        await fs.writeFile(file, 'modified source content');
      }
      return stat;
    });
    const dependencies = imageDependencies();
    try {
      await expect(new NvxFilesystemBuilder({
        runId: 'changed-source', workDir: root, layers: [{ role: 'distro', sourcePath: source }],
      }, dependencies).prepare()).rejects.toThrow(/source changed/);
      expect(dependencies.runTool).not.toHaveBeenCalled();
    } finally {
      jest.mocked(fs.lstat).mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects runtime/custom roots without a distro source', () => {
    for (const role of ['runtime', 'custom'] as const) {
      expect(() => new NvxFilesystemBuilder({
        runId: 'missing-distro', workDir: process.cwd(),
        layers: [{ role, sourcePath: '/unused' }],
      }, imageDependencies())).toThrow(/requires a distro source/);
    }
  });

  it('rejects duplicate roles and unsafe run identifiers', () => {
    const source = path.join(process.cwd(), 'awf-nvx-images-unused-source');
    const dependencies: NvxFilesystemBuilderDependencies = {
      runTool: jest.fn(),
      randomUuid: () => '11111111-2222-4333-8444-555555555555',
      sha256: jest.fn(),
    };
    expect(() => new NvxFilesystemBuilder({
      runId: '../unsafe',
      workDir: process.cwd(),
      layers: [{ role: 'distro', sourcePath: source }],
    }, dependencies)).toThrow(/Unsafe NVX run id/);
    expect(() => new NvxFilesystemBuilder({
      runId: 'duplicate',
      workDir: process.cwd(),
      layers: [
        { role: 'distro', sourcePath: source },
        { role: 'distro', sourcePath: source },
      ],
    }, dependencies)).toThrow(/Duplicate NVX layer role/);
  });

  it('stages the bundle in the canonical run directory when requested', () => {
    const source = path.join(process.cwd(), 'awf-nvx-images-unused-source');
    const dependencies: NvxFilesystemBuilderDependencies = {
      runTool: jest.fn(),
      randomUuid: () => '11111111-2222-4333-8444-555555555555',
      sha256: jest.fn(),
    };
    const runId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const builder = new NvxFilesystemBuilder({
      runId,
      workDir: process.cwd(),
      useCanonicalRunDirectory: true,
      layers: [{ role: 'distro', sourcePath: source }],
    }, dependencies);
    expect(builder.runDirectory).toBe(`/var/lib/awf-nvx/runs/${runId}`);
    expect(() => new NvxFilesystemBuilder({
      runId: 'not-canonical',
      workDir: process.cwd(),
      useCanonicalRunDirectory: true,
      layers: [{ role: 'distro', sourcePath: source }],
    }, dependencies)).toThrow(/32 lowercase hexadecimal/);
  });

  linuxIt('rejects escaping symlinks in prepare()', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'awf-nvx-images-'));
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
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  linuxIt('excludes credential paths nested below a rootfs home directory', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'awf-nvx-images-'));
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
    const root = await fs.mkdtemp(path.join(process.cwd(), 'awf-nvx-images-'));
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
