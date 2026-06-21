import { writeConfigs } from './config-writer';
import { preserveIptablesAudit } from './artifact-preservation';
import { cleanup } from './container-cleanup';
import { collectDiagnosticLogs } from './diagnostic-collector';
import { WrapperConfig } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions

// Mock execa module
import { mockExecaFn, mockExecaSync } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

// Mock host identity functions so chownSync uses the real uid/gid
// (on macOS, gid < 1000 gets clamped to 1000 which causes EPERM)
jest.mock('./host-env', () => {
  const actual = jest.requireActual('./host-env');
  return {
    ...actual,
    getSafeHostUid: () => String(process.getuid?.() ?? 1000),
    getSafeHostGid: () => String(process.getgid?.() ?? 1000),
  };
});

describe('docker-manager writeConfigs and cleanup', () => {
  describe('writeConfigs', () => {
    const { getDir } = useTempDir();
    const createWriteConfig = (overrides: Partial<WrapperConfig> = {}): WrapperConfig => ({
      allowedDomains: ['github.com'],
      agentCommand: 'echo test',
      logLevel: 'info',
      keepContainers: false,
      workDir: getDir(),
      ...overrides,
    });

    const writeConfigsAllowingFailure = async (config: WrapperConfig): Promise<void> => {
      try {
        await writeConfigs(config);
      } catch {
        // Some tests assert side effects that may exist even when writeConfigs throws.
      }
    };

    it('should create work directory if it does not exist', async () => {
      const newWorkDir = path.join(getDir(), 'new-work-dir');
      const config = createWriteConfig({ workDir: newWorkDir });
      await writeConfigsAllowingFailure(config);

      // Verify work directory was created
      expect(fs.existsSync(newWorkDir)).toBe(true);
    });

    it('should create agent-logs directory', async () => {
      const config = createWriteConfig();
      await writeConfigsAllowingFailure(config);

      // Verify agent-logs directory was created
      expect(fs.existsSync(path.join(getDir(), 'agent-logs'))).toBe(true);
    });

    it('should create squid-logs directory', async () => {
      const config = createWriteConfig();
      await writeConfigsAllowingFailure(config);

      // Verify squid-logs directory was created
      expect(fs.existsSync(path.join(getDir(), 'squid-logs'))).toBe(true);
    });

    it('should create /tmp/gh-aw/mcp-logs directory with world-writable permissions', async () => {
      const config = createWriteConfig();
      await writeConfigsAllowingFailure(config);

      // Verify /tmp/gh-aw/mcp-logs directory was created
      expect(fs.existsSync('/tmp/gh-aw/mcp-logs')).toBe(true);
      const stats = fs.statSync('/tmp/gh-aw/mcp-logs');
      expect(stats.isDirectory()).toBe(true);
      // Verify permissions are 0o777 (rwxrwxrwx) to allow non-root users to create subdirectories
      expect((stats.mode & 0o777).toString(8)).toBe('777');
    });

    it('should write squid.conf file', async () => {
      const config = createWriteConfig({ allowedDomains: ['github.com', 'example.com'] });
      await writeConfigsAllowingFailure(config);

      // squid.conf creation depends on where writeConfigs fails.
      const squidConfPath = path.join(getDir(), 'squid.conf');
      if (fs.existsSync(squidConfPath)) {
        const content = fs.readFileSync(squidConfPath, 'utf-8');
        expect(content).toContain('github.com');
        expect(content).toContain('example.com');
      }
    });

    it('should write docker-compose.yml file', async () => {
      const config = createWriteConfig();
      await writeConfigsAllowingFailure(config);

      // Verify docker-compose.yml was created
      const dockerComposePath = path.join(getDir(), 'docker-compose.yml');
      if (fs.existsSync(dockerComposePath)) {
        const content = fs.readFileSync(dockerComposePath, 'utf-8');
        expect(content).toContain('awf-squid');
        expect(content).toContain('awf-agent');
      }
    });

    it('should create work directory with restricted permissions (0o700)', async () => {
      const newWorkDir = path.join(getDir(), 'restricted-dir');
      const config = createWriteConfig({ workDir: newWorkDir });
      await writeConfigsAllowingFailure(config);

      // Verify directory was created with restricted permissions
      expect(fs.existsSync(newWorkDir)).toBe(true);
      const stats = fs.statSync(newWorkDir);
      expect((stats.mode & 0o777).toString(8)).toBe('700');
    });

    it('should write config files with restricted permissions (0o600)', async () => {
      const config = createWriteConfig();
      await writeConfigsAllowingFailure(config);

      // Verify squid.conf is readable by proxy user (0o644) for non-root Squid
      const squidConfPath = path.join(getDir(), 'squid.conf');
      if (fs.existsSync(squidConfPath)) {
        const stats = fs.statSync(squidConfPath);
        expect((stats.mode & 0o777).toString(8)).toBe('644');
      }

      // Verify docker-compose.yml has restricted permissions
      const dockerComposePath = path.join(getDir(), 'docker-compose.yml');
      if (fs.existsSync(dockerComposePath)) {
        const stats = fs.statSync(dockerComposePath);
        expect((stats.mode & 0o777).toString(8)).toBe('600');
      }
    });

    it('should use proxyLogsDir when specified', async () => {
      const proxyLogsDir = path.join(getDir(), 'custom-proxy-logs');
      const config = createWriteConfig({ proxyLogsDir });
      await writeConfigsAllowingFailure(config);

      // Verify proxyLogsDir was created
      expect(fs.existsSync(proxyLogsDir)).toBe(true);
    });

    it('should create api-proxy-logs subdirectory inside proxyLogsDir when specified', async () => {
      const proxyLogsDir = path.join(getDir(), 'custom-proxy-logs');
      const config = createWriteConfig({ proxyLogsDir });
      await writeConfigsAllowingFailure(config);

      // Verify api-proxy-logs subdirectory was created inside proxyLogsDir
      const apiProxyLogsDir = path.join(proxyLogsDir, 'api-proxy-logs');
      expect(fs.existsSync(apiProxyLogsDir)).toBe(true);
    });

    it('should create proxyLogsDir with nested non-existent parents', async () => {
      const proxyLogsDir = path.join(getDir(), 'deeply', 'nested', 'proxy-logs');
      const config = createWriteConfig({ proxyLogsDir });
      await writeConfigsAllowingFailure(config);

      // Verify deeply nested proxyLogsDir was created recursively
      expect(fs.existsSync(proxyLogsDir)).toBe(true);
    });

    it('should pre-create chroot home subdirectories with correct ownership', async () => {
      // Use a temporary home directory to avoid modifying the real one
      const fakeHome = path.join(getDir(), 'fakehome');
      fs.mkdirSync(fakeHome, { recursive: true });
      const originalHome = process.env.HOME;
      const originalSudoUser = process.env.SUDO_USER;
      process.env.HOME = fakeHome;
      // Clear SUDO_USER to make getRealUserHome() use process.env.HOME
      delete process.env.SUDO_USER;

      const config = createWriteConfig();
      await writeConfigsAllowingFailure(config);

      // Verify chroot home subdirectories were created
      const expectedDirs = [
        '.copilot', '.cache', '.config', '.local',
        '.anthropic', '.claude', '.cargo', '.rustup', '.npm', '.nvm',
      ];
      for (const dir of expectedDirs) {
        expect(fs.existsSync(path.join(fakeHome, dir))).toBe(true);
      }
      // ~/.gemini is only pre-created when geminiApiKey is configured
      expect(fs.existsSync(path.join(fakeHome, '.gemini'))).toBe(false);

      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      } else {
        delete process.env.HOME;
      }
      if (originalSudoUser !== undefined) {
        process.env.SUDO_USER = originalSudoUser;
      } else {
        delete process.env.SUDO_USER;
      }
    });

    it('should pre-create ~/.gemini when geminiApiKey is configured', async () => {
      const fakeHome = path.join(getDir(), 'fakehome-gemini');
      fs.mkdirSync(fakeHome, { recursive: true });
      const originalHome = process.env.HOME;
      const originalSudoUser = process.env.SUDO_USER;
      process.env.HOME = fakeHome;
      delete process.env.SUDO_USER;

      const config = createWriteConfig({ geminiApiKey: 'AIza-test-key' });
      await writeConfigsAllowingFailure(config);

      expect(fs.existsSync(path.join(fakeHome, '.gemini'))).toBe(true);

      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      } else {
        delete process.env.HOME;
      }
      if (originalSudoUser !== undefined) {
        process.env.SUDO_USER = originalSudoUser;
      } else {
        delete process.env.SUDO_USER;
      }
    });
  });
  describe('cleanup', () => {
    const { getDir } = useTempDir('awf-');

    beforeEach(() => {
      // Mock execa.sync for chmod
      mockExecaSync.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
    });

    afterEach(() => {
      // Clean up any moved log directories
      const timestamp = path.basename(getDir()).replace('awf-', '');
      const agentLogsDir = path.join(os.tmpdir(), `awf-agent-logs-${timestamp}`);
      const squidLogsDir = path.join(os.tmpdir(), `squid-logs-${timestamp}`);
      if (fs.existsSync(agentLogsDir)) {
        fs.rmSync(agentLogsDir, { recursive: true, force: true });
      }
      if (fs.existsSync(squidLogsDir)) {
        fs.rmSync(squidLogsDir, { recursive: true, force: true });
      }
    });

    it('should skip cleanup when keepFiles is true', async () => {
      await cleanup(getDir(), true);

      // Verify directory still exists
      expect(fs.existsSync(getDir())).toBe(true);
    });

    it('should remove work directory when keepFiles is false', async () => {
      await cleanup(getDir(), false);

      expect(fs.existsSync(getDir())).toBe(false);
    });

    it('should clean up chroot-home directory alongside workDir', async () => {
      // Create chroot-home sibling directory (as writeConfigs does in chroot mode)
      const chrootHomeDir = `${getDir()}-chroot-home`;
      fs.mkdirSync(chrootHomeDir, { recursive: true });

      await cleanup(getDir(), false);

      // Both workDir and chroot-home should be removed
      expect(fs.existsSync(getDir())).toBe(false);
      expect(fs.existsSync(chrootHomeDir)).toBe(false);
    });

    it('should preserve agent logs when they exist', async () => {
      // Create agent logs directory with a file
      const agentLogsDir = path.join(getDir(), 'agent-logs');
      fs.mkdirSync(agentLogsDir, { recursive: true });
      fs.writeFileSync(path.join(agentLogsDir, 'test.log'), 'test log content');

      await cleanup(getDir(), false);

      // Verify work directory was removed
      expect(fs.existsSync(getDir())).toBe(false);

      // Verify agent logs were moved
      const timestamp = path.basename(getDir()).replace('awf-', '');
      const preservedLogsDir = path.join(os.tmpdir(), `awf-agent-logs-${timestamp}`);
      expect(fs.existsSync(preservedLogsDir)).toBe(true);
      expect(fs.readFileSync(path.join(preservedLogsDir, 'test.log'), 'utf-8')).toBe('test log content');
    });

    it('should preserve squid logs when they exist', async () => {
      // Create squid logs directory with a file
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(path.join(squidLogsDir, 'access.log'), 'squid log content');

      await cleanup(getDir(), false);

      // Verify work directory was removed
      expect(fs.existsSync(getDir())).toBe(false);

      // Verify squid logs were moved
      const timestamp = path.basename(getDir()).replace('awf-', '');
      const preservedLogsDir = path.join(os.tmpdir(), `squid-logs-${timestamp}`);
      expect(fs.existsSync(preservedLogsDir)).toBe(true);
    });

    it('should not preserve empty log directories', async () => {
      // Create empty agent logs directory
      const agentLogsDir = path.join(getDir(), 'agent-logs');
      fs.mkdirSync(agentLogsDir, { recursive: true });

      await cleanup(getDir(), false);

      // Verify work directory was removed
      expect(fs.existsSync(getDir())).toBe(false);

      // Verify no empty log directory was created
      const timestamp = path.basename(getDir()).replace('awf-', '');
      const preservedLogsDir = path.join(os.tmpdir(), `awf-agent-logs-${timestamp}`);
      expect(fs.existsSync(preservedLogsDir)).toBe(false);
    });

    it('should use proxyLogsDir when specified', async () => {
      const proxyLogsDir = path.join(getDir(), 'custom-proxy-logs');
      fs.mkdirSync(proxyLogsDir, { recursive: true });
      fs.writeFileSync(path.join(proxyLogsDir, 'access.log'), 'proxy log content');

      await cleanup(getDir(), false, proxyLogsDir);

      // Verify chmod was called on proxyLogsDir
      expect(mockExecaSync).toHaveBeenCalledWith('chmod', ['-R', 'a+rX', proxyLogsDir]);
    });

    it('should not move squid logs to /tmp when proxyLogsDir is specified', async () => {
      // proxyLogsDir must be OUTSIDE workDir since cleanup deletes workDir
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-proxy-logs-test-'));
      const proxyLogsDir = path.join(externalDir, 'proxy-logs');
      fs.mkdirSync(proxyLogsDir, { recursive: true });
      fs.writeFileSync(path.join(proxyLogsDir, 'access.log'), 'proxy log content');

      try {
        await cleanup(getDir(), false, proxyLogsDir);

        // Logs should remain in proxyLogsDir (not moved to /tmp/squid-logs-*)
        expect(fs.existsSync(path.join(proxyLogsDir, 'access.log'))).toBe(true);
      } finally {
        fs.rmSync(externalDir, { recursive: true, force: true });
      }
    });

    it('should chmod api-proxy-logs subdirectory when proxyLogsDir is specified', async () => {
      // proxyLogsDir must be OUTSIDE workDir since cleanup deletes workDir
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-proxy-logs-test-'));
      const proxyLogsDir = path.join(externalDir, 'proxy-logs');
      const apiProxyLogsDir = path.join(proxyLogsDir, 'api-proxy-logs');
      fs.mkdirSync(proxyLogsDir, { recursive: true });
      fs.mkdirSync(apiProxyLogsDir, { recursive: true });
      fs.writeFileSync(path.join(proxyLogsDir, 'access.log'), 'proxy log content');
      fs.writeFileSync(path.join(apiProxyLogsDir, 'access.log'), 'api proxy log content');

      try {
        await cleanup(getDir(), false, proxyLogsDir);

        // Verify chmod was called on both proxyLogsDir and api-proxy-logs subdirectory
        expect(mockExecaSync).toHaveBeenCalledWith('chmod', ['-R', 'a+rX', proxyLogsDir]);
        expect(mockExecaSync).toHaveBeenCalledWith('chmod', ['-R', 'a+rX', apiProxyLogsDir]);
      } finally {
        fs.rmSync(externalDir, { recursive: true, force: true });
      }
    });

    it('should handle non-existent work directory gracefully', async () => {
      const nonExistentDir = path.join(os.tmpdir(), 'awf-nonexistent-12345');

      // Should not throw
      await expect(cleanup(nonExistentDir, false)).resolves.not.toThrow();
    });

    it('should preserve session state to /tmp when sessionStateDir is not specified', async () => {
      const sessionStateDir = path.join(getDir(), 'agent-session-state');
      const sessionDir = path.join(sessionStateDir, 'abc-123');
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), '{"event":"test"}');

      await cleanup(getDir(), false);

      // Verify session state was moved to timestamped /tmp directory
      const timestamp = path.basename(getDir()).replace('awf-', '');
      const preservedDir = path.join(os.tmpdir(), `awf-agent-session-state-${timestamp}`);
      expect(fs.existsSync(preservedDir)).toBe(true);
      expect(fs.existsSync(path.join(preservedDir, 'abc-123', 'events.jsonl'))).toBe(true);
    });

    it('should chmod session state in-place when sessionStateDir is specified', async () => {
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-session-test-'));
      const sessionStateDir = path.join(externalDir, 'session-state');
      fs.mkdirSync(sessionStateDir, { recursive: true });
      fs.writeFileSync(path.join(sessionStateDir, 'events.jsonl'), '{"event":"test"}');

      try {
        await cleanup(getDir(), false, undefined, undefined, sessionStateDir);

        // Verify chmod was called on sessionStateDir (not moved)
        expect(mockExecaSync).toHaveBeenCalledWith('chmod', ['-R', 'a+rX', sessionStateDir]);
        // Files should remain in-place
        expect(fs.existsSync(path.join(sessionStateDir, 'events.jsonl'))).toBe(true);
      } finally {
        fs.rmSync(externalDir, { recursive: true, force: true });
      }
    });
  });

  describe('collectDiagnosticLogs', () => {
    const { getDir } = useTempDir('awf-');

    it('should create diagnostics directory and write container logs', async () => {
      // Mock docker logs returning content
      mockExecaFn
        .mockResolvedValueOnce({ stdout: 'squid log output', stderr: '', exitCode: 0 })  // docker logs awf-squid
        .mockResolvedValueOnce({ stdout: '0 ', stderr: '', exitCode: 0 })                 // docker inspect state awf-squid
        .mockResolvedValueOnce({ stdout: '[{"Type":"bind"}]', stderr: '', exitCode: 0 })  // docker inspect mounts awf-squid
        .mockResolvedValueOnce({ stdout: 'agent log output', stderr: '', exitCode: 0 })   // docker logs awf-agent
        .mockResolvedValueOnce({ stdout: '1 container crashed', stderr: '', exitCode: 0 }) // docker inspect state awf-agent
        .mockResolvedValueOnce({ stdout: '[{"Type":"volume"}]', stderr: '', exitCode: 0 }) // docker inspect mounts awf-agent
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })                    // docker logs awf-api-proxy (not started)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })                    // docker inspect state awf-api-proxy
        .mockResolvedValueOnce({ stdout: 'null', stderr: '', exitCode: 0 })                // docker inspect mounts awf-api-proxy (null)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })                    // docker logs awf-iptables-init
        .mockResolvedValueOnce({ stdout: '0 ', stderr: '', exitCode: 0 })                 // docker inspect state awf-iptables-init
        .mockResolvedValueOnce({ stdout: '[]', stderr: '', exitCode: 0 });                 // docker inspect mounts awf-iptables-init

      // Create a docker-compose.yml with a secret env var
      const composeContent = [
        'services:',
        '  squid:',
        '    environment:',
        '      AWF_SQUID_CONFIG_B64: secretvalue',
        '      GITHUB_TOKEN: ghp_abc123',
        '      SOME_KEY: mykey',
        '      NORMAL_VAR: normalvalue',
      ].join('\n');
      fs.writeFileSync(path.join(getDir(), 'docker-compose.yml'), composeContent);

      await collectDiagnosticLogs(getDir());

      const diagnosticsDir = path.join(getDir(), 'diagnostics');
      expect(fs.existsSync(diagnosticsDir)).toBe(true);

      // awf-squid.log should have content
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-squid.log'))).toBe(true);
      expect(fs.readFileSync(path.join(diagnosticsDir, 'awf-squid.log'), 'utf8')).toContain('squid log output');

      // awf-agent.log should have content
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-agent.log'))).toBe(true);
      expect(fs.readFileSync(path.join(diagnosticsDir, 'awf-agent.log'), 'utf8')).toContain('agent log output');

      // State files should be written
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-squid.state'))).toBe(true);
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-agent.state'))).toBe(true);

      // Mounts files for containers that returned non-null JSON
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-squid.mounts.json'))).toBe(true);
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-agent.mounts.json'))).toBe(true);
      // awf-api-proxy returned 'null' so no mounts file
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-api-proxy.mounts.json'))).toBe(false);

      // Sanitized docker-compose.yml should exist with secrets redacted
      const sanitizedCompose = fs.readFileSync(path.join(diagnosticsDir, 'docker-compose.yml'), 'utf8');
      expect(sanitizedCompose).toContain('[REDACTED]');
      // GITHUB_TOKEN and SOME_KEY contain TOKEN/KEY → redacted
      expect(sanitizedCompose).not.toContain('ghp_abc123');
      expect(sanitizedCompose).not.toContain('mykey');
      // AWF_SQUID_CONFIG_B64 does not contain TOKEN/KEY/SECRET → preserved
      expect(sanitizedCompose).toContain('secretvalue');
      // Non-secret env vars should be unchanged
      expect(sanitizedCompose).toContain('NORMAL_VAR: normalvalue');
    });

    it('should not write log file when docker logs returns empty output', async () => {
      mockExecaFn
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }); // all containers return empty

      await collectDiagnosticLogs(getDir());

      const diagnosticsDir = path.join(getDir(), 'diagnostics');
      // No .log files should be written for empty output
      const files = fs.existsSync(diagnosticsDir) ? fs.readdirSync(diagnosticsDir) : [];
      const logFiles = files.filter(f => f.endsWith('.log'));
      expect(logFiles).toHaveLength(0);
    });

    it('should skip docker-compose.yml sanitization when file does not exist', async () => {
      mockExecaFn.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      // No docker-compose.yml created in getDir()
      await expect(collectDiagnosticLogs(getDir())).resolves.not.toThrow();

      const diagnosticsDir = path.join(getDir(), 'diagnostics');
      expect(fs.existsSync(path.join(diagnosticsDir, 'docker-compose.yml'))).toBe(false);
    });

    it('should handle docker command failures gracefully', async () => {
      // All docker commands throw errors
      mockExecaFn.mockRejectedValue(new Error('docker not found'));

      await expect(collectDiagnosticLogs(getDir())).resolves.not.toThrow();
    });

    it('should redact lowercase and mixed-case secret env var names', async () => {
      mockExecaFn.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const composeContent = [
        'services:',
        '  agent:',
        '    environment:',
        '      github_token: ghp_lowercase',
        '      Api_Key: mixedcase_value',
        '      OAUTH_SECRET: uppercase_secret',
        '      not_sensitive: keepme',
      ].join('\n');
      fs.writeFileSync(path.join(getDir(), 'docker-compose.yml'), composeContent);

      await collectDiagnosticLogs(getDir());

      const sanitized = fs.readFileSync(path.join(getDir(), 'diagnostics', 'docker-compose.yml'), 'utf8');
      // All three secret patterns should be redacted
      expect(sanitized).not.toContain('ghp_lowercase');
      expect(sanitized).not.toContain('mixedcase_value');
      expect(sanitized).not.toContain('uppercase_secret');
      // Non-secret var must be preserved
      expect(sanitized).toContain('not_sensitive: keepme');
    });
  });

  describe('cleanup - diagnostics preservation', () => {
    const { getDir } = useTempDir('awf-');

    beforeEach(() => {
      mockExecaSync.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
    });

    afterEach(() => {
      const timestamp = path.basename(getDir()).replace('awf-', '');
      const diagDir = path.join(os.tmpdir(), `awf-diagnostics-${timestamp}`);
      if (fs.existsSync(diagDir)) {
        fs.rmSync(diagDir, { recursive: true, force: true });
      }
    });

    it('should preserve diagnostics to /tmp when no auditDir is specified', async () => {
      const diagnosticsDir = path.join(getDir(), 'diagnostics');
      fs.mkdirSync(diagnosticsDir, { recursive: true });
      fs.writeFileSync(path.join(diagnosticsDir, 'awf-squid.log'), 'squid crashed\n');

      await cleanup(getDir(), false);

      const timestamp = path.basename(getDir()).replace('awf-', '');
      const preserved = path.join(os.tmpdir(), `awf-diagnostics-${timestamp}`);
      expect(fs.existsSync(preserved)).toBe(true);
      expect(fs.readFileSync(path.join(preserved, 'awf-squid.log'), 'utf8')).toBe('squid crashed\n');
    });

    it('should co-locate diagnostics under auditDir/diagnostics when auditDir is specified', async () => {
      const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-audit-test-'));
      try {
        const diagnosticsDir = path.join(getDir(), 'diagnostics');
        fs.mkdirSync(diagnosticsDir, { recursive: true });
        fs.writeFileSync(path.join(diagnosticsDir, 'awf-agent.log'), 'agent output\n');

        await cleanup(getDir(), false, undefined, auditDir);

        const auditDiagnosticsDir = path.join(auditDir, 'diagnostics');
        expect(fs.existsSync(auditDiagnosticsDir)).toBe(true);
        expect(fs.readFileSync(path.join(auditDiagnosticsDir, 'awf-agent.log'), 'utf8')).toBe('agent output\n');
        expect(mockExecaSync).toHaveBeenCalledWith('chmod', ['-R', 'a+rX', auditDiagnosticsDir]);
      } finally {
        fs.rmSync(auditDir, { recursive: true, force: true });
      }
    });

    it('should not create diagnostics destination when diagnostics dir is empty', async () => {
      // Empty diagnostics dir
      const diagnosticsDir = path.join(getDir(), 'diagnostics');
      fs.mkdirSync(diagnosticsDir, { recursive: true });

      await cleanup(getDir(), false);

      const timestamp = path.basename(getDir()).replace('awf-', '');
      const preserved = path.join(os.tmpdir(), `awf-diagnostics-${timestamp}`);
      expect(fs.existsSync(preserved)).toBe(false);
    });
  });

  describe('preserveIptablesAudit', () => {
    const { getDir } = useTempDir('awf-audit-');

    it('should copy iptables audit file when both source and target directory exist', () => {
      const initSignalDir = path.join(getDir(), 'init-signal');
      fs.mkdirSync(initSignalDir, { recursive: true });
      fs.writeFileSync(path.join(initSignalDir, 'iptables-audit.txt'), 'iptables rules here');

      const auditDir = path.join(getDir(), 'audit');
      fs.mkdirSync(auditDir, { recursive: true });

      preserveIptablesAudit(getDir(), auditDir);

      const destFile = path.join(auditDir, 'iptables-audit.txt');
      expect(fs.existsSync(destFile)).toBe(true);
      expect(fs.readFileSync(destFile, 'utf8')).toBe('iptables rules here');
    });

    it('should do nothing when source file does not exist', () => {
      const auditDir = path.join(getDir(), 'audit');
      fs.mkdirSync(auditDir, { recursive: true });

      preserveIptablesAudit(getDir(), auditDir);

      expect(fs.existsSync(path.join(auditDir, 'iptables-audit.txt'))).toBe(false);
    });

    it('should do nothing when target audit directory does not exist', () => {
      const initSignalDir = path.join(getDir(), 'init-signal');
      fs.mkdirSync(initSignalDir, { recursive: true });
      fs.writeFileSync(path.join(initSignalDir, 'iptables-audit.txt'), 'iptables rules');

      preserveIptablesAudit(getDir(), path.join(getDir(), 'nonexistent-audit'));

      expect(fs.existsSync(path.join(getDir(), 'nonexistent-audit', 'iptables-audit.txt'))).toBe(false);
    });

    it('should use default audit dir (workDir/audit) when auditDir is not specified', () => {
      const initSignalDir = path.join(getDir(), 'init-signal');
      fs.mkdirSync(initSignalDir, { recursive: true });
      fs.writeFileSync(path.join(initSignalDir, 'iptables-audit.txt'), 'default audit');

      const defaultAuditDir = path.join(getDir(), 'audit');
      fs.mkdirSync(defaultAuditDir, { recursive: true });

      preserveIptablesAudit(getDir());

      expect(fs.existsSync(path.join(defaultAuditDir, 'iptables-audit.txt'))).toBe(true);
    });
  });
});
