/**
 * PID Tracker - Correlates network requests to processes using /proc filesystem
 *
 * This module provides functionality to trace network connections back to their
 * originating processes by reading /proc/net/tcp and scanning /proc/[pid]/fd.
 *
 * The tracking flow:
 * 1. Parse /proc/net/tcp to find the socket inode for a given local port
 * 2. Scan /proc/[pid]/fd/ directories to find which process owns that socket
 * 3. Read /proc/[pid]/cmdline to get the full command line
 *
 * @example
 * ```typescript
 * import { trackPidForPort, getProcessInfo, parseNetTcp } from './pid-tracker';
 *
 * // Track a process by its source port
 * const result = await trackPidForPort(45678);
 * console.log(result);
 * // { pid: 12345, cmdline: 'curl https://github.com', comm: 'curl', inode: '123456' }
 * ```
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { PidTrackResult } from './types';

// Re-export PidTrackResult for convenience
export { PidTrackResult } from './types';

/**
 * Parsed entry from /proc/net/tcp
 */
interface NetTcpEntry {
  /** Local IP address in hex format */
  localAddressHex: string;
  /** Local port number */
  localPort: number;
  /** Remote IP address in hex format */
  remoteAddressHex: string;
  /** Remote port number */
  remotePort: number;
  /** Connection state (e.g., 01 = ESTABLISHED, 06 = TIME_WAIT) */
  state: string;
  /** Socket inode number */
  inode: string;
  /** UID of the process owning the socket */
  uid: number;
}

/**
 * Parses a hex IP address from /proc/net/tcp format to dotted decimal
 * Note: /proc/net/tcp stores IP addresses in little-endian hex format
 *
 * @param hexIp - Hex IP address (e.g., "0100007F" for 127.0.0.1)
 * @returns Dotted decimal IP address (e.g., "127.0.0.1")
 */
export function parseHexIp(hexIp: string): string {
  // /proc/net/tcp stores IPs in little-endian format
  // So "0100007F" means 127.0.0.1
  const bytes = [];
  for (let i = 6; i >= 0; i -= 2) {
    bytes.push(parseInt(hexIp.substring(i, i + 2), 16));
  }
  return bytes.join('.');
}

/**
 * Converts a hex port number to decimal
 *
 * @param hexPort - Hex port number (e.g., "01BB" for 443)
 * @returns Decimal port number
 */
export function parseHexPort(hexPort: string): number {
  return parseInt(hexPort, 16);
}

/**
 * Parses /proc/net/tcp content and returns structured entries
 *
 * The format of /proc/net/tcp is:
 * sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
 *
 * @param content - Raw content of /proc/net/tcp
 * @returns Array of parsed TCP connection entries
 */
export function parseNetTcp(content: string): NetTcpEntry[] {
  const lines = content.trim().split('\n');
  const entries: NetTcpEntry[] = [];

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Split by whitespace
    const fields = line.split(/\s+/);
    if (fields.length < 10) continue;

    // Fields: sl, local_address, rem_address, st, tx:rx, tr:tm, retrnsmt, uid, timeout, inode
    const localAddress = fields[1]; // e.g., "0100007F:01BB"
    const remoteAddress = fields[2];
    const state = fields[3];
    const uid = parseInt(fields[7], 10);
    const inode = fields[9];

    // Parse local address
    const [localAddrHex, localPortHex] = localAddress.split(':');
    const localPort = parseHexPort(localPortHex);

    // Parse remote address
    const [remoteAddrHex, remotePortHex] = remoteAddress.split(':');
    const remotePort = parseHexPort(remotePortHex);

    entries.push({
      localAddressHex: localAddrHex,
      localPort,
      remoteAddressHex: remoteAddrHex,
      remotePort,
      state,
      inode,
      uid,
    });
  }

  return entries;
}

/**
 * Finds the socket inode for a given local port
 *
 * @param entries - Parsed /proc/net/tcp entries
 * @param srcPort - Source port to find
 * @returns Socket inode string or undefined if not found
 */
