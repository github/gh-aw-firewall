/**
 * Tests for logs-audit command
 */

import { auditCommand, AuditCommandOptions } from './logs-audit';
import * as logAggregator from '../logs/log-aggregator';
import * as auditEnricher from '../logs/audit-enricher';
import * as logsCommandHelpers from './logs-command-helpers';
import { LogSource, ParsedLogEntry, PolicyManifest } from '../types';
import { EnrichedLogEntry } from '../logs/audit-enricher';

// Mock dependencies
jest.mock('./logs-command-helpers');
jest.mock('../logs/log-aggregator');
jest.mock('../logs/audit-enricher');
jest.mock('../logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockedHelpers = logsCommandHelpers as jest.Mocked<typeof logsCommandHelpers>;
const mockedAggregator = logAggregator as jest.Mocked<typeof logAggregator>;
const mockedEnricher = auditEnricher as jest.Mocked<typeof auditEnricher>;

// Helpers for test fixtures

function makeSource(partial: Partial<LogSource> = {}): LogSource {
  return {
    type: 'preserved',
    path: '/tmp/squid-logs-123',
    timestamp: 1000000,
    dateStr: '2024-01-01 00:00:00',
    ...partial,
  };
}

function makeEntry(partial: Partial<ParsedLogEntry> = {}): ParsedLogEntry {
  return {
    timestamp: 1700000000,
    clientIp: '172.30.0.20',
    clientPort: '12345',
    host: 'github.com',
    destIp: '1.2.3.4',
    destPort: '443',
    protocol: '1.1',
    method: 'CONNECT',
    statusCode: 200,
    decision: 'TCP_TUNNEL:HIER_DIRECT',
    url: 'github.com:443',
    userAgent: 'curl/7.81.0',
    domain: 'github.com',
    isAllowed: true,
    isHttps: true,
    ...partial,
  };
}

function makeEnrichedEntry(partial: Partial<EnrichedLogEntry> = {}): EnrichedLogEntry {
  return {
    ...makeEntry(),
    matchedRuleId: 'allow-both-plain',
    matchReason: 'Allowed by domain allowlist',
    ...partial,
  };
}

function makeManifest(partial: Partial<PolicyManifest> = {}): PolicyManifest {
  return {
    version: 1,
    generatedAt: '2024-01-01T00:00:00.000Z',
    rules: [
      {
        id: 'allow-both-plain',
        order: 1,
        action: 'allow',
        aclName: 'allowed_domains',
        protocol: 'both',
        domains: ['.github.com'],
        description: 'Allow github.com and subdomains',
      },
      {
        id: 'deny-default',
        order: 99,
        action: 'deny',
        aclName: 'all',
        protocol: 'both',
        domains: [],
        description: 'Deny all other traffic',
      },
    ],
    dangerousPorts: [22, 25],
    dnsServers: ['8.8.8.8', '8.8.4.4'],
    sslBumpEnabled: false,
    dlpEnabled: false,
    hostAccessEnabled: false,
    allowHostPorts: null,
    ...partial,
  };
}

describe('logs-audit command', () => {
  let mockExit: jest.SpyInstance;
  let mockConsoleLog: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockConsoleLog = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockConsoleLog.mockRestore();
  });

  describe('when no log entries are found', () => {
    it('should exit with error', async () => {
      const source = makeSource();
      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue([]);

      const options: AuditCommandOptions = { format: 'pretty' };

      await expect(auditCommand(options)).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('when no policy manifest is found', () => {
    it('should exit with error', async () => {
      const source = makeSource();
      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue([makeEntry()]);
      mockedHelpers.findPolicyManifestForSource.mockReturnValue(null);

      const options: AuditCommandOptions = { format: 'pretty' };

      await expect(auditCommand(options)).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('with valid entries and manifest', () => {
    function setupMocks(entries: EnrichedLogEntry[], manifest: PolicyManifest = makeManifest()) {
      const source = makeSource();
      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue(entries.map(e => e as ParsedLogEntry));
      mockedHelpers.findPolicyManifestForSource.mockReturnValue(manifest);
      mockedEnricher.enrichWithPolicyRules.mockReturnValue(entries);
      mockedEnricher.computeRuleStats.mockReturnValue([
        { ruleId: 'allow-both-plain', description: 'Allow github.com', action: 'allow', hits: 1 },
        { ruleId: 'deny-default', description: 'Deny all', action: 'deny', hits: 0 },
      ]);
    }

    it('should output json format', async () => {
      const entries = [makeEnrichedEntry()];
      setupMocks(entries);

      const options: AuditCommandOptions = { format: 'json' };
      await auditCommand(options);

      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
      const output = mockConsoleLog.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).toMatchObject({
        domain: 'github.com',
        decision: 'allowed',
        matchedRule: 'allow-both-plain',
      });
    });

    it('should output markdown format', async () => {
      const entries = [makeEnrichedEntry()];
      setupMocks(entries);

      const options: AuditCommandOptions = { format: 'markdown' };
      await auditCommand(options);

      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
      const output = mockConsoleLog.mock.calls[0][0] as string;
      expect(output).toContain('## Firewall Audit Report');
      expect(output).toContain('### Active Policy');
      expect(output).toContain('### Rule Evaluation');
    });

    it('should output pretty format', async () => {
      const entries = [makeEnrichedEntry()];
      setupMocks(entries);

      const options: AuditCommandOptions = { format: 'pretty' };
      await auditCommand(options);

      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
      const output = mockConsoleLog.mock.calls[0][0] as string;
      expect(output).toContain('Firewall Audit Report');
      expect(output).toContain('Rule Evaluation:');
    });

    it('should default to pretty format when format is unrecognized', async () => {
      const entries = [makeEnrichedEntry()];
      setupMocks(entries);

      // Cast to bypass TypeScript to test the default branch
      const options = { format: 'unknown' as any } as AuditCommandOptions;
      await auditCommand(options);

      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
      const output = mockConsoleLog.mock.calls[0][0] as string;
      expect(output).toContain('Firewall Audit Report');
    });
  });

  describe('filtering', () => {
    function setupMocksWithMultipleEntries() {
      const source = makeSource();
      const manifest = makeManifest();
      const entries: EnrichedLogEntry[] = [
        makeEnrichedEntry({ domain: 'github.com', matchedRuleId: 'allow-both-plain', isAllowed: true }),
        makeEnrichedEntry({ domain: 'evil.com', matchedRuleId: 'deny-default', isAllowed: false }),
        makeEnrichedEntry({ domain: 'api.github.com', matchedRuleId: 'allow-both-plain', isAllowed: true }),
      ];

      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue(entries as ParsedLogEntry[]);
      mockedHelpers.findPolicyManifestForSource.mockReturnValue(manifest);
      mockedEnricher.enrichWithPolicyRules.mockReturnValue(entries);
      mockedEnricher.computeRuleStats.mockReturnValue([]);

      return entries;
    }

    it('should filter by rule ID', async () => {
      setupMocksWithMultipleEntries();

      const options: AuditCommandOptions = { format: 'json', rule: 'deny-default' };
      await auditCommand(options);

      const output = mockConsoleLog.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].domain).toBe('evil.com');
    });

    it('should filter by domain (case-insensitive substring)', async () => {
      setupMocksWithMultipleEntries();

      const options: AuditCommandOptions = { format: 'json', domain: 'api.github' };
      await auditCommand(options);

      const output = mockConsoleLog.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].domain).toBe('api.github.com');
    });

    it('should filter by decision=allowed', async () => {
      setupMocksWithMultipleEntries();

      const options: AuditCommandOptions = { format: 'json', decision: 'allowed' };
      await auditCommand(options);

      const output = mockConsoleLog.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.every((e: any) => e.decision === 'allowed')).toBe(true);
      expect(parsed).toHaveLength(2);
    });

    it('should filter by decision=denied', async () => {
      setupMocksWithMultipleEntries();

      const options: AuditCommandOptions = { format: 'json', decision: 'denied' };
      await auditCommand(options);

      const output = mockConsoleLog.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.every((e: any) => e.decision === 'denied')).toBe(true);
      expect(parsed).toHaveLength(1);
    });

    it('should filter out error:transaction-end-before-headers entries', async () => {
      const source = makeSource();
      const manifest = makeManifest();
      const entries: EnrichedLogEntry[] = [
        makeEnrichedEntry({ domain: 'github.com', isAllowed: true }),
        makeEnrichedEntry({ url: 'error:transaction-end-before-headers', domain: '-', isAllowed: false }),
      ];

      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue(entries as ParsedLogEntry[]);
      mockedHelpers.findPolicyManifestForSource.mockReturnValue(manifest);
      mockedEnricher.enrichWithPolicyRules.mockReturnValue(entries);
      mockedEnricher.computeRuleStats.mockReturnValue([]);

      const options: AuditCommandOptions = { format: 'json' };
      await auditCommand(options);

      const output = mockConsoleLog.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].domain).toBe('github.com');
    });
  });

  describe('markdown format details', () => {
    it('should include denied requests section when denials exist', async () => {
      const source = makeSource();
      const manifest = makeManifest();
      const deniedEntry = makeEnrichedEntry({
        domain: 'evil.com',
        isAllowed: false,
        matchedRuleId: 'deny-default',
        matchReason: 'Deny all other traffic',
        url: 'evil.com:443',
      });
      const entries = [deniedEntry];

      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue(entries as ParsedLogEntry[]);
      mockedHelpers.findPolicyManifestForSource.mockReturnValue(manifest);
      mockedEnricher.enrichWithPolicyRules.mockReturnValue(entries);
      mockedEnricher.computeRuleStats.mockReturnValue([
        { ruleId: 'deny-default', description: 'Deny all', action: 'deny', hits: 1 },
      ]);

      const options: AuditCommandOptions = { format: 'markdown' };
      await auditCommand(options);

      const output = mockConsoleLog.mock.calls[0][0] as string;
      expect(output).toContain('### Denied Requests');
      expect(output).toContain('evil.com');
    });

    it('should show SSL Bump and DLP status in policy summary', async () => {
      const source = makeSource();
      const manifest = makeManifest({ sslBumpEnabled: true, dlpEnabled: true, hostAccessEnabled: true });
      const entries = [makeEnrichedEntry()];

      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue(entries as ParsedLogEntry[]);
      mockedHelpers.findPolicyManifestForSource.mockReturnValue(manifest);
      mockedEnricher.enrichWithPolicyRules.mockReturnValue(entries);
      mockedEnricher.computeRuleStats.mockReturnValue([]);

      const options: AuditCommandOptions = { format: 'markdown' };
      await auditCommand(options);

      const output = mockConsoleLog.mock.calls[0][0] as string;
      expect(output).toContain('**SSL Bump**: enabled');
      expect(output).toContain('**DLP**: enabled');
      expect(output).toContain('**Host Access**: enabled');
    });

    it('should cap denied requests table at 50 rows and show overflow count', async () => {
      const source = makeSource();
      const manifest = makeManifest();
      // Create 55 denied entries
      const entries: EnrichedLogEntry[] = Array.from({ length: 55 }, (_, i) =>
        makeEnrichedEntry({
          domain: `evil${i}.com`,
          isAllowed: false,
          matchedRuleId: 'deny-default',
          url: `evil${i}.com:443`,
        })
      );

      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue(entries as ParsedLogEntry[]);
      mockedHelpers.findPolicyManifestForSource.mockReturnValue(manifest);
      mockedEnricher.enrichWithPolicyRules.mockReturnValue(entries);
      mockedEnricher.computeRuleStats.mockReturnValue([]);

      const options: AuditCommandOptions = { format: 'markdown' };
      await auditCommand(options);

      const output = mockConsoleLog.mock.calls[0][0] as string;
      expect(output).toContain('...and 5 more denied requests');
    });
  });

  describe('pretty format details', () => {
    it('should show denied requests section when denials exist', async () => {
      const source = makeSource();
      const manifest = makeManifest();
      const deniedEntry = makeEnrichedEntry({
        domain: 'evil.com',
        isAllowed: false,
        matchedRuleId: 'deny-default',
      });
      const entries = [deniedEntry];

      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue(entries as ParsedLogEntry[]);
      mockedHelpers.findPolicyManifestForSource.mockReturnValue(manifest);
      mockedEnricher.enrichWithPolicyRules.mockReturnValue(entries);
      mockedEnricher.computeRuleStats.mockReturnValue([
        { ruleId: 'deny-default', description: 'Deny all', action: 'deny', hits: 1 },
      ]);

      const options: AuditCommandOptions = { format: 'pretty' };
      await auditCommand(options);

      const output = mockConsoleLog.mock.calls[0][0] as string;
      expect(output).toContain('Denied Requests (1):');
      expect(output).toContain('evil.com');
    });

    it('should cap pretty denied requests at 20 rows and show overflow count', async () => {
      const source = makeSource();
      const manifest = makeManifest();
      const entries: EnrichedLogEntry[] = Array.from({ length: 25 }, (_, i) =>
        makeEnrichedEntry({
          domain: `evil${i}.com`,
          isAllowed: false,
          matchedRuleId: 'deny-default',
        })
      );

      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue(entries as ParsedLogEntry[]);
      mockedHelpers.findPolicyManifestForSource.mockReturnValue(manifest);
      mockedEnricher.enrichWithPolicyRules.mockReturnValue(entries);
      mockedEnricher.computeRuleStats.mockReturnValue([]);

      const options: AuditCommandOptions = { format: 'pretty' };
      await auditCommand(options);

      const output = mockConsoleLog.mock.calls[0][0] as string;
      expect(output).toContain('...and 5 more');
    });
  });

  describe('source option', () => {
    it('should pass source option to discoverAndSelectSource', async () => {
      const source = makeSource({ path: '/custom/path' });
      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue([makeEntry()]);
      mockedHelpers.findPolicyManifestForSource.mockReturnValue(makeManifest());
      mockedEnricher.enrichWithPolicyRules.mockReturnValue([makeEnrichedEntry()]);
      mockedEnricher.computeRuleStats.mockReturnValue([]);

      const options: AuditCommandOptions = { format: 'json', source: '/custom/path' };
      await auditCommand(options);

      expect(mockedHelpers.discoverAndSelectSource).toHaveBeenCalledWith(
        '/custom/path',
        expect.objectContaining({ format: 'json' })
      );
    });

    it('should suppress info logs for json format', async () => {
      const source = makeSource();
      mockedHelpers.discoverAndSelectSource.mockResolvedValue(source);
      mockedAggregator.loadAllLogs.mockResolvedValue([makeEntry()]);
      mockedHelpers.findPolicyManifestForSource.mockReturnValue(makeManifest());
      mockedEnricher.enrichWithPolicyRules.mockReturnValue([makeEnrichedEntry()]);
      mockedEnricher.computeRuleStats.mockReturnValue([]);

      const options: AuditCommandOptions = { format: 'json' };
      await auditCommand(options);

      // Verify shouldLog function was passed as not logging for json
      const call = mockedHelpers.discoverAndSelectSource.mock.calls[0];
      const loggingOptions = call[1];
      expect(loggingOptions.shouldLog('json')).toBe(false);
      expect(loggingOptions.shouldLog('pretty')).toBe(true);
    });
  });
});
