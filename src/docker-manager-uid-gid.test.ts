import {
  getSafeHostUid,
  getSafeHostGid,
  getRealUserHome,
} from './host-env';
import * as fs from 'fs';

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

describe('docker-manager UID/GID utilities', () => {
  describe('validateIdNotInSystemRange (via getSafeHostUid)', () => {
    const originalGetuid = process.getuid;
    const originalSudoUid = process.env.SUDO_UID;

    afterEach(() => {
      process.getuid = originalGetuid;
      if (originalSudoUid !== undefined) {
        process.env.SUDO_UID = originalSudoUid;
      } else {
        delete process.env.SUDO_UID;
      }
    });

    it('should return 1000 for system UIDs (0-999)', () => {
      // Test via SUDO_UID path which calls validateIdNotInSystemRange
      process.getuid = () => 0;
      process.env.SUDO_UID = '0';
      expect(getSafeHostUid()).toBe('1000');
      process.env.SUDO_UID = '1';
      expect(getSafeHostUid()).toBe('1000');
      process.env.SUDO_UID = '13'; // proxy user
      expect(getSafeHostUid()).toBe('1000');
      process.env.SUDO_UID = '999';
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return the UID as-is for regular users (>= 1000)', () => {
      process.getuid = () => 0;
      process.env.SUDO_UID = '1000';
      expect(getSafeHostUid()).toBe('1000');
      process.env.SUDO_UID = '1001';
      expect(getSafeHostUid()).toBe('1001');
      process.env.SUDO_UID = '65534'; // nobody user on some systems
      expect(getSafeHostUid()).toBe('65534');
    });
  });

  describe('getSafeHostUid', () => {
    const originalGetuid = process.getuid;
    const originalSudoUid = process.env.SUDO_UID;

    afterEach(() => {
      process.getuid = originalGetuid;
      if (originalSudoUid !== undefined) {
        process.env.SUDO_UID = originalSudoUid;
      } else {
        delete process.env.SUDO_UID;
      }
    });

    it('should return 1000 when SUDO_UID is a system UID', () => {
      process.getuid = () => 0; // Running as root
      process.env.SUDO_UID = '13'; // proxy user
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return SUDO_UID when it is a regular user UID', () => {
      process.getuid = () => 0; // Running as root
      process.env.SUDO_UID = '1001';
      expect(getSafeHostUid()).toBe('1001');
    });

    it('should return 1000 when SUDO_UID is 0', () => {
      process.getuid = () => 0; // Running as root
      process.env.SUDO_UID = '0';
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return 1000 when running as root without SUDO_UID', () => {
      process.getuid = () => 0;
      delete process.env.SUDO_UID;
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return 1000 for non-root system UID', () => {
      process.getuid = () => 13; // proxy user
      delete process.env.SUDO_UID;
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return the UID when running as regular user', () => {
      process.getuid = () => 1001;
      delete process.env.SUDO_UID;
      expect(getSafeHostUid()).toBe('1001');
    });

    it('should return 1000 when SUDO_UID is not a valid number', () => {
      process.getuid = () => 0; // Running as root
      process.env.SUDO_UID = 'not-a-number';
      expect(getSafeHostUid()).toBe('1000');
    });
  });

  describe('getSafeHostGid', () => {
    const originalGetgid = process.getgid;
    const originalSudoGid = process.env.SUDO_GID;

    afterEach(() => {
      process.getgid = originalGetgid;
      if (originalSudoGid !== undefined) {
        process.env.SUDO_GID = originalSudoGid;
      } else {
        delete process.env.SUDO_GID;
      }
    });

    it('should return 1000 when SUDO_GID is a system GID', () => {
      process.getgid = () => 0; // Running as root
      process.env.SUDO_GID = '13'; // proxy group
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return SUDO_GID when it is a regular user GID', () => {
      process.getgid = () => 0; // Running as root
      process.env.SUDO_GID = '1001';
      expect(getSafeHostGid()).toBe('1001');
    });

    it('should return 1000 when SUDO_GID is 0', () => {
      process.getgid = () => 0; // Running as root
      process.env.SUDO_GID = '0';
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return 1000 when running as root without SUDO_GID', () => {
      process.getgid = () => 0;
      delete process.env.SUDO_GID;
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return 1000 for non-root system GID', () => {
      process.getgid = () => 13; // proxy group
      delete process.env.SUDO_GID;
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return the GID when running as regular user', () => {
      process.getgid = () => 1001;
      delete process.env.SUDO_GID;
      expect(getSafeHostGid()).toBe('1001');
    });

    it('should return 1000 when SUDO_GID is not a valid number', () => {
      process.getgid = () => 0; // Running as root
      process.env.SUDO_GID = 'not-a-number';
      expect(getSafeHostGid()).toBe('1000');
    });
  });

  describe('getRealUserHome', () => {
    const originalGetuid = process.getuid;
    const originalSudoUser = process.env.SUDO_USER;
    const originalHome = process.env.HOME;

    afterEach(() => {
      process.getuid = originalGetuid;
      process.env.SUDO_USER = originalSudoUser;
      process.env.HOME = originalHome;
      jest.restoreAllMocks();
    });

    it('should return HOME when running as regular user', () => {
      process.getuid = () => 1001;
      process.env.HOME = '/home/testuser';
      expect(getRealUserHome()).toBe('/home/testuser');
    });

    it('should return /root as fallback when HOME is not set and running as root', () => {
      process.getuid = () => 0;
      delete process.env.SUDO_USER;
      delete process.env.HOME;
      expect(getRealUserHome()).toBe('/root');
    });

    it('should use HOME as fallback when running as root without SUDO_USER', () => {
      process.getuid = () => 0;
      delete process.env.SUDO_USER;
      process.env.HOME = '/root';
      expect(getRealUserHome()).toBe('/root');
    });

    it('should look up user home from /etc/passwd when running as root with SUDO_USER (using real root user)', () => {
      // Test with actual /etc/passwd by using 'root' user which always exists
      process.getuid = () => 0;
      process.env.SUDO_USER = 'root';
      process.env.HOME = '/some/other/path';

      // Read actual root home from /etc/passwd (differs by platform: /root on Linux, /var/root on macOS)
      const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
      const rootLine = passwd.split('\n').find(line => line.startsWith('root:'));
      const expectedRootHome = rootLine ? rootLine.split(':')[5] : '/root';

      expect(getRealUserHome()).toBe(expectedRootHome);
    });

    it('should fall back to HOME when SUDO_USER not found in /etc/passwd', () => {
      process.getuid = () => 0;
      process.env.SUDO_USER = 'nonexistent_user_12345';
      process.env.HOME = '/fallback/home';

      // User doesn't exist in /etc/passwd, should fall back to HOME
      expect(getRealUserHome()).toBe('/fallback/home');
    });

    it('should handle undefined getuid gracefully (using real /etc/passwd)', () => {
      // Simulate environment where process.getuid is undefined (e.g., Windows)
      process.getuid = undefined as any;
      process.env.SUDO_USER = 'root';
      process.env.HOME = '/custom/home';

      // Read actual root home from /etc/passwd (differs by platform)
      const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
      const rootLine = passwd.split('\n').find(line => line.startsWith('root:'));
      const expectedRootHome = rootLine ? rootLine.split(':')[5] : '/root';

      // With getuid undefined, uid is undefined (falsy), so it attempts passwd lookup
      expect(getRealUserHome()).toBe(expectedRootHome);
    });
  });

  describe('MIN_REGULAR_UID threshold (via getSafeHostUid)', () => {
    const originalGetuid = process.getuid;
    const originalSudoUid = process.env.SUDO_UID;

    afterEach(() => {
      process.getuid = originalGetuid;
      if (originalSudoUid !== undefined) {
        process.env.SUDO_UID = originalSudoUid;
      } else {
        delete process.env.SUDO_UID;
      }
    });

    it('should treat 1000 as the minimum regular UID threshold', () => {
      process.getuid = () => 0;
      // UID 999 is in system range → returns 1000
      process.env.SUDO_UID = '999';
      expect(getSafeHostUid()).toBe('1000');
      // UID 1000 is the first regular UID → returns 1000
      process.env.SUDO_UID = '1000';
      expect(getSafeHostUid()).toBe('1000');
    });
  });
});
