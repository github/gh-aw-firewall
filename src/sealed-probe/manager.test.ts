import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import type { SealedProbesConfig, WrapperConfig } from '../types';
import { resolveSealedProbePaths } from './paths';
import {
  SEALED_PROBE_RUN_LABEL,
  isSealedProbesEnabled,
  managerTestHelpers,
  prepareSealedProbes,
  teardownSealedProbes,
} from './manager';
import { releaseSeedPermissions, type GitRunner } from './staging';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('./staging', () => {
  const actual = jest.requireActual('./staging');
  return {
    ...actual,
    releaseSeedPermissions: jest.fn(actual.releaseSeedPermissions),
  };
});
const mockExeca = execa as unknown as jest.Mock;
const mockReleaseSeedPermissions = releaseSeedPermissions as jest.MockedFunction<typeof releaseSeedPermissions>;

const sealedProbes: SealedProbesConfig = {
  enabled: true,
  privateRepos: ['octo/private'],
  runtime: 'docker',
  timeout: 30,
  memoryLimit: '512m',
  interpreter: 'python3',
  maxInvocations: 7,
};

const gitRunner: GitRunner = async (args) => {
  if (args.includes('clone')) {
    const dest = args[args.length - 1];
    fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dest, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(dest, 'README.md'), 'contents\n');
    return { stdout: '' };
  }
  if (args[0] === 'rev-parse') return { stdout: 'a'.repeat(40) };
  return { stdout: '' };
};

function buildConfig(workDir: string, overrides: Partial<SealedProbesConfig> = {}): WrapperConfig {
  return { workDir, sealedProbes: { ...sealedProbes, ...overrides } } as unknown as WrapperConfig;
}

describe('isSealedProbesEnabled', () => {
  it('is true only for an explicitly enabled config', () => {
    expect(isSealedProbesEnabled({} as WrapperConfig)).toBe(false);
    expect(isSealedProbesEnabled(buildConfig('/tmp/x', { enabled: false }))).toBe(false);
    expect(isSealedProbesEnabled(buildConfig('/tmp/x'))).toBe(true);
  });
});

