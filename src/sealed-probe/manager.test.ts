import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SealedProbesConfig, WrapperConfig } from '../types';
import { resolveSealedProbePaths } from './paths';
import { isSealedProbesEnabled, prepareSealedProbes, teardownSealedProbes } from './manager';
import { releaseSeedPermissions, type GitRunner } from './staging';

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
});
