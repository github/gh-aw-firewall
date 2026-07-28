import type { WrapperConfig } from '../types';
import execa from 'execa';
import { assertProbeRuntimeAvailable, preflightTestHelpers, validateSealedProbeConfig } from './preflight';
import type { SealedProbesConfig } from '../types';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const mockExeca = execa as unknown as jest.Mock;

const baseSealedProbes: SealedProbesConfig = {
  enabled: true,
  privateRepos: ['octo/private'],
  runtime: 'docker',
  timeout: 30,
  memoryLimit: '512m',
  interpreter: 'python3',
  maxInvocations: 32,
};

function buildConfig(overrides: Partial<SealedProbesConfig> = {}, config: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    workDir: '/tmp/awf-test',
    sealedProbes: { ...baseSealedProbes, ...overrides },
    ...config,
  } as unknown as WrapperConfig;
}

const envWithToken: NodeJS.ProcessEnv = { GH_TOKEN: 'ghs_example' };

describe('validateSealedProbeConfig', () => {
  it('accepts a well-formed enabled configuration', () => {
    expect(validateSealedProbeConfig(buildConfig(), envWithToken)).toEqual([]);
  });

  it('returns no errors when sealed probes are absent or disabled', () => {
    expect(validateSealedProbeConfig({ workDir: '/tmp/x' } as unknown as WrapperConfig, {})).toEqual([]);
    expect(validateSealedProbeConfig(buildConfig({ enabled: false }), {})).toEqual([]);
  });

  it('rejects an enabled configuration with no repositories', () => {
    const errors = validateSealedProbeConfig(buildConfig({ privateRepos: [] }), envWithToken);
    expect(errors.join('\n')).toContain('privateRepos is empty');
  });

  it.each([
    ['https://github.com/octo/private', 'scheme'],
    ['octo/private?x=1', 'query'],
    ['octo/private#frag', 'fragment'],
    ['octo/*', 'wildcard'],
    ['octo/../etc', 'traversal'],
    ['user:token@octo/private', 'credentials'],
    ['octo/private/extra', 'extra path segment'],
  ])('rejects unsafe repository slug %s (%s)', (repo) => {
    const errors = validateSealedProbeConfig(buildConfig({ privateRepos: [repo] }), envWithToken);
    expect(errors.join('\n')).toContain('is not a bare owner/repo slug');
  });

  it('rejects case-insensitive duplicates', () => {
    const errors = validateSealedProbeConfig(
      buildConfig({ privateRepos: ['octo/private', 'Octo/Private'] }),
      envWithToken,
    );
    expect(errors.join('\n')).toContain('duplicate entry');
  });

  it('fails closed for an unsupported probe runtime instead of downgrading', () => {
    // Cast to bypass the type check — JSON parsing at runtime can produce any string.
    const errors = validateSealedProbeConfig(buildConfig({ runtime: 'vmware' as 'docker' }), envWithToken);
    expect(errors.join('\n')).toContain('is not supported');
    expect(errors.join('\n')).toContain('never downgrade');
  });

  it('accepts the gvisor probe runtime at the configuration layer', () => {
    expect(validateSealedProbeConfig(buildConfig({ runtime: 'gvisor' }), envWithToken)).toEqual([]);
  });

  it('rejects a microVM primary agent runtime, which cannot receive the socket', () => {
    const errors = validateSealedProbeConfig(buildConfig({}, { containerRuntime: 'sbx' }), envWithToken);
    expect(errors.join('\n')).toContain('cannot be exposed to a "sbx" primary agent');
  });

  it('allows a gvisor primary agent runtime (still a Compose service)', () => {
    expect(validateSealedProbeConfig(buildConfig({}, { containerRuntime: 'gvisor' }), envWithToken)).toEqual([]);
  });

  it('requires a staging credential on the AWF host', () => {
    const errors = validateSealedProbeConfig(buildConfig(), {});
    expect(errors.join('\n')).toContain('GH_TOKEN or GITHUB_TOKEN');
  });

  it('rejects a TCP Docker host, which a network-less broker cannot reach', () => {
    const errors = validateSealedProbeConfig(buildConfig({}, { awfDockerHost: 'tcp://localhost:2375' }), envWithToken);
    expect(errors.join('\n')).toContain('require a Unix-socket Docker host');
  });

  it('rejects a TCP DOCKER_HOST inherited from the environment', () => {
    const errors = validateSealedProbeConfig(buildConfig(), {
      ...envWithToken,
      DOCKER_HOST: 'tcp://127.0.0.1:2375',
    });
    expect(errors.join('\n')).toContain('require a Unix-socket Docker host');
  });

  it('accepts an explicit Unix-socket Docker host', () => {
    expect(
      validateSealedProbeConfig(buildConfig({}, { awfDockerHost: 'unix:///run/user/1001/docker.sock' }), envWithToken),
    ).toEqual([]);
  });

  it('accepts GITHUB_TOKEN as the staging credential', () => {
    expect(validateSealedProbeConfig(buildConfig(), { GITHUB_TOKEN: 'ghs_x' })).toEqual([]);
  });

  it('rejects out-of-range or malformed limits', () => {
    const errors = validateSealedProbeConfig(
      buildConfig({ timeout: 0, maxInvocations: 0, memoryLimit: 'lots' }),
      envWithToken,
    );
    expect(errors.join('\n')).toContain('timeout must be a positive integer');
    expect(errors.join('\n')).toContain('maxInvocations must be a positive integer');
    expect(errors.join('\n')).toContain('is not a Docker memory limit');
  });

  it('rejects an unsupported interpreter', () => {
    const errors = validateSealedProbeConfig(
      buildConfig({ interpreter: 'ruby' as unknown as SealedProbesConfig['interpreter'] }),
      envWithToken,
    );
    expect(errors.join('\n')).toContain('interpreter "ruby" is not supported');
  });
});

describe('assertProbeRuntimeAvailable', () => {
  it('does not probe Docker for the default runtime', async () => {
    const probe = jest.fn();
    await expect(assertProbeRuntimeAvailable(baseSealedProbes, probe)).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('accepts gvisor when runsc is registered with the daemon', async () => {
    const probe = jest.fn().mockResolvedValue(true);
    await expect(
      assertProbeRuntimeAvailable({ ...baseSealedProbes, runtime: 'gvisor' }, probe),
    ).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledWith('runsc');
  });

  it('fails closed when runsc is unavailable', async () => {
    const probe = jest.fn().mockResolvedValue(false);
    await expect(
      assertProbeRuntimeAvailable({ ...baseSealedProbes, runtime: 'gvisor' }, probe),
    ).rejects.toThrow(/runsc.*not available|not available.*fall back/s);
  });

  it('detects registered runtimes through Docker info', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '{"runc":{},"runsc":{}}' });
    await expect(preflightTestHelpers.defaultDockerRuntimeProbe('runsc')).resolves.toBe(true);
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['info', '--format', '{{json .Runtimes}}'],
      expect.objectContaining({ reject: false }),
    );
  });

  it('fails closed when Docker info fails or returns malformed JSON', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: '' });
    await expect(preflightTestHelpers.defaultDockerRuntimeProbe('runsc')).resolves.toBe(false);

    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: 'not-json' });
    await expect(preflightTestHelpers.defaultDockerRuntimeProbe('runsc')).resolves.toBe(false);
  });
});
