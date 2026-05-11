/**
 * Unit tests for pid-tracker.ts
 *
 * These tests use mock /proc filesystem data to test the parsing
 * and tracking logic without requiring actual system access.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  trackPidForPort,
  trackPidForPortSync,
  isPidTrackingAvailable,
} from './pid-tracker';

describe('pid-tracker', () => {
  describe('Mock /proc filesystem tests', () => {
    let mockProcPath: string;

    beforeEach(() => {
      // Create a temporary mock /proc directory
      mockProcPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-proc-'));
    });

    afterEach(() => {
      // Clean up
      fs.rmSync(mockProcPath, { recursive: true, force: true });
    });

    const createMockNetTcp = (entries: string) => {
      const netDir = path.join(mockProcPath, 'net');
      fs.mkdirSync(netDir, { recursive: true });
      fs.writeFileSync(path.join(netDir, 'tcp'), entries);
    };

    describe('isPidTrackingAvailable', () => {
      it('should return true when /proc/net/tcp exists', () => {
        createMockNetTcp('header\n');
        expect(isPidTrackingAvailable(mockProcPath)).toBe(true);
      });

      it('should return false when /proc/net/tcp does not exist', () => {
        expect(isPidTrackingAvailable(mockProcPath)).toBe(false);
      });
    });

    // Helper to create mock proc with actual symlinks (for socket fd testing)
    const createMockProcWithSymlinks = (
      pid: number,
      cmdline: string,
      comm: string,
      socketInodes: string[]
    ) => {
      const pidDir = path.join(mockProcPath, pid.toString());
      fs.mkdirSync(pidDir, { recursive: true });

      // Write cmdline (null-separated)
      fs.writeFileSync(path.join(pidDir, 'cmdline'), cmdline.replace(/ /g, '\0'));

      // Write comm
      fs.writeFileSync(path.join(pidDir, 'comm'), comm);

      // Create fd directory and socket symlinks
      const fdDir = path.join(pidDir, 'fd');
      fs.mkdirSync(fdDir, { recursive: true });

      socketInodes.forEach((inode, index) => {
        const fdPath = path.join(fdDir, (index + 3).toString());
        // Create actual symlink to socket:[inode]
        fs.symlinkSync(`socket:[${inode}]`, fdPath);
      });
    };

    describe('trackPidForPort', () => {
      it('should ignore malformed /proc/net/tcp rows', async () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: malformed`;
        createMockNetTcp(netTcpContent);

        const result = await trackPidForPort(3306, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('No socket found');
      });

      it('should return error when /proc/net/tcp does not exist', async () => {
        const result = await trackPidForPort(45678, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('Failed to read');
      });

      it('should return error when port not found in tcp table', async () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);

        const result = await trackPidForPort(99999, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('No socket found');
      });

      it('should return error when inode is 0', async () => {
        // Inode 0 indicates no socket assigned
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);

        const result = await trackPidForPort(3306, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('No socket found');
      });

      it('should successfully track process for port', async () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);
        createMockProcWithSymlinks(1234, 'curl https://github.com', 'curl', ['123456']);

        const result = await trackPidForPort(45688, mockProcPath); // B278 in hex
        expect(result.pid).toBe(1234);
        expect(result.cmdline).toBe('curl https://github.com');
        expect(result.comm).toBe('curl');
        expect(result.inode).toBe('123456');
        expect(result.error).toBeUndefined();
      });

      it('should return error when no process owns the socket', async () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);
        // Create a process but with different inode
        createMockProcWithSymlinks(1234, 'curl', 'curl', ['999999']);
        expect(fs.existsSync(path.join(mockProcPath, '1234'))).toBe(true);

        const result = await trackPidForPort(45688, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.inode).toBe('123456');
        expect(result.error).toContain('Socket inode 123456 found but no process owns it');
      });

      it('should return unknown metadata when cmdline and comm are unreadable', async () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);

        const pidDir = path.join(mockProcPath, '4321');
        const fdDir = path.join(pidDir, 'fd');
        fs.mkdirSync(fdDir, { recursive: true });
        fs.symlinkSync('socket:[123456]', path.join(fdDir, '3'));
        // Intentionally omit /proc/[pid]/cmdline and /proc/[pid]/comm

        const result = await trackPidForPort(45688, mockProcPath);
        expect(result.pid).toBe(4321);
        expect(result.inode).toBe('123456');
        expect(result.cmdline).toBe('unknown');
        expect(result.comm).toBe('unknown');
      });
    });

    describe('trackPidForPortSync', () => {
      it('should return error when /proc/net/tcp does not exist', () => {
        const result = trackPidForPortSync(45678, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('Failed to read');
      });

      it('should return error when port not found in tcp table', () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);

        const result = trackPidForPortSync(99999, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('No socket found');
      });

      it('should return error when inode is 0', () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);

        const result = trackPidForPortSync(3306, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('No socket found');
      });

      it('should successfully track process for port synchronously', () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);
        createMockProcWithSymlinks(1234, 'curl https://github.com', 'curl', ['123456']);

        const result = trackPidForPortSync(45688, mockProcPath); // B278 in hex
        expect(result.pid).toBe(1234);
        expect(result.cmdline).toBe('curl https://github.com');
        expect(result.comm).toBe('curl');
        expect(result.inode).toBe('123456');
        expect(result.error).toBeUndefined();
      });

      it('should return error when no process owns the socket synchronously', () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);
        // Create a process but with different inode
        createMockProcWithSymlinks(1234, 'curl', 'curl', ['999999']);
        expect(fs.existsSync(path.join(mockProcPath, '1234'))).toBe(true);

        const result = trackPidForPortSync(45688, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.inode).toBe('123456');
        expect(result.error).toContain('Socket inode 123456 found but no process owns it');
      });

      it('should ignore non-symlink file descriptors', () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);

        const pidDir = path.join(mockProcPath, '5678');
        const fdDir = path.join(pidDir, 'fd');
        fs.mkdirSync(fdDir, { recursive: true });
        fs.writeFileSync(path.join(pidDir, 'cmdline'), 'curl');
        fs.writeFileSync(path.join(pidDir, 'comm'), 'curl');
        fs.writeFileSync(path.join(fdDir, '3'), 'not-a-symlink');

        const result = trackPidForPortSync(45688, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.inode).toBe('123456');
        expect(result.error).toContain('Socket inode 123456 found but no process owns it');
      });
    });
  });

  describe('Real /proc filesystem (integration)', () => {
    // These tests only run if /proc is available (Linux only)
    const isLinux = process.platform === 'linux';

    it('should check if PID tracking is available', () => {
      const result = isPidTrackingAvailable();
      // On Linux, this should be true; on other platforms, false
      if (isLinux) {
        expect(result).toBe(true);
      } else {
        expect(result).toBe(false);
      }
    });

  });
});
