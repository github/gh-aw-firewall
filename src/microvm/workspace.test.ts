import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import {
  MICROVM_DEFAULT_MAX_WORKSPACE_IMAGE_BYTES,
  MICROVM_MIN_WORKSPACE_IMAGE_BYTES,
  MicrovmWorkspaceImage,
  assertNoWorkspaceConflicts,
  buildMicrovmWorkspaceManifest,
  calculateMicrovmWorkspaceImageBytes,
  type MicrovmWorkspaceImageDependencies,
} from './workspace';

describe('microVM workspace images', () => {
  it('sizes images with headroom, block alignment, minimum, and cap', () => {
    expect(calculateMicrovmWorkspaceImageBytes(0))
      .toBe(MICROVM_MIN_WORKSPACE_IMAGE_BYTES);
    expect(calculateMicrovmWorkspaceImageBytes(512 * 1024 * 1024) % 4096).toBe(0);
    expect(() => calculateMicrovmWorkspaceImageBytes(
      MICROVM_DEFAULT_MAX_WORKSPACE_IMAGE_BYTES,
    )).toThrow(/exceeding cap/);
    expect(() => calculateMicrovmWorkspaceImageBytes(0, 1024)).toThrow(/cap/);
  });

  it('preserves hidden files, modes, and safe symlinks while excluding credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-workspace-'));
    const workspace = path.join(root, 'source');
    const home = path.join(root, 'home');
    const baseRootfs = path.join(root, 'base.ext4');
    const supervisor = path.join(root, 'supervisor');
    await fs.mkdir(path.join(workspace, 'bin'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.hidden'), 'hidden');
    await fs.writeFile(path.join(workspace, 'bin', 'run'), '#!/bin/sh\n');
    await fs.chmod(path.join(workspace, 'bin', 'run'), 0o755);
    await fs.symlink('bin/run', path.join(workspace, 'run'));
    await fs.mkdir(path.join(home, '.config', 'gh'), { recursive: true });
    await fs.writeFile(path.join(home, '.config', 'safe'), 'keep');
    await fs.writeFile(path.join(home, '.config', 'gh', 'hosts.yml'), 'secret');
    await fs.writeFile(baseRootfs, 'rootfs');
    await fs.writeFile(supervisor, 'binary');
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const dependencies: MicrovmWorkspaceImageDependencies = {
      runTool: jest.fn(async (command, args) => {
        commands.push({ command, args });
      }),
    };
    const image = new MicrovmWorkspaceImage({
      runId: 'run-1',
      workDir: root,
      workspacePath: workspace,
      homePath: home,
      baseRootfsPath: baseRootfs,
      supervisorBinaryPath: supervisor,
      supervisorSha256: createHash('sha256').update('binary').digest('hex'),
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }, dependencies);

    const prepared = await image.prepare();
    expect(prepared.imageBytes).toBe(MICROVM_MIN_WORKSPACE_IMAGE_BYTES);
    expect((await fs.stat(prepared.workspaceImagePath)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(
      path.join(image.stagingDirectory, 'workspace', '.hidden'),
      'utf8',
    )).toBe('hidden');
    expect((await fs.stat(
      path.join(image.stagingDirectory, 'workspace', 'bin', 'run'),
    )).mode & 0o777).toBe(0o755);
    expect(await fs.readlink(
      path.join(image.stagingDirectory, 'workspace', 'run'),
    )).toBe('bin/run');
    expect(await fs.readFile(
      path.join(image.stagingDirectory, 'workspace', '.awf-home', '.config', 'safe'),
      'utf8',
    )).toBe('keep');
    await expect(fs.access(
      path.join(image.stagingDirectory, 'workspace', '.awf-home', '.config', 'gh'),
    )).rejects.toThrow();
    expect(commands.map(({ command }) => command)).toEqual([
      'mke2fs', 'debugfs', 'debugfs', 'debugfs', 'e2fsck',
    ]);
    expect(commands[1].args).toContain('rm /sbin/awf-supervisor');
    expect(commands[0].args).toEqual(expect.arrayContaining(['-b', '4096']));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects escaping symlinks and special path hazards', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-workspace-'));
    const workspace = path.join(root, 'source');
    await fs.mkdir(workspace);
    await fs.symlink('../outside', path.join(workspace, 'escape'));
    await expect(buildMicrovmWorkspaceManifest(workspace))
      .rejects.toThrow(/escapes/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('detects conflicting host and guest changes but permits identical convergence', () => {
    const file = (digest: string) => ({
      type: 'file' as const,
      mode: 0o644,
      uid: 1000,
      gid: 1000,
      size: 1,
      digest,
    });
    const original = new Map([['file', file('before')]]);
    const guest = new Map([['file', file('guest')]]);
    expect(() => assertNoWorkspaceConflicts(
      original,
      guest,
      new Map([['file', file('host')]]),
    )).toThrow(/concurrently/);
    expect(() => assertNoWorkspaceConflicts(
      original,
      original,
      new Map([['file', file('host')]]),
    )).toThrow(/concurrently/);
    expect(() => assertNoWorkspaceConflicts(original, guest, guest)).not.toThrow();
  });

  it('rejects host-only changes that copy-back would overwrite or delete', () => {
    const file = (digest: string) => ({
      type: 'file' as const,
      mode: 0o644,
      uid: 1000,
      gid: 1000,
      size: 1,
      digest,
    });
    const original = new Map([['existing', file('before')]]);
    const unchangedGuest = new Map([['existing', file('before')]]);
    const hostChanged = new Map([
      ['existing', file('host-change')],
      ['host-created', file('host-created')],
    ]);

    expect(() => assertNoWorkspaceConflicts(
      original,
      unchangedGuest,
      hostChanged,
    )).toThrow(/existing.*host-created/);
  });

  it('preserves the changed image when copy-back fails and cleanup remains safe', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-workspace-'));
    const workspace = path.join(root, 'source');
    const home = path.join(root, 'home');
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    await fs.writeFile(path.join(workspace, 'file'), 'before');
    await fs.writeFile(path.join(root, 'base.ext4'), 'rootfs');
    await fs.writeFile(path.join(root, 'supervisor'), 'binary');
    let e2fsckCalls = 0;
    const dependencies: MicrovmWorkspaceImageDependencies = {
      runTool: jest.fn(async (command) => {
        if (command === 'e2fsck' && ++e2fsckCalls > 1) {
          throw new Error('corrupt image');
        }
      }),
    };
    const image = new MicrovmWorkspaceImage({
      runId: 'run-2',
      workDir: root,
      workspacePath: workspace,
      homePath: home,
      baseRootfsPath: path.join(root, 'base.ext4'),
      supervisorBinaryPath: path.join(root, 'supervisor'),
      supervisorSha256: createHash('sha256').update('binary').digest('hex'),
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }, dependencies);
    await image.prepare();
    await expect(image.extractAfterStop()).rejects.toThrow(/preserved at/);
    await expect(fs.access(image.recoveryImagePath)).resolves.toBeUndefined();
    await image.cleanup();
    await expect(fs.access(image.recoveryImagePath)).resolves.toBeUndefined();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('extracts only workspace content and delays cleanup until copy-back succeeds', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-workspace-'));
    const workspace = path.join(root, 'source');
    const home = path.join(root, 'home');
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    await fs.writeFile(path.join(workspace, 'file'), 'before');
    await fs.writeFile(path.join(root, 'base.ext4'), 'rootfs');
    await fs.writeFile(path.join(root, 'supervisor'), 'binary');
    const rsyncCalls: string[][] = [];
    const image = new MicrovmWorkspaceImage({
      runId: 'run-3',
      workDir: root,
      workspacePath: workspace,
      homePath: home,
      baseRootfsPath: path.join(root, 'base.ext4'),
      supervisorBinaryPath: path.join(root, 'supervisor'),
      supervisorSha256: createHash('sha256').update('binary').digest('hex'),
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    }, {
      runTool: jest.fn(async (command, args) => {
        if (command === 'debugfs' && args[0] === '-R' && args[1].startsWith('rdump ')) {
          const extracted = path.join(image.runDirectory, 'extracted');
          await fs.writeFile(path.join(extracted, 'file'), 'after');
          await fs.mkdir(path.join(extracted, '.awf-home'), { recursive: true });
          await fs.writeFile(path.join(extracted, '.awf-home', 'token'), 'guest-only');
          await fs.mkdir(path.join(extracted, 'lost+found'), { recursive: true });
        }
        if (command === 'rsync') {
          rsyncCalls.push([...args]);
          const sourceDirectory = args[args.length - 2];
          const destinationDirectory = args[args.length - 1];
          if (!sourceDirectory || !destinationDirectory) return;
          const sourceFile = path.join(sourceDirectory, 'file');
          const destinationFile = path.join(destinationDirectory, 'file');
          await fs.mkdir(path.dirname(destinationFile), { recursive: true });
          await fs.copyFile(sourceFile, destinationFile);
        }
      }),
    });

    await image.prepare();
    await image.extractAfterStop();
    expect(rsyncCalls).toEqual([[
      '-a',
      '--delete',
      '--safe-links',
      `${path.join(image.runDirectory, 'extracted')}${path.sep}`,
      `${path.join(root, '.source.awf-merge-run-3')}${path.sep}`,
    ]]);
    await expect(fs.readFile(path.join(workspace, 'file'), 'utf8')).resolves.toBe('after');
    await image.cleanup();
    await expect(fs.access(image.runDirectory)).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });
});
