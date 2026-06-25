/**
 * Error-path and uncovered-branch coverage for artifact-preservation.ts.
 *
 * Targets the following uncovered lines identified in the coverage report:
 *   21  – catch block in preserveIptablesAudit (fs.copyFileSync throws)
 *   62  – catch block in preserveDirectory when runtimeDir chmod fails
 *   78  – catch block in preserveDirectory when no-runtimeDir renameSync fails
 *  101  – catch block for agent-logs renameSync in preserveCleanupArtifacts
 *  163  – catch block for auditDir chmod in preserveCleanupArtifacts
 *  170–175 – default audit-dir preservation branch (no auditDir, workDir/audit exists)
 *  192  – catch block when diagnostics→auditDir move fails
 *  204  – catch block when diagnostics→/tmp move fails
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

// Wrap the fs methods we need to control with jest.fn() so individual tests
// can inject one-shot errors without using jest.spyOn (which fails on non-
// configurable properties in Jest's module sandbox).
jest.mock('fs', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...real,
    copyFileSync: jest.fn(real.copyFileSync),
    renameSync: jest.fn(real.renameSync),
    mkdirSync: jest.fn(real.mkdirSync),
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mockExecaSync } from './test-helpers/mock-execa.test-utils';
import {
  preserveIptablesAudit,
  preserveCleanupArtifacts,
} from './artifact-preservation';

// Cast mocked methods for convenient mockImplementationOnce usage.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realFs = jest.requireActual<typeof import('fs')>('fs');
const mockCopyFileSync = fs.copyFileSync as jest.MockedFunction<typeof fs.copyFileSync>;
const mockRenameSync = fs.renameSync as jest.MockedFunction<typeof fs.renameSync>;
const mockMkdirSync = fs.mkdirSync as jest.MockedFunction<typeof fs.mkdirSync>;

function makeTempDir(prefix = 'awf-'): string {
  // Always use the real mkdtempSync for test setup.
  return realFs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('artifact-preservation – error paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecaSync.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
    // Re-apply real implementations in case a test replaced them with mockImplementation/mockImplementationOnce.
    mockCopyFileSync.mockImplementation(realFs.copyFileSync);
    mockRenameSync.mockImplementation(realFs.renameSync);
    mockMkdirSync.mockImplementation(realFs.mkdirSync);
  });

  // ─── preserveIptablesAudit ──────────────────────────────────────────────

  describe('preserveIptablesAudit', () => {
    it('does not throw when fs.copyFileSync errors (line 21)', () => {
      const workDir = makeTempDir('awf-audit-');
      try {
        const initSignalDir = path.join(workDir, 'init-signal');
        realFs.mkdirSync(initSignalDir);
        realFs.writeFileSync(path.join(initSignalDir, 'iptables-audit.txt'), 'rules');

        const auditDir = path.join(workDir, 'audit');
        realFs.mkdirSync(auditDir);

        mockCopyFileSync.mockImplementationOnce(() => {
          throw new Error('ENOSPC: no space left on device');
        });

        expect(() => preserveIptablesAudit(workDir, auditDir)).not.toThrow();
      } finally {
        realFs.rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  // ─── preserveCleanupArtifacts ───────────────────────────────────────────

  describe('preserveCleanupArtifacts', () => {
    let getuidSpy: jest.SpyInstance<number | undefined, []> | undefined;

    afterEach(() => {
      getuidSpy?.mockRestore();
      getuidSpy = undefined;
    });

    it('does not throw when agent-logs renameSync fails (line 101)', () => {
      const workDir = makeTempDir();
      try {
        const agentLogsDir = path.join(workDir, 'agent-logs');
        realFs.mkdirSync(agentLogsDir);
        realFs.writeFileSync(path.join(agentLogsDir, 'out.log'), 'log data');

        // agent-logs rename is the first renameSync call when agent-logs exists.
        mockRenameSync.mockImplementationOnce(() => {
          throw new Error('EXDEV: cross-device link not permitted');
        });

        expect(() => preserveCleanupArtifacts(workDir)).not.toThrow();
      } finally {
        realFs.rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('does not throw when runtimeDir chmod fails (line 62)', () => {
      // proxyLogsDir squid-logs uses runtimeDirMustExist:false → chmod always called.
      // With no api-proxy-logs or cli-proxy-logs subdirs, squid-logs chmod is first.
      const externalDir = makeTempDir();
      const workDir = makeTempDir();
      try {
        const proxyLogsDir = path.join(externalDir, 'proxy-logs');
        realFs.mkdirSync(proxyLogsDir);

        mockExecaSync.mockImplementationOnce(() => {
          throw new Error('chmod: operation not permitted');
        });

        expect(() => preserveCleanupArtifacts(workDir, { proxyLogsDir })).not.toThrow();
      } finally {
        realFs.rmSync(externalDir, { recursive: true, force: true });
        realFs.rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('does not throw when no-runtimeDir renameSync fails (line 78)', () => {
      // Trigger via session-state (no runtimeDir, sourceDir has content).
      // Skip creating agent-logs so session-state gets the first renameSync call.
      const workDir = makeTempDir();
      try {
        const sessionStateDir = path.join(workDir, 'agent-session-state');
        realFs.mkdirSync(sessionStateDir);
        realFs.writeFileSync(path.join(sessionStateDir, 'events.jsonl'), '{"e":1}');

        mockRenameSync.mockImplementationOnce(() => {
          throw new Error('EXDEV: cross-device link not permitted');
        });

        expect(() => preserveCleanupArtifacts(workDir)).not.toThrow();
      } finally {
        realFs.rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('does not throw when auditDir chmod fails (line 163)', () => {
      // Empty workDir + existing auditDir: first execa.sync is the auditDir chmod.
      const auditDir = makeTempDir('awf-audit-');
      const workDir = makeTempDir();
      try {
        mockExecaSync.mockImplementationOnce(() => {
          throw new Error('chmod: permission denied');
        });

        expect(() => preserveCleanupArtifacts(workDir, { auditDir })).not.toThrow();
      } finally {
        realFs.rmSync(auditDir, { recursive: true, force: true });
        realFs.rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('runs rootless permission repair with translated mount paths', () => {
      const auditDir = makeTempDir('awf-audit-');
      const workDir = makeTempDir();
      try {
        getuidSpy = jest.spyOn(process, 'getuid').mockReturnValue(1001);
        expect(() => preserveCleanupArtifacts(workDir, {
          auditDir,
          dockerHostPathPrefix: '/host',
          imageRegistry: 'ghcr.io/github/gh-aw-firewall',
          imageTag: 'latest',
        })).not.toThrow();

        expect(mockExecaSync).toHaveBeenCalledWith(
          'docker',
          expect.arrayContaining([
            'run',
            '--pull',
            'never',
            '-v',
            `/host${path.resolve(auditDir)}:/fix:rw`,
            'ghcr.io/github/gh-aw-firewall/agent:latest',
          ]),
          expect.objectContaining({ reject: false }),
        );
      } finally {
        realFs.rmSync(auditDir, { recursive: true, force: true });
        realFs.rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('uses agent-act image when agentImage is act', () => {
      const auditDir = makeTempDir('awf-audit-');
      const workDir = makeTempDir();
      try {
        getuidSpy = jest.spyOn(process, 'getuid').mockReturnValue(1001);
        expect(() => preserveCleanupArtifacts(workDir, {
          auditDir,
          imageRegistry: 'ghcr.io/github/gh-aw-firewall',
          imageTag: 'latest',
          agentImage: 'act',
        })).not.toThrow();

        expect(mockExecaSync).toHaveBeenCalledWith(
          'docker',
          expect.arrayContaining([
            'ghcr.io/github/gh-aw-firewall/agent-act:latest',
          ]),
          expect.objectContaining({ reject: false }),
        );
      } finally {
        realFs.rmSync(auditDir, { recursive: true, force: true });
        realFs.rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('skips rootless permission repair when running as root', () => {
      const auditDir = makeTempDir('awf-audit-');
      const workDir = makeTempDir();
      try {
        getuidSpy = jest.spyOn(process, 'getuid').mockReturnValue(0);
        expect(() => preserveCleanupArtifacts(workDir, { auditDir })).not.toThrow();
        expect(mockExecaSync.mock.calls.some(call => call[0] === 'docker')).toBe(false);
      } finally {
        realFs.rmSync(auditDir, { recursive: true, force: true });
        realFs.rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('preserves default audit dir to /tmp when no auditDir arg is provided (lines 170-173)', () => {
      const workDir = makeTempDir();
      const timestamp = path.basename(workDir).replace('awf-', '');
      const auditDestination = path.join(os.tmpdir(), `awf-audit-${timestamp}`);
      try {
        const defaultAuditDir = path.join(workDir, 'audit');
        realFs.mkdirSync(defaultAuditDir);
        realFs.writeFileSync(path.join(defaultAuditDir, 'report.txt'), 'audit data');

        expect(() => preserveCleanupArtifacts(workDir)).not.toThrow();

        // rename was successful → chmod called on the moved destination.
        expect(mockExecaSync).toHaveBeenCalledWith(
          'chmod', ['-R', 'a+rX', auditDestination]
        );
      } finally {
        realFs.rmSync(workDir, { recursive: true, force: true });
        if (realFs.existsSync(auditDestination)) {
          realFs.rmSync(auditDestination, { recursive: true, force: true });
        }
      }
    });

    it('does not throw when default audit dir rename fails (line 175)', () => {
      const workDir = makeTempDir();
      try {
        const defaultAuditDir = path.join(workDir, 'audit');
        realFs.mkdirSync(defaultAuditDir);
        realFs.writeFileSync(path.join(defaultAuditDir, 'report.txt'), 'audit data');

        // Make ALL rename calls throw to ensure the audit rename hits the catch block.
        mockRenameSync.mockImplementation(() => {
          throw new Error('EXDEV: cross-device link not permitted');
        });

        expect(() => preserveCleanupArtifacts(workDir)).not.toThrow();
      } finally {
        realFs.rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('does not throw when diagnostics-to-auditDir mkdir fails (line 192)', () => {
      const auditDir = makeTempDir('awf-audit-');
      const workDir = makeTempDir();
      // Create dirs using the real fs BEFORE overriding mkdirSync.
      const diagnosticsDir = path.join(workDir, 'diagnostics');
      realFs.mkdirSync(diagnosticsDir);
      realFs.writeFileSync(path.join(diagnosticsDir, 'awf-agent.log'), 'crash log');

      // The first mkdirSync call inside preserveCleanupArtifacts is for auditDiagnosticsDir.
      mockMkdirSync.mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });

      try {
        expect(() => preserveCleanupArtifacts(workDir, { auditDir })).not.toThrow();
      } finally {
        realFs.rmSync(auditDir, { recursive: true, force: true });
        realFs.rmSync(workDir, { recursive: true, force: true });
      }
    });

    it('does not throw when diagnostics-to-tmp mkdir fails (line 204)', () => {
      const workDir = makeTempDir();
      // Create diagnostics dir using real fs BEFORE overriding mkdirSync.
      const diagnosticsDir = path.join(workDir, 'diagnostics');
      realFs.mkdirSync(diagnosticsDir);
      realFs.writeFileSync(path.join(diagnosticsDir, 'awf-squid.log'), 'squid log');

      // The first mkdirSync call inside preserveCleanupArtifacts (no auditDir)
      // is for the diagnosticsDestination dir.
      mockMkdirSync.mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device');
      });

      try {
        expect(() => preserveCleanupArtifacts(workDir)).not.toThrow();
      } finally {
        realFs.rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
});
