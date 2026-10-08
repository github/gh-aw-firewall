import { promises as fs, type Stats } from 'fs';
import * as path from 'path';
import {
  CREDENTIAL_ENTRIES,
  HOME_FORBIDDEN_SUBDIRS,
  HOME_TOOL_PATHS,
} from '../config/mount-policy';
import { NVX_GUEST_HOME, NVX_GUEST_RUN_SCRIPT } from './workspace-export';

const EXCLUDED_RELATIVE_PATHS = [
  ...CREDENTIAL_ENTRIES.map(({ path: entryPath }) => normalizeRelative(entryPath)),
  ...HOME_FORBIDDEN_SUBDIRS.map(normalizeRelative),
];

export interface NvxGuestConfigLayerConfig {
  readonly stagingRoot: string;
  readonly uid: number;
  readonly gid: number;
  readonly runScript: string;
  readonly homePath?: string;
}

export interface NvxGuestConfigLayerDependencies {
  readonly chown?: (target: string, uid: number, gid: number) => Promise<void>;
  readonly lchown?: (target: string, uid: number, gid: number) => Promise<void>;
}

/**
 * Builds the immutable custom EROFS source tree. It contains only AWF-owned
 * guest configuration: the generated entrypoint and the explicitly allowed
 * guest-home state. Live workspace/tool-cache content is never copied here.
 */
export class NvxGuestConfigLayer {
  readonly layerSourcePath: string;
  private staged = false;
  private readonly chown: (target: string, uid: number, gid: number) => Promise<void>;
  private readonly lchown: (target: string, uid: number, gid: number) => Promise<void>;

  constructor(
    private readonly config: NvxGuestConfigLayerConfig,
    dependencies: NvxGuestConfigLayerDependencies = {},
  ) {
    this.layerSourcePath = path.join(config.stagingRoot, 'custom-layer');
    this.chown = dependencies.chown ?? fs.chown;
    this.lchown = dependencies.lchown ?? fs.lchown;
  }

  async stage(): Promise<string> {
    if (this.staged) throw new Error('NVX guest configuration layer is already staged');
    await fs.mkdir(this.config.stagingRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.stagingRoot, 0o700);
    await fs.mkdir(this.layerSourcePath, { recursive: true, mode: 0o755 });
    await this.stageGuestHome();
    await this.stageRunScript();
    this.staged = true;
    return this.layerSourcePath;
  }

  async cleanup(): Promise<void> {
    await restoreWritable(this.config.stagingRoot);
    await fs.rm(this.config.stagingRoot, { recursive: true, force: true });
    this.staged = false;
  }

  private async stageGuestHome(): Promise<void> {
    const guestHome = path.join(this.layerSourcePath, NVX_GUEST_HOME.slice(1));
    await fs.mkdir(guestHome, { recursive: true, mode: 0o700 });
    await this.chown(guestHome, this.config.uid, this.config.gid);
    if (!this.config.homePath) return;
    for (const toolPath of HOME_TOOL_PATHS) {
      const source = path.join(this.config.homePath, toolPath);
      let stat: Stats;
      try {
        stat = await fs.lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Allowed NVX guest home state must be a real directory: ${source}`);
      }
      const destination = path.join(guestHome, toolPath);
      await copySafeTree(source, destination, this.config.homePath);
      await applyOwnership(destination, this.config.uid, this.config.gid, this.chown, this.lchown);
    }
    await applyOwnership(guestHome, this.config.uid, this.config.gid, this.chown, this.lchown);
  }

  private async stageRunScript(): Promise<void> {
    const scriptPath = path.join(this.layerSourcePath, NVX_GUEST_RUN_SCRIPT.slice(1));
    await fs.mkdir(path.dirname(scriptPath), { recursive: true, mode: 0o755 });
    await fs.writeFile(scriptPath, this.config.runScript, { mode: 0o555 });
    await this.chown(scriptPath, 0, 0);
    await fs.chmod(scriptPath, 0o555);
    await this.chown(path.dirname(scriptPath), 0, 0);
    await fs.chmod(path.dirname(scriptPath), 0o555);
  }
}

async function restoreWritable(root: string): Promise<void> {
  let stats: Stats;
  try {
    stats = await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stats.isSymbolicLink()) {
    await fs.chmod(root, (stats.mode & 0o7777) | 0o700).catch(() => undefined);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) return;
  for (const entry of await fs.readdir(root)) {
    await restoreWritable(path.join(root, entry));
  }
}

async function copySafeTree(source: string, destination: string, root: string): Promise<void> {
  const sourceStat = await fs.lstat(source);
  await fs.mkdir(destination, { recursive: true, mode: sourceStat.mode & 0o7777 });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = path.join(source, entry.name);
    const relative = path.relative(root, sourcePath).split(path.sep).join('/');
    if (isExcluded(relative)) continue;
    const destinationPath = path.join(destination, entry.name);
    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(sourcePath), destinationPath);
    } else if (stat.isDirectory()) {
      await copySafeTree(sourcePath, destinationPath, root);
    } else if (stat.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
      await fs.chmod(destinationPath, stat.mode & 0o7777);
    }
  }
}

async function applyOwnership(
  root: string,
  uid: number,
  gid: number,
  chown: (target: string, uid: number, gid: number) => Promise<void>,
  lchown: (target: string, uid: number, gid: number) => Promise<void>,
): Promise<void> {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) {
    await lchown(root, uid, gid);
    return;
  }
  await chown(root, uid, gid);
  if (!stat.isDirectory()) return;
  for (const entry of await fs.readdir(root)) {
    await applyOwnership(path.join(root, entry), uid, gid, chown, lchown);
  }
}

function isExcluded(relative: string): boolean {
  return EXCLUDED_RELATIVE_PATHS.some(
    (entry) => relative === entry || relative.startsWith(`${entry}/`),
  );
}

function normalizeRelative(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}
