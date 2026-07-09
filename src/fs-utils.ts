import * as fs from 'fs';
import * as path from 'path';

export interface EnsureDirectoryOptions {
  mode?: number;
  onCreate?: () => void;
  onExists?: () => void;
  onAfterEnsure?: () => void;
}

export function ensureDirectory(dirPath: string, options: EnsureDirectoryOptions = {}): boolean {
  const { mode, onCreate, onExists, onAfterEnsure } = options;
  let created: boolean;
  try {
    created = Boolean(
      fs.mkdirSync(dirPath, mode === undefined ? { recursive: true } : { recursive: true, mode })
    );
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EACCES') {
      const uid = process.getuid?.() ?? '?';
      // Identify the blocking ancestor for actionable diagnostics.
      // Walk up and choose the first existing ancestor that fails a W_OK|X_OK access
      // check — that is the actual permission boundary. Fall back to the nearest
      // existing ancestor if every ancestor passes (unusual, but avoids a null result).
      let blocker: string | null = null;
      let nearestExisting: string | null = null;
      let current = path.resolve(dirPath);
      while (current !== path.dirname(current)) {
        if (fs.existsSync(current)) {
          if (nearestExisting === null) {
            nearestExisting = current;
          }
          try {
            fs.accessSync(current, fs.constants.W_OK | fs.constants.X_OK);
          } catch {
            // This ancestor fails the access check — it is the real blocker.
            blocker = current;
            break;
          }
        }
        current = path.dirname(current);
      }
      if (blocker === null) {
        blocker = nearestExisting;
      }
      throw new Error(
        `EACCES: cannot create directory ${dirPath} (running as uid=${uid}).\n` +
        `  Blocked by: ${blocker ?? dirPath}\n` +
        `  This is typically caused by a previous AWF run leaving root-owned directories.\n` +
        `  The orchestrator must clean up stale directories before invoking AWF.`
      );
    }
    throw error;
  }

  const lstat = fs.lstatSync(dirPath);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink as directory: ${dirPath}`);
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Expected directory but found non-directory path: ${dirPath}`);
  }

  if (created) {
    onCreate?.();
  } else {
    onExists?.();
  }

  onAfterEnsure?.();
  return created;
}

export function assertRealDirectory(dirPath: string): void {
  const lstat = fs.lstatSync(dirPath);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink as directory: ${dirPath}`);
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Expected directory but found non-directory path: ${dirPath}`);
  }
}

export function createMissingOwnedDirectorySegments(dirPath: string, uid: number, gid: number): void {
  let currentPath = path.isAbsolute(dirPath)
    ? path.parse(dirPath).root
    : '';
  const segments = dirPath.split(path.sep).filter(Boolean);

  for (const segment of segments) {
    currentPath = currentPath ? path.join(currentPath, segment) : segment;
    let created = false;
    if (!fs.existsSync(currentPath)) {
      fs.mkdirSync(currentPath);
      created = true;
    }

    // Validate the current segment is a directory. Allow root-owned system symlinks
    // (e.g. /var on macOS) but refuse user-controlled symlinks.
    const lstat = fs.lstatSync(currentPath);
    if (lstat.isSymbolicLink() && (created || lstat.uid !== 0)) {
      throw new Error(`Refusing to use symlink as directory: ${currentPath}`);
    }
    const stat = fs.statSync(currentPath);
    if (!stat.isDirectory()) {
      throw new Error(`Expected directory but found non-directory path: ${currentPath}`);
    }

    if (created) {
      fs.chownSync(currentPath, uid, gid);
      fs.chmodSync(currentPath, 0o755);
    }
  }
}
