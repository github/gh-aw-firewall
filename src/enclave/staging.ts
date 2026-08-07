import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { logger } from '../logger';
import type { EnclaveRepository } from '../types/enclave-options';
import {
  PRIVATE_REPOSITORY_PATTERN,
  type PrivateRepositorySeedDescriptor,
  type PrivateRepositoryStagingResult,
  normalizePrivateRepositoryKey,
} from '../bounded-execution';
import { deriveEnclaveSeedId, type EnclavePaths } from './paths';

/**
 * Trusted host-side staging: materializes one immutable, credential-free seed
 * per configured private repository before anything untrusted starts.
 *
 * Security properties this module is responsible for:
 *
 * - The staging token is read from the AWF host environment and passed to
 *   `git` **only** through the child process environment plus a `GIT_ASKPASS`
 *   helper. It never appears in argv, in a clone URL, in the compose file, in
 *   the primary agent, MCP server, executor environment, or any log line.
 * - Each seed is scrubbed of every credential- or escape-bearing artifact
 *   (remotes, credential helpers, hooks, alternates, worktree links, reflogs)
 *   and rejected outright if it declares submodules.
 * - Each seed is made read-only and that is verified before staging succeeds.
 *
 * Staging failures are fatal: the caller must abort before the primary agent
 * starts.
 */

/** Environment variable the askpass helper reads the token file path from. */
const ASKPASS_TOKEN_FILE_ENV = 'AWF_ENCLAVE_STAGING_TOKEN_FILE';

/** Username git sends alongside a GitHub token over HTTPS Basic auth. */
const TOKEN_USERNAME = 'x-access-token';

/** Maximum wall-clock time allowed for a single staging git command. */
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `.git` entries that are removed from every seed.
 *
 * `config` is not listed: it is *rewritten* (see {@link rewriteGitConfig})
 * rather than deleted, because git refuses to operate on a repository with no
 * `core.repositoryformatversion`.
 */
const GIT_DIR_REMOVALS = [
  'hooks',
  'worktrees',
  'commondir',
  'gitdir',
  'logs',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'shallow',
  'objects/info/alternates',
  'objects/info/http-alternates',
];

/** Minimal, credential-free replacement for a seed's `.git/config`. */
const MINIMAL_GIT_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '\tfilemode = true',
  '\tbare = false',
  '\tlogallrefupdates = false',
  '',
].join('\n');

/** Runs a git command. Injectable so unit tests never touch a real network. */
export type GitRunner = (
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

const defaultGitRunner: GitRunner = async (args, options) => {
  const result = await execa('git', args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: false,
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: result.stdout };
};

export interface StageEnclaveSeedsParams {
  /** Trusted repository descriptors exactly as configured (already schema-validated). */
  repos: EnclaveRepository[];
  /**
   * Resolved private-root layout.
   *
   * Structurally typed so tests can use a minimal private-root layout.
   */
  paths: Pick<EnclavePaths, 'root' | 'seedsDir'>;
  /** Run-unique id used to derive opaque seed directory names. */
  runId: string;
  /** Staging credential. Never logged, never forwarded past this module. */
  token: string;
  /** Override the git runner (tests). */
  gitRunner?: GitRunner;
  /** Log prefix identifying the calling subsystem. */
  label?: string;
}

/** Thrown for every staging failure. Messages never contain the token. */
export class EnclaveStagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnclaveStagingError';
  }
}

/**
 * Reads the staging credential from the AWF host environment.
 *
 * `GH_TOKEN` wins over `GITHUB_TOKEN` to match the precedence used elsewhere
 * in AWF (see `cli-proxy-service.ts`).
 */
export function resolveStagingToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  return token && token.length > 0 ? token : undefined;
}

/**
 * Builds the clone URL for a repository.
 *
 * The URL is constructed by AWF from a validated `owner/repo` slug — the
 * agent never supplies a URL — and deliberately carries no userinfo component
 * so the token cannot leak through `.git/config`, process listings, or git's
 * own error messages.
 */
export function buildCloneUrl(repo: string): string {
  if (!PRIVATE_REPOSITORY_PATTERN.test(repo)) {
    throw new EnclaveStagingError(`Refusing to stage unsafe repository slug: ${repo}`);
  }
  return `https://github.com/${repo}.git`;
}

/**
 * Writes the staging token to a 0o600 file inside the (already 0o700) protected
 * query root.
 *
 * Placing the credential in a file (rather than a child-process environment
 * variable) prevents it from appearing in `/proc/<git-pid>/environ` for the
 * duration of the clone. Only the file PATH — not its content — appears in
 * the git process environment.
 */
function writeTokenFile(root: string, token: string): string {
  const tokenFilePath = path.join(root, 'staging-token');
  fs.writeFileSync(tokenFilePath, token, { mode: 0o600 });
  fs.chmodSync(tokenFilePath, 0o600);
  return tokenFilePath;
}

/**
 * Writes the `GIT_ASKPASS` helper used to hand the token to git.
 *
 * The helper reads the token from a file whose PATH is in its environment;
 * the token itself never appears in the environment or in argv.
 * The file is created inside the (already 0o700) enclave root.
 */