export function findInodeForPort(entries: NetTcpEntry[], srcPort: number): string | undefined {
  const entry = entries.find((e) => e.localPort === srcPort);
  return entry?.inode;
}

/**
 * Checks if a string is numeric (for filtering /proc entries)
 *
 * @param str - String to check
 * @returns true if the string represents a positive integer
 */
export function isNumeric(str: string): boolean {
  return /^\d+$/.test(str);
}

/**
 * Reads the command line for a process from /proc/[pid]/cmdline
 * The cmdline file contains null-separated arguments
 *
 * @param pid - Process ID
 * @param procPath - Base path to /proc (default: '/proc')
 * @returns Command line string with arguments separated by spaces, or null if not readable
 */
export function readCmdline(pid: number, procPath = '/proc'): string | null {
  try {
    const cmdlinePath = path.join(procPath, pid.toString(), 'cmdline');
    const content = fs.readFileSync(cmdlinePath, 'utf-8');
    // cmdline contains null-separated arguments, replace with spaces
    return content.replace(/\0/g, ' ').trim();
  } catch {
    return null;
  }
}

/**
 * Reads the short command name from /proc/[pid]/comm
 *
 * @param pid - Process ID
 * @param procPath - Base path to /proc (default: '/proc')
 * @returns Short command name, or null if not readable
 */