describe('prepareSealedProbes', () => {
  let workDir: string;

  beforeEach(() => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' });
    mockReleaseSeedPermissions.mockImplementation(
      jest.requireActual<typeof import('./staging')>('./staging').releaseSeedPermissions,
    );
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sealed-manager-'));
  });

  afterEach(() => {
    releaseSeedPermissions(resolveSealedProbePaths(workDir).seedsDir);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('does nothing when sealed probes are disabled', async () => {
    await prepareSealedProbes(buildConfig(workDir, { enabled: false }), { env: { GH_TOKEN: 't' }, gitRunner });
    expect(fs.existsSync(resolveSealedProbePaths(workDir).root)).toBe(false);
  });

  it('creates the directory layout, seed map, and skill artifact', async () => {
    await prepareSealedProbes(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner });
    const paths = resolveSealedProbePaths(workDir);

    expect(fs.existsSync(paths.seedsDir)).toBe(true);
    expect(fs.existsSync(paths.workDir)).toBe(true);
    expect(fs.existsSync(paths.runDir)).toBe(true);
    expect(fs.existsSync(paths.auditDir)).toBe(true);
    expect(fs.existsSync(paths.skillPath)).toBe(true);

    const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8'));
    expect(seedMap.version).toBe(1);
    expect(seedMap.runId).toMatch(/^[0-9a-f]{32}$/);
    expect(seedMap.seeds).toEqual([{ repo: 'octo/private', seedId: expect.stringMatching(/^[0-9a-f]{32}$/) }]);
    expect(fs.statSync(paths.seedMapPath).mode & 0o777).toBe(0o600);
  });

  it('keeps the seed map free of host paths and credentials', async () => {
    await prepareSealedProbes(buildConfig(workDir), { env: { GH_TOKEN: 'ghs_secret' }, gitRunner });
    const raw = fs.readFileSync(resolveSealedProbePaths(workDir).seedMapPath, 'utf8');

    expect(raw).not.toContain('ghs_secret');
    expect(raw).not.toContain(workDir);
  });

  it('protects broker-only directories and shares only the run/agent directories', async () => {
    await prepareSealedProbes(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner });
    const paths = resolveSealedProbePaths(workDir);

    expect(fs.statSync(paths.seedsDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.auditDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.workDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.runDir).mode & 0o777).toBe(0o770);
  });

  it('aborts when the configuration is invalid', async () => {
    await expect(
      prepareSealedProbes(buildConfig(workDir, { privateRepos: [] }), { env: { GH_TOKEN: 't' }, gitRunner }),
    ).rejects.toThrow(/configuration is invalid/);
  });

  it('aborts when no staging credential is available', async () => {
    await expect(
      prepareSealedProbes(buildConfig(workDir), { env: {}, gitRunner }),
    ).rejects.toThrow(/GH_TOKEN or GITHUB_TOKEN/);
  });

  it('aborts if the staging credential disappears after validation', async () => {
    let reads = 0;
    const env = {
      get GH_TOKEN() {
        reads += 1;
        return reads === 1 ? 't' : undefined;
      },
    } as NodeJS.ProcessEnv;

    await expect(prepareSealedProbes(buildConfig(workDir), { env, gitRunner }))
      .rejects.toThrow(/credential disappeared/);
  });

  it('rejects a symlink work directory before staging', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sealed-manager-target-'));
    const link = path.join(os.tmpdir(), `awf-sealed-manager-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(target, link);
    try {
      await expect(prepareSealedProbes(buildConfig(link), { env: { GH_TOKEN: 't' }, gitRunner }))
        .rejects.toThrow(/symlink work directory/);
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('aborts when a seed cannot be staged', async () => {
    const failing: GitRunner = async () => {
      throw new Error('fatal: repository not found');
    };

    await expect(
      prepareSealedProbes(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner: failing }),
    ).rejects.toThrow(/staging failed/);
  });
});

describe('teardownSealedProbes', () => {
  beforeEach(() => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' });
  });

  it('is a no-op when sealed probes were never enabled', async () => {
    await expect(teardownSealedProbes({ workDir: '/nonexistent' } as WrapperConfig)).resolves.toBeUndefined();
  });

  it('restores seed write permissions so generic cleanup can remove them', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sealed-teardown-'));
    try {
      await prepareSealedProbes(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner });
      const paths = resolveSealedProbePaths(workDir);

      expect(() => fs.rmSync(paths.seedsDir, { recursive: true })).toThrow();

      // No probe containers exist for this run, so the docker lookup is a
      // no-op; the permission restore is what must happen.
      await teardownSealedProbes(buildConfig(workDir));

      expect(() => fs.rmSync(paths.seedsDir, { recursive: true })).not.toThrow();
    } finally {
      releaseSeedPermissions(resolveSealedProbePaths(workDir).seedsDir);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('leaves the seeds read-only under --keep-containers', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sealed-keep-'));
    try {
      await prepareSealedProbes(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner });
      const paths = resolveSealedProbePaths(workDir);

      await teardownSealedProbes({ ...buildConfig(workDir), keepContainers: true } as WrapperConfig);

      expect(() => fs.rmSync(paths.seedsDir, { recursive: true })).toThrow();
    } finally {
      releaseSeedPermissions(resolveSealedProbePaths(workDir).seedsDir);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('removes every orphaned probe container for the staged run', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'probe-a\nprobe-b\n' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' });

    await managerTestHelpers.removeOrphanProbeContainers('run-id');

    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['ps', '-aq', '--filter', `label=${SEALED_PROBE_RUN_LABEL}=run-id`],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['rm', '-f', 'probe-a', 'probe-b'],
      expect.objectContaining({ reject: false }),
    );
  });

  it('does not remove containers when the Docker listing fails', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: 'probe-a' });

    await managerTestHelpers.removeOrphanProbeContainers('run-id');

    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the sealed-probe root is absent', async () => {
    await teardownSealedProbes(buildConfig('/nonexistent/sealed-probe-work-dir'));
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('handles unreadable or unusable seed maps without attempting Docker cleanup', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sealed-bad-map-'));
    const paths = resolveSealedProbePaths(workDir);
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(paths.seedMapPath, '{bad json');
    try {
      await teardownSealedProbes(buildConfig(workDir));
      expect(mockExeca).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('continues cleanup when orphan container removal fails', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sealed-orphan-failure-'));
    try {
      await prepareSealedProbes(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner });
      mockExeca.mockRejectedValueOnce(new Error('docker unavailable'));

      await expect(teardownSealedProbes(buildConfig(workDir))).resolves.toBeUndefined();
      expect(() => fs.rmSync(resolveSealedProbePaths(workDir).seedsDir, { recursive: true })).not.toThrow();
    } finally {
      releaseSeedPermissions(resolveSealedProbePaths(workDir).seedsDir);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('does not fail teardown when seed permissions cannot be restored', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sealed-permission-failure-'));
    const paths = resolveSealedProbePaths(workDir);
    try {
      fs.mkdirSync(paths.root, { recursive: true });
      fs.writeFileSync(paths.seedMapPath, JSON.stringify({ runId: '' }));
      fs.writeFileSync(paths.seedsDir, 'not a directory');
      mockReleaseSeedPermissions.mockImplementationOnce(() => {
        throw new Error('permission denied');
      });

      await expect(teardownSealedProbes(buildConfig(workDir))).resolves.toBeUndefined();
      expect(mockReleaseSeedPermissions).toHaveBeenCalledWith(paths.seedsDir);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
