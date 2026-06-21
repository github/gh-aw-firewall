import { preserveIptablesAudit } from './artifact-preservation';
import { collectDiagnosticLogs } from './diagnostic-collector';
import * as fs from 'fs';
import * as path from 'path';

import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

describe('docker-manager diagnostics', () => {
  describe('collectDiagnosticLogs', () => {
    const { getDir } = useTempDir('awf-');

    it('should create diagnostics directory and write container logs', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ stdout: 'squid log output', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '0 ', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '[{"Type":"bind"}]', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: 'agent log output', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '1 container crashed', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '[{"Type":"volume"}]', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
        .mockResolvedValueOnce({ stdout: 'null', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '0 ', stderr: '', exitCode: 0 })
        .mockResolvedValueOnce({ stdout: '[]', stderr: '', exitCode: 0 });

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
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-squid.log'))).toBe(true);
      expect(fs.readFileSync(path.join(diagnosticsDir, 'awf-squid.log'), 'utf8')).toContain('squid log output');
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-agent.log'))).toBe(true);
      expect(fs.readFileSync(path.join(diagnosticsDir, 'awf-agent.log'), 'utf8')).toContain('agent log output');
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-squid.state'))).toBe(true);
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-agent.state'))).toBe(true);
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-squid.mounts.json'))).toBe(true);
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-agent.mounts.json'))).toBe(true);
      expect(fs.existsSync(path.join(diagnosticsDir, 'awf-api-proxy.mounts.json'))).toBe(false);

      const sanitizedCompose = fs.readFileSync(path.join(diagnosticsDir, 'docker-compose.yml'), 'utf8');
      expect(sanitizedCompose).toContain('[REDACTED]');
      expect(sanitizedCompose).not.toContain('ghp_abc123');
      expect(sanitizedCompose).not.toContain('mykey');
      expect(sanitizedCompose).toContain('secretvalue');
      expect(sanitizedCompose).toContain('NORMAL_VAR: normalvalue');
    });

    it('should not write log file when docker logs returns empty output', async () => {
      mockExecaFn.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      await collectDiagnosticLogs(getDir());

      const diagnosticsDir = path.join(getDir(), 'diagnostics');
      const files = fs.existsSync(diagnosticsDir) ? fs.readdirSync(diagnosticsDir) : [];
      const logFiles = files.filter(f => f.endsWith('.log'));
      expect(logFiles).toHaveLength(0);
    });

    it('should skip docker-compose.yml sanitization when file does not exist', async () => {
      mockExecaFn.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      await expect(collectDiagnosticLogs(getDir())).resolves.not.toThrow();

      const diagnosticsDir = path.join(getDir(), 'diagnostics');
      expect(fs.existsSync(path.join(diagnosticsDir, 'docker-compose.yml'))).toBe(false);
    });

    it('should handle docker command failures gracefully', async () => {
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
      expect(sanitized).not.toContain('ghp_lowercase');
      expect(sanitized).not.toContain('mixedcase_value');
      expect(sanitized).not.toContain('uppercase_secret');
      expect(sanitized).toContain('not_sensitive: keepme');
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
