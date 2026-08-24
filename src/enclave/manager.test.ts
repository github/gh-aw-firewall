import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import {
  enclaveManagerTestHelpers,
  isEnclaveAgentEnabled,
  isEnclaveScriptEnabled,
  prepareEnclaves,
  teardownEnclaves,
} from './manager';
import { releaseSeedPermissions, type GitRunner } from './staging';
import { resolveEnclavePaths } from './paths';
import * as runtimePreflight from './runtime-preflight';

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

function enclaveEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GH_TOKEN: 'secret',
    AWF_ENCLAVE_MCP_CAPABILITY: 'a'.repeat(64),
    AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: 'test-run-identity',
    AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: 'http://127.0.0.1:8080/mcp/awf-enclave',
    MCP_GATEWAY_API_KEY: 'g'.repeat(48),
    ...overrides,
  };
}

function githubEnclaveEnv(workDir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const caCert = path.join(workDir, 'enclave-github-ca.crt');
  fs.writeFileSync(caCert, 'test-ca', { mode: 0o600 });
  return enclaveEnv({
    AWF_ENCLAVE_GITHUB_PROXY_CONTAINER: 'compiler-mcpg',
    AWF_ENCLAVE_GITHUB_PROXY_IDENTITY: 'gh-aw-egh-123456-1-abcdef123456',
    AWF_ENCLAVE_GITHUB_PROXY_CA_CERT: caCert,
    ...overrides,
  });
}

const repository = { repo: 'octo/private', sensitivity: 'internal' as const };

type EnclaveEntries = NonNullable<Parameters<typeof normalizeEnclavesConfig>[0]>;

const scriptEntries: EnclaveEntries = [{ script: {}, repos: [repository] }];

function config(workDir: string, entries: EnclaveEntries = scriptEntries): WrapperConfig {
  return {
    workDir,
    networkIsolation: true,
    topologyAttach: ['awmg-mcpg'],
    enclaves: normalizeEnclavesConfig(entries),
  } as WrapperConfig;
}

/** A configuration whose agent executor has a routed API-proxy model target. */
function agentConfig(
  workDir: string,
  entries: EnclaveEntries = scriptEntries,
): WrapperConfig {
  return {
    ...config(workDir, entries),
    enableApiProxy: true,
    copilotGithubToken: 'copilot-token',
  } as WrapperConfig;
}

/**
 * Runs staging but tolerates a sandboxed host that cannot create the private
 * `/var/tmp` root. Every other failure still fails the test, and the ordering
 * assertions below run either way because runtime proofs precede staging.
 */
