import type { WrapperConfig } from '../types';
import execa from 'execa';
import {
  assertPrimaryRuntimeAvailable,
  assertQueryRuntimeAvailable,
  preflightTestHelpers,
  validateBoundedQueryConfig,
} from './preflight';
import type { BoundedQueriesConfig } from '../types';
import type { BoundedQueryRepository } from '../types/bounded-query-options';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const mockExeca = execa as unknown as jest.Mock;

function repo(name: string, sensitivity: BoundedQueryRepository['sensitivity'] = 'internal'): BoundedQueryRepository {
  return { repo: name, sensitivity };
}

const baseBoundedQueries: BoundedQueriesConfig = {
  enabled: true,
  privateRepos: [repo('octo/private')],
  runtime: 'docker',
  timeout: 30,
  memoryLimit: '512m',
  interpreter: 'python3',
  maxInvocations: 32,
};

function buildConfig(overrides: Partial<BoundedQueriesConfig> = {}, config: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    workDir: '/tmp/awf-test',
    boundedQueries: { ...baseBoundedQueries, ...overrides },
    ...config,
  } as unknown as WrapperConfig;
}

const envWithToken: NodeJS.ProcessEnv = { GH_TOKEN: 'ghs_example' };

describe('validateBoundedQueryConfig', () => {
  it('accepts a well-formed enabled configuration', () => {
    expect(validateBoundedQueryConfig(buildConfig(), envWithToken)).toEqual([]);
  });

  it('returns no errors when bounded queries are absent or disabled', () => {
    expect(validateBoundedQueryConfig({ workDir: '/tmp/x' } as unknown as WrapperConfig, {})).toEqual([]);
    expect(validateBoundedQueryConfig(buildConfig({ enabled: false }), {})).toEqual([]);
  });

  it('rejects an enabled configuration with no repositories', () => {
    const errors = validateBoundedQueryConfig(buildConfig({ privateRepos: [] }), envWithToken);
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
  ])('rejects unsafe repository slug %s (%s)', (repoSlug) => {
    const errors = validateBoundedQueryConfig(buildConfig({ privateRepos: [repo(repoSlug)] }), envWithToken);
    expect(errors.join('\n')).toContain('is not a bare owner/repo slug');
  });

  it('rejects case-insensitive duplicates', () => {
    const errors = validateBoundedQueryConfig(
      buildConfig({ privateRepos: [repo('octo/private'), repo('Octo/Private')] }),
      envWithToken,
    );
    expect(errors.join('\n')).toContain('duplicate entry');
  });

  it('fails closed for an unsupported query runtime instead of downgrading', () => {
    // Cast to bypass the type check — JSON parsing at runtime can produce any string.
    const errors = validateBoundedQueryConfig(buildConfig({ runtime: 'vmware' as 'docker' }), envWithToken);
    expect(errors.join('\n')).toContain('is not supported');
    expect(errors.join('\n')).toContain('never downgrade');
  });

  it('accepts the gvisor query runtime at the configuration layer', () => {
    expect(validateBoundedQueryConfig(buildConfig({ runtime: 'gvisor' }), envWithToken)).toEqual([]);
  });

  it('accepts the sbx query runtime at the configuration layer for executable preflight', () => {
    expect(validateBoundedQueryConfig(buildConfig({ runtime: 'sbx' }), envWithToken)).toEqual([]);
  });

  it('accepts an sbx primary agent; trusted preflight selects and probes its ingress', () => {
    expect(validateBoundedQueryConfig(buildConfig({}, { containerRuntime: 'sbx' }), envWithToken)).toEqual([]);
  });

  it('allows a gvisor primary agent runtime (still a Compose service)', () => {
    expect(validateBoundedQueryConfig(buildConfig({}, { containerRuntime: 'gvisor' }), envWithToken)).toEqual([]);
  });

  it('requires a staging credential on the AWF host', () => {
    const errors = validateBoundedQueryConfig(buildConfig(), {});
    expect(errors.join('\n')).toContain('GH_TOKEN or GITHUB_TOKEN');
  });

  it('rejects a TCP Docker host, which a network-less broker cannot reach', () => {
    const errors = validateBoundedQueryConfig(buildConfig({}, { awfDockerHost: 'tcp://localhost:2375' }), envWithToken);
    expect(errors.join('\n')).toContain('require a Unix-socket Docker host');
  });

  it('rejects a TCP DOCKER_HOST inherited from the environment', () => {
    const errors = validateBoundedQueryConfig(buildConfig(), {
      ...envWithToken,
      DOCKER_HOST: 'tcp://127.0.0.1:2375',
    });
    expect(errors.join('\n')).toContain('require a Unix-socket Docker host');
  });

  it('accepts an explicit Unix-socket Docker host', () => {
    expect(
      validateBoundedQueryConfig(buildConfig({}, { awfDockerHost: 'unix:///run/user/1001/docker.sock' }), envWithToken),
    ).toEqual([]);
  });

  it('does not apply Docker-daemon transport requirements to the independent sbx query runtime', () => {
    expect(
      validateBoundedQueryConfig(
        buildConfig({ runtime: 'sbx' }, { awfDockerHost: 'tcp://localhost:2375' }),
        envWithToken,
      ),
    ).toEqual([]);
  });

  it('accepts GITHUB_TOKEN as the staging credential', () => {
    expect(validateBoundedQueryConfig(buildConfig(), { GITHUB_TOKEN: 'ghs_x' })).toEqual([]);
  });

  it('rejects out-of-range or malformed limits', () => {
    const errors = validateBoundedQueryConfig(
      buildConfig({ timeout: 0, maxInvocations: 0, memoryLimit: 'lots' }),
      envWithToken,
    );
    expect(errors.join('\n')).toContain('timeout must be a positive integer');
    expect(errors.join('\n')).toContain('maxInvocations must be a positive integer');
    expect(errors.join('\n')).toContain('is not a Docker memory limit');
  });

  it('accepts a timeout that preserves the final one-minute processing margin (540s)', () => {
    expect(validateBoundedQueryConfig(buildConfig({ timeout: 540 }), envWithToken)).toEqual([]);
  });

  it('rejects a timeout that consumes the final timing bucket processing margin', () => {
    const errors = validateBoundedQueryConfig(buildConfig({ timeout: 541 }), envWithToken);
    expect(errors.join('\n')).toContain('timeout must be at most 540 seconds');
    expect(errors.join('\n')).toContain('reserves its final minute');
  });

  it('rejects an unsupported interpreter', () => {
    const errors = validateBoundedQueryConfig(
      buildConfig({ interpreter: 'ruby' as unknown as BoundedQueriesConfig['interpreter'] }),
      envWithToken,
    );
    expect(errors.join('\n')).toContain('interpreter "ruby" is not supported');
  });
});

