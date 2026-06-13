/**
 * Coverage tests for docker-manager.ts barrel file and container-cleanup.ts.
 *
 * docker-manager.ts re-exports symbols from several source modules.
 * This test file ensures Istanbul/c8 counts all re-exported symbols as covered
 * by actually invoking each one through the barrel, not just comparing identity.
 *
 * container-cleanup.ts branches covered here:
 *   - cleanup() with keepFiles=true (early return path)
 *   - cleanup() when workDir does not exist (early return path)
 *   - cleanup() error handling (catch block)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

// Prevent real chroot / UID lookups
jest.mock('./host-env', () => ({
  setAwfDockerHost: jest.fn(),
  getLocalDockerEnv: jest.fn().mockReturnValue({}),
  parseDifcProxyHost: jest.fn().mockReturnValue(undefined),
  getSafeHostUid: jest.fn().mockReturnValue('1000'),
  getSafeHostGid: jest.fn().mockReturnValue('1000'),
  getRealUserHome: jest.fn().mockReturnValue('/home/testuser'),
  stripScheme: jest.fn((v: string) => v),
}));

jest.mock('./config-writer', () => ({
  writeConfigs: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./container-lifecycle', () => ({
  startContainers: jest.fn().mockResolvedValue(undefined),
  runAgentCommand: jest.fn().mockResolvedValue({ exitCode: 0 }),
  fastKillAgentContainer: jest.fn().mockResolvedValue(undefined),
}));

// container-cleanup exports a re-export and a real function – mock only the
// re-exported symbols so the real cleanup() can still be exercised.
jest.mock('./diagnostic-collector', () => ({
  collectDiagnosticLogs: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./container-stop', () => ({
  runComposeDown: jest.fn().mockResolvedValue(undefined),
  stopContainers: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./artifact-preservation', () => ({
  preserveIptablesAudit: jest.fn(),
  preserveCleanupArtifacts: jest.fn(),
  removeWorkDirectories: jest.fn(),
}));

jest.mock('./ssl-bump', () => ({
  cleanupSslKeyMaterial: jest.fn(),
  unmountSslTmpfs: jest.fn().mockResolvedValue(undefined),
}));

import * as dockerManager from './docker-manager';
import { cleanup } from './container-cleanup';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── docker-manager.ts barrel invocation ─────────────────────────────────────

describe('docker-manager barrel – invocation coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('setAwfDockerHost is invocable via barrel', () => {
    expect(() => dockerManager.setAwfDockerHost('/var/run/docker.sock')).not.toThrow();
  });

  it('getLocalDockerEnv returns a value via barrel', () => {
    const result = dockerManager.getLocalDockerEnv();
    expect(result).toBeDefined();
  });

  it('parseDifcProxyHost is invocable via barrel', () => {
    const result = dockerManager.parseDifcProxyHost('tcp://1.2.3.4:2376');
    // Result depends on mock – just ensure it is callable without error
    expect(result).toBeUndefined();
  });

  it('writeConfigs is invocable via barrel', async () => {
    await expect(
      dockerManager.writeConfigs({
        allowedDomains: ['github.com'],
        agentCommand: 'echo test',
        logLevel: 'info',
        keepContainers: false,
        workDir: '/tmp/test-awf',
      })
    ).resolves.not.toThrow();
  });

  it('startContainers is invocable via barrel', async () => {
    await expect(
      dockerManager.startContainers('/tmp/test-awf', ['github.com'])
    ).resolves.not.toThrow();
  });

  it('runAgentCommand returns an exit-code-like value via barrel', async () => {
    const result = await dockerManager.runAgentCommand('/tmp/test-awf', ['github.com']);
    expect(result).toBeDefined();
  });

  it('fastKillAgentContainer is invocable via barrel', async () => {
    await expect(dockerManager.fastKillAgentContainer()).resolves.not.toThrow();
  });

  it('collectDiagnosticLogs is invocable via barrel', async () => {
    await expect(dockerManager.collectDiagnosticLogs('/tmp/test-awf')).resolves.not.toThrow();
  });

  it('stopContainers is invocable via barrel', async () => {
    await expect(dockerManager.stopContainers('/tmp/test-awf', false)).resolves.not.toThrow();
  });

it('preserveIptablesAudit is invocable via barrel', () => {
  expect(() => dockerManager.preserveIptablesAudit('/tmp/test-awf')).not.toThrow();
});

  it('cleanup is invocable via barrel', async () => {
    await expect(
      dockerManager.cleanup('/tmp/nonexistent-awf-barrel', false)
    ).resolves.not.toThrow();
  });
});

// ─── container-cleanup.ts – uncovered branch coverage ────────────────────────

describe('container-cleanup cleanup() – keepFiles=true branch', () => {
  it('returns immediately without deleting anything when keepFiles is true', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-keepfiles-'));
    const sentinelFile = path.join(workDir, 'sentinel.txt');
    fs.writeFileSync(sentinelFile, 'keep me');

    try {
      await cleanup(workDir, true);

      // The workDir must be intact – keepFiles=true skips all deletion
      expect(fs.existsSync(sentinelFile)).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('does not call preserveCleanupArtifacts when keepFiles is true', async () => {
    const { preserveCleanupArtifacts } =
      jest.requireMock('./artifact-preservation') as { preserveCleanupArtifacts: jest.Mock };
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-keepfiles-'));

    try {
      await cleanup(workDir, true);
      expect(preserveCleanupArtifacts).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('container-cleanup cleanup() – non-existent workDir branch', () => {
  it('returns without error when workDir does not exist', async () => {
    const nonExistent = path.join(os.tmpdir(), `awf-never-created-${Date.now()}`);

    await expect(cleanup(nonExistent, false)).resolves.not.toThrow();
  });

  it('does not call removeWorkDirectories when workDir does not exist', async () => {
    const { removeWorkDirectories } =
      jest.requireMock('./artifact-preservation') as { removeWorkDirectories: jest.Mock };
    const nonExistent = path.join(os.tmpdir(), `awf-never-created-${Date.now()}`);

    await cleanup(nonExistent, false);

    expect(removeWorkDirectories).not.toHaveBeenCalled();
  });
});

describe('container-cleanup cleanup() – error catch branch', () => {
  it('does not throw when preserveCleanupArtifacts throws an error', async () => {
    const { preserveCleanupArtifacts } =
      jest.requireMock('./artifact-preservation') as { preserveCleanupArtifacts: jest.Mock };

    preserveCleanupArtifacts.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-error-'));

    try {
      // cleanup() has a try/catch; errors must be swallowed, not propagated
      await expect(cleanup(workDir, false)).resolves.not.toThrow();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
