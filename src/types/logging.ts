/**
 * Logging types for the agentic workflow firewall
 */

/**
 * Information about a blocked network target
 * 
 * Represents a domain and optional port that was blocked by the firewall.
 * Used for error reporting and diagnostics when egress traffic is denied.
 * Parsed from Squid proxy access logs (TCP_DENIED entries).
 */
export interface BlockedTarget {
  /**
   * Full target specification including port if present
   * 
   * @example 'github.com:8443'
   * @example 'example.com'
   */
  target: string;

  /**
   * Domain name without port
   * 
   * Extracted from the target for matching against the allowed domains list.
   * 
   * @example 'github.com'
   * @example 'example.com'
   */
  domain: string;

  /**
   * Port number if specified in the blocked request
   *
   * Non-standard ports (other than 80/443) that were part of the connection attempt.
   *
   * @example '8443'
   * @example '8080'
   */
  port?: string;
}

/**
 * Parsed entry from Squid's firewall_detailed log format
 *
 * Represents a single log line parsed into structured fields for
 * display formatting and analysis.
 */
export interface ParsedLogEntry {
  /** Unix timestamp with milliseconds (e.g., 1761074374.646) */
  timestamp: number;
  /** Client IP address */
  clientIp: string;
  /** Client port number */
  clientPort: string;
  /** Host header value (may be "-" for CONNECT requests) */
  host: string;
  /** Destination IP address (may be "-" for denied requests) */
  destIp: string;
  /** Destination port number */
  destPort: string;
  /** HTTP protocol version (e.g., "1.1") */
  protocol: string;
  /** HTTP method (CONNECT, GET, POST, etc.) */
  method: string;
  /** HTTP status code (200, 403, etc.) */
  statusCode: number;
  /** Squid decision code (e.g., "TCP_TUNNEL:HIER_DIRECT", "TCP_DENIED:HIER_NONE") */
  decision: string;
  /** Request URL or domain:port for CONNECT */
  url: string;
  /** User-Agent header value */
  userAgent: string;
  /** Extracted domain name */
  domain: string;
  /** true if request was allowed (TCP_TUNNEL), false if denied (TCP_DENIED) */
  isAllowed: boolean;
  /** true if CONNECT method (HTTPS) */
  isHttps: boolean;
}

/**
 * Output format for log display
 */
export type OutputFormat = 'raw' | 'pretty' | 'json';

/**
 * Output format for log stats and summary commands
 */
export type LogStatsFormat = 'json' | 'markdown' | 'pretty';

/**
 * Source of log data (running container or preserved log files)
 */
export interface LogSource {
  /** Type of log source */
  type: 'running' | 'preserved';
  /** Path to preserved log directory (for preserved type) */
  path?: string;
  /** Container name (for running type) */
  containerName?: string;
  /** Timestamp extracted from directory name (for preserved type) */
  timestamp?: number;
  /** Human-readable date string (for preserved type) */
  dateStr?: string;
}


/**
 * Extended log entry with PID tracking information
 *
 * Combines the standard parsed log entry with process attribution
 * for complete request tracking.
 */
export interface EnhancedLogEntry extends ParsedLogEntry {
  /** Process ID that made the request, or -1 if unknown */
  pid?: number;
  /** Full command line of the process that made the request */
  cmdline?: string;
  /** Short command name (from /proc/[pid]/comm) */
  comm?: string;
  /** Socket inode associated with the connection */
  inode?: string;
}
