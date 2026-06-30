/**
 * Tests for uncovered branches in logs-command-helpers.ts:
 *
 * 1. findPolicyManifestForSource — all uncovered branches:
 *    - returns null for a running source
 *    - returns null when source.path is missing
 *    - reads and parses a manifest found at source.path/policy-manifest.json
 *    - adds AWF_AUDIT_DIR to the candidate list when the env var is set
 * 2. runLogsCommand — policy-manifest enrichment path:
 *    - loadAllLogs, enrichWithPolicyRules, and computeRuleStats are called
 *      when findPolicyManifestForSource returns a non-null manifest
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../logs/log-discovery');
jest.mock('../logs/log-aggregator');
jest.mock('../logs/audit-enricher');
jest.mock('../logs/stats-formatter');
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());

import * as logDiscovery from '../logs/log-discovery';
import * as logAggregator from '../logs/log-aggregator';
import * as auditEnricher from '../logs/audit-enricher';
import * as statsFormatter from '../logs/stats-formatter';

import {
  findPolicyManifestForSource,
  runLogsCommand,
} from './logs-command-helpers';
import type { LogSource, PolicyManifest } from '../types';

const MINIMAL_MANIFEST: PolicyManifest = {
  version: 1,
  generatedAt: '2024-01-01T00:00:00.000Z',
  rules: [],
  dangerousPorts: [],
  dnsServers: ['8.8.8.8'],
  sslBumpEnabled: false,
  dlpEnabled: false,
  hostAccessEnabled: false,
  allowHostPorts: null,
};

// ─── findPolicyManifestForSource ─────────────────────────────────────────────

describe('findPolicyManifestForSource', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-manifest-test-'));
    delete process.env.AWF_AUDIT_DIR;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env.AWF_AUDIT_DIR;
  });

  it('returns null for a running source', () => {
    const source: LogSource = { type: 'running', containerName: 'awf-agent' };
    expect(findPolicyManifestForSource(source)).toBeNull();
  });

  it('returns null when source.path is undefined', () => {
    const source: LogSource = { type: 'preserved', path: undefined };
    expect(findPolicyManifestForSource(source)).toBeNull();
  });

  it('returns null when no manifest file is found at any candidate path', () => {
    const source: LogSource = { type: 'preserved', path: tempDir };
    expect(findPolicyManifestForSource(source)).toBeNull();
  });

  it('reads and parses the manifest when it exists at source.path/policy-manifest.json', () => {
    fs.writeFileSync(
      path.join(tempDir, 'policy-manifest.json'),
      JSON.stringify(MINIMAL_MANIFEST)
    );

    const source: LogSource = { type: 'preserved', path: tempDir };
    const result = findPolicyManifestForSource(source);

    expect(result).toEqual(MINIMAL_MANIFEST);
  });

  it('finds a manifest via AWF_AUDIT_DIR when it is not co-located with the source', () => {
    const auditEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-audit-env-'));
    process.env.AWF_AUDIT_DIR = auditEnvDir;

    try {
      fs.writeFileSync(
        path.join(auditEnvDir, 'policy-manifest.json'),
        JSON.stringify(MINIMAL_MANIFEST)
      );

      // Source dir has no manifest so the standard candidates are exhausted first
      const source: LogSource = { type: 'preserved', path: tempDir };
      const result = findPolicyManifestForSource(source);

      expect(result).toEqual(MINIMAL_MANIFEST);
    } finally {
      fs.rmSync(auditEnvDir, { recursive: true, force: true });
    }
  });
});

// ─── runLogsCommand — enrichment path ────────────────────────────────────────

describe('runLogsCommand - policy manifest enrichment', () => {
  let tempDir: string;
  let mockExit: jest.SpyInstance;
  let mockConsoleLog: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-manifest-test-'));
    delete process.env.AWF_AUDIT_DIR;
    mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockConsoleLog = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env.AWF_AUDIT_DIR;
    mockExit.mockRestore();
    mockConsoleLog.mockRestore();
  });

  it('calls loadAllLogs, enrichWithPolicyRules, and computeRuleStats when a manifest is found', async () => {
    // Place a manifest at source.path/policy-manifest.json so findPolicyManifestForSource
    // returns a non-null value and the enrichment branch is exercised.
    fs.writeFileSync(
      path.join(tempDir, 'policy-manifest.json'),
      JSON.stringify(MINIMAL_MANIFEST)
    );

    const source: LogSource = { type: 'preserved', path: tempDir };

    const emptyStats = {
      totalRequests: 0,
      allowedRequests: 0,
      deniedRequests: 0,
      uniqueDomains: 0,
      byDomain: new Map(),
      timeRange: null,
    };

    const fakeEntries = [{ domain: 'example.com', action: 'ALLOWED', timestamp: 0 }];
    const fakeRuleStats = [
      { ruleId: 'allow-r1', description: 'allow rule', action: 'allow' as const, hits: 1 },
    ];

    (logDiscovery.discoverLogSources as jest.Mock).mockResolvedValue([source]);
    (logDiscovery.selectMostRecent as jest.Mock).mockReturnValue(source);
    (logAggregator.loadAndAggregate as jest.Mock).mockResolvedValue({
      ...emptyStats,
      byDomain: new Map(),
    });
    (logAggregator.loadAllLogs as jest.Mock).mockResolvedValue(fakeEntries);
    (auditEnricher.enrichWithPolicyRules as jest.Mock).mockReturnValue(fakeEntries);
    (auditEnricher.computeRuleStats as jest.Mock).mockReturnValue(fakeRuleStats);
    (statsFormatter.formatStats as jest.Mock).mockReturnValue('formatted output');

    await runLogsCommand({ format: 'json' }, () => false);

    expect(logAggregator.loadAllLogs).toHaveBeenCalledWith(source);
    expect(auditEnricher.enrichWithPolicyRules).toHaveBeenCalledWith(
      fakeEntries,
      MINIMAL_MANIFEST
    );
    expect(auditEnricher.computeRuleStats).toHaveBeenCalledWith(fakeEntries, MINIMAL_MANIFEST);
  });
});