describe('assertQueryRuntimeAvailable', () => {
  it('requires a reachable Docker daemon for the default query runtime', async () => {
    const runtimeQuery = jest.fn();
    const dockerAvailable = jest.fn().mockResolvedValue(true);
    await expect(
      assertQueryRuntimeAvailable(baseBoundedQueries, runtimeQuery, jest.fn(), dockerAvailable),
    ).resolves.toBeUndefined();
    expect(runtimeQuery).not.toHaveBeenCalled();
    expect(dockerAvailable).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the Docker query daemon is unavailable', async () => {
    await expect(
      assertQueryRuntimeAvailable(
        baseBoundedQueries,
        jest.fn(),
        jest.fn(),
        jest.fn().mockResolvedValue(false),
      ),
    ).rejects.toThrow(/Docker daemon.*not available.*never fall back/s);
  });

  it('accepts gvisor when runsc is registered with the daemon', async () => {
    const query = jest.fn().mockResolvedValue(true);
    await expect(
      assertQueryRuntimeAvailable({ ...baseBoundedQueries, runtime: 'gvisor' }, query),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith('runsc');
  });

  it('fails closed when runsc is unavailable', async () => {
    const query = jest.fn().mockResolvedValue(false);
    await expect(
      assertQueryRuntimeAvailable({ ...baseBoundedQueries, runtime: 'gvisor' }, query),
    ).rejects.toThrow(/runsc.*not available|not available.*fall back/s);
  });

  it('routes custom and omitted runtimes through their fixed Docker capability checks', async () => {
    const runtimeQuery = jest.fn().mockResolvedValue(true);
    const dockerAvailable = jest.fn().mockResolvedValue(true);

    await expect(
      assertQueryRuntimeAvailable(
        { ...baseBoundedQueries, runtime: 'custom' } as unknown as BoundedQueriesConfig,
        runtimeQuery,
        jest.fn(),
        dockerAvailable,
      ),
    ).resolves.toBeUndefined();
    expect(runtimeQuery).toHaveBeenCalledWith('runsc');

    await expect(
      assertQueryRuntimeAvailable(
        { ...baseBoundedQueries, runtime: undefined } as unknown as BoundedQueriesConfig,
        runtimeQuery,
        jest.fn(),
        dockerAvailable,
      ),
    ).resolves.toBeUndefined();
    expect(dockerAvailable).toHaveBeenCalledTimes(1);
  });

  it('fails closed when custom and omitted runtime capability checks fail', async () => {
    await expect(
      assertQueryRuntimeAvailable(
        { ...baseBoundedQueries, runtime: 'custom' } as unknown as BoundedQueriesConfig,
        jest.fn().mockResolvedValue(false),
      ),
    ).rejects.toThrow(/runsc.*not available|not available.*fall back/s);

    await expect(
      assertQueryRuntimeAvailable(
        { ...baseBoundedQueries, runtime: undefined } as unknown as BoundedQueriesConfig,
        jest.fn(),
        jest.fn(),
        jest.fn().mockResolvedValue(false),
      ),
    ).rejects.toThrow(/Docker daemon.*not available.*never fall back/s);
  });

  it('fails closed when sbx lacks any mandatory query isolation capability', async () => {
    const query = jest.fn().mockResolvedValue({
      supported: false,
      version: '0.37.1',
      missing: ['sbx create --network=none', 'sbx create --pids-limit'],
    });
    await expect(
      assertQueryRuntimeAvailable(
        { ...baseBoundedQueries, runtime: 'sbx' },
        jest.fn(),
        query,
      ),
    ).rejects.toThrow(/sbx.*blocked.*network=none.*pids-limit.*never fall back/s);
  });

  it('accepts sbx only when the complete executable capability proof succeeds', async () => {
    const query = jest.fn().mockResolvedValue({
      supported: true,
      version: '0.37.1',
      missing: [],
    });
    await expect(
      assertQueryRuntimeAvailable(
        { ...baseBoundedQueries, runtime: 'sbx' },
        jest.fn(),
        query,
      ),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('detects registered runtimes through Docker info', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '{"runc":{},"runsc":{}}' });
    await expect(preflightTestHelpers.defaultDockerRuntimeQuery('runsc')).resolves.toBe(true);
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['info', '--format', '{{json .Runtimes}}'],
      expect.objectContaining({ reject: false }),
    );
  });

  it('fails closed when Docker info fails or returns malformed JSON', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: '' });
    await expect(preflightTestHelpers.defaultDockerRuntimeQuery('runsc')).resolves.toBe(false);

    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: 'not-json' });
    await expect(preflightTestHelpers.defaultDockerRuntimeQuery('runsc')).resolves.toBe(false);
  });

  it('reports the current sbx CLI as unsupported when essential controls are absent', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Docker Sandboxes v0.37.1' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '--name --cpus --memory --template',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '--user --workdir',
      });

    await expect(preflightTestHelpers.defaultSbxCapabilityQuery()).resolves.toEqual({
      supported: false,
      version: '0.37.1',
      missing: expect.arrayContaining([
        'pinned AWF Python query template and bootstrap',
        'sbx create --network=none',
        'sbx create --pids-limit',
        'sbx create --disk-limit',
        'sbx create --ulimit-fsize',
        'sbx create --mount-target',
      ]),
    });
  });

  describe('assertPrimaryRuntimeAvailable', () => {
    it.each([
      [undefined, 'docker'],
      ['docker', 'docker'],
      ['gvisor', 'gvisor'],
      ['runsc', 'gvisor'],
      ['sbx', 'sbx'],
      ['kata', 'custom'],
    ] as const)('accepts an available %s primary backend (%s)', async (runtime, _backend) => {
      await expect(assertPrimaryRuntimeAvailable(
        runtime,
        jest.fn().mockResolvedValue(true),
        jest.fn().mockResolvedValue(true),
        jest.fn().mockResolvedValue(true),
      )).resolves.toBeUndefined();
    });

    it.each([
      [undefined, /Docker primary-agent runtime is unavailable/],
      ['docker', /OCI runtime "docker" is not registered.*never fall back/s],
      ['gvisor', /Primary-agent runtime "gvisor".*runsc.*never fall back/s],
      ['sbx', /Primary-agent runtime "sbx" is unavailable.*never fall back/s],
      ['kata', /OCI runtime "kata" is not registered.*never fall back/s],
    ] as const)('fails %s before staging when its primary capability is unavailable', async (runtime, message) => {
      await expect(assertPrimaryRuntimeAvailable(
        runtime,
        jest.fn().mockResolvedValue(false),
        jest.fn().mockResolvedValue(false),
        jest.fn().mockResolvedValue(false),
      )).rejects.toThrow(message);
    });

    it('checks explicit docker runtime registration instead of Docker daemon availability', async () => {
      const runtimeQuery = jest.fn().mockResolvedValue(true);
      const dockerAvailable = jest.fn().mockResolvedValue(false);
      await expect(assertPrimaryRuntimeAvailable(
        'docker',
        runtimeQuery,
        dockerAvailable,
        jest.fn().mockResolvedValue(true),
      )).resolves.toBeUndefined();
      expect(runtimeQuery).toHaveBeenCalledWith('docker');
      expect(dockerAvailable).not.toHaveBeenCalled();
    });
  });

  it('requires authenticated sbx daemon reachability and preserves only its management environment', async () => {
    const savedToken = process.env.SBX_AUTH_TOKEN;
    const savedProxy = process.env.DOCKER_SANDBOXES_PROXY;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.SBX_AUTH_TOKEN = 'daemon-credential';
    process.env.DOCKER_SANDBOXES_PROXY = 'http://proxy.invalid';
    process.env.XDG_CONFIG_HOME = '/wrong/config';
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Docker Sandboxes v0.37.1' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' });

    try {
      const report = await preflightTestHelpers.defaultSbxCapabilityQuery();
      expect(report.missing).toContain('authenticated sbx CLI/daemon');
      expect(mockExeca).toHaveBeenCalledWith(
        'sbx',
        ['ls'],
        expect.objectContaining({
          env: expect.objectContaining({ SBX_AUTH_TOKEN: 'daemon-credential' }),
        }),
      );
      const lsOptions = mockExeca.mock.calls.find((call) => call[1][0] === 'ls')?.[2];
      expect(lsOptions.env).not.toHaveProperty('DOCKER_SANDBOXES_PROXY');
      expect(lsOptions.env).not.toHaveProperty('XDG_CONFIG_HOME');
    } finally {
      if (savedToken === undefined) delete process.env.SBX_AUTH_TOKEN;
      else process.env.SBX_AUTH_TOKEN = savedToken;
      if (savedProxy === undefined) delete process.env.DOCKER_SANDBOXES_PROXY;
      else process.env.DOCKER_SANDBOXES_PROXY = savedProxy;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  it('uses authenticated sbx listing for primary availability', async () => {
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: '[]' });

    await expect(preflightTestHelpers.defaultSbxAvailabilityQuery()).resolves.toBe(true);
    expect(mockExeca).toHaveBeenCalledWith(
      'sbx',
      ['ls'],
      expect.objectContaining({ reject: false }),
    );
  });
});
