import { cleanup } from './container-cleanup';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { mockExecaSync } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

describe('docker-manager cleanup', () => {
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

});
