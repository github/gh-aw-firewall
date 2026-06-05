/**
 * Unit tests for pid-tracker.ts
 *
 * These tests use mock /proc filesystem data to validate behavior
 * through the module's public API.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { trackPidForPortSync, isPidTrackingAvailable } from './pid-tracker';

describe('pid-tracker', () => {
  describe('Mock /proc filesystem tests', () => {
    let mockProcPath: string;

    beforeEach(() => {
      mockProcPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-proc-'));
    });

    afterEach(() => {
      fs.rmSync(mockProcPath, { recursive: true, force: true });
    });

    const createMockNetTcp = (entries: string) => {
      const netDir = path.join(mockProcPath, 'net');
      fs.mkdirSync(netDir, { recursive: true });
      fs.writeFileSync(path.join(netDir, 'tcp'), entries);
    };

    const createMockProcWithSymlinks = (
      pid: number,
      cmdline: string,
      comm: string,
      socketInodes: string[]
    ) => {
      const pidDir = path.join(mockProcPath, pid.toString());
      fs.mkdirSync(pidDir, { recursive: true });

      fs.writeFileSync(path.join(pidDir, 'cmdline'), cmdline.replace(/ /g, '\0'));
      fs.writeFileSync(path.join(pidDir, 'comm'), comm);

      const fdDir = path.join(pidDir, 'fd');
      fs.mkdirSync(fdDir, { recursive: true });

      socketInodes.forEach((inode, index) => {
        const fdPath = path.join(fdDir, (index + 3).toString());
        fs.symlinkSync(`socket:[${inode}]`, fdPath);
      });
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

    describe('trackPidForPortSync', () => {
      it('should return error when /proc/net/tcp does not exist', () => {
        const result = trackPidForPortSync(45678, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('Failed to read');
      });

      it('should return error when tcp table content is empty', () => {
        createMockNetTcp('');

        const result = trackPidForPortSync(3306, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('No socket found');
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

      it('should successfully track process for parsed hex port and inode', () => {
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

      it('should return unknown labels when process info files are missing', () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);

        const pidDir = path.join(mockProcPath, '1234');
        fs.mkdirSync(path.join(pidDir, 'fd'), { recursive: true });
        fs.symlinkSync('socket:[123456]', path.join(pidDir, 'fd', '3'));

        const result = trackPidForPortSync(45688, mockProcPath);
        expect(result.pid).toBe(1234);
        expect(result.cmdline).toBe('unknown');
        expect(result.comm).toBe('unknown');
      });

      it('should return error when no process owns the socket', () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);
        createMockProcWithSymlinks(1234, 'curl', 'curl', ['999999']);

        const result = trackPidForPortSync(45688, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.inode).toBe('123456');
        expect(result.error).toContain('Socket inode 123456 found but no process owns it');
      });

      it('should ignore malformed /proc/net/tcp rows', () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: malformed`;
        createMockNetTcp(netTcpContent);

        const result = trackPidForPortSync(3306, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('No socket found');
      });

      it('should ignore non-symlink file descriptors', () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);

        // Create a process with a regular file fd instead of a socket symlink
        const pidDir = path.join(mockProcPath, '1234');
        const fdDir = path.join(pidDir, 'fd');
        fs.mkdirSync(fdDir, { recursive: true });
        fs.writeFileSync(path.join(pidDir, 'cmdline'), 'test');
        fs.writeFileSync(path.join(pidDir, 'comm'), 'test');
        fs.writeFileSync(path.join(fdDir, '3'), 'regular-file');

        const result = trackPidForPortSync(45688, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('Socket inode 123456 found but no process owns it');
      });

      it('should handle empty lines within /proc/net/tcp content', () => {
        // Empty lines between data rows trigger the `if (!line) continue` branch.
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0

   1: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 654321 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);
        createMockProcWithSymlinks(1234, 'curl https://github.com', 'curl', ['123456']);

        // B278 = 45688 decimal
        const result = trackPidForPortSync(45688, mockProcPath);
        expect(result.pid).toBe(1234);
        expect(result.inode).toBe('123456');
      });

      it('should handle fd symlink pointing to non-socket target', () => {
        // readFdLink returns a value that doesn't match socket:[inode] pattern.
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);

        const pidDir = path.join(mockProcPath, '1234');
        const fdDir = path.join(pidDir, 'fd');
        fs.mkdirSync(fdDir, { recursive: true });
        fs.writeFileSync(path.join(pidDir, 'cmdline'), 'test');
        fs.writeFileSync(path.join(pidDir, 'comm'), 'test');
        // Symlink to a pipe (not a socket)
        fs.symlinkSync('pipe:[999]', path.join(fdDir, '3'));

        const result = trackPidForPortSync(45688, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('Socket inode 123456 found but no process owns it');
      });

      it('should return null from findProcessByInode when /proc has no numeric PID entries', () => {
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);

        // No numeric pid directories are created under mockProcPath, so findProcessByInode returns null.
        // The existing net/ directory entry is non-numeric and will be filtered out by isNumeric().
        const result = trackPidForPortSync(45688, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('Socket inode 123456 found but no process owns it');
      });

      it('should handle process whose fd dir is missing (processOwnsSocket catch path)', () => {
        // Create a pid dir without an fd subdirectory so readdirSync(fdDir) throws ENOENT.
        const netTcpContent = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B278 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0`;
        createMockNetTcp(netTcpContent);

        // Create a numeric pid dir but no fd/ inside it — triggers catch in processOwnsSocket.
        const pidDir = path.join(mockProcPath, '5678');
        fs.mkdirSync(pidDir, { recursive: true });

        const result = trackPidForPortSync(45688, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.error).toContain('Socket inode 123456 found but no process owns it');
      });
    });
  });

  describe('Real /proc filesystem (integration)', () => {
    const isLinux = process.platform === 'linux';

    it('should check if PID tracking is available', () => {
      const result = isPidTrackingAvailable();
      if (isLinux) {
        expect(result).toBe(true);
      } else {
        expect(result).toBe(false);
      }
    });
  });
});
