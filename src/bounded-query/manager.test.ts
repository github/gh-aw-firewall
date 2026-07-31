import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import type { BoundedQueriesConfig, WrapperConfig } from '../types';
import { resolveBoundedQueryPaths } from './paths';
import {
  BOUNDED_QUERY_RUN_LABEL,
  isBoundedQueriesEnabled,
  managerTestHelpers,
  prepareBoundedQueries,
  teardownBoundedQueries,
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

const boundedQueries: BoundedQueriesConfig = {
  enabled: true,
  privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
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

function buildConfig(workDir: string, overrides: Partial<BoundedQueriesConfig> = {}): WrapperConfig {
  return { workDir, boundedQueries: { ...boundedQueries, ...overrides } } as unknown as WrapperConfig;
}

describe('isBoundedQueriesEnabled', () => {
  it('is true only for an explicitly enabled config', () => {
    expect(isBoundedQueriesEnabled({} as WrapperConfig)).toBe(false);
    expect(isBoundedQueriesEnabled(buildConfig('/tmp/x', { enabled: false }))).toBe(false);
    expect(isBoundedQueriesEnabled(buildConfig('/tmp/x'))).toBe(true);
  });
});

describe('prepareBoundedQueries', () => {
  let workDir: string;

  beforeEach(() => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' });
    mockReleaseSeedPermissions.mockImplementation(
      jest.requireActual<typeof import('./staging')>('./staging').releaseSeedPermissions,
    );
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-query-manager-'));
  });

  afterEach(() => {
    const paths = resolveBoundedQueryPaths(workDir);
    releaseSeedPermissions(paths.seedsDir);
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('does nothing when bounded queries are disabled', async () => {
    await prepareBoundedQueries(buildConfig(workDir, { enabled: false }), { env: { GH_TOKEN: 't' }, gitRunner });
    expect(fs.existsSync(resolveBoundedQueryPaths(workDir).root)).toBe(false);
  });

  it('creates the directory layout, seed map, skill, and wrapper artifacts', async () => {
    await prepareBoundedQueries(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner });
    const paths = resolveBoundedQueryPaths(workDir);

    expect(fs.existsSync(paths.seedsDir)).toBe(true);
    expect(fs.existsSync(paths.workDir)).toBe(true);
    expect(fs.existsSync(paths.runDir)).toBe(true);
    expect(fs.existsSync(paths.auditDir)).toBe(true);
    expect(fs.existsSync(paths.controlDir)).toBe(true);
    expect(fs.existsSync(paths.skillPath)).toBe(true);
    expect(fs.existsSync(paths.wrapperPath)).toBe(true);
    expect(fs.statSync(paths.wrapperPath).mode & 0o777).toBe(0o555);
    expect(paths.root.startsWith(workDir)).toBe(false);

    const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8'));
    expect(seedMap.version).toBe(2);
    expect(seedMap.runId).toMatch(/^[0-9a-f]{32}$/);
    expect(seedMap.seeds).toEqual([
      { repo: 'octo/private', seedId: expect.stringMatching(/^[0-9a-f]{32}$/), sensitivity: 'internal' },
    ]);
    expect(fs.statSync(paths.seedMapPath).mode & 0o777).toBe(0o600);
  });

  it.each([
    [true, 'unix'],
    [false, 'sbx-http'],
  ] as const)('selects sbx ingress from the executable socket probe (%s)', async (supported, expected) => {
    const config = {
      ...buildConfig(workDir),
      containerRuntime: 'sbx',
    };
    const probe = jest.fn().mockResolvedValue(supported);

    await prepareBoundedQueries(config, {
      env: { GH_TOKEN: 't' },
      gitRunner,
      probeSbxUnixSocket: probe,
    });

    const paths = resolveBoundedQueryPaths(workDir);
    expect(config.boundedQueryIngressTransport).toBe(expected);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(paths.capabilityPath)).toBe(!supported);
    if (!supported) {
      const raw = fs.readFileSync(paths.capabilityPath, 'utf8');
      expect(raw).not.toContain('GH_TOKEN');
      expect(JSON.parse(raw)).toEqual({
        version: 1,
        query: expect.stringMatching(/^[0-9a-f]{64}$/),
        probe: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(fs.statSync(paths.capabilityPath).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the seed map free of host paths and credentials', async () => {
    await prepareBoundedQueries(buildConfig(workDir), { env: { GH_TOKEN: 'ghs_secret' }, gitRunner });
    const raw = fs.readFileSync(resolveBoundedQueryPaths(workDir).seedMapPath, 'utf8');

    expect(raw).not.toContain('ghs_secret');
    expect(raw).not.toContain(workDir);
  });

  it('protects broker-only directories and shares only the run/agent directories', async () => {
    await prepareBoundedQueries(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner });
    const paths = resolveBoundedQueryPaths(workDir);

    expect(fs.statSync(paths.seedsDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.auditDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.workDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.runDir).mode & 0o777).toBe(0o770);
  });

  it('aborts when the configuration is invalid', async () => {
    await expect(
      prepareBoundedQueries(buildConfig(workDir, { privateRepos: [] }), { env: { GH_TOKEN: 't' }, gitRunner }),
    ).rejects.toThrow(/configuration is invalid/);
  });

  it('aborts when no staging credential is available', async () => {
    await expect(
      prepareBoundedQueries(buildConfig(workDir), { env: {}, gitRunner }),
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

    await expect(prepareBoundedQueries(buildConfig(workDir), { env, gitRunner }))
      .rejects.toThrow(/credential disappeared/);
  });

  it('rejects a symlink work directory before staging', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-query-manager-target-'));
    const link = path.join(os.tmpdir(), `awf-bounded-query-manager-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(target, link);
    try {
      await expect(prepareBoundedQueries(buildConfig(link), { env: { GH_TOKEN: 't' }, gitRunner }))
        .rejects.toThrow(/symlink work directory/);
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('rejects a pre-existing private root instead of reusing attacker-controlled state', async () => {
    const paths = resolveBoundedQueryPaths(workDir);
    fs.mkdirSync(paths.root);
    await expect(prepareBoundedQueries(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner }))
      .rejects.toThrow(/EEXIST|file already exists/);
  });

  it('rejects a pre-existing ingress root instead of following a planted symlink', async () => {
    const paths = resolveBoundedQueryPaths(workDir);
    const target = fs.mkdtempSync(path.join('/var/tmp', 'awf-bounded-query-ingress-target-'));
    fs.symlinkSync(target, paths.ingressRoot);
    try {
      await expect(prepareBoundedQueries(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner }))
        .rejects.toThrow(/EEXIST|file already exists/);
    } finally {
      fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('aborts when a seed cannot be staged', async () => {
    const failing: GitRunner = async () => {
      throw new Error('fatal: repository not found');
    };

    await expect(
      prepareBoundedQueries(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner: failing }),
    ).rejects.toThrow(/staging failed/);
  });

  it.each(['docker', 'gvisor', 'sbx'] as const)(
    'fails query runtime %s capability preflight before directories or staging',
    async (runtime) => {
      const assertRuntimeAvailable = jest.fn().mockRejectedValue(new Error(`${runtime} unavailable`));
      const probeSbxUnixSocket = jest.fn();
      const config = buildConfig(workDir, { runtime });
      await expect(prepareBoundedQueries(config, {
        env: { GH_TOKEN: 't' },
        gitRunner,
        assertRuntimeAvailable,
        probeSbxUnixSocket,
      })).rejects.toThrow(`${runtime} unavailable`);
      expect(assertRuntimeAvailable).toHaveBeenCalledTimes(1);
      expect(probeSbxUnixSocket).not.toHaveBeenCalled();
      expect(fs.existsSync(resolveBoundedQueryPaths(workDir).root)).toBe(false);
    },
  );

  it.each([undefined, 'gvisor', 'sbx'] as const)(
    'fails primary runtime %s capability preflight before query preflight or staging',
    async (containerRuntime) => {
      const assertPrimaryAvailable = jest.fn().mockRejectedValue(new Error('primary unavailable'));
      const assertRuntimeAvailable = jest.fn();
      const probeSbxUnixSocket = jest.fn();
      await expect(prepareBoundedQueries(
        { ...buildConfig(workDir), containerRuntime },
        {
          env: { GH_TOKEN: 't' },
          gitRunner,
          assertPrimaryAvailable,
          assertRuntimeAvailable,
          probeSbxUnixSocket,
        },
      )).rejects.toThrow('primary unavailable');
      expect(assertRuntimeAvailable).not.toHaveBeenCalled();
      expect(probeSbxUnixSocket).not.toHaveBeenCalled();
      expect(fs.existsSync(resolveBoundedQueryPaths(workDir).root)).toBe(false);
    },
  );
});

describe('teardownBoundedQueries', () => {
  beforeEach(() => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' });
  });

  it('is a no-op when bounded queries were never enabled', async () => {
    await expect(teardownBoundedQueries({ workDir: '/nonexistent' } as WrapperConfig)).resolves.toBeUndefined();
  });

  it('restores seed write permissions so generic cleanup can remove them', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-query-teardown-'));
    const paths = resolveBoundedQueryPaths(workDir);
    try {
      await prepareBoundedQueries(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner });

      expect(() => fs.rmSync(paths.seedsDir, { recursive: true })).toThrow();

      // No query containers exist for this run, so the docker lookup is a
      // no-op; the permission restore is what must happen.
      await teardownBoundedQueries(buildConfig(workDir));

      expect(fs.existsSync(paths.root)).toBe(false);
      expect(fs.existsSync(paths.ingressRoot)).toBe(false);
    } finally {
      releaseSeedPermissions(paths.seedsDir);
      fs.rmSync(paths.root, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('leaves the seeds read-only under --keep-containers', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-query-keep-'));
    try {
      await prepareBoundedQueries(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner });
      const paths = resolveBoundedQueryPaths(workDir);

      await teardownBoundedQueries({ ...buildConfig(workDir), keepContainers: true } as WrapperConfig);

      expect(() => fs.rmSync(paths.seedsDir, { recursive: true })).toThrow();
    } finally {
      const cleanupPaths = resolveBoundedQueryPaths(workDir);
      releaseSeedPermissions(cleanupPaths.seedsDir);
      fs.rmSync(cleanupPaths.root, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('removes every orphaned query container for the staged run', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'query-a\nquery-b\n' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' });

    await managerTestHelpers.removeOrphanQueryContainers('run-id');

    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['ps', '-aq', '--filter', `label=${BOUNDED_QUERY_RUN_LABEL}=run-id`],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['rm', '-f', 'query-a', 'query-b'],
      expect.objectContaining({ reject: false }),
    );
  });

  it('does not remove containers when the Docker listing fails', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: 'query-a' });

    await managerTestHelpers.removeOrphanQueryContainers('run-id');

    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the bounded-query root is absent', async () => {
    await teardownBoundedQueries(buildConfig('/nonexistent/bounded-query-work-dir'));
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('handles unreadable or unusable seed maps without attempting Docker cleanup', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-query-bad-map-'));
    const paths = resolveBoundedQueryPaths(workDir);
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(paths.seedMapPath, '{bad json');
    try {
      await teardownBoundedQueries(buildConfig(workDir));
      expect(mockExeca).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('continues cleanup when orphan container removal fails', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-query-orphan-failure-'));
    try {
      await prepareBoundedQueries(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner });
      mockExeca.mockRejectedValueOnce(new Error('docker unavailable'));

      await expect(teardownBoundedQueries(buildConfig(workDir))).resolves.toBeUndefined();
      expect(fs.existsSync(resolveBoundedQueryPaths(workDir).root)).toBe(false);
    } finally {
      const cleanupPaths = resolveBoundedQueryPaths(workDir);
      releaseSeedPermissions(cleanupPaths.seedsDir);
      fs.rmSync(cleanupPaths.root, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('does not fail teardown when seed permissions cannot be restored', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-query-permission-failure-'));
    const paths = resolveBoundedQueryPaths(workDir);
    try {
      fs.mkdirSync(paths.root, { recursive: true });
      fs.writeFileSync(paths.seedMapPath, JSON.stringify({ runId: '' }));
      fs.writeFileSync(paths.seedsDir, 'not a directory');
      mockReleaseSeedPermissions.mockImplementationOnce(() => {
        throw new Error('permission denied');
      });

      await expect(teardownBoundedQueries(buildConfig(workDir))).resolves.toBeUndefined();
      expect(mockReleaseSeedPermissions).toHaveBeenCalledWith(paths.seedsDir);
    } finally {
      fs.rmSync(paths.root, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('repairs rootless private-state permissions and retries cleanup', () => {
    const paths = resolveBoundedQueryPaths('/tmp/rootless-cleanup');
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const removeTree = jest.fn()
      .mockImplementationOnce(() => { throw permissionError; })
      .mockImplementation(() => undefined);
    const repairPermissions = jest.fn();

    managerTestHelpers.removePrivateState(
      buildConfig('/tmp/rootless-cleanup'),
      paths,
      { removeTree, repairPermissions },
    );

    expect(repairPermissions).toHaveBeenCalledWith(
      [paths.root, paths.ingressRoot],
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(removeTree).toHaveBeenCalledTimes(3);
  });

  it('surfaces cleanup failures after rootless permission repair', () => {
    const paths = resolveBoundedQueryPaths('/tmp/rootless-retry-failure');
    const permissionError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const removeTree = jest.fn()
      .mockImplementationOnce(() => { throw permissionError; })
      .mockImplementationOnce(() => { throw new Error('still denied'); });

    expect(() => managerTestHelpers.removePrivateState(
      buildConfig('/tmp/rootless-retry-failure'),
      paths,
      { removeTree, repairPermissions: jest.fn() },
    )).not.toThrow();
  });

  it('surfaces non-permission cleanup failures without attempting repair', () => {
    const paths = resolveBoundedQueryPaths('/tmp/private-cleanup-failure');
    const repairPermissions = jest.fn();

    expect(() => managerTestHelpers.removePrivateState(
      buildConfig('/tmp/private-cleanup-failure'),
      paths,
      {
        removeTree: () => { throw new Error('I/O failure'); },
        repairPermissions,
      },
    )).not.toThrow();
    expect(repairPermissions).not.toHaveBeenCalled();
  });
});
