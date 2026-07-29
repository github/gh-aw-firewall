import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import type { BoundedQueryRepository } from '../types/bounded-query-options';
import { resolveBoundedQueryPaths, type BoundedQueryPaths } from './paths';
import {
  buildCloneUrl,
  buildStagingGitEnv,
  releaseSeedPermissions,
  resolveStagingToken,
  scrubSeed,
  BoundedQueryStagingError,
  stageBoundedQuerySeeds,
  stagingTestHelpers,
  type GitRunner,
} from './staging';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const mockExeca = execa as unknown as jest.Mock;

const TOKEN = 'ghs_super_secret_value';

function makeTempWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-query-staging-'));
}

/**
 * Builds a fake `git` that materializes a realistic clone (including the
 * credential-bearing and escape-bearing artifacts staging must strip) instead
 * of touching the network.
 */
function createFakeGit(options: { onClone?: (dest: string) => void } = {}): {
  runner: GitRunner;
  calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd?: string }>;
} {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd?: string }> = [];

  const runner: GitRunner = async (args, opts) => {
    calls.push({ args, env: opts.env, cwd: opts.cwd });

    if (args.includes('clone')) {
      const dest = args[args.length - 1];
      const gitDir = path.join(dest, '.git');
      fs.mkdirSync(path.join(gitDir, 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(gitDir, 'refs', 'remotes', 'origin'), { recursive: true });
      fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
      fs.mkdirSync(path.join(gitDir, 'logs'), { recursive: true });
      fs.mkdirSync(path.join(gitDir, 'worktrees'), { recursive: true });
      fs.writeFileSync(
        path.join(gitDir, 'config'),
        `[remote "origin"]\n\turl = https://x-access-token:${TOKEN}@github.com/octo/private.git\n` +
        '[credential]\n\thelper = store\n',
      );
      fs.writeFileSync(path.join(gitDir, 'hooks', 'post-checkout'), '#!/bin/sh\necho pwned\n');
      fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), '/var/lib/other-repo/objects\n');
      fs.writeFileSync(path.join(gitDir, 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/heads/main\n');
      fs.writeFileSync(path.join(gitDir, 'logs', 'HEAD'), 'reflog\n');
      fs.writeFileSync(path.join(gitDir, 'FETCH_HEAD'), 'fetched\n');
      fs.writeFileSync(
        path.join(gitDir, 'packed-refs'),
        '# pack-refs with: peeled\nabc refs/heads/main\ndef refs/remotes/origin/main\n',
      );
      fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
      fs.writeFileSync(path.join(dest, 'README.md'), 'private contents\n');
      options.onClone?.(dest);
      return { stdout: '' };
    }

    if (args[0] === 'rev-parse') {
      return { stdout: '0123456789abcdef0123456789abcdef01234567\n' };
    }

    return { stdout: '' };
  };

  return { runner, calls };
}

async function stage(
  workDir: string,
  runner: GitRunner,
  repos: BoundedQueryRepository[] = [{ repo: 'octo/private', sensitivity: 'internal' }],
): Promise<{ paths: BoundedQueryPaths; result: Awaited<ReturnType<typeof stageBoundedQuerySeeds>> }> {
  const paths = resolveBoundedQueryPaths(workDir);
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const result = await stageBoundedQuerySeeds({
    repos,
    paths,
    runId: 'f'.repeat(32),
    token: TOKEN,
    gitRunner: runner,
  });
  return { paths, result };
}

