import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import { prepareEnclaves, teardownEnclaves } from './manager';
import { releaseSeedPermissions, type GitRunner } from '../bounded-query/staging';
import { resolveEnclavePaths } from './paths';

const gitRunner: GitRunner = async (args) => {
  if (args.includes('clone')) {
    const destination = args[args.length - 1];
    fs.mkdirSync(path.join(destination, '.git'), { recursive: true });
    fs.writeFileSync(path.join(destination, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(destination, 'README.md'), 'private\n');
    return { stdout: '' };
  }
  if (args[0] === 'rev-parse') return { stdout: 'a'.repeat(40) };
  return { stdout: '' };
};

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const mockExeca = execa as unknown as jest.Mock;

function config(workDir: string, overrides: Parameters<typeof normalizeEnclavesConfig>[0] = {}): WrapperConfig {
  return {
    workDir,
    enclaves: normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { script: { enabled: true } },
      ...overrides,
    }),
  } as WrapperConfig;
}

describe('prepareEnclaves fail-closed preflight', () => {
  let workDir: string;

  beforeEach(() => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-manager-'));
  });

  afterEach(() => {
    const paths = resolveEnclavePaths(workDir);
    releaseSeedPermissions(paths.seedsDir);
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('rejects a network Docker daemon before staging', async () => {
    await expect(prepareEnclaves(config(workDir), {
      env: { GH_TOKEN: 'secret', DOCKER_HOST: 'tcp://daemon:2375' },
      assertPrimaryAvailable: jest.fn(),
      assertScriptRuntimeAvailable: jest.fn(),
    })).rejects.toThrow(/Unix-socket Docker host/);
  });

  it('rejects the future agent executor rather than half-enabling it', async () => {
    await expect(prepareEnclaves(config(workDir, {
      executors: {
        script: { enabled: true },
        agent: { enabled: true, model: 'future-model' },
      },
    }), {
      env: { GH_TOKEN: 'secret' },
      assertPrimaryAvailable: jest.fn(),
      assertScriptRuntimeAvailable: jest.fn(),
    })).rejects.toThrow(/reserved for migration layer 3/);
  });

  it('rejects the unimplemented sbx script runtime before staging', async () => {
    await expect(prepareEnclaves(config(workDir, {
      executors: { script: { enabled: true, runtime: 'sbx' } },
    }), {
      env: { GH_TOKEN: 'secret' },
      assertPrimaryAvailable: jest.fn(),
      assertScriptRuntimeAvailable: jest.fn(),
    })).rejects.toThrow(/runtime "sbx" is not implemented/);
  });

  it('requires a staging credential before runtime probes', async () => {
    const assertPrimaryAvailable = jest.fn();
    await expect(prepareEnclaves(config(workDir), {
      env: {},
      assertPrimaryAvailable,
      assertScriptRuntimeAvailable: jest.fn(),
    })).rejects.toThrow(/staging credential/);
    expect(assertPrimaryAvailable).not.toHaveBeenCalled();
  });

  it('stages immutable seeds and a private MCP capability before Compose starts', async () => {
    await prepareEnclaves(config(workDir), {
      env: { GH_TOKEN: 'secret' },
      gitRunner,
      assertPrimaryAvailable: jest.fn().mockResolvedValue(undefined),
      assertScriptRuntimeAvailable: jest.fn().mockResolvedValue(undefined),
    });
    const paths = resolveEnclavePaths(workDir);
    const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8'));
    expect(seedMap).toMatchObject({
      version: 2,
      runId: expect.stringMatching(/^[0-9a-f]{32}$/),
      seeds: [{
        repo: 'octo/private',
        seedId: expect.stringMatching(/^[0-9a-f]{32}$/),
        sensitivity: 'internal',
      }],
    });
    expect(fs.readFileSync(paths.capabilityPath, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(paths.capabilityPath).mode & 0o777).toBe(0o600);
    expect(paths.root.startsWith(workDir)).toBe(false);
    expect(paths.ingressRoot.startsWith(workDir)).toBe(false);
  });

  it('removes labelled orphan containers and both private roots on teardown', async () => {
    const wrapperConfig = config(workDir);
    await prepareEnclaves(wrapperConfig, {
      env: { GH_TOKEN: 'secret' },
      gitRunner,
      assertPrimaryAvailable: jest.fn().mockResolvedValue(undefined),
      assertScriptRuntimeAvailable: jest.fn().mockResolvedValue(undefined),
    });
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'a'.repeat(12) })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' });
    const paths = resolveEnclavePaths(workDir);
    const runId = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8')).runId;
    await teardownEnclaves(wrapperConfig);
    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['ps', '-aq', '--filter', `label=awf.enclave.run=${runId}`],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['rm', '-f', 'a'.repeat(12)],
      expect.objectContaining({ reject: false }),
    );
    expect(fs.existsSync(paths.root)).toBe(false);
    expect(fs.existsSync(paths.ingressRoot)).toBe(false);
  });

  it('preserves private state and fails loudly when orphan cleanup fails', async () => {
    const wrapperConfig = config(workDir);
    await prepareEnclaves(wrapperConfig, {
      env: { GH_TOKEN: 'secret' },
      gitRunner,
      assertPrimaryAvailable: jest.fn().mockResolvedValue(undefined),
      assertScriptRuntimeAvailable: jest.fn().mockResolvedValue(undefined),
    });
    mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'daemon unavailable' });
    const paths = resolveEnclavePaths(workDir);
    await expect(teardownEnclaves(wrapperConfig)).rejects.toThrow(
      /Failed to list orphaned enclave script containers/,
    );
    expect(fs.existsSync(paths.root)).toBe(true);
    expect(fs.existsSync(paths.ingressRoot)).toBe(true);
  });
});
