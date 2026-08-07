import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCloneUrl,
  buildStagingGitEnv,
  EnclaveStagingError,
  releaseSeedPermissions,
  resolveStagingToken,
  stageEnclaveSeeds,
  stagingTestHelpers,
  type GitRunner,
} from './staging';
import { resolveEnclavePaths } from './paths';

const TOKEN = 'ghs_super_secret_value';

describe('enclave staging', () => {
  it('resolves credentials with GH_TOKEN precedence', () => {
    expect(resolveStagingToken({ GH_TOKEN: 'first', GITHUB_TOKEN: 'second' })).toBe('first');
    expect(resolveStagingToken({ GITHUB_TOKEN: 'second' })).toBe('second');
    expect(resolveStagingToken({})).toBeUndefined();
  });

  it('constructs only credential-free GitHub clone URLs', () => {
    expect(buildCloneUrl('octo/private')).toBe('https://github.com/octo/private.git');
    expect(() => buildCloneUrl('https://evil.example/repo')).toThrow(EnclaveStagingError);
  });

  it('passes a token file path, not token content or inherited credentials', () => {
    const env = buildStagingGitEnv({
      tokenFilePath: '/private/staging-token',
      askpassPath: '/private/askpass.sh',
      isolatedHome: '/private/home',
    });
    expect(env[stagingTestHelpers.ASKPASS_TOKEN_FILE_ENV]).toBe('/private/staging-token');
    expect(Object.values(env).join('\n')).not.toContain(TOKEN);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('scrubs credential-bearing metadata and makes staged seeds immutable', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-staging-'));
    const paths = resolveEnclavePaths(workDir, path.join(workDir, 'private'));
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const gitRunner: GitRunner = async (args, options) => {
      calls.push({ args, env: options.env });
      if (args.includes('clone')) {
        const destination = args[args.length - 1];
        fs.mkdirSync(path.join(destination, '.git', 'hooks'), { recursive: true });
        fs.mkdirSync(path.join(destination, '.git', 'objects', 'info'), { recursive: true });
        fs.writeFileSync(
          path.join(destination, '.git', 'config'),
          `[remote "origin"]\n\turl = https://x-access-token:${TOKEN}@github.com/octo/private.git\n`,
        );
        fs.writeFileSync(path.join(destination, '.git', 'hooks', 'post-checkout'), 'malicious');
        fs.writeFileSync(path.join(destination, 'README.md'), 'private');
      }
      return { stdout: args[0] === 'rev-parse' ? '0123456789abcdef0123456789abcdef01234567\n' : '' };
    };

    try {
      const result = await stageEnclaveSeeds({
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
        paths,
        runId: 'f'.repeat(32),
        token: TOKEN,
        gitRunner,
      });
      expect(result.seeds).toHaveLength(1);
      expect(calls.every(({ args }) => !args.join(' ').includes(TOKEN))).toBe(true);
      expect(calls.every(({ env }) => !Object.values(env).join('\n').includes(TOKEN))).toBe(true);
      const seed = path.join(paths.seedsDir, result.seeds[0].seedId);
      expect(fs.existsSync(path.join(seed, '.git', 'hooks'))).toBe(false);
      expect(fs.readFileSync(path.join(seed, '.git', 'config'), 'utf8')).not.toContain(TOKEN);
      expect(fs.statSync(path.join(seed, 'README.md')).mode & 0o222).toBe(0);
    } finally {
      releaseSeedPermissions(paths.seedsDir);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