describe('resolveStagingToken', () => {
  it('prefers GH_TOKEN over GITHUB_TOKEN', () => {
    expect(resolveStagingToken({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b' })).toBe('a');
  });

  it('falls back to GITHUB_TOKEN', () => {
    expect(resolveStagingToken({ GITHUB_TOKEN: 'b' })).toBe('b');
  });

  it('treats an empty value as absent', () => {
    expect(resolveStagingToken({ GH_TOKEN: '' })).toBeUndefined();
    expect(resolveStagingToken({})).toBeUndefined();
  });

  it('uses the process environment by default', () => {
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'from-process';
    try {
      expect(resolveStagingToken()).toBe('from-process');
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }
  });
});

describe('buildCloneUrl', () => {
  it('builds a plain https URL with no userinfo component', () => {
    expect(buildCloneUrl('octo/private')).toBe('https://github.com/octo/private.git');
  });

  it('refuses to build a URL for an unsafe slug', () => {
    expect(() => buildCloneUrl('octo/private?a=1')).toThrow(BoundedQueryStagingError);
    expect(() => buildCloneUrl('https://evil.example/x')).toThrow(BoundedQueryStagingError);
  });
});

describe('buildStagingGitEnv', () => {
  const env = buildStagingGitEnv({
    tokenFilePath: '/work/staging-token',
    askpassPath: '/work/askpass.sh',
    isolatedHome: '/work/staging-home',
  });

  it('passes only the token file PATH (not the token itself) through the environment', () => {
    expect(env[stagingTestHelpers.ASKPASS_TOKEN_FILE_ENV]).toBe('/work/staging-token');
    const otherValues = Object.entries(env)
      .filter(([key]) => key !== stagingTestHelpers.ASKPASS_TOKEN_FILE_ENV)
      .map(([, value]) => String(value));
    // The token itself must not appear anywhere in the git environment.
    expect(otherValues.some((value) => value.includes(TOKEN))).toBe(false);
  });

  it('isolates git from host/user/system configuration and interactive prompts', () => {
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.HOME).toBe('/work/staging-home');
    expect(env.XDG_CONFIG_HOME).toBe('/work/staging-home/.config');
    expect(env.GIT_ASKPASS).toBe('/work/askpass.sh');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
  });

  it('does not forward unrelated host environment variables', () => {
    expect(Object.keys(env).sort()).toEqual([
      stagingTestHelpers.ASKPASS_TOKEN_FILE_ENV,
      'GIT_ASKPASS',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_VALUE_0',
      'GIT_TERMINAL_PROMPT',
      'HOME',
      'PATH',
      'XDG_CONFIG_HOME',
    ].sort());
  });

  it('uses a safe PATH when the host PATH is absent', () => {
    const previous = process.env.PATH;
    delete process.env.PATH;
    try {
      expect(buildStagingGitEnv({
        tokenFilePath: '/token',
        askpassPath: '/askpass',
        isolatedHome: '/home',
      }).PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    } finally {
      if (previous !== undefined) process.env.PATH = previous;
    }
  });
});

describe('stageBoundedQuerySeeds', () => {
  let workDir: string;

  beforeEach(() => {
    mockExeca.mockReset();
    workDir = makeTempWorkDir();
  });

  afterEach(() => {
    releaseSeedPermissions(resolveBoundedQueryPaths(workDir).seedsDir);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('never passes the credential in argv', async () => {
    const { runner, calls } = createFakeGit();
    await stage(workDir, runner);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(TOKEN);
      expect(call.args.join(' ')).not.toContain('x-access-token');
    }
  });

  it('never places the token itself in git environment variables', async () => {
    const { runner, calls } = createFakeGit();
    await stage(workDir, runner);

    for (const call of calls) {
      for (const [key, value] of Object.entries(call.env)) {
        // The token file PATH env var is expected; the token VALUE must not be.
        if (key !== stagingTestHelpers.ASKPASS_TOKEN_FILE_ENV) {
          expect(String(value)).not.toContain(TOKEN);
        }
      }
    }
  });

  it('clones from an AWF-constructed URL with no embedded credential', async () => {
    const { runner, calls } = createFakeGit();
    await stage(workDir, runner);

    const clone = calls.find((call) => call.args.includes('clone'));
    expect(clone?.args).toContain('https://github.com/octo/private.git');
    expect(clone?.args).toContain('--recurse-submodules=no');
  });

  it('removes the askpass helper, token file, and isolated home once staging finishes', async () => {
    const { runner } = createFakeGit();
    const { paths } = await stage(workDir, runner);

    expect(fs.existsSync(path.join(paths.root, 'askpass.sh'))).toBe(false);
    expect(fs.existsSync(path.join(paths.root, 'staging-token'))).toBe(false);
    expect(fs.existsSync(path.join(paths.root, 'staging-home'))).toBe(false);
  });

  it('leaves no file under the bounded-query root containing the credential', async () => {
    const { runner } = createFakeGit();
    const { paths } = await stage(workDir, runner);
    releaseSeedPermissions(paths.seedsDir);

    const offenders: string[] = [];
    const walk = (target: string): void => {
      let fd: number;
      try {
        fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      } catch {
        return;
      }
      try {
        const stat = fs.fstatSync(fd);
        if (stat.isDirectory()) {
          fs.closeSync(fd);
          for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
          return;
        }
        if (fs.readFileSync(fd, 'utf8').includes(TOKEN)) offenders.push(target);
      } catch {
        // skip unreadable entries
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed before directory traversal
        }
      }
    };
    walk(paths.root);

    expect(offenders).toEqual([]);
  });

  it('scrubs remotes, credential helpers, hooks, alternates, reflogs, and worktree links', async () => {
    const { runner } = createFakeGit();
    const { paths, result } = await stage(workDir, runner);
    const gitDir = path.join(result.seeds[0].seedPath, '.git');

    expect(fs.readFileSync(path.join(gitDir, 'config'), 'utf8')).not.toContain('remote');
    expect(fs.readFileSync(path.join(gitDir, 'config'), 'utf8')).not.toContain('helper');
    expect(fs.existsSync(path.join(gitDir, 'hooks'))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, 'objects', 'info', 'alternates'))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, 'worktrees'))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, 'FETCH_HEAD'))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, 'refs', 'remotes'))).toBe(false);
    expect(fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')).not.toContain('refs/remotes/');
    expect(paths.seedsDir).toContain('bounded-queries');
  });

  it('records the staged commit and an opaque seed id', async () => {
    const { runner } = createFakeGit();
    const { result } = await stage(workDir, runner);

    expect(result.seeds[0].commit).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(result.seeds[0].seedId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.seeds[0].repoKey).toBe('octo/private');
    expect(result.seeds[0].sensitivity).toBe('internal');
  });

  it('makes every staged path read-only', async () => {
    const { runner } = createFakeGit();
    const { result } = await stage(workDir, runner);

    const writable: string[] = [];
    const walk = (target: string): void => {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) return;
      if ((stat.mode & 0o222) !== 0) writable.push(target);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
      }
    };
    walk(result.seeds[0].seedPath);

    expect(writable).toEqual([]);
  });

  it('rejects a repository that declares submodules and removes the partial tree', async () => {
    const { runner } = createFakeGit({
      onClone: (dest) => fs.writeFileSync(path.join(dest, '.gitmodules'), '[submodule "x"]\n'),
    });

    await expect(stage(workDir, runner)).rejects.toThrow(/submodule/i);
    expect(fs.existsSync(resolveBoundedQueryPaths(workDir).seedsDir)).toBe(false);
  });

  it('rejects a clone whose .git is a symlink', async () => {
    const { runner } = createFakeGit({
      onClone: (dest) => {
        fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });
        fs.symlinkSync('/etc', path.join(dest, '.git'));
      },
    });

    await expect(stage(workDir, runner)).rejects.toThrow(/symlink/i);
  });

  it('stages every configured repository into its own seed', async () => {
    const { runner } = createFakeGit();
    const { result } = await stage(workDir, runner, [
      { repo: 'octo/one', sensitivity: 'internal' },
      { repo: 'octo/two', sensitivity: 'confidential' },
    ]);

    expect(result.seeds).toHaveLength(2);
    expect(new Set(result.seeds.map((seed) => seed.seedId)).size).toBe(2);
    expect(result.seeds.map((seed) => seed.sensitivity)).toEqual(['internal', 'confidential']);
  });

  it('rejects duplicate repositories before overwriting an existing seed', async () => {
    const { runner } = createFakeGit();
    await expect(
      stage(workDir, runner, [
        { repo: 'octo/private', sensitivity: 'internal' },
        { repo: 'octo/private', sensitivity: 'internal' },
      ]),
    ).rejects.toThrow(/already exists/);
  });

  it('uses the production git runner when no test runner is supplied', async () => {
    mockExeca.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1];
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        fs.writeFileSync(path.join(dest, '.git', 'config'), '[core]\n');
        fs.writeFileSync(path.join(dest, 'README.md'), 'contents\n');
        return { stdout: '' };
      }
      return { stdout: `${'a'.repeat(40)}\n` };
    });

    const paths = resolveBoundedQueryPaths(workDir);
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });

    const result = await stageBoundedQuerySeeds({
      repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      paths,
      runId: 'f'.repeat(32),
      token: TOKEN,
    });

    expect(result.seeds[0].commit).toBe('a'.repeat(40));
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      expect.any(Array),
      expect.objectContaining({ extendEnv: false, timeout: expect.any(Number) }),
    );
  });

  it('canonicalizes a non-Error staging failure', async () => {
    const failing: GitRunner = async () => Promise.reject('clone rejected');
    await expect(stage(workDir, failing)).rejects.toThrow(/clone rejected/);
  });
});

