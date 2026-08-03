import {
  assertEnclaveRuntimeAvailable,
  assertPrimaryRuntimeAvailable,
  resolveApiProxyRoute,
  validateBoundedAgentConfig,
} from './preflight';
import { BOUNDED_AGENT_DEFAULTS, type BoundedAgentsConfig } from '../types/bounded-agent-options';
import type { WrapperConfig } from '../types';
import * as boundedQueryPreflight from '../bounded-query/preflight';

/**
 * Fail-closed preflight coverage.
 *
 * Everything here must abort the run *before* staging clones a private
 * repository and before any container exists, and nothing may ever downgrade
 * to a weaker runtime.
 */

const boundedAgents = (overrides: Partial<BoundedAgentsConfig> = {}): BoundedAgentsConfig => ({
  ...BOUNDED_AGENT_DEFAULTS,
  enabled: true,
  model: 'gpt-4o-mini',
  privateRepos: [{ repo: 'octo/alpha', sensitivity: 'internal' }],
  ...overrides,
});

const config = (overrides: Partial<WrapperConfig> = {}): WrapperConfig => ({
  enableApiProxy: true,
  openaiApiKey: 'sk-real',
  boundedAgents: boundedAgents(),
  ...overrides,
} as WrapperConfig);

const env = { GH_TOKEN: 'ghs_token' } as NodeJS.ProcessEnv;

