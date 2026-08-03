import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import type { WrapperConfig } from '../types';
import { BOUNDED_AGENT_DEFAULTS, type BoundedAgentsConfig } from '../types/bounded-agent-options';
import { resolveBoundedAgentPaths } from './paths';
import {
  BOUNDED_AGENT_RUN_LABEL,
  boundedAgentManagerTestHelpers,
  isBoundedAgentsEnabled,
  prepareBoundedAgents,
  teardownBoundedAgents,
} from './manager';
import { releaseSeedPermissions, type GitRunner } from './staging';
import { resolveBoundedQueryPaths } from '../bounded-query/paths';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const mockExeca = execa as unknown as jest.Mock;

const boundedAgents: BoundedAgentsConfig = {
  ...BOUNDED_AGENT_DEFAULTS,
  enabled: true,
  model: 'gpt-4o-mini',
  privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
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

function buildConfig(workDir: string, overrides: Partial<BoundedAgentsConfig> = {}): WrapperConfig {
  return {
    workDir,
    enableApiProxy: true,
    openaiApiKey: 'sk-real',
    boundedAgents: { ...boundedAgents, ...overrides },
  } as unknown as WrapperConfig;
}

/** Preflight is proven separately; here it always succeeds unless overridden. */
const assertRuntimeAvailable = jest.fn(async () => undefined);

describe('isBoundedAgentsEnabled', () => {
  it('is true only for an explicitly enabled config', () => {
    expect(isBoundedAgentsEnabled({} as WrapperConfig)).toBe(false);
    expect(isBoundedAgentsEnabled(buildConfig('/tmp/x', { enabled: false }))).toBe(false);
    expect(isBoundedAgentsEnabled(buildConfig('/tmp/x'))).toBe(true);
  });
});

describe('prepareBoundedAgents', () => {
  let workDir: string;

  beforeEach(() => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' });
    assertRuntimeAvailable.mockClear();
    assertRuntimeAvailable.mockResolvedValue(undefined);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-manager-'));
  });

  afterEach(() => {
    const paths = resolveBoundedAgentPaths(workDir);
    releaseSeedPermissions(paths.seedsDir);
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('does nothing when bounded agents are disabled', async () => {
    await prepareBoundedAgents(buildConfig(workDir, { enabled: false }), {
      env: { GH_TOKEN: 't' },
      gitRunner,
      assertRuntimeAvailable,
    });
    expect(fs.existsSync(resolveBoundedAgentPaths(workDir).root)).toBe(false);
  });

  it('creates the private layout, seed map, skill, and wrapper artifacts', async () => {
    await prepareBoundedAgents(buildConfig(workDir), {
      env: { GH_TOKEN: 't' },
      gitRunner,
      assertRuntimeAvailable,
    });
    const paths = resolveBoundedAgentPaths(workDir);

    expect(fs.existsSync(paths.seedsDir)).toBe(true);
    expect(fs.existsSync(paths.workDir)).toBe(true);
    expect(fs.existsSync(paths.controlDir)).toBe(true);
    expect(fs.existsSync(paths.auditDir)).toBe(true);
    expect(fs.existsSync(paths.seedMapPath)).toBe(true);
    expect(fs.existsSync(paths.skillPath)).toBe(true);
    expect(fs.existsSync(paths.wrapperPath)).toBe(true);
  });

  it('uses a private root disjoint from the bounded-query private root', async () => {
    const agentPaths = resolveBoundedAgentPaths(workDir);
    const queryPaths = resolveBoundedQueryPaths(workDir);

    expect(agentPaths.root).not.toBe(queryPaths.root);
    expect(agentPaths.ingressRoot).not.toBe(queryPaths.ingressRoot);
    expect(agentPaths.root.startsWith(queryPaths.root)).toBe(false);
    expect(queryPaths.root.startsWith(agentPaths.root)).toBe(false);
  });

  it('runs preflight before staging clones anything', async () => {
    assertRuntimeAvailable.mockRejectedValueOnce(new Error('runsc is not registered'));
    const cloned: string[][] = [];
    const trackingGitRunner: GitRunner = async (args) => {
      cloned.push(args);
      return gitRunner(args, { env: {} });
    };

    await expect(
      prepareBoundedAgents(buildConfig(workDir, { runtime: 'gvisor' }), {
        env: { GH_TOKEN: 't' },
        gitRunner: trackingGitRunner,
        assertRuntimeAvailable,
      }),
    ).rejects.toThrow(/runsc is not registered/);

    expect(cloned).toEqual([]);
    expect(fs.existsSync(resolveBoundedAgentPaths(workDir).root)).toBe(false);
  });

  it('aborts before staging when the configuration is invalid', async () => {
    await expect(
      prepareBoundedAgents({ ...buildConfig(workDir), enableApiProxy: false } as WrapperConfig, {
        env: { GH_TOKEN: 't' },
        gitRunner,
        assertRuntimeAvailable,
      }),
    ).rejects.toThrow(/Bounded-agent configuration is invalid/);
    expect(assertRuntimeAvailable).not.toHaveBeenCalled();
  });

  it('aborts when no staging credential is available', async () => {
    await expect(
      prepareBoundedAgents(buildConfig(workDir), { env: {}, gitRunner, assertRuntimeAvailable }),
    ).rejects.toThrow(/GH_TOKEN or GITHUB_TOKEN/);
  });

  it('scrubs the staging credential and helper before returning', async () => {
    await prepareBoundedAgents(buildConfig(workDir), {
      env: { GH_TOKEN: 'ghs_super_secret' },
      gitRunner,
      assertRuntimeAvailable,
    });
    const paths = resolveBoundedAgentPaths(workDir);

    expect(fs.existsSync(path.join(paths.root, 'staging-token'))).toBe(false);
    expect(fs.existsSync(path.join(paths.root, 'askpass.sh'))).toBe(false);
    expect(fs.existsSync(path.join(paths.root, 'staging-home'))).toBe(false);

    const seedMap = fs.readFileSync(paths.seedMapPath, 'utf8');
    expect(seedMap).not.toContain('ghs_super_secret');
    const skill = fs.readFileSync(paths.skillPath, 'utf8');
    expect(skill).not.toContain('ghs_super_secret');
  });

  it('gives staging git no GitHub Actions, OIDC, or inherited credential environment', async () => {
    const observed: NodeJS.ProcessEnv[] = [];
    const capturingGitRunner: GitRunner = async (args, options) => {
      observed.push(options.env);
      return gitRunner(args, options);
    };
    await prepareBoundedAgents(buildConfig(workDir), {
      env: {
        GH_TOKEN: 'ghs_super_secret',
        GITHUB_TOKEN: 'github-fallback',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret',
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: '/sensitive/workspace',
      },
      gitRunner: capturingGitRunner,
      assertRuntimeAvailable,
    });
    expect(observed.length).toBeGreaterThan(0);
    for (const env of observed) {
      expect(env).not.toHaveProperty('GH_TOKEN');
      expect(env).not.toHaveProperty('GITHUB_TOKEN');
      expect(env).not.toHaveProperty('ACTIONS_ID_TOKEN_REQUEST_URL');
      expect(env).not.toHaveProperty('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
      expect(env).not.toHaveProperty('GITHUB_ACTIONS');
      expect(env).not.toHaveProperty('GITHUB_WORKSPACE');
      expect(Object.keys(env).sort()).toEqual([
        'GIT_ASKPASS',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_CONFIG_VALUE_0',
        'GIT_TERMINAL_PROMPT',
        'HOME',
        'PATH',
        'XDG_CONFIG_HOME',
        'AWF_BOUNDED_QUERY_STAGING_TOKEN_FILE',
      ].sort());
    }
  });

  it('writes a seed map with opaque seed ids and trusted sensitivity only', async () => {
    await prepareBoundedAgents(buildConfig(workDir), {
      env: { GH_TOKEN: 't' },
      gitRunner,
      assertRuntimeAvailable,
    });
    const paths = resolveBoundedAgentPaths(workDir);
    const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8'));

    expect(seedMap.version).toBe(2);
    expect(seedMap.runId).toMatch(/^[0-9a-f]{32}$/);
    expect(seedMap.seeds).toHaveLength(1);
    expect(seedMap.seeds[0].repo).toBe('octo/private');
    expect(seedMap.seeds[0].seedId).toMatch(/^[0-9a-f]{32}$/);
    expect(seedMap.seeds[0].sensitivity).toBe('internal');
    // No host paths leak into broker input.
    expect(JSON.stringify(seedMap)).not.toContain(workDir);
  });

  it('protects the private directories and leaves only the ingress agent-readable', async () => {
    await prepareBoundedAgents(buildConfig(workDir), {
      env: { GH_TOKEN: 't' },
      gitRunner,
      assertRuntimeAvailable,
    });
    const paths = resolveBoundedAgentPaths(workDir);

    expect(fs.statSync(paths.root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.auditDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.seedMapPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.agentDir).mode & 0o777).toBe(0o755);
  });

  it('sanitizes exactly one immutable seed per configured repository', async () => {
    await prepareBoundedAgents(
      buildConfig(workDir, {
        privateRepos: [
          { repo: 'octo/private', sensitivity: 'internal' },
          { repo: 'octo/other', sensitivity: 'confidential' },
        ],
      }),
      { env: { GH_TOKEN: 't' }, gitRunner, assertRuntimeAvailable },
    );
    const paths = resolveBoundedAgentPaths(workDir);
    const seeds = fs.readdirSync(paths.seedsDir);

    expect(seeds).toHaveLength(2);
    for (const seed of seeds) {
      const gitConfig = fs.readFileSync(path.join(paths.seedsDir, seed, '.git', 'config'), 'utf8');
      expect(gitConfig).not.toContain('remote');
      expect(gitConfig).not.toContain('url');
      // Seeds are read-only.
      expect(fs.statSync(path.join(paths.seedsDir, seed, 'README.md')).mode & 0o222).toBe(0);
      // The fixed unprivileged enclave uid can traverse and read the direct bind mount.
      expect(fs.statSync(path.join(paths.seedsDir, seed)).mode & 0o005).toBe(0o005);
      expect(fs.statSync(path.join(paths.seedsDir, seed, 'README.md')).mode & 0o004).toBe(0o004);
    }
  });

  it('refuses to reuse an existing private root', async () => {
    const paths = resolveBoundedAgentPaths(workDir);
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });

    await expect(
      prepareBoundedAgents(buildConfig(workDir), { env: { GH_TOKEN: 't' }, gitRunner, assertRuntimeAvailable }),
    ).rejects.toThrow(/EEXIST/);
  });
});

describe('teardownBoundedAgents', () => {
  let workDir: string;

  beforeEach(() => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' });
    assertRuntimeAvailable.mockClear();
    assertRuntimeAvailable.mockResolvedValue(undefined);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-teardown-'));
  });

  afterEach(() => {
    const paths = resolveBoundedAgentPaths(workDir);
    releaseSeedPermissions(paths.seedsDir);
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('is a no-op when bounded agents are disabled', async () => {
    await teardownBoundedAgents(buildConfig(workDir, { enabled: false }));
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('deterministically removes orphaned enclave containers by run label', async () => {
    await prepareBoundedAgents(buildConfig(workDir), {
      env: { GH_TOKEN: 't' },
      gitRunner,
      assertRuntimeAvailable,
    });
    const paths = resolveBoundedAgentPaths(workDir);
    const runId = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8')).runId as string;

    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123\ndef456\n' });
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '' });

    await teardownBoundedAgents(buildConfig(workDir));

    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['ps', '-aq', '--filter', `label=${BOUNDED_AGENT_RUN_LABEL}=${runId}`],
      expect.anything(),
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['rm', '-f', 'abc123', 'def456'],
      expect.anything(),
    );
    expect(fs.existsSync(paths.root)).toBe(false);
    expect(fs.existsSync(paths.ingressRoot)).toBe(false);
  });

  it('uses a run label distinct from bounded queries', () => {
    expect(BOUNDED_AGENT_RUN_LABEL).toBe('awf.bounded-agent.run');
  });

  it('removes orphaned enclaves but preserves private state under --keep-containers', async () => {
    await prepareBoundedAgents(buildConfig(workDir), {
      env: { GH_TOKEN: 't' },
      gitRunner,
      assertRuntimeAvailable,
    });
    const paths = resolveBoundedAgentPaths(workDir);

    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123\n' });
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '' });

    await teardownBoundedAgents({ ...buildConfig(workDir), keepContainers: true } as WrapperConfig);

    expect(mockExeca).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(paths.root)).toBe(true);
  });

  it('removes a stale ingress root when the private root is already gone', async () => {
    const paths = resolveBoundedAgentPaths(workDir);
    fs.mkdirSync(paths.runDir, { recursive: true });

    await teardownBoundedAgents(buildConfig(workDir));
    expect(fs.existsSync(paths.ingressRoot)).toBe(false);
  });
});

