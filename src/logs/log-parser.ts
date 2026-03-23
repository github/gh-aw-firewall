/**
 * Parser for Squid's firewall_detailed log format
 *
 * Log format:
 * %ts.%03tu %>a:%>p %{Host}>h %<a:%<p %rv %rm %>Hs %Ss:%Sh %ru "%{User-Agent}>h"
 *
 * Example lines:
 * 1761074374.646 172.30.0.20:39748 api.github.com:443 140.82.114.22:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT api.github.com:443 "-"
 * 1760994429.358 172.30.0.20:36274 github.com:8443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE github.com:8443 "curl/7.81.0"
 */

import { ParsedLogEntry } from '../types';

/**
 * Regex pattern for parsing Squid's firewall_detailed log format
 *
 * Groups:
 * 1: timestamp (e.g., "1761074374.646")
 * 2: client IP (e.g., "172.30.0.20")
 * 3: client port (e.g., "39748")
 * 4: host header (e.g., "api.github.com:443" or "-")
 * 5: dest IP (e.g., "140.82.114.22" or "-")
 * 6: dest port (e.g., "443" or "-")
 * 7: protocol version (e.g., "1.1")
 * 8: method (e.g., "CONNECT", "GET")
 * 9: status code (e.g., "200", "403")
 * 10: decision (e.g., "TCP_TUNNEL:HIER_DIRECT", "TCP_DENIED:HIER_NONE")
 * 11: URL (e.g., "api.github.com:443")
 * 12: user agent (e.g., "-", "curl/7.81.0")
 */
const LOG_PATTERN = /^(\d+\.\d+)\s+([^:]+):(\d+)\s+(\S+)\s+([^:]+):(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+"([^"]*)"/;

/**
 * Parses a single Squid log line into a structured entry
 *
 * @param line - Raw log line from access.log
 * @returns Parsed log entry or null if parsing failed
 */
export function parseLogLine(line: string): ParsedLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(LOG_PATTERN);
  if (!match) {
    return null;
  }

  const [
    ,
    timestampStr,
    clientIp,
    clientPort,
    host,
    destIp,
    destPort,
    protocol,
    method,
    statusCodeStr,
    decision,
    url,
    userAgent,
  ] = match;

  const timestamp = parseFloat(timestampStr);
  const statusCode = parseInt(statusCodeStr, 10);
  const isAllowed = decision.startsWith('TCP_TUNNEL') || decision.startsWith('TCP_MISS');
  const isHttps = method === 'CONNECT';

  // Extract domain from the appropriate field
  const domain = extractDomain(url, host, method);

  return {
    timestamp,
    clientIp,
    clientPort,
    host,
    destIp,
    destPort,
    protocol,
    method,
    statusCode,
    decision,
    url,
    userAgent,
    domain,
    isAllowed,
    isHttps,
  };
}

/**
 * Extracts the domain name from log fields
 *
 * For CONNECT requests, the domain is in the URL field (e.g., "api.github.com:443")
 * For other methods, the domain is in the Host header
 *
 * @param url - URL field from the log
 * @param host - Host header field from the log
 * @param method - HTTP method
 * @returns Extracted domain name without port
 */
export function extractDomain(url: string, host: string, method: string): string {
  if (method === 'CONNECT') {
    // For CONNECT, URL is domain:port
    const colonIndex = url.lastIndexOf(':');
    if (colonIndex !== -1) {
      const possiblePort = url.substring(colonIndex + 1);
      // Only strip if it looks like a port number
      if (/^\d+$/.test(possiblePort)) {
        return url.substring(0, colonIndex);
      }
    }
    return url;
  }

  // For other methods, use Host header
  if (host && host !== '-') {
    const colonIndex = host.lastIndexOf(':');
    if (colonIndex !== -1) {
      const possiblePort = host.substring(colonIndex + 1);
      if (/^\d+$/.test(possiblePort)) {
        return host.substring(0, colonIndex);
      }
    }
    return host;
  }

  // Fallback: try to parse domain from URL
  try {
    // Handle URLs that might not have a protocol
    const urlWithProtocol = url.startsWith('http') ? url : `http://${url}`;
    const urlObj = new URL(urlWithProtocol);
    return urlObj.hostname;
  } catch {
    return url;
  }
}

/**
 * Extracts the port from a domain:port string or URL
 *
 * @param url - URL field or domain:port string
 * @param method - HTTP method
 * @returns Port number string or undefined
 */
export function extractPort(url: string, method: string): string | undefined {
  if (method === 'CONNECT') {
    const colonIndex = url.lastIndexOf(':');
    if (colonIndex !== -1) {
      const possiblePort = url.substring(colonIndex + 1);
      if (/^\d+$/.test(possiblePort)) {
        return possiblePort;
      }
    }
  }
  return undefined;
}

/**
 * Parses a single line from the JSONL audit log (audit.jsonl).
 *
 * Format: {"ts":1761074374.646,"client":"172.30.0.20","host":"api.github.com:443","dest":"140.82.114.22:443","method":"CONNECT","status":200,"decision":"TCP_TUNNEL","url":"api.github.com:443"}
 *
 * @param line - Raw JSONL line
 * @returns Parsed log entry or null if parsing failed
 */
export function parseAuditJsonlLine(line: string): ParsedLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const obj = JSON.parse(trimmed);

    const method = obj.method || '';
    const isHttps = method === 'CONNECT';
    const decision = obj.decision || '';
    const isAllowed = decision.startsWith('TCP_TUNNEL') || decision.startsWith('TCP_MISS');

    // Parse dest into IP and port
    const destStr = obj.dest || '-:-';
    const destParts = destStr.split(':');
    const destIp = destParts[0] || '-';
    const destPort = destParts[1] || '-';

    // Extract domain
    const url = obj.url || '';
    const host = obj.host || '-';
    const domain = extractDomain(url, host, method);

    return {
      timestamp: obj.ts || 0,
      clientIp: obj.client || '-',
      clientPort: '-', // Not in JSONL format
      host,
      destIp,
      destPort,
      protocol: '-', // Not in JSONL format
      method,
      statusCode: obj.status || 0,
      decision,
      url,
      userAgent: '-', // Not in JSONL format (intentionally omitted)
      domain,
      isAllowed,
      isHttps,
    };
  } catch {
    // JSON parse failed — likely a line with unescaped characters
    return null;
  }
}