export function readComm(pid: number, procPath = '/proc'): string | null {
  try {
    const commPath = path.join(procPath, pid.toString(), 'comm');
    return fs.readFileSync(commPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Gets the symlink target for a file descriptor
 *
 * @param fdPath - Full path to the fd symlink
 * @returns Symlink target (e.g., 'socket:[123456]'), or null if not readable
 */
export function readFdLink(fdPath: string): string | null {
  try {
    return fs.readlinkSync(fdPath);
  } catch {
    return null;
  }
}

/**
 * Scans a process's file descriptors to find one that matches the given socket inode
 *
 * @param pid - Process ID to scan
 * @param inode - Socket inode to look for
 * @param procPath - Base path to /proc (default: '/proc')
 * @returns true if the process owns the socket, false otherwise
 */
export function processOwnsSocket(pid: number, inode: string, procPath = '/proc'): boolean {
  const fdDir = path.join(procPath, pid.toString(), 'fd');

  try {
    const fds = fs.readdirSync(fdDir);
    for (const fd of fds) {
      const fdPath = path.join(fdDir, fd);
      const link = readFdLink(fdPath);
      if (link && link === `socket:[${inode}]`) {
        return true;
      }
    }
  } catch {
    // Process may have exited or we don't have permission
    return false;
  }

  return false;
}

/**
 * Finds the process that owns a socket with the given inode
 *
 * @param inode - Socket inode to find
 * @param procPath - Base path to /proc (default: '/proc')
 * @returns Object with pid, cmdline, and comm, or null if not found
 */
export function findProcessByInode(
  inode: string,
  procPath = '/proc'
): { pid: number; cmdline: string; comm: string } | null {
  try {
    const entries = fs.readdirSync(procPath);
    const pids = entries.filter(isNumeric).map((s) => parseInt(s, 10));

    for (const pid of pids) {
      if (processOwnsSocket(pid, inode, procPath)) {
        const cmdline = readCmdline(pid, procPath) || 'unknown';
        const comm = readComm(pid, procPath) || 'unknown';
        return { pid, cmdline, comm };
      }
    }
  } catch {
    // Could not read /proc
    return null;
  }

  return null;
}

/**
 * Gets detailed information about a process
 *
 * @param pid - Process ID
 * @param procPath - Base path to /proc (default: '/proc')
 * @returns Object with cmdline and comm, or null if not found
 */
export function getProcessInfo(
  pid: number,
  procPath = '/proc'
): { cmdline: string; comm: string } | null {
  const cmdline = readCmdline(pid, procPath);
  const comm = readComm(pid, procPath);

  if (cmdline === null && comm === null) {
    return null;
  }

  return {
    cmdline: cmdline || 'unknown',
    comm: comm || 'unknown',
  };
}

/**
 * Resolves a PidTrackResult from already-read /proc/net/tcp content.
 *
 * Shared helper used by both trackPidForPort (async) and trackPidForPortSync (sync)
 * to avoid duplicating the parse/lookup/return logic.
 *
 * @param tcpContent - Contents of /proc/net/tcp
 * @param srcPort - Source port number from the network connection
 * @param procPath - Base path to /proc
 * @returns PidTrackResult with process information
 */
function resolvePidFromTcpContent(
  tcpContent: string,
  srcPort: number,
  procPath: string
): PidTrackResult {
  const entries = parseNetTcp(tcpContent);
  const inode = findInodeForPort(entries, srcPort);

  if (!inode || inode === '0') {
    return {
      pid: -1,
      cmdline: 'unknown',
      comm: 'unknown',
      error: `No socket found for port ${srcPort}`,
    };
  }

  const processInfo = findProcessByInode(inode, procPath);

  if (!processInfo) {
    return {
      pid: -1,
      cmdline: 'unknown',
      comm: 'unknown',
      inode,
      error: `Socket inode ${inode} found but no process owns it`,
    };
  }

  return {
    pid: processInfo.pid,
    cmdline: processInfo.cmdline,
    comm: processInfo.comm,
    inode,
  };
}

/**
 * Main function to track a process by its source port
 *
 * This reads /proc/net/tcp to find the socket inode, then scans
 * all process file descriptors to find the owning process.
 *
 * @param srcPort - Source port number from the network connection
 * @param procPath - Base path to /proc (default: '/proc', useful for testing)
 * @returns PidTrackResult with process information
 *
 * @example
 * ```typescript
 * const result = await trackPidForPort(45678);
 * if (result.pid !== -1) {
 *   console.log(`Port 45678 is owned by PID ${result.pid}: ${result.cmdline}`);
 * }
 * ```
 */
export async function trackPidForPort(
  srcPort: number,
  procPath = '/proc'
): Promise<PidTrackResult> {
  try {
    // Read /proc/net/tcp using async operations
    const tcpPath = path.join(procPath, 'net', 'tcp');
    let tcpContent: string;

    try {
      tcpContent = await fsPromises.readFile(tcpPath, 'utf-8');
    } catch (err) {
      return {
        pid: -1,
        cmdline: 'unknown',
        comm: 'unknown',
        error: `Failed to read ${tcpPath}: ${err}`,
      };
    }

    return resolvePidFromTcpContent(tcpContent, srcPort, procPath);
  } catch (err) {
    return {
      pid: -1,
      cmdline: 'unknown',
      comm: 'unknown',
      error: `Unexpected error: ${err}`,
    };
  }
}

/**
 * Synchronous version of trackPidForPort for use in contexts where async is not available
 *
 * @param srcPort - Source port number from the network connection
 * @param procPath - Base path to /proc (default: '/proc')
 * @returns PidTrackResult with process information
 */
export function trackPidForPortSync(srcPort: number, procPath = '/proc'): PidTrackResult {
  try {
    // Read /proc/net/tcp
    const tcpPath = path.join(procPath, 'net', 'tcp');
    let tcpContent: string;

    try {
      tcpContent = fs.readFileSync(tcpPath, 'utf-8');
    } catch (err) {
      return {
        pid: -1,
        cmdline: 'unknown',
        comm: 'unknown',
        error: `Failed to read ${tcpPath}: ${err}`,
      };
    }

    return resolvePidFromTcpContent(tcpContent, srcPort, procPath);
  } catch (err) {
    return {
      pid: -1,
      cmdline: 'unknown',
      comm: 'unknown',
      error: `Unexpected error: ${err}`,
    };
  }
}

/**
 * Checks if PID tracking is available on the current system
 * (requires /proc filesystem to be mounted and readable)
 *
 * @param procPath - Base path to /proc (default: '/proc')
 * @returns true if PID tracking is available
 */
export function isPidTrackingAvailable(procPath = '/proc'): boolean {
  try {
    const tcpPath = path.join(procPath, 'net', 'tcp');
    fs.accessSync(tcpPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
