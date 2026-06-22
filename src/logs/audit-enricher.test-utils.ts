import { ParsedLogEntry, PolicyManifest, PolicyRule } from '../types';
import { createLogEntry } from './log-test-fixtures.test-utils';

export function makeEntry(overrides: Partial<ParsedLogEntry> = {}): ParsedLogEntry {
  return createLogEntry({
    timestamp: 1700000000.0,
    host: 'github.com:443',
    url: 'github.com:443',
    userAgent: 'curl/7.81.0',
    domain: 'github.com',
    ...overrides,
  });
}

export function makeManifest(rules: PolicyRule[]): PolicyManifest {
  return {
    version: 1,
    generatedAt: '2024-01-01T00:00:00.000Z',
    rules,
    dangerousPorts: [22, 3306],
    dnsServers: ['8.8.8.8'],
    sslBumpEnabled: false,
    dlpEnabled: false,
    hostAccessEnabled: false,
    allowHostPorts: null,
  };
}
