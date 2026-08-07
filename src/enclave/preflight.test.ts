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

  it('fails closed when a legacy subsystem is also enabled', () => {
    const errors = validateEnclavesConfig(config({
      boundedAgents: { enabled: true } as WrapperConfig['boundedAgents'],
    }));
    expect(errors.join('\n')).toMatch(/cannot be enabled with boundedQueries or boundedAgents/);
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
          maxModelRequests: 0,
          maxModelTokens: 0,
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
      /agent.maxModelRequests must be a positive integer/,
      /agent.maxModelTokens must be a positive integer/,
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
          maxModelRequests: 65,
          maxModelTokens: 32_769,
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
    expect(errors).toMatch(/agent.maxModelRequests must be at most 64/);
    expect(errors).toMatch(/agent.maxModelTokens must be at most 32768/);
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
