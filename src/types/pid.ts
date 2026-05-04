/**
 * PID tracking types for the agentic workflow firewall
 */

/**
 * Result of PID tracking operation
 *
 * Contains information about the process that made a network request,
 * identified by correlating the source port with /proc filesystem data.
 */
export interface PidTrackResult {
  /** Process ID that owns the socket, or -1 if not found */
  pid: number;
  /** Full command line of the process, or 'unknown' if not found */
  cmdline: string;
  /** Short command name (from /proc/[pid]/comm), or 'unknown' if not found */
  comm: string;
  /** Socket inode number, or undefined if not found */
  inode?: string;
  /** Error message if tracking failed, or undefined on success */
  error?: string;
}
