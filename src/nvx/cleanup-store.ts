import { randomBytes } from 'crypto';
import { constants, promises as fs } from 'fs';
import * as path from 'path';
import {
  NVX_CLEANUP_ROOT,
  parseNvxCleanupRecord,
  assertNvxCleanupStageConsistency,
  type NvxCleanupProcessIdentity,
  type NvxCleanupRecord,
} from './cleanup-record';

export interface NvxCleanupStoreDependencies {
  readonly effectiveUid: number;
  readonly pid: number;
  mkdir: typeof fs.mkdir;
  lstat: typeof fs.lstat;
  open: typeof fs.open;
  link: typeof fs.link;
  rename: typeof fs.rename;
  unlink: typeof fs.unlink;
  readdir: typeof fs.readdir;
  readFile: typeof fs.readFile;
  processMatches(identity: NvxCleanupProcessIdentity): Promise<boolean>;
}

const defaults: NvxCleanupStoreDependencies = {
  effectiveUid: process.geteuid?.() ?? -1,
  pid: process.pid,
  mkdir: fs.mkdir,
  lstat: fs.lstat,
  open: fs.open,
  link: fs.link,
  rename: fs.rename,
  unlink: fs.unlink,
  readdir: fs.readdir,
  readFile: fs.readFile,
  processMatches: async () => false,
};

export class NvxCleanupStore {
  readonly dependencies: NvxCleanupStoreDependencies;

  constructor(
    dependencies: Partial<NvxCleanupStoreDependencies> = {},
    readonly rootDirectory = NVX_CLEANUP_ROOT,
  ) {
    this.dependencies = { ...defaults, ...dependencies };
  }

  async ensure(): Promise<void> {
    if (this.dependencies.effectiveUid !== 0) {
      throw new Error('NVX cleanup store requires effective uid 0');
    }
    await this.dependencies.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    const stat = await this.dependencies.lstat(this.rootDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o777) !== 0o700
    ) {
      throw new Error(`NVX cleanup store has unsafe ownership or mode: ${this.rootDirectory}`);
    }
  }

  recordPath(runId: string): string {
    return path.join(this.rootDirectory, `${runId}.json`);
  }

  async create(record: NvxCleanupRecord): Promise<void> {
    await this.ensure();
    await this.write(record, true);
  }

  async update(record: NvxCleanupRecord): Promise<void> {
    await this.write(record, false);
  }

  async read(recordPath: string): Promise<NvxCleanupRecord> {
    const stat = await this.dependencies.lstat(recordPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o777) !== 0o600
    ) throw new Error('NVX cleanup record must be a root-owned mode-0600 regular file');
    const record = parseNvxCleanupRecord(
      await this.dependencies.readFile(recordPath, 'utf8'),
      recordPath,
      this.rootDirectory,
    );
    assertNvxCleanupStageConsistency(record);
    return record;
  }

  async list(): Promise<string[]> {
    await this.ensure();
    return (await this.dependencies.readdir(this.rootDirectory))
      .filter((name) => /^[a-f0-9]{32}\.json$/.test(name))
      .map((name) => path.join(this.rootDirectory, name));
  }

  async remove(runId: string): Promise<void> {
    await this.dependencies.unlink(this.recordPath(runId)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
  }

  async claim(
    recordPath: string,
    owner: NvxCleanupProcessIdentity,
  ): Promise<(() => Promise<void>) | undefined> {
    const lockPath = `${recordPath}.lock`;
    const temporaryPath = `${lockPath}.${this.dependencies.pid}.${randomBytes(6).toString('hex')}`;
    await writePrivate(this.dependencies, temporaryPath, `${JSON.stringify(owner)}\n`);
    try {
      await this.dependencies.link(temporaryPath, lockPath);
      return async () => {
        await this.dependencies.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const before = await this.dependencies.lstat(lockPath, { bigint: true });
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.uid !== 0n ||
        (before.mode & 0o777n) !== 0o600n
      ) throw new Error(`NVX cleanup claim has unsafe ownership or mode: ${lockPath}`);
      const existing = parseClaim(
        await this.dependencies.readFile(lockPath, 'utf8'),
      );
      if (await this.dependencies.processMatches(existing)) return undefined;
      const quarantine = `${lockPath}.stale-${randomBytes(6).toString('hex')}`;
      try {
        await this.dependencies.rename(lockPath, quarantine);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw renameError;
      }
      const after = await this.dependencies.lstat(quarantine, { bigint: true });
      const quarantinedOwner = parseClaim(
        await this.dependencies.readFile(quarantine, 'utf8'),
      );
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        await this.dependencies.processMatches(quarantinedOwner)
      ) {
        await this.dependencies.rename(quarantine, lockPath).catch(() => undefined);
        throw new Error('NVX cleanup claim ownership changed during stale takeover');
      }
      await this.dependencies.unlink(quarantine);
      return this.claim(recordPath, owner);
    } finally {
      await this.dependencies.unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async write(record: NvxCleanupRecord, exclusive: boolean): Promise<void> {
    const recordPath = this.recordPath(record.runId);
    const temporaryPath = `${recordPath}.tmp-${this.dependencies.pid}-${randomBytes(6).toString('hex')}`;
    await writePrivate(
      this.dependencies,
      temporaryPath,
      `${JSON.stringify(record, null, 2)}\n`,
    );
    try {
      if (exclusive) {
        try {
          await this.dependencies.link(temporaryPath, recordPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`NVX cleanup record already exists for run "${record.runId}"`);
          }
          throw error;
        }
        await this.dependencies.unlink(temporaryPath);
      } else {
        await this.dependencies.rename(temporaryPath, recordPath);
      }
      const directory = await this.dependencies.open(this.rootDirectory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await this.dependencies.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

async function writePrivate(
  dependencies: NvxCleanupStoreDependencies,
  filePath: string,
  contents: string,
): Promise<void> {
  const handle = await dependencies.open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseClaim(contents: string): NvxCleanupProcessIdentity {
  const parsed = JSON.parse(contents) as NvxCleanupProcessIdentity;
  if (
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 1 ||
    !/^\d+$/.test(parsed.startTimeTicks) ||
    !path.isAbsolute(parsed.executable)
  ) throw new Error('NVX cleanup claim owner is malformed');
  return parsed;
}