async function prepareToleratingPrivateRootIo(
  wrapperConfig: WrapperConfig,
  deps: Parameters<typeof prepareEnclaves>[1],
): Promise<void> {
  try {
    await prepareEnclaves(wrapperConfig, deps);
  } catch (error) {
    if (!/EPERM|EACCES/.test(String(error))) throw error;
  }
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
      env: enclaveEnv({ DOCKER_HOST: 'tcp://daemon:2375' }),
      assertPrimaryAvailable: jest.fn(),
      assertScriptRuntimeAvailable: jest.fn(),
    })).rejects.toThrow(/Unix-socket Docker host/);
  });

  it('requires the compiler topology handoff before staging', async () => {
    const wrapperConfig = config(workDir);
    wrapperConfig.networkIsolation = false;
    wrapperConfig.topologyAttach = [];
    await expect(prepareEnclaves(wrapperConfig, {
      env: enclaveEnv(),
      assertPrimaryAvailable: jest.fn(),
      assertScriptRuntimeAvailable: jest.fn(),
    })).rejects.toThrow(/require networkIsolation/);
  });

  it('rejects a gateway container omitted from topologyAttach', async () => {
    const wrapperConfig = config(workDir);
    wrapperConfig.topologyAttach = ['another-peer'];
    await expect(prepareEnclaves(wrapperConfig, {
      env: enclaveEnv(),
      assertPrimaryAvailable: jest.fn(),
      assertScriptRuntimeAvailable: jest.fn(),
    })).rejects.toThrow(/topologyAttach to include/);
  });

  it('proves both executor runtimes before staging when both are enabled', async () => {
    const assertScriptRuntimeAvailable = jest.fn().mockResolvedValue(undefined);
    const assertAgentRuntimeAvailable = jest.fn().mockResolvedValue(undefined);
    await prepareToleratingPrivateRootIo(agentConfig(workDir, [
      { script: {}, repos: [repository] },
      { agent: { model: 'gpt-test' }, repos: [repository] },
    ]), {
      env: enclaveEnv(),
      gitRunner,
      assertPrimaryAvailable: jest.fn().mockResolvedValue(undefined),
      assertScriptRuntimeAvailable,
      assertAgentRuntimeAvailable,
    });

    expect(assertScriptRuntimeAvailable).toHaveBeenCalledTimes(1);
    expect(assertAgentRuntimeAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, runtime: 'docker', model: 'gpt-test' }),
    );
  });

  it('uses the default runtime proofs for enabled executors', async () => {
    const scriptProof = jest.spyOn(runtimePreflight, 'assertScriptRuntimeAvailable')
      .mockResolvedValueOnce(undefined);
    const agentProof = jest.spyOn(runtimePreflight, 'assertAgentRuntimeAvailable')
      .mockResolvedValueOnce(undefined);
    const wrapperConfig = agentConfig(workDir, [
      { script: {}, repos: [repository] },
      { agent: { model: 'gpt-test' }, repos: [repository] },
    ]);
    try {
      await prepareToleratingPrivateRootIo(wrapperConfig, {
        env: enclaveEnv(),
        gitRunner,
        assertPrimaryAvailable: jest.fn().mockResolvedValue(undefined),
      });
      expect(scriptProof).toHaveBeenCalledTimes(1);
      expect(agentProof).toHaveBeenCalledTimes(1);
      expect(isEnclaveScriptEnabled(wrapperConfig)).toBe(true);
      expect(isEnclaveAgentEnabled(wrapperConfig)).toBe(true);
    } finally {
      scriptProof.mockRestore();
      agentProof.mockRestore();
    }
  });

  it('never probes a disabled executor runtime', async () => {
    const assertScriptRuntimeAvailable = jest.fn().mockResolvedValue(undefined);
    const assertAgentRuntimeAvailable = jest.fn().mockResolvedValue(undefined);
    await prepareToleratingPrivateRootIo(agentConfig(workDir, [
      { agent: { model: 'gpt-test' }, repos: [repository] },
    ]), {
      env: enclaveEnv(),
      gitRunner,
      assertPrimaryAvailable: jest.fn().mockResolvedValue(undefined),
      assertScriptRuntimeAvailable,
      assertAgentRuntimeAvailable,
    });
    expect(assertScriptRuntimeAvailable).not.toHaveBeenCalled();
    expect(assertAgentRuntimeAvailable).toHaveBeenCalledTimes(1);
  });

  it('rejects the unproven sbx agent runtime before staging and never downgrades', async () => {
    const assertAgentRuntimeAvailable = jest.fn();
    await expect(prepareEnclaves(agentConfig(workDir, [
      { agent: { model: 'gpt-test' }, runtime: 'sbx', repos: [repository] },
    ]), {
      env: enclaveEnv(),
      assertPrimaryAvailable: jest.fn(),
      assertScriptRuntimeAvailable: jest.fn(),
      assertAgentRuntimeAvailable,
    })).rejects.toThrow(/agent.runtime "sbx" is not implemented/);
    expect(assertAgentRuntimeAvailable).not.toHaveBeenCalled();
  });

  it('rejects an agent executor without the mandatory API proxy', async () => {
    await expect(prepareEnclaves({
      ...agentConfig(workDir, [
        { agent: { model: 'gpt-test' }, repos: [repository] },
      ]),
      enableApiProxy: false,
    } as WrapperConfig, {
      env: enclaveEnv(),
      assertPrimaryAvailable: jest.fn(),
      assertAgentRuntimeAvailable: jest.fn(),
    })).rejects.toThrow(/agent executor requires the AWF API proxy/);
  });

  it.each([
    undefined,
    'a'.repeat(63),
    'A'.repeat(64),
    'z'.repeat(64),
  ])('rejects a malformed enclave GitHub capability root (%s)', async (root) => {
    await expect(prepareEnclaves(agentConfig(workDir, [{
      agent: {
        model: 'gpt-test',
        github: { cli: 'issues-read-v1' },
      },
      repos: [repository],
    }]), {
      env: githubEnclaveEnv(workDir, { MCP_GATEWAY_ENCLAVE_CAPABILITY_KEY: root }),
      assertPrimaryAvailable: jest.fn(),
      assertAgentRuntimeAvailable: jest.fn(),
    })).rejects.toThrow(/MCP_GATEWAY_ENCLAVE_CAPABILITY_KEY/);
  });

  it('rejects the unimplemented sbx script runtime before staging', async () => {
    await expect(prepareEnclaves(config(workDir, [
      { script: {}, runtime: 'sbx', repos: [repository] },
    ]), {
      env: enclaveEnv(),
      assertPrimaryAvailable: jest.fn(),
      assertScriptRuntimeAvailable: jest.fn(),
    })).rejects.toThrow(/runtime "sbx" is not implemented/);
  });

  it('requires a staging credential before runtime probes', async () => {
    const assertPrimaryAvailable = jest.fn();
    await expect(prepareEnclaves(config(workDir), {
      env: enclaveEnv({ GH_TOKEN: undefined }),
      assertPrimaryAvailable,
      assertScriptRuntimeAvailable: jest.fn(),
    })).rejects.toThrow(/staging credential/);
    expect(assertPrimaryAvailable).not.toHaveBeenCalled();
  });

  it('stages immutable seeds and a private MCP capability before Compose starts', async () => {
    await prepareEnclaves(config(workDir), {
      env: enclaveEnv(),
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
    expect(fs.readFileSync(paths.capabilityPath, 'utf8').trim()).toBe('a'.repeat(64));
    expect(fs.statSync(paths.capabilityPath).mode & 0o777).toBe(0o600);
    expect(paths.root.startsWith(workDir)).toBe(false);
    expect(paths.ingressRoot.startsWith(workDir)).toBe(false);
  });

  it('stages the GitHub HMAC root as a private mode-0600 file', async () => {
    const root = '0123456789abcdef'.repeat(4);
    await prepareEnclaves(agentConfig(workDir, [{
      agent: {
        model: 'gpt-test',
        github: { cli: 'issues-read-v1' },
      },
      repos: [repository],
    }]), {
      env: githubEnclaveEnv(workDir, { MCP_GATEWAY_ENCLAVE_CAPABILITY_KEY: root }),
      gitRunner,
      assertPrimaryAvailable: jest.fn().mockResolvedValue(undefined),
      assertAgentRuntimeAvailable: jest.fn().mockResolvedValue(undefined),
    });
    const paths = resolveEnclavePaths(workDir);
    expect(fs.readFileSync(paths.githubCapabilityKeyPath, 'utf8').trim()).toBe(root);
    expect(fs.statSync(paths.githubCapabilityKeyPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(paths.githubRunIdentityPath, 'utf8').trim())
      .toBe('gh-aw-egh-123456-1-abcdef123456');
    expect(fs.statSync(paths.githubRunIdentityPath).mode & 0o777).toBe(0o600);
    const seedRunId = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8')).runId;
    expect(seedRunId).toMatch(/^[0-9a-f]{32}$/);
    expect(seedRunId).not.toBe('gh-aw-egh-123456-1-abcdef123456');
  });

  it('removes labelled orphan containers and both private roots on teardown', async () => {
    const wrapperConfig = config(workDir);
    await prepareEnclaves(wrapperConfig, {
      env: enclaveEnv(),
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
      env: enclaveEnv(),
      gitRunner,
      assertPrimaryAvailable: jest.fn().mockResolvedValue(undefined),
      assertScriptRuntimeAvailable: jest.fn().mockResolvedValue(undefined),
    });
    mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'daemon unavailable' });
    const paths = resolveEnclavePaths(workDir);
    await expect(teardownEnclaves(wrapperConfig)).rejects.toThrow(
      /Failed to list orphaned enclave containers/,
    );
    expect(fs.existsSync(paths.root)).toBe(true);
    expect(fs.existsSync(paths.ingressRoot)).toBe(true);
  });

  it('uses the local enclave image and fails teardown when permission repair fails', async () => {
    const wrapperConfig = config(workDir);
    wrapperConfig.buildLocal = true;
    const paths = resolveEnclavePaths(workDir);
    fs.mkdirSync(paths.root, { recursive: true });
    fs.mkdirSync(paths.ingressRoot, { recursive: true });
    const remove = jest.fn((target: string) => {
      if (target === paths.root) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
    });
    const repair = jest.fn(() => false);
    expect(() => enclaveManagerTestHelpers.removePrivateState(wrapperConfig, paths, { remove, repair })).toThrow(
      /failed to repair private state permissions/,
    );
    expect(repair).toHaveBeenCalledWith(
      [paths.root, paths.ingressRoot],
      undefined,
      undefined,
      undefined,
      undefined,
      'awf-enclave-mcp-server:local',
    );
    expect(remove.mock.calls.filter(([target]) => target === paths.root)).toHaveLength(1);
  });
});
