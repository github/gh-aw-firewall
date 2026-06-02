import * as fs from 'fs';

/**
 * Base image for the 'act' preset when building locally.
 * Uses catthehacker's GitHub Actions parity image.
 */
export const ACT_PRESET_BASE_IMAGE = 'ghcr.io/catthehacker/ubuntu:act-24.04';

/**
 * Minimum UID/GID value for regular users.
 * UIDs 0-999 are reserved for system users on most Linux distributions.
 */
const MIN_REGULAR_UID = 1000;

/**
 * Validates that a UID/GID value is safe for use (not in system range).
 * Returns the value if valid, or the default (1000) if in system range.
 */
function validateIdNotInSystemRange(id: number): string {
  // Reject system UIDs/GIDs (0-999) - use default unprivileged user instead
  if (id < MIN_REGULAR_UID) {
    return MIN_REGULAR_UID.toString();
  }
  return id.toString();
}

/**
 * Gets the host user's UID, with fallback to 1000 if unavailable, root (0),
 * or in the system UID range (0-999).
 * When running with sudo, uses SUDO_UID to get the actual user's UID.
 * @internal Exported for testing
 */
export function getSafeHostUid(): string {
  const uid = process.getuid?.();
  
  // When running as root (sudo), try to get the original user's UID
  if (!uid || uid === 0) {
    const sudoUid = process.env.SUDO_UID;
    if (sudoUid) {
      const parsedUid = parseInt(sudoUid, 10);
      if (!isNaN(parsedUid)) {
        return validateIdNotInSystemRange(parsedUid);
      }
    }
    return MIN_REGULAR_UID.toString();
  }
  
  return validateIdNotInSystemRange(uid);
}

/**
 * Gets the host user's GID, with fallback to 1000 if unavailable, root (0),
 * or in the system GID range (0-999).
 * When running with sudo, uses SUDO_GID to get the actual user's GID.
 * @internal Exported for testing
 */
export function getSafeHostGid(): string {
  const gid = process.getgid?.();
  
  // When running as root (sudo), try to get the original user's GID
  if (!gid || gid === 0) {
    const sudoGid = process.env.SUDO_GID;
    if (sudoGid) {
      const parsedGid = parseInt(sudoGid, 10);
      if (!isNaN(parsedGid)) {
        return validateIdNotInSystemRange(parsedGid);
      }
    }
    return MIN_REGULAR_UID.toString();
  }
  
  return validateIdNotInSystemRange(gid);
}

/**
 * Gets the real user's home directory, accounting for sudo.
 * When running with sudo, uses SUDO_USER to find the actual user's home.
 * @internal Exported for testing
 */
export function getRealUserHome(): string {
  const uid = process.getuid?.();

  // When running as root (sudo), try to get the original user's home
  if (!uid || uid === 0) {
    // Try SUDO_USER first - look up their home directory from passwd
    const sudoUser = process.env.SUDO_USER;
    if (sudoUser) {
      try {
        // Look up user's home directory from /etc/passwd
        const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
        const userLine = passwd.split('\n').find(line => line.startsWith(`${sudoUser}:`));
        if (userLine) {
          const parts = userLine.split(':');
          if (parts.length >= 6 && parts[5]) {
            return parts[5]; // Home directory is the 6th field
          }
        }
      } catch {
        // Fall through to use HOME
      }
    }
  }

  // Use HOME environment variable as fallback
  return process.env.HOME || '/root';
}