function writeAskpassHelper(root: string): string {
  const askpassPath = path.join(root, 'askpass.sh');
  const script = [
    '#!/bin/sh',
    '# Generated by AWF enclave staging. Reads the credential from a',
    '# file so the token itself never appears in the environment or in argv.',
    'case "$1" in',
    `  Username*) printf '%s' '${TOKEN_USERNAME}' ;;`,
    `  *) cat "\${${ASKPASS_TOKEN_FILE_ENV}}" ;;`,
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(askpassPath, script, { mode: 0o700 });
  fs.chmodSync(askpassPath, 0o700);
  return askpassPath;
}

/**
 * Builds the environment for a staging git invocation.
 *
 * `extendEnv: false` is used at the call site, so this is the *complete*
 * environment git sees: no inherited proxy settings, no inherited credential
 * helpers, no unrelated secrets.
 *
 * The staging credential is passed as a FILE PATH (not the token itself),
 * so it does not appear in `/proc/<git-pid>/environ`.
 */
export function buildStagingGitEnv(params: {
  tokenFilePath: string;
  askpassPath: string;
  isolatedHome: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    // An empty, AWF-owned HOME/XDG root means git cannot pick up a user
    // ~/.gitconfig, a credential helper, or an insteadOf rewrite.
    HOME: params.isolatedHome,
    XDG_CONFIG_HOME: path.join(params.isolatedHome, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: params.askpassPath,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    // The token FILE PATH (non-sensitive) is in the environment.
    // The token itself lives in the file (0o600, not in env / not /proc-visible).
    [ASKPASS_TOKEN_FILE_ENV]: params.tokenFilePath,
  };
}

/** Recursively applies a permission transform to a directory tree. */
function walkAndChmod(target: string, transform: (mode: number, isDir: boolean) => number): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;

  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      walkAndChmod(path.join(target, entry), transform);
    }
  }
  fs.chmodSync(target, transform(stat.mode & 0o7777, stat.isDirectory()));
}

/** Strips every write bit from a staged seed so it becomes immutable. */
function makeSeedReadOnly(seedPath: string): void {
  walkAndChmod(seedPath, (mode) => mode & ~0o222);
}

/**
 * Restores owner-write permissions on a seed tree.
 *
 * Required before AWF's generic work-directory cleanup can remove the seeds:
 * `rm -rf` cannot unlink entries inside a directory that has no write bit.
 */
export function releaseSeedPermissions(seedsDir: string): void {
  if (!fs.existsSync(seedsDir)) return;
  walkAndChmod(seedsDir, (mode, isDir) => (isDir ? mode | 0o700 : mode | 0o200));
}

/** Fails staging if any entry in the seed is still writable. */
function verifySeedReadOnly(seedPath: string): void {
  const offenders: string[] = [];

  const visit = (target: string): void => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return;
    if ((stat.mode & 0o222) !== 0) {
      offenders.push(target);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) {
        visit(path.join(target, entry));
      }
    }
  };

  visit(seedPath);

  if (offenders.length > 0) {
    throw new EnclaveStagingError(
      `Seed is not read-only after staging (${offenders.length} writable path(s), first: ${offenders[0]})`,
    );
  }
}

/**
 * Rejects a checkout that declares submodules.
 *
 * v1 policy is reject-not-omit: a submodule implies an external reference the
 * query sandbox must never be able to resolve, and silently dropping it would
 * hand the query a repository that does not match what the operator approved.
 */
function assertNoSubmodules(seedPath: string): void {
  const gitmodules = path.join(seedPath, '.gitmodules');
  if (fs.existsSync(gitmodules)) {
    throw new EnclaveStagingError(
      'Repository declares submodules (.gitmodules); enclaves reject submodule-bearing repositories',
    );
  }

  const modulesDir = path.join(seedPath, '.git', 'modules');
  if (fs.existsSync(modulesDir)) {
    throw new EnclaveStagingError(
      'Repository contains .git/modules; enclaves reject submodule-bearing repositories',
    );
  }
}

/** Replaces the cloned `.git/config` with a minimal, credential-free one. */
function rewriteGitConfig(gitDir: string): void {
  fs.writeFileSync(path.join(gitDir, 'config'), MINIMAL_GIT_CONFIG, { mode: 0o600 });
}

/** Drops every remote-tracking ref so no upstream identity survives. */
function removeRemoteRefs(gitDir: string): void {
  const remotesDir = path.join(gitDir, 'refs', 'remotes');
  fs.rmSync(remotesDir, { recursive: true, force: true });

  const packedRefsPath = path.join(gitDir, 'packed-refs');
  let content: string;
  try {
    content = fs.readFileSync(packedRefsPath, 'utf8');
  } catch {
    // packed-refs doesn't exist; nothing to filter.
    return;
  }

  const kept = content
    .split('\n')
    .filter((line) => !line.includes('refs/remotes/'));
  fs.writeFileSync(packedRefsPath, kept.join('\n'), { mode: 0o600 });
}

