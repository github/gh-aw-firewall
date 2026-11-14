import * as fs from 'fs';
import * as path from 'path';
import {
  credentialEntriesUnderMountedPaths,
  gitLabCredentialFiles,
  HOME_TOOL_PATHS,
} from '../config/mount-policy';
import { assertRealDirectory } from '../fs-utils';
import { logger } from '../logger';

/** Records a credential path that was moved aside before `sbx create`. */
interface ScrubbedCredential {
  /** Original host path (inside a wholesale-mounted home dir). */
  original: string;
  /** Backup location the path was moved to (outside any mount). */
  backup: string;
  /** Identity of the parent directory, used to reject substituted restore paths. */
  parent: {
    realPath: string;
    dev: number;
    ino: number;
    isSymbolicLink: boolean;
    linkTarget?: string;
  };
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function existingRealPath(candidate: string): string | undefined {
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    throw new Error(`Cannot safely resolve GitLab credential path ${candidate}: ${(error as Error).message}`);
  }
}

function directoryIdentity(dirPath: string): ScrubbedCredential['parent'] {
  const linkStat = fs.lstatSync(dirPath);
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Credential parent is not a directory: ${dirPath}`);
  }
  const isSymbolicLink = linkStat.isSymbolicLink();
  return {
    realPath: fs.realpathSync(dirPath),
    dev: linkStat.dev,
    ino: linkStat.ino,
    isSymbolicLink,
    ...(isSymbolicLink ? { linkTarget: fs.readlinkSync(dirPath) } : {}),
  };
}

function assertCredentialParentUnchanged(
  original: string,
  expected: ScrubbedCredential['parent'],
): void {
  const parentPath = path.dirname(original);
  const current = directoryIdentity(parentPath);
  if (
    (expected.dev !== undefined && current.dev !== expected.dev) ||
    (expected.ino !== undefined && current.ino !== expected.ino) ||
    current.realPath !== expected.realPath ||
    current.isSymbolicLink !== expected.isSymbolicLink ||
    current.linkTarget !== expected.linkTarget
  ) {
    throw new Error(`Credential parent path changed while sandbox was running: ${parentPath}`);
  }
}

export function resolveExistingHomeToolDirectory(
  homePath: string,
  toolPath: string,
): { source: string; relativeHomePath?: string } | undefined {
  const source = path.join(homePath, toolPath);
  try {
    assertRealDirectory(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  const resolvedSource = fs.realpathSync(source);
  const resolvedHome = fs.realpathSync(homePath);
  const relativeHomePath = path.relative(resolvedHome, resolvedSource);
  const isUnderHome = Boolean(relativeHomePath) &&
    !relativeHomePath.startsWith('..') &&
    !path.isAbsolute(relativeHomePath);
  return {
    source: resolvedSource,
    relativeHomePath: isUnderHome
      ? relativeHomePath.split(path.sep).join('/')
      : undefined,
  };
}

/** Owns the private credential backups for one sandbox lifecycle. */
export class CredentialScrubHandle {
  private scrubbedCredentials: ScrubbedCredential[] = [];
  private credentialBackupRoot: string | undefined;

  get hasPendingRestoration(): boolean {
    return this.scrubbedCredentials.length > 0;
  }

  /**
   * Moves known credential stores out of wholesale-mounted home tool dirs.
   * The central mount policy keeps this in sync with compose credential overlays.
   */
  scrubHomeCredentials(
    homePath: string,
    mountedHomePaths: ReadonlySet<string> = new Set<string>(HOME_TOOL_PATHS),
    mountedPaths: ReadonlySet<string> = new Set(
      [...mountedHomePaths].map((relative) => path.join(homePath, relative)),
    ),
  ): void {
    if (this.hasPendingRestoration) {
      throw new Error(
        'Cannot create another sbx sandbox while previous credential backups still need restoration',
      );
    }
    this.scrubbedCredentials = [];
    this.credentialBackupRoot = undefined;

    const entries = credentialEntriesUnderMountedPaths(mountedHomePaths);
    const gitLabFiles = gitLabCredentialFiles(homePath);
    const credentials = entries.map((entry) => ({
      original: path.join(homePath, entry.path),
      label: entry.path,
      isGitLab: entry.path === '.config/glab-cli',
    }));
    const mountRoots = [...mountedPaths].map((root) => ({
      lexical: path.resolve(root),
      canonical: existingRealPath(root),
    }));
    const seenGitLabFiles = new Set<string>();
    for (const [index, file] of gitLabFiles.entries()) {
      const lexicalFile = path.resolve(file);
      const canonicalFile = existingRealPath(file);
      const coveringEntry = credentials.find(({ original }) => {
        const lexicalEntry = path.resolve(original);
        const canonicalEntry = existingRealPath(original);
        return isWithin(lexicalEntry, lexicalFile) ||
          (canonicalEntry !== undefined && canonicalFile !== undefined &&
            isWithin(canonicalEntry, canonicalFile));
      });
      if (coveringEntry) coveringEntry.isGitLab = true;

      const lexicallyExposed = mountRoots.some(({ lexical }) => isWithin(lexical, lexicalFile));
      const canonicallyExposed = canonicalFile !== undefined && mountRoots.some(({ canonical }) =>
        canonical !== undefined && isWithin(canonical, canonicalFile)
      );
      if (!lexicallyExposed && !canonicallyExposed) continue;

      const coveringPath = coveringEntry && existingRealPath(coveringEntry.original);
      let coveredByMovedDirectory = false;
      if (coveringEntry && canonicalFile && coveringPath) {
        try {
          const stat = fs.lstatSync(coveringEntry.original);
          coveredByMovedDirectory = !stat.isSymbolicLink() &&
            isWithin(coveringPath, canonicalFile);
        } catch {
          coveredByMovedDirectory = false;
        }
      }
      if (coveredByMovedDirectory) continue;

      const original = canonicalFile ?? lexicalFile;
      if (seenGitLabFiles.has(original)) continue;
      seenGitLabFiles.add(original);
      credentials.push({ original, label: `gitlab-config-${index}`, isGitLab: true });
    }

    for (const { original, label, isGitLab } of credentials) {
      if (existingRealPath(original) === undefined && !fs.existsSync(original)) continue;

      if (!this.credentialBackupRoot) {
        let backupWouldBeMounted = false;
        try {
          const backupRoot = fs.mkdtempSync(path.join(homePath, '.awf-sbx-cred-backup-'));
          this.credentialBackupRoot = backupRoot;
          fs.chmodSync(backupRoot, 0o700);
          const canonicalBackupRoot = fs.realpathSync(backupRoot);
          backupWouldBeMounted = mountRoots.some(({ lexical, canonical }) =>
            isWithin(lexical, path.resolve(backupRoot)) ||
            (canonical !== undefined && isWithin(canonical, canonicalBackupRoot))
          );
          if (backupWouldBeMounted) {
            throw new Error('credential backup directory would be exposed by a sandbox mount');
          }
        } catch (err) {
          logger.warn(`[sbx] Could not secure credential backup dir: ${(err as Error).message}`);
          if (this.credentialBackupRoot) {
            try {
              fs.rmSync(this.credentialBackupRoot, { recursive: true, force: true });
            } catch {
              // Keep the failed path out of every mount; best-effort cleanup.
            }
          }
          this.credentialBackupRoot = undefined;
          if (backupWouldBeMounted) {
            throw new Error(`Cannot hide credentials before creating sandbox: ${(err as Error).message}`);
          }
          if (credentials.some((credential) =>
            credential.isGitLab && (existingRealPath(credential.original) !== undefined ||
              fs.existsSync(credential.original)))) {
            throw new Error(`Cannot hide GitLab CLI credentials before creating sandbox: ${(err as Error).message}`);
          }
          return;
        }
      }

      const backup = path.join(this.credentialBackupRoot, label.replace(/\//g, '__'));
      try {
        const parent = directoryIdentity(path.dirname(original));
        fs.renameSync(original, backup);
        this.scrubbedCredentials.push({ original, backup, parent });
        logger.info(`[sbx] Hid credential path from sandbox: ${label}`);
      } catch (err) {
        logger.warn(`[sbx] Could not hide credential path ${original}: ${(err as Error).message}`);
        if (isGitLab) {
          this.restoreHomeCredentials();
          throw new Error(`Cannot hide GitLab CLI credentials before creating sandbox: ${(err as Error).message}`);
        }
      }
    }

    if (this.scrubbedCredentials.length > 0 && this.credentialBackupRoot) {
      logger.info(
        `[sbx] Moved ${this.scrubbedCredentials.length} credential path(s) aside to ${this.credentialBackupRoot} for the duration of the sandbox`,
      );
    }
  }

  /**
   * Idempotent, non-throwing restore. Run only after live sandbox mounts are gone.
   * Failed restorations remain owned by this handle for a later retry.
   */
  restoreHomeCredentials(): void {
    const pending: ScrubbedCredential[] = [];
    for (const credential of this.scrubbedCredentials) {
      const { original, backup, parent } = credential;
      try {
        if (!fs.existsSync(backup)) continue;
        assertCredentialParentUnchanged(original, parent);
        try {
          fs.lstatSync(original);
          throw new Error(`Credential destination already exists: ${original}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        fs.renameSync(backup, original);
      } catch (err) {
        logger.warn(
          `[sbx] Could not restore credential path ${original} from ${backup}: ${(err as Error).message}. ` +
            `The original is preserved at ${backup}.`,
        );
        pending.push(credential);
      }
    }
    this.scrubbedCredentials = pending;

    if (this.credentialBackupRoot && this.scrubbedCredentials.length === 0) {
      try {
        fs.rmSync(this.credentialBackupRoot, { recursive: true, force: true });
        this.credentialBackupRoot = undefined;
      } catch (err) {
        logger.warn(`[sbx] Could not remove empty credential backup directory ${this.credentialBackupRoot}: ${(err as Error).message}`);
      }
    }
  }
}