describe('validateBoundedAgentConfig', () => {
  it('accepts a complete, minimal configuration', () => {
    expect(validateBoundedAgentConfig(config(), env)).toEqual([]);
  });

  it('is a no-op when bounded agents are not enabled', () => {
    expect(validateBoundedAgentConfig(config({ boundedAgents: undefined }), {})).toEqual([]);
    expect(
      validateBoundedAgentConfig(config({ boundedAgents: boundedAgents({ enabled: false }) }), {}),
    ).toEqual([]);
  });

  it('requires the API proxy', () => {
    const errors = validateBoundedAgentConfig(config({ enableApiProxy: false }), env);
    expect(errors.join('\n')).toMatch(/require the AWF API proxy/);
  });

  it('requires a configured API target for the selected profile', () => {
    const openaiMissing = validateBoundedAgentConfig(config({ openaiApiKey: undefined }), env);
    expect(openaiMissing.join('\n')).toMatch(/supported configured API target for profile "openai"/);

    const anthropic = config({
      boundedAgents: boundedAgents({ profile: 'anthropic', model: 'claude-sonnet-4' }),
      openaiApiKey: undefined,
      anthropicApiKey: undefined,
    });
    expect(validateBoundedAgentConfig(anthropic, env).join('\n')).toMatch(
      /supported configured API target for profile "anthropic"/,
    );

    const anthropicOk = config({
      boundedAgents: boundedAgents({ profile: 'anthropic', model: 'claude-sonnet-4' }),
      openaiApiKey: undefined,
      anthropicApiKey: 'sk-ant-real',
    });
    expect(validateBoundedAgentConfig(anthropicOk, env)).toEqual([]);
  });

  it('requires a model', () => {
    const errors = validateBoundedAgentConfig(config({ boundedAgents: boundedAgents({ model: '' }) }), env);
    expect(errors.join('\n')).toMatch(/boundedAgents\.model is required/);
  });

  it('requires a staging credential', () => {
    const errors = validateBoundedAgentConfig(config(), {});
    expect(errors.join('\n')).toMatch(/GH_TOKEN or GITHUB_TOKEN/);
  });

  it('requires a non-empty, unique, bare owner/repo allowlist', () => {
    expect(
      validateBoundedAgentConfig(config({ boundedAgents: boundedAgents({ privateRepos: [] }) }), env)
        .join('\n'),
    ).toMatch(/privateRepos is empty/);

    expect(
      validateBoundedAgentConfig(
        config({
          boundedAgents: boundedAgents({
            privateRepos: [
              { repo: 'octo/alpha', sensitivity: 'internal' },
              { repo: 'Octo/Alpha', sensitivity: 'public' },
            ],
          }),
        }),
        env,
      ).join('\n'),
    ).toMatch(/duplicate entry/);

    expect(
      validateBoundedAgentConfig(
        config({
          boundedAgents: boundedAgents({
            privateRepos: [{ repo: 'https://github.com/octo/alpha', sensitivity: 'internal' }],
          }),
        }),
        env,
      ).join('\n'),
    ).toMatch(/bare owner\/repo slug/);
  });

  it('accepts sbx as a schema-level enclave runtime (capability-gated, not config-rejected)', () => {
    // sbx is fully schema-accepted at the configuration level: whether it is
    // actually usable is decided later by assertEnclaveRuntimeAvailable's
    // capability proof, never by blanket config rejection.
    expect(validateBoundedAgentConfig(config({ boundedAgents: boundedAgents({ runtime: 'sbx' }) }), env))
      .toEqual([]);
  });

  it('accepts every implemented and capability-gated backend', () => {
    for (const runtime of ['docker', 'gvisor', 'sbx'] as const) {
      expect(validateBoundedAgentConfig(config({ boundedAgents: boundedAgents({ runtime }) }), env))
        .toEqual([]);
    }
  });

  it('rejects an unknown enclave runtime name with no downgrade', () => {
    const errors = validateBoundedAgentConfig(
      config({ boundedAgents: boundedAgents({ runtime: 'wasm' as unknown as BoundedAgentsConfig['runtime'] }) }),
      env,
    );
    expect(errors.join('\n')).toMatch(/"wasm" is not supported/);
    expect(errors.join('\n')).toMatch(/never downgrade/);
  });

  it('no longer rejects a primary sbx microVM at the config-validation level', () => {
    // The primary-agent runtime axis is proven independently by the
    // bounded-agent-specific assertPrimaryRuntimeAvailable, not blanket-rejected
    // here: a primary sbx microVM is supported once its bounded-agent ingress
    // is proven (see ./ingress.ts).
    expect(validateBoundedAgentConfig(config({ containerRuntime: 'sbx' }), env)).toEqual([]);
  });

  it('rejects exposing the enclave Docker daemon to the primary agent', () => {
    const errors = validateBoundedAgentConfig(config({ enableDind: true }), env);
    expect(errors.join('\n')).toMatch(/cannot be combined with enableDind/);
    expect(errors.join('\n')).toMatch(/bypass the finite-disclosure ledger/);
  });

  it('rejects a non-Unix Docker host', () => {
    const errors = validateBoundedAgentConfig(config({ awfDockerHost: 'tcp://10.0.0.1:2375' }), env);
    expect(errors.join('\n')).toMatch(/Unix-socket Docker host/);
  });

  it('bounds every conservative resource and budget field', () => {
    const cases: Array<[Partial<BoundedAgentsConfig>, RegExp]> = [
      [{ timeout: 0 }, /timeout must be a positive integer/],
      [{ timeout: 10_000 }, /timeout must be at most/],
      [{ maxInvocations: 0 }, /maxInvocations must be a positive integer/],
      [{ maxModelRequests: 0 }, /maxModelRequests must be a positive integer/],
      [{ maxModelTokens: 0 }, /maxModelTokens must be a positive integer/],
      [{ pidsLimit: 0 }, /pidsLimit must be a positive integer/],
      [{ maxOutputBytes: 0 }, /maxOutputBytes must be between/],
      [{ maxOutputBytes: 1_000_000 }, /maxOutputBytes must be between/],
      [{ maxTaskBytes: 0 }, /maxTaskBytes must be between/],
      [{ maxTaskBytes: 1_000_000 }, /maxTaskBytes must be between/],
      [{ memoryLimit: 'lots' }, /is not a Docker memory limit/],
      [{ tmpfsLimit: '64' }, /is not a Docker size limit/],
      [{ cpuLimit: 'all' }, /positive Docker --cpus value/],
      [{ cpuLimit: '0' }, /positive Docker --cpus value/],
    ];
    for (const [patch, matcher] of cases) {
      const errors = validateBoundedAgentConfig(
        config({ boundedAgents: boundedAgents(patch) }),
        env,
      );
      expect(errors.join('\n')).toMatch(matcher);
    }
  });
});

describe('resolveApiProxyRoute', () => {
  it('maps each profile to its provider credential', () => {
    expect(resolveApiProxyRoute({ openaiApiKey: 'k' } as WrapperConfig, 'openai').routed).toBe(true);
    expect(resolveApiProxyRoute({ openaiApiKey: 'k' } as WrapperConfig, 'anthropic').routed).toBe(false);
    expect(resolveApiProxyRoute({ anthropicApiKey: 'k' } as WrapperConfig, 'anthropic').routed).toBe(true);
  });
});

