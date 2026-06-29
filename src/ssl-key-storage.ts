/**
 * SSL Key Storage lifecycle utilities
 *
 * Provides secure storage and cleanup for SSL key material:
 * - tmpfs mount/unmount for memory-only key storage
 * - Best-effort secure file wiping (overwrite before deletion)
 * - Recursive directory ownership management
 *
 * Security considerations:
 * - Keys stored in tmpfs never touch disk
 * - File overwrite reduces recovery risk for disk-backed storage (best effort)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import execa from 'execa';
import { logger } from './logger';

/**
 * Recursively chown a directory and its contents
 */
export function chownRecursive(dirPath: string, uid: number, gid: number): void {
  fs.chownSync(dirPath, uid, gid);
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      chownRecursive(fullPath, uid, gid);
    } else {
      fs.chownSync(fullPath, uid, gid);
    }
  }
}

/**
 * Mounts a tmpfs filesystem at the given path so SSL keys are stored in memory only.
 * Falls back gracefully if mount fails (e.g., insufficient permissions).
 *
 * @param sslDir - Directory path to mount tmpfs on
 * @returns true if tmpfs was mounted, false if fallback to disk
 */
export async function mountSslTmpfs(sslDir: string): Promise<boolean> {
  try {
    // Mount tmpfs with restrictive options (4MB is more than enough for SSL keys)
    await execa('mount', [
      '-t', 'tmpfs',
      '-o', 'size=4m,mode=0700,noexec,nosuid,nodev',
      'tmpfs',
      sslDir,
    ]);

    logger.debug(`tmpfs mounted at ${sslDir} for SSL key storage`);
    return true;
  } catch (error) {
    logger.debug(`Could not mount tmpfs at ${sslDir} (falling back to disk): ${error}`);
    return false;
  }
}

/**
 * Unmounts a tmpfs filesystem. All data is immediately destroyed since tmpfs is memory-only.
 *
 * @param sslDir - Directory path where tmpfs was mounted
 */
export async function unmountSslTmpfs(sslDir: string): Promise<void> {
  try {
    await execa('umount', [sslDir]);
    logger.debug(`tmpfs unmounted at ${sslDir} - key material destroyed`);
  } catch (error) {
    logger.debug(`Could not unmount tmpfs at ${sslDir}: ${error}`);
  }
}

/**
 * Securely wipes a file by overwriting its contents with random data before unlinking.
 * This is best-effort risk reduction for disk-backed storage; recovery prevention
 * cannot be guaranteed on all filesystems (for example, journaling/COW).
 *
 * @param filePath - Path to the file to securely wipe
 * @internal Exported for testing
 */
export function secureWipeFile(filePath: string): void {
  let fd: number | undefined;

  try {
    const openFlags = fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(filePath, openFlags);

    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Refusing to wipe non-regular file: ${filePath}`);
    }

    const size = stat.size;
    if (size > 0) {
      // Overwrite with random data
      const randomData = crypto.randomBytes(size);
      let offset = 0;
      while (offset < size) {
        offset += fs.writeSync(fd, randomData, offset, size - offset, offset);
      }
      fs.fsyncSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    logger.debug(`Could not securely overwrite ${filePath}: ${error}`);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors during cleanup
      }
    }
  }

  // Best-effort: if secure wipe fails, still try to delete
  try {
    fs.unlinkSync(filePath);
    logger.debug(`Securely wiped (best-effort): ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore deletion errors during cleanup
    }
    logger.debug(`Could not delete ${filePath} after wipe attempt: ${error}`);
  }
}

/**
 * Securely cleans up SSL key material from the workDir.
 * Overwrites private keys with random data before deletion to prevent recovery.
 *
 * @param workDir - Working directory containing ssl/ subdirectory
 */
export function cleanupSslKeyMaterial(workDir: string): void {
  const sslDir = path.join(workDir, 'ssl');
  if (!fs.existsSync(sslDir)) {
    return;
  }

  logger.debug('Securely wiping SSL key material...');

  // Wipe the private key (most sensitive)
  secureWipeFile(path.join(sslDir, 'ca-key.pem'));

  // Wipe other SSL files
  secureWipeFile(path.join(sslDir, 'ca-cert.pem'));
  secureWipeFile(path.join(sslDir, 'ca-cert.der'));

  // Clean up ssl_db (contains generated per-host certificates)
  const sslDbPath = path.join(workDir, 'ssl_db');
  if (fs.existsSync(sslDbPath)) {
    const certsDir = path.join(sslDbPath, 'certs');
    if (fs.existsSync(certsDir)) {
      for (const file of fs.readdirSync(certsDir)) {
        secureWipeFile(path.join(certsDir, file));
      }
    }
  }

  logger.debug('SSL key material securely wiped');
}
