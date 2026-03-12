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
  parseHexIp,
  parseHexPort,
  parseNetTcp,
  findInodeForPort,
  isNumeric,
  readCmdline,
  readComm,
  readFdLink,
  processOwnsSocket,
  findProcessByInode,
  getProcessInfo,
  trackPidForPort,
  trackPidForPortSync,
  isPidTrackingAvailable,
} from './pid-tracker';

describe('pid-tracker', () => {
  describe('parseHexIp', () => {
    it('should parse localhost (127.0.0.1) correctly', () => {
      // 127.0.0.1 in little-endian hex is 0100007F
      expect(parseHexIp('0100007F')).toBe('127.0.0.1');
    });

    it('should parse 0.0.0.0 correctly', () => {
      expect(parseHexIp('00000000')).toBe('0.0.0.0');
    });

    it('should parse 192.168.1.1 correctly', () => {
      // 192.168.1.1 in little-endian hex: 01 01 A8 C0
      expect(parseHexIp('0101A8C0')).toBe('192.168.1.1');
    });

    it('should parse 10.0.0.1 correctly', () => {
      // 10.0.0.1 in little-endian hex: 01 00 00 0A
      expect(parseHexIp('0100000A')).toBe('10.0.0.1');
    });

    it('should parse 172.30.0.20 correctly', () => {
      // 172.30.0.20 in little-endian hex: 14 00 1E AC
      expect(parseHexIp('14001EAC')).toBe('172.30.0.20');
    });
  });

  describe('parseHexPort', () => {
    it('should parse port 443 correctly', () => {
      expect(parseHexPort('01BB')).toBe(443);
    });

    it('should parse port 80 correctly', () => {
      expect(parseHexPort('0050')).toBe(80);
    });

    it('should parse port 3128 correctly', () => {
      expect(parseHexPort('0C38')).toBe(3128);
    });

    it('should parse high port correctly', () => {
      expect(parseHexPort('C000')).toBe(49152);
    });

    it('should parse port 0 correctly', () => {
      expect(parseHexPort('0000')).toBe(0);
    });
  });

  describe('parseNetTcp', () => {
    const sampleNetTcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1 0000000000000000 100 0 0 10 0
   1: 0100007F:01BB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 789012 1 0000000000000000 100 0 0 10 0
   2: 14001EAC:B278 8C728E58:01BB 01 00000000:00000000 02:000A8D98 00000000  1000        0 345678 1 0000000000000000 100 0 0 10 0`;

    it('should parse /proc/net/tcp content correctly', () => {
      const entries = parseNetTcp(sampleNetTcp);
      expect(entries).toHaveLength(3);
    });

    it('should parse local port correctly', () => {
      const entries = parseNetTcp(sampleNetTcp);
      expect(entries[0].localPort).toBe(3306); // 0CEA in hex
      expect(entries[1].localPort).toBe(443); // 01BB in hex
      expect(entries[2].localPort).toBe(45688); // B278 in hex
    });

    it('should parse remote port correctly', () => {
      const entries = parseNetTcp(sampleNetTcp);
      expect(entries[0].remotePort).toBe(0);
      expect(entries[1].remotePort).toBe(0);
      expect(entries[2].remotePort).toBe(443);
    });

    it('should parse inode correctly', () => {
      const entries = parseNetTcp(sampleNetTcp);
      expect(entries[0].inode).toBe('123456');
      expect(entries[1].inode).toBe('789012');
      expect(entries[2].inode).toBe('345678');
    });

    it('should parse connection state correctly', () => {
      const entries = parseNetTcp(sampleNetTcp);
      expect(entries[0].state).toBe('0A'); // LISTEN
      expect(entries[1].state).toBe('0A'); // LISTEN
      expect(entries[2].state).toBe('01'); // ESTABLISHED
    });

    it('should parse UID correctly', () => {
      const entries = parseNetTcp(sampleNetTcp);
      expect(entries[0].uid).toBe(1000);
    });

    it('should handle empty content', () => {
      const entries = parseNetTcp('');
      expect(entries).toHaveLength(0);
    });

    it('should handle header only', () => {
      const entries = parseNetTcp(
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
      );
      expect(entries).toHaveLength(0);
    });
  });

  describe('findInodeForPort', () => {
    const entries = [
      {
        localAddressHex: '0100007F',
        localPort: 3306,
        remoteAddressHex: '00000000',
        remotePort: 0,
        state: '0A',
        inode: '123456',
        uid: 1000,
      },
      {
        localAddressHex: '0100007F',
        localPort: 443,
        remoteAddressHex: '00000000',
        remotePort: 0,
        state: '0A',
        inode: '789012',
        uid: 1000,
      },
    ];

    it('should find inode for existing port', () => {
      expect(findInodeForPort(entries, 3306)).toBe('123456');
      expect(findInodeForPort(entries, 443)).toBe('789012');
    });

    it('should return undefined for non-existent port', () => {
      expect(findInodeForPort(entries, 8080)).toBeUndefined();
    });

    it('should return undefined for empty entries', () => {
      expect(findInodeForPort([], 3306)).toBeUndefined();
    });
  });

  describe('isNumeric', () => {
    it('should return true for numeric strings', () => {
      expect(isNumeric('123')).toBe(true);
      expect(isNumeric('1')).toBe(true);
      expect(isNumeric('0')).toBe(true);
      expect(isNumeric('999999')).toBe(true);
    });

    it('should return false for non-numeric strings', () => {
      expect(isNumeric('')).toBe(false);
      expect(isNumeric('abc')).toBe(false);
      expect(isNumeric('12a')).toBe(false);
      expect(isNumeric('-1')).toBe(false);
      expect(isNumeric('1.5')).toBe(false);
      expect(isNumeric(' 123')).toBe(false);
    });
  });

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

    const createMockProc = (
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

      // Create fd directory and socket links
      const fdDir = path.join(pidDir, 'fd');
      fs.mkdirSync(fdDir, { recursive: true });

      socketInodes.forEach((inode, index) => {
        const fdPath = path.join(fdDir, (index + 3).toString());
        // We can't create actual socket symlinks, so we'll mock readlinkSync in tests
        fs.writeFileSync(fdPath, `socket:[${inode}]`);
      });
    };

    const createMockNetTcp = (entries: string) => {
      const netDir = path.join(mockProcPath, 'net');
      fs.mkdirSync(netDir, { recursive: true });
      fs.writeFileSync(path.join(netDir, 'tcp'), entries);
    };

    describe('readCmdline', () => {
      it('should read command line from mock proc', () => {
        createMockProc(1234, 'curl https://github.com', 'curl', []);
        const result = readCmdline(1234, mockProcPath);
        expect(result).toBe('curl https://github.com');
      });

      it('should return null for non-existent process', () => {
        const result = readCmdline(99999, mockProcPath);
        expect(result).toBeNull();
      });
    });

    describe('readComm', () => {
      it('should read comm from mock proc', () => {
        createMockProc(1234, 'curl', 'curl', []);
        const result = readComm(1234, mockProcPath);
        expect(result).toBe('curl');
      });

      it('should return null for non-existent process', () => {
        const result = readComm(99999, mockProcPath);
        expect(result).toBeNull();
      });
    });

    describe('getProcessInfo', () => {
      it('should get process info from mock proc', () => {
        createMockProc(1234, 'node server.js', 'node', []);
        const result = getProcessInfo(1234, mockProcPath);
        expect(result).not.toBeNull();
        expect(result!.cmdline).toBe('node server.js');
        expect(result!.comm).toBe('node');
      });

      it('should return null for non-existent process', () => {
        const result = getProcessInfo(99999, mockProcPath);
        expect(result).toBeNull();
      });
    });

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

    describe('readFdLink', () => {
      it('should read symlink target for socket fd', () => {
        createMockProcWithSymlinks(1234, 'node app.js', 'node', ['123456']);
        const fdPath = path.join(mockProcPath, '1234', 'fd', '3');
        const result = readFdLink(fdPath);
        expect(result).toBe('socket:[123456]');
      });

      it('should return null for non-existent fd', () => {
        const result = readFdLink(path.join(mockProcPath, 'nonexistent', 'fd', '999'));
        expect(result).toBeNull();
      });

      it('should return null for regular file (not symlink)', () => {
        const filePath = path.join(mockProcPath, 'regular-file');
        fs.writeFileSync(filePath, 'content');
        const result = readFdLink(filePath);
        expect(result).toBeNull();
      });
    });

    describe('processOwnsSocket', () => {
      it('should return true when process owns the socket', () => {
        createMockProcWithSymlinks(1234, 'curl https://example.com', 'curl', ['123456', '789012']);
        const result = processOwnsSocket(1234, '123456', mockProcPath);
        expect(result).toBe(true);
      });

      it('should return true for second socket inode', () => {
        createMockProcWithSymlinks(1234, 'curl https://example.com', 'curl', ['123456', '789012']);
        const result = processOwnsSocket(1234, '789012', mockProcPath);
        expect(result).toBe(true);
      });

      it('should return false when process does not own the socket', () => {
        createMockProcWithSymlinks(1234, 'curl https://example.com', 'curl', ['123456']);
        const result = processOwnsSocket(1234, '999999', mockProcPath);
        expect(result).toBe(false);
      });

      it('should return false for non-existent process', () => {
        const result = processOwnsSocket(99999, '123456', mockProcPath);
        expect(result).toBe(false);
      });

      it('should return false when fd directory does not exist', () => {
        const pidDir = path.join(mockProcPath, '5678');
        fs.mkdirSync(pidDir, { recursive: true });
        fs.writeFileSync(path.join(pidDir, 'cmdline'), 'test');
        // No fd directory created
        const result = processOwnsSocket(5678, '123456', mockProcPath);
        expect(result).toBe(false);
      });
    });

    describe('findProcessByInode', () => {
      it('should find process that owns the socket inode', () => {
        createMockProcWithSymlinks(1234, 'node server.js', 'node', ['123456']);
        const result = findProcessByInode('123456', mockProcPath);
        expect(result).not.toBeNull();
        expect(result!.pid).toBe(1234);
        expect(result!.cmdline).toBe('node server.js');
        expect(result!.comm).toBe('node');
      });

      it('should return null when no process owns the inode', () => {
        createMockProcWithSymlinks(1234, 'node server.js', 'node', ['123456']);
        const result = findProcessByInode('999999', mockProcPath);
        expect(result).toBeNull();
      });

      it('should return null when proc directory is empty', () => {
        const result = findProcessByInode('123456', mockProcPath);
        expect(result).toBeNull();
      });

      it('should find correct process among multiple processes', () => {
        createMockProcWithSymlinks(1111, 'bash', 'bash', ['111111']);
        createMockProcWithSymlinks(2222, 'curl https://api.github.com', 'curl', ['222222']);
        createMockProcWithSymlinks(3333, 'node app.js', 'node', ['333333']);

        const result = findProcessByInode('222222', mockProcPath);
        expect(result).not.toBeNull();
        expect(result!.pid).toBe(2222);
        expect(result!.cmdline).toBe('curl https://api.github.com');
      });
    });

    describe('trackPidForPort', () => {
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

        const result = await trackPidForPort(45688, mockProcPath);
        expect(result.pid).toBe(-1);
        expect(result.inode).toBe('123456');
        expect(result.error).toContain('Socket inode 123456 found but no process owns it');
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

    if (isLinux) {
      it('should be able to parse real /proc/net/tcp', () => {
        const tcpPath = '/proc/net/tcp';
        if (fs.existsSync(tcpPath)) {
          const content = fs.readFileSync(tcpPath, 'utf-8');
          const entries = parseNetTcp(content);
          // Should be able to parse without errors
          expect(Array.isArray(entries)).toBe(true);
        }
      });

      it('should get info for current process', () => {
        const pid = process.pid;
        const info = getProcessInfo(pid);
        expect(info).not.toBeNull();
        // Modern Node.js (v17+) sets comm to 'MainThread' instead of 'node'
        // via prctl(PR_SET_NAME); check cmdline instead, which reliably contains the node binary
        expect(info!.cmdline).toContain('node');
      });
    }
  });
});