describe('boundedAgentManagerTestHelpers.readRunId', () => {
  it('returns undefined for a missing or malformed seed map', () => {
    const paths = resolveBoundedAgentPaths('/nonexistent-work-dir-for-tests');
    expect(boundedAgentManagerTestHelpers.readRunId(paths)).toBeUndefined();
  });

  describe('boundedAgentManagerTestHelpers.prepareDirectories', () => {
    it('hands private proxy logs to the safe host identity under sudo', () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-owner-'));
      const paths = resolveBoundedAgentPaths(workDir);
      const getuid = jest.spyOn(process, 'getuid').mockReturnValue(0);
      const getgid = jest.spyOn(process, 'getgid').mockReturnValue(0);
      const chown = jest.fn();
      const previousUid = process.env.SUDO_UID;
      const previousGid = process.env.SUDO_GID;
      process.env.SUDO_UID = '1234';
      process.env.SUDO_GID = '5678';

      try {
        boundedAgentManagerTestHelpers.prepareDirectories(paths, chown);
        expect(chown).toHaveBeenCalledWith(paths.runDir, 1234, 5678);
        expect(chown).toHaveBeenCalledWith(paths.apiProxyLogsDir, 1234, 5678);
      } finally {
        getuid.mockRestore();
        getgid.mockRestore();
        if (previousUid === undefined) delete process.env.SUDO_UID;
        else process.env.SUDO_UID = previousUid;
        if (previousGid === undefined) delete process.env.SUDO_GID;
        else process.env.SUDO_GID = previousGid;
        fs.rmSync(paths.root, { recursive: true, force: true });
        fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
});
