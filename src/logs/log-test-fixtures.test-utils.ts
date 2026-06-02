import { ParsedLogEntry } from '../types';

export function createLogEntry(overrides: Partial<ParsedLogEntry> = {}): ParsedLogEntry {
  return {
    timestamp: 1761074374.646,
    clientIp: '172.30.0.20',
    clientPort: '39748',
    host: 'api.github.com:443',
    destIp: '140.82.114.22',
    destPort: '443',
    protocol: '1.1',
    method: 'CONNECT',
    statusCode: 200,
    decision: 'TCP_TUNNEL:HIER_DIRECT',
    url: 'api.github.com:443',
    userAgent: '-',
    domain: 'api.github.com',
    isAllowed: true,
    isHttps: true,
    ...overrides,
  };
}

type RawLogLineFields = Omit<ParsedLogEntry, 'domain' | 'isAllowed' | 'isHttps'>;

export function createRawLogLine(overrides: Partial<RawLogLineFields> = {}): string {
  const entry = createLogEntry(overrides);

  return `${entry.timestamp} ${entry.clientIp}:${entry.clientPort} ${entry.host} ${entry.destIp}:${entry.destPort} ${entry.protocol} ${entry.method} ${entry.statusCode} ${entry.decision} ${entry.url} "${entry.userAgent}"`;
}
