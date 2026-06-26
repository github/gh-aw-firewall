/**
 * Targeted branch-coverage tests for container-cleanup.ts.
 *
 * These tests cover paths that were not exercised by the existing
 * docker-manager-cleanup.test.ts suite, focusing on:
 *  - sanitizeDockerComposeYaml edge cases
 *  - cleanup() branches for cli-proxy logs, audit dir, session state, and SSL
 */

import { cleanup } from './container-cleanup';
import { collectDiagnosticLogs } from './diagnostic-collector';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { useCleanupTestDir } from './test-helpers/docker-test-fixtures.test-utils';

// Mock execa
import { mockExecaFn, mockExecaSync } from './test-helpers/mock-execa.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

// Mock ssl-bump so cleanup() doesn't attempt real mount operations
jest.mock('./ssl-bump', () => ({
  cleanupSslKeyMaterial: jest.fn(),
  unmountSslTmpfs: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./host-env', () => {
  const actual = jest.requireActual('./host-env');
  return {
    ...actual,
    getSafeHostUid: () => String(process.getuid?.() ?? 1000),
    getSafeHostGid: () => String(process.getgid?.() ?? 1000),
  };
});

// ─── sanitizeDockerComposeYaml edge cases (via collectDiagnosticLogs) ────────

describe('sanitizeDockerComposeYaml edge cases', () => {
  const { getDir } = useCleanupTestDir(() => {
    jest.clearAllMocks();
    mockExecaFn.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('returns raw string when YAML parses to a non-object (null)', async () => {
    // "null" is valid YAML that parses to null — the sanitizer should return the raw content
    fs.writeFileSync(path.join(getDir(), 'docker-compose.yml'), 'null');
    await collectDiagnosticLogs(getDir());
    const diagnosticsDir = path.join(getDir(), 'diagnostics');
    const sanitized = fs.readFileSync(path.join(diagnosticsDir, 'docker-compose.yml'), 'utf8');
    expect(sanitized).toBe('null');
  });

  it('sanitizes when compose has no services key', async () => {
    // Parsed object but without a "services" key — should dump the yaml without error
    fs.writeFileSync(path.join(getDir(), 'docker-compose.yml'), 'version: "3"\n');
    await collectDiagnosticLogs(getDir());
    const diagnosticsDir = path.join(getDir(), 'diagnostics');
    const sanitized = fs.readFileSync(path.join(diagnosticsDir, 'docker-compose.yml'), 'utf8');
    expect(yaml.load(sanitized)).toEqual({ version: '3' });
  });

  it('sanitizes when services is an array instead of an object', async () => {
    // services is an array — should be treated as "no services to sanitize"
    fs.writeFileSync(
      path.join(getDir(), 'docker-compose.yml'),
      ['version: "3"', 'services:', '  - name: agent'].join('\n')
    );
    await collectDiagnosticLogs(getDir());
    const diagnosticsDir = path.join(getDir(), 'diagnostics');
    const sanitized = fs.readFileSync(path.join(diagnosticsDir, 'docker-compose.yml'), 'utf8');
    expect(yaml.load(sanitized)).toEqual({ version: '3', services: [{ name: 'agent' }] });
  });

  it('skips service entries that are not plain objects', async () => {
    // A service entry whose value is a primitive (null/string) — should not throw
    const raw = ['services:', '  broken_service: null', '  valid_service:', '    image: nginx'].join('\n');
    fs.writeFileSync(path.join(getDir(), 'docker-compose.yml'), raw);
    await collectDiagnosticLogs(getDir());
    const diagnosticsDir = path.join(getDir(), 'diagnostics');
    const sanitized = fs.readFileSync(path.join(diagnosticsDir, 'docker-compose.yml'), 'utf8');
    expect(yaml.load(sanitized)).toEqual({
      services: {
        broken_service: null,
        valid_service: {
          image: 'nginx',
        },
      },
    });
  });

  it('preserves all env vars when service has no environment key', async () => {
    // Service without an "environment" field — no redaction needed
    const raw = ['services:', '  agent:', '    image: ubuntu:22.04'].join('\n');
    fs.writeFileSync(path.join(getDir(), 'docker-compose.yml'), raw);
    await collectDiagnosticLogs(getDir());
    const sanitized = fs.readFileSync(
      path.join(getDir(), 'diagnostics', 'docker-compose.yml'),
      'utf8'
    );
    expect(sanitized).not.toContain('[REDACTED]');
    expect(yaml.load(sanitized)).toEqual({
      services: {
        agent: {
          image: 'ubuntu:22.04',
        },
      },
    });
  });

  it('redacts secrets in array-form environment entries', async () => {
    // Array-style environment (list of KEY=VALUE strings)
    const raw = [
      'services:',
      '  agent:',
      '    environment:',
      '      - GITHUB_TOKEN=ghp_array',
      '      - NORMAL_VAR=keep_me',
      '      - NO_EQUALS_HERE',
    ].join('\n');
    fs.writeFileSync(path.join(getDir(), 'docker-compose.yml'), raw);
    await collectDiagnosticLogs(getDir());
    const sanitized = fs.readFileSync(
      path.join(getDir(), 'diagnostics', 'docker-compose.yml'),
      'utf8'
    );
    expect(sanitized).not.toContain('ghp_array');
    expect(sanitized).toContain('keep_me');
    // Entry without "=" should be preserved unchanged
    expect(sanitized).toContain('NO_EQUALS_HERE');
  });

  it('redacts full value when array entry contains embedded equals', async () => {
    const raw = [
      'services:',
      '  agent:',
      '    environment:',
      '      - API_KEY=a=b=c',
      '      - NORMAL_VAR=keep_me',
    ].join('\n');
    fs.writeFileSync(path.join(getDir(), 'docker-compose.yml'), raw);
    await collectDiagnosticLogs(getDir());
    const sanitized = fs.readFileSync(
      path.join(getDir(), 'diagnostics', 'docker-compose.yml'),
      'utf8'
    );
    expect(sanitized).not.toContain('a=b=c');
    expect(sanitized).toContain('API_KEY=[REDACTED]');
    expect(sanitized).toContain('NORMAL_VAR=keep_me');
  });
});

// ─── cleanup() missing branch coverage ───────────────────────────────────────

describe('cleanup - cli-proxy logs', () => {
  const { getDir } = useCleanupTestDir(() => {
    jest.clearAllMocks();
    mockExecaSync.mockReturnValue(undefined);
  });

  it('chmods cli-proxy-logs inside proxyLogsDir when it exists', async () => {
    const proxyLogsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-proxy-'));
    try {
      const cliProxyLogsDir = path.join(proxyLogsDir, 'cli-proxy-logs');
      fs.mkdirSync(cliProxyLogsDir, { recursive: true });
      fs.writeFileSync(path.join(cliProxyLogsDir, 'difc-proxy.log'), 'audit entry\n');

      await cleanup(getDir(), false, proxyLogsDir);

      expect(mockExecaSync).toHaveBeenCalledWith('chmod', ['-R', 'a+rX', cliProxyLogsDir]);
    } finally {
      if (fs.existsSync(proxyLogsDir)) {
        fs.rmSync(proxyLogsDir, { recursive: true, force: true });
      }
    }
  });

  it('moves non-empty cli-proxy-logs to /tmp when proxyLogsDir is not specified', async () => {
    const cliProxyLogsDir = path.join(getDir(), 'cli-proxy-logs');
    fs.mkdirSync(cliProxyLogsDir, { recursive: true });
    fs.writeFileSync(path.join(cliProxyLogsDir, 'difc-proxy.log'), 'audit entry\n');

    await cleanup(getDir(), false);

    const timestamp = path.basename(getDir()).replace('awf-', '');
    const destination = path.join(os.tmpdir(), `cli-proxy-logs-${timestamp}`);
    expect(fs.existsSync(destination)).toBe(true);
    const movedLogPath = path.join(destination, 'difc-proxy.log');
    expect(fs.existsSync(movedLogPath)).toBe(true);
    expect(fs.readFileSync(movedLogPath, 'utf8')).toBe('audit entry\n');
    // testDir is deleted by cleanup; clean up the destination
    if (fs.existsSync(destination)) {
      fs.rmSync(destination, { recursive: true, force: true });
    }
  });

  it('does not move empty cli-proxy-logs directory', async () => {
    const cliProxyLogsDir = path.join(getDir(), 'cli-proxy-logs');
    fs.mkdirSync(cliProxyLogsDir, { recursive: true });
    // leave it empty

    await cleanup(getDir(), false);

    const timestamp = path.basename(getDir()).replace('awf-', '');
    const destination = path.join(os.tmpdir(), `cli-proxy-logs-${timestamp}`);
    expect(fs.existsSync(destination)).toBe(false);
  });
});

describe('cleanup - api-proxy logs via proxyLogsDir', () => {
  const { getDir } = useCleanupTestDir(() => {
    jest.clearAllMocks();
    mockExecaSync.mockReturnValue(undefined);
  });

  it('chmods api-proxy-logs inside proxyLogsDir when it exists and is non-empty', async () => {
    const proxyLogsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-proxy-'));
    try {
      const apiProxyLogsDir = path.join(proxyLogsDir, 'api-proxy-logs');
      fs.mkdirSync(apiProxyLogsDir, { recursive: true });
      fs.writeFileSync(path.join(apiProxyLogsDir, 'proxy.log'), 'request\n');

      await cleanup(getDir(), false, proxyLogsDir);

      expect(mockExecaSync).toHaveBeenCalledWith('chmod', ['-R', 'a+rX', apiProxyLogsDir]);
    } finally {
      if (fs.existsSync(proxyLogsDir)) {
        fs.rmSync(proxyLogsDir, { recursive: true, force: true });
      }
    }
  });
});

describe('cleanup - audit dir', () => {
  const { getDir } = useCleanupTestDir(() => {
    jest.clearAllMocks();
    mockExecaSync.mockReturnValue(undefined);
  });

  it('skips chmod when auditDir is specified but does not exist', async () => {
    const nonExistentAuditDir = path.join(os.tmpdir(), `awf-nonexistent-audit-${Date.now()}`);

    await cleanup(getDir(), false, undefined, nonExistentAuditDir);

    expect(mockExecaSync).not.toHaveBeenCalledWith('chmod', ['-R', 'a+rX', nonExistentAuditDir]);
  });

  it('does not move empty default audit directory', async () => {
    const defaultAuditDir = path.join(getDir(), 'audit');
    fs.mkdirSync(defaultAuditDir, { recursive: true });
    // leave it empty

    await cleanup(getDir(), false);

    const timestamp = path.basename(getDir()).replace('awf-', '');
    const destination = path.join(os.tmpdir(), `awf-audit-${timestamp}`);
    expect(fs.existsSync(destination)).toBe(false);
  });
});

describe('cleanup - sessionStateDir', () => {
  const { getDir } = useCleanupTestDir(() => {
    jest.clearAllMocks();
    mockExecaSync.mockReturnValue(undefined);
  });

  it('skips chmod when sessionStateDir is specified but does not exist', async () => {
    const nonExistentStateDir = path.join(os.tmpdir(), `awf-nonexistent-state-${Date.now()}`);

    await cleanup(getDir(), false, undefined, undefined, nonExistentStateDir);

    expect(mockExecaSync).not.toHaveBeenCalledWith('chmod', ['-R', 'a+rX', nonExistentStateDir]);
  });

  it('chmods sessionStateDir in-place when it exists', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-state-'));
    try {
      fs.writeFileSync(path.join(stateDir, 'events.jsonl'), '{"type":"start"}\n');

      await cleanup(getDir(), false, undefined, undefined, stateDir);

      expect(mockExecaSync).toHaveBeenCalledWith('chmod', ['-R', 'a+rX', stateDir]);
    } finally {
      if (fs.existsSync(stateDir)) {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    }
  });
});

describe('cleanup - SSL directory', () => {
  const { getDir } = useCleanupTestDir(() => {
    jest.clearAllMocks();
    mockExecaSync.mockReturnValue(undefined);
  });

  it('calls unmountSslTmpfs when ssl directory exists in workDir', async () => {
    const { cleanupSslKeyMaterial, unmountSslTmpfs } = jest.requireMock('./ssl-bump') as {
      cleanupSslKeyMaterial: jest.Mock;
      unmountSslTmpfs: jest.Mock;
    };
    unmountSslTmpfs.mockResolvedValue(undefined);

    const sslDir = path.join(getDir(), 'ssl');
    fs.mkdirSync(sslDir, { recursive: true });
    fs.writeFileSync(path.join(sslDir, 'ca.pem'), 'fake-cert');

    await cleanup(getDir(), false);

    expect(cleanupSslKeyMaterial).toHaveBeenCalledWith(getDir());
    expect(unmountSslTmpfs).toHaveBeenCalledWith(sslDir);
  });

  it('does not call unmountSslTmpfs when ssl directory does not exist', async () => {
    const { unmountSslTmpfs } = jest.requireMock('./ssl-bump') as {
      unmountSslTmpfs: jest.Mock;
    };

    await cleanup(getDir(), false);

    expect(unmountSslTmpfs).not.toHaveBeenCalled();
  });
});
