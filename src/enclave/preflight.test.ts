import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import { validateEnclavesConfig } from './preflight';

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    workDir: '/tmp/awf',
    enclaves: normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { script: { enabled: true } },
    }),
    ...overrides,
  } as WrapperConfig;
}

describe('validateEnclavesConfig', () => {
  it('accepts a minimal normalized foundation configuration', () => {
    expect(validateEnclavesConfig(config())).toEqual([]);
  });

  it('rejects duplicate repositories and no enabled executor', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [
        { repo: 'octo/private', sensitivity: 'internal' },
        { repo: 'Octo/Private', sensitivity: 'internal' },
      ],
      executors: {},
    });
    const errors = validateEnclavesConfig(config({ enclaves }));
    expect(errors.join('\n')).toMatch(/duplicate entry/);
    expect(errors.join('\n')).toMatch(/no enclave executor is enabled/);
  });

  it('rejects an empty repository list', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      executors: { script: { enabled: true } },
    });
    expect(validateEnclavesConfig(config({ enclaves })).join('\n')).toMatch(/privateRepos is empty/);
  });

  it('rejects script disclosure bounds the container cannot enforce', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: {
        script: {
          enabled: true,
          maxScriptBytes: 65_537,
          maxOutputBytes: 8_193,
        },
      },
    });
    const errors = validateEnclavesConfig(config({ enclaves })).join('\n');
    expect(errors).toMatch(/maxScriptBytes must be at most 65536/);
    expect(errors).toMatch(/maxOutputBytes must be at most 8192/);
  });

  it('requires the API proxy and a usable route for the agent executor', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { agent: { enabled: true, model: 'gpt-5' } },
    });

    expect(validateEnclavesConfig(config({ enclaves })).join('\n')).toMatch(/requires the AWF API proxy/);
    expect(validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
    })).join('\n')).toMatch(/COPILOT_GITHUB_TOKEN/);
    expect(validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      copilotGithubToken: 'token',
    }))).toEqual([]);
  });

  it('rejects malformed executor controls that bypass schema validation', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'not-a-slug', sensitivity: 'internal' }],
      executors: {
        script: {
          enabled: true,
          runtime: 'invalid' as 'docker',
          network: 'bridge' as 'none',
          interpreter: 'ruby' as 'python3',
          timeout: 0,
          memoryLimit: 'lots',
          cpuLimit: '0',
          pidsLimit: 0,
          tmpfsLimit: '64',
          maxOutputBytes: 0,
          maxScriptBytes: 0,
          maxInvocations: 0,
        },
        agent: {
          enabled: true,
          runtime: 'invalid' as 'docker',
          engine: 'invalid' as 'copilot',
          network: 'bridge' as 'api-proxy-only',
          model: '',
          timeout: 601,
          memoryLimit: 'lots',
          cpuLimit: 'all',
          pidsLimit: 0,
          tmpfsLimit: '64',
          maxOutputBytes: 0,
          maxTaskBytes: 0,
          maxInvocations: 0,
        },
      },
    });

    const errors = validateEnclavesConfig(config({ enclaves, enableApiProxy: true })).join('\n');
    expect(errors).toMatch(/not a bare owner\/repo slug/);
    expect(errors).toMatch(/script.runtime "invalid" is not supported/);
    expect(errors).toMatch(/script.network must be "none"/);
    expect(errors).toMatch(/script.interpreter must be "python3"/);
    expect(errors).toMatch(/script.timeout must be between/);
    expect(errors).toMatch(/agent.runtime "invalid" is not supported/);
    expect(errors).toMatch(/agent.engine "invalid" is not supported/);
    expect(errors).toMatch(/agent.network must be "api-proxy-only"/);
    expect(errors).toMatch(/agent.model is required/);
    expect(errors).toMatch(/agent.timeout must be between/);
    expect(errors).toMatch(/is not a Docker size/);
    expect(errors).toMatch(/positive Docker --cpus value/);
    expect(errors).toMatch(/must be a positive integer/);
  });

  it('accepts an agent executor with a routed API-proxy model target', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { agent: { enabled: true, model: 'gpt-test' } },
    });
    expect(validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      copilotGithubToken: 'token',
    }))).toEqual([]);
  });

  it('rejects an agent executor whose engine has no audited enclave image', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { agent: { enabled: true, model: 'claude-test', engine: 'claude' } },
    });
    const errors = validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      anthropicApiKey: 'key',
    })).join('\n');
    expect(errors).toMatch(/engine "claude" is not implemented/);
    expect(errors).toMatch(/never fall back to a different engine/);
  });

  it('rejects an agent executor without a configured provider route', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { agent: { enabled: true, model: 'gpt-test' } },
    });
    expect(validateEnclavesConfig(config({ enclaves, enableApiProxy: true })).join('\n'))
      .toMatch(/requires a configured API target for engine "copilot"/);
  });

  it('rejects a Copilot base URL without a credential', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { agent: { enabled: true, model: 'gpt-test' } },
    });
    expect(validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      copilotProviderBaseUrl: 'https://models.example.test',
    })).join('\n')).toMatch(/requires a configured API target for engine "copilot"/);
  });

  it('rejects any enclave executor combined with a Docker socket in the primary agent', () => {
    expect(validateEnclavesConfig(config({ enableDind: true })).join('\n'))
      .toMatch(/enclaves cannot be combined with enableDind/);

    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { agent: { enabled: true, model: 'gpt-test' } },
    });
    expect(validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      copilotGithubToken: 'token',
      enableDind: true,
    })).join('\n')).toMatch(/enclaves cannot be combined with enableDind/);
  });

  it('rejects script-only enclaves when the primary agent receives the Docker socket', () => {
    expect(validateEnclavesConfig(config({ enableDind: true }))).toEqual(
      expect.arrayContaining([expect.stringContaining('cannot be combined with enableDind')]),
    );
  });

  it.each([
    '/var/run/docker.sock:/var/run/docker.sock',
    '/var/run:/host-run:ro',
  ])('rejects a custom bind that exposes the Docker socket: %s', (volume) => {
    expect(validateEnclavesConfig(config({ volumeMounts: [volume] })).join('\n'))
      .toMatch(/cannot expose the Docker socket.*custom volume/);
  });

  it('rejects an agent executor that cannot reach a model or drops its network', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { agent: { enabled: true } },
    });
    const errors = validateEnclavesConfig(config({ enclaves })).join('\n');
    expect(errors).toMatch(/agent.model is required/);
    expect(errors).toMatch(/agent executor requires the AWF API proxy/);
  });

  it('rejects agent disclosure and resource bounds the enclave cannot enforce', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: {
        agent: {
          enabled: true,
          model: 'gpt-test',
          timeout: 100_000,
          memoryLimit: 'huge',
          cpuLimit: '0',
          pidsLimit: 0,
          maxOutputBytes: 0,
        },
      },
    });
    const errors = validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      copilotGithubToken: 'token',
    })).join('\n');
    for (const pattern of [
      /agent.timeout must be between/,
      /agent.memoryLimit is not a Docker size/,
      /agent.cpuLimit must be a positive/,
      /agent.pidsLimit must be a positive integer/,
      /agent.maxOutputBytes must be a positive integer/,
    ]) {
      expect(errors).toMatch(pattern);
    }
  });

  it('rejects agent bounds above the server and native-loop hard ceilings', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: {
        agent: {
          enabled: true,
          model: 'gpt-test',
          maxOutputBytes: 8193,
          maxTaskBytes: 65_537,
        },
      },
    });
    const errors = validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      copilotGithubToken: 'token',
    })).join('\n');
    expect(errors).toMatch(/agent.maxOutputBytes must be at most 8192/);
    expect(errors).toMatch(/agent.maxTaskBytes must be at most 65536/);
  });

  it('rejects script disclosure bounds the container cannot enforce', () => {
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: {
        script: {
          enabled: true,
          maxScriptBytes: 65_537,
          maxOutputBytes: 8_193,
        },
      },
    });
    const errors = validateEnclavesConfig(config({ enclaves })).join('\n');
    expect(errors).toMatch(/maxScriptBytes must be at most 65536/);
    expect(errors).toMatch(/maxOutputBytes must be at most 8192/);
  });
});