describe('releaseSeedPermissions', () => {
  it('restores owner write access so cleanup can remove read-only seeds', async () => {
    const workDir = makeTempWorkDir();
    try {
      const { runner } = createFakeGit();
      const { paths } = await stage(workDir, runner);

      expect(() => fs.rmSync(paths.seedsDir, { recursive: true })).toThrow();
      releaseSeedPermissions(paths.seedsDir);
      expect(() => fs.rmSync(paths.seedsDir, { recursive: true })).not.toThrow();
    } finally {
      releaseSeedPermissions(resolveBoundedQueryPaths(workDir).seedsDir);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('is a no-op for a missing directory', () => {
    expect(() => releaseSeedPermissions('/nonexistent/awf-bounded-query-seeds')).not.toThrow();
  });
});

describe('scrubSeed', () => {
  it('rejects a gitdir-pointer .git file (external repository reference)', () => {
    const workDir = makeTempWorkDir();
    try {
      const seed = path.join(workDir, 'seed');
      fs.mkdirSync(seed, { recursive: true });
      fs.writeFileSync(path.join(seed, '.git'), 'gitdir: /elsewhere/.git\n');

      expect(() => scrubSeed(seed)).toThrow(/not a directory/i);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('rejects a checkout carrying .git/modules', () => {
    const workDir = makeTempWorkDir();
    try {
      const seed = path.join(workDir, 'seed');
      fs.mkdirSync(path.join(seed, '.git', 'modules'), { recursive: true });

      expect(() => scrubSeed(seed)).toThrow(/submodule/i);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('staging read-only verification', () => {
  it('reports writable paths left in a seed', () => {
    const workDir = makeTempWorkDir();
    try {
      const seed = path.join(workDir, 'seed');
      fs.mkdirSync(seed, { mode: 0o700 });
      fs.writeFileSync(path.join(seed, 'writable'), 'contents', { mode: 0o600 });

      expect(() => stagingTestHelpers.verifySeedReadOnly(seed))
        .toThrow(/2 writable path\(s\)/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('ignores symlinks when checking write permissions', () => {
    const workDir = makeTempWorkDir();
    const seed = path.join(workDir, 'seed');
    try {
      fs.mkdirSync(seed, { mode: 0o700 });
      fs.symlinkSync('/tmp', path.join(seed, 'link'));
      fs.chmodSync(seed, 0o500);

      expect(() => stagingTestHelpers.verifySeedReadOnly(seed)).not.toThrow();
    } finally {
      fs.chmodSync(seed, 0o700);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