describe('assertEnclaveRuntimeAvailable', () => {
  it('accepts docker when the daemon is reachable', async () => {
    await expect(
      assertEnclaveRuntimeAvailable(boundedAgents(), async () => false, async () => true),
    ).resolves.toBeUndefined();
  });

  it('rejects docker when the daemon is unreachable, with no fallback', async () => {
    await expect(
      assertEnclaveRuntimeAvailable(boundedAgents(), async () => true, async () => false),
    ).rejects.toThrow(/never fall back/);
  });

  it('requires an exactly registered runsc for gvisor', async () => {
    const runtimes: string[] = [];
    await expect(
      assertEnclaveRuntimeAvailable(
        boundedAgents({ runtime: 'gvisor' }),
        async (name) => {
          runtimes.push(name);
          return true;
        },
        async () => true,
      ),
    ).resolves.toBeUndefined();
    expect(runtimes).toEqual(['runsc']);
  });

  it('never downgrades gvisor to the default runtime', async () => {
    await expect(
      assertEnclaveRuntimeAvailable(
        boundedAgents({ runtime: 'gvisor' }),
        async () => false,
        // Even a perfectly healthy default Docker runtime must not rescue this.
        async () => true,
      ),
    ).rejects.toThrow(/never fall back to a weaker runtime/);
  });

  it('accepts sbx when the capability probe reports full support', async () => {
    const querySbxCapabilities = jest.fn(async () => ({ supported: true, missing: [], auditedVersion: '0.37.1' }));
    await expect(
      assertEnclaveRuntimeAvailable(
        boundedAgents({ runtime: 'sbx' }),
        async () => true,
        async () => true,
        querySbxCapabilities,
      ),
    ).resolves.toBeUndefined();
    expect(querySbxCapabilities).toHaveBeenCalledTimes(1);
  });

  it('blocks sbx with the exact missing capabilities and never falls back, honestly reflecting audited 0.37.1', async () => {
    const missing = ['pinned AWF bounded-agent sbx template and bootstrap', 'sbx create --network'];
    await expect(
      assertEnclaveRuntimeAvailable(
        boundedAgents({ runtime: 'sbx' }),
        async () => true,
        async () => true,
        async () => ({ supported: false, missing, auditedVersion: '0.37.1' }),
      ),
    ).rejects.toThrow(/pinned AWF bounded-agent sbx template and bootstrap.*sbx create --network/);
    await expect(
      assertEnclaveRuntimeAvailable(
        boundedAgents({ runtime: 'sbx' }),
        async () => true,
        async () => true,
        async () => ({ supported: false, missing, auditedVersion: '0.37.1' }),
      ),
    ).rejects.toThrow(/never fall back to Docker or gVisor/);
  });

  it('rejects an unrecognized runtime with no implemented launcher', async () => {
    await expect(
      assertEnclaveRuntimeAvailable(
        { ...boundedAgents(), runtime: 'wasm' as unknown as BoundedAgentsConfig['runtime'] },
        async () => true,
        async () => true,
      ),
    ).rejects.toThrow(/no implemented enclave launcher/);
  });
});

describe('assertPrimaryRuntimeAvailable', () => {
  it('is not the bounded-query implementation: bounded-agent errors must never leak bounded-query wording', () => {
    expect(assertPrimaryRuntimeAvailable).not.toBe(boundedQueryPreflight.assertPrimaryRuntimeAvailable);
  });

  it.each([
    [undefined, 'docker'],
    ['docker', 'docker'],
    ['gvisor', 'gvisor'],
    ['runsc', 'gvisor'],
    ['sbx', 'sbx'],
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

  it('always identifies failures as bounded-agent, never bounded-query', async () => {
    await expect(assertPrimaryRuntimeAvailable(
      undefined,
      jest.fn().mockResolvedValue(false),
      jest.fn().mockResolvedValue(false),
      jest.fn().mockResolvedValue(false),
    )).rejects.toThrow(/Bounded agents abort before staging/);

    let sbxError: Error | undefined;
    try {
      await assertPrimaryRuntimeAvailable(
        'sbx',
        jest.fn().mockResolvedValue(false),
        jest.fn().mockResolvedValue(false),
        jest.fn().mockResolvedValue(false),
      );
    } catch (error) {
      sbxError = error as Error;
    }
    expect(sbxError?.message).toMatch(/Bounded agents abort before staging/);
    expect(sbxError?.message).not.toMatch(/[Bb]ounded quer(y|ies)/);
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