/**
 * Removes every credential-, hook-, and external-reference-bearing artifact
 * from a freshly cloned seed.
 */
export function scrubSeed(seedPath: string): void {
  const gitDirPath = path.join(seedPath, '.git');
  const gitDirStat = fs.lstatSync(gitDirPath);
  if (gitDirStat.isSymbolicLink()) {
    throw new EnclaveStagingError('Refusing to stage a seed whose .git is a symlink');
  }
  if (!gitDirStat.isDirectory()) {
    // A file-form `.git` is a gitdir pointer into an external repository —
    // exactly the external reference enclaves must never resolve.
    throw new EnclaveStagingError('Refusing to stage a seed whose .git is not a directory');
  }

  assertNoSubmodules(seedPath);

  for (const relative of GIT_DIR_REMOVALS) {
    fs.rmSync(path.join(gitDirPath, relative), { recursive: true, force: true });
  }

  removeRemoteRefs(gitDirPath);
  rewriteGitConfig(gitDirPath);
}

async function stageOneSeed(
  repository: EnclaveRepository,
  params: Required<Pick<StageEnclaveSeedsParams, 'paths' | 'runId'>> & {
    gitRunner: GitRunner;
    gitEnv: NodeJS.ProcessEnv;
  },
): Promise<PrivateRepositorySeedDescriptor> {
  const { paths, runId, gitRunner, gitEnv } = params;
  const { repo, sensitivity } = repository;
  const seedId = deriveEnclaveSeedId(runId, repo);
  const seedPath = path.join(paths.seedsDir, seedId);

  if (fs.existsSync(seedPath)) {
    throw new EnclaveStagingError(`Seed directory already exists: ${seedId}`);
  }
  fs.mkdirSync(seedPath, { recursive: true, mode: 0o700 });

  const cloneUrl = buildCloneUrl(repo);
  await gitRunner(
    [
      '-c',
      'protocol.version=2',
      'clone',
      '--quiet',
      '--depth=1',
      '--single-branch',
      '--no-tags',
      '--no-hardlinks',
      '--recurse-submodules=no',
      cloneUrl,
      seedPath,
    ],
    { env: gitEnv },
  );

  const { stdout: commit } = await gitRunner(['rev-parse', 'HEAD'], { cwd: seedPath, env: gitEnv });

  scrubSeed(seedPath);
  makeSeedReadOnly(seedPath);
  verifySeedReadOnly(seedPath);

  return {
    repoKey: normalizePrivateRepositoryKey(repo),
    repo,
    seedId,
    seedPath,
    commit: commit.trim(),
    // Trusted AWF configuration state, carried unmodified — staging never
    // derives sensitivity from anything the clone/checkout produced.
    sensitivity,
  };
}

/**
 * Materializes an immutable seed for every configured repository.
 *
 * On any failure the partially-staged tree is released and removed, and a
 * {@link EnclaveStagingError} is thrown so the caller aborts before the
 * primary agent starts.
 */
export async function stageEnclaveSeeds(
  params: StageEnclaveSeedsParams,
): Promise<PrivateRepositoryStagingResult> {
  const { repos, paths, runId, token } = params;
  const gitRunner = params.gitRunner ?? defaultGitRunner;
  const label = params.label ?? 'Enclaves';

  const isolatedHome = path.join(paths.root, 'staging-home');
  fs.mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.seedsDir, { recursive: true, mode: 0o700 });

  const askpassPath = writeAskpassHelper(paths.root);
  // Write the token to a file so it never enters git's /proc-visible environment.
  const tokenFilePath = writeTokenFile(paths.root, token);
  const gitEnv = buildStagingGitEnv({ tokenFilePath, askpassPath, isolatedHome });

  const seeds: PrivateRepositorySeedDescriptor[] = [];
  try {
    for (const repository of repos) {
      logger.info(`${label}: staging seed for ${repository.repo} (sensitivity: ${repository.sensitivity})...`);
      seeds.push(await stageOneSeed(repository, { paths, runId, gitRunner, gitEnv }));
    }
  } catch (error) {
    releaseSeedPermissions(paths.seedsDir);
    fs.rmSync(paths.seedsDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new EnclaveStagingError(`${label}: staging failed: ${message}`);
  } finally {
    // The helper, token file, and isolated HOME are only needed for the
    // duration of staging. Removing them leaves no staging artifact behind
    // for the server, the agent, or a later phase to find.
    fs.rmSync(askpassPath, { force: true });
    fs.rmSync(tokenFilePath, { force: true });
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }

  for (const seed of seeds) {
    logger.debug(`Enclaves: staged ${seed.repo} at ${seed.commit} (seed ${seed.seedId})`);
  }

  return { runId, seeds };
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const stagingTestHelpers = {
  ASKPASS_TOKEN_FILE_ENV,
  GIT_DIR_REMOVALS,
  MINIMAL_GIT_CONFIG,
  writeAskpassHelper,
  writeTokenFile,
  makeSeedReadOnly,
  verifySeedReadOnly,
};
