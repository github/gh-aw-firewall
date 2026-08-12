import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import { validateEnclavesConfig } from './preflight';

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    workDir: '/tmp/awf',
    enclaves: normalizeEnclavesConfig([
      { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]),
    ...overrides,
  } as WrapperConfig;
}

describe('validateEnclavesConfig', () => {
  it('accepts a minimal normalized foundation configuration', () => {
    expect(validateEnclavesConfig(config())).toEqual([]);
  });

  it('rejects repositories shared with conflicting sensitivities', () => {
    const enclaves = normalizeEnclavesConfig([
      { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
      { agent: { model: 'gpt-5' }, repos: [{ repo: 'Octo/Private', sensitivity: 'confidential' }] },
    ]);
    expect(validateEnclavesConfig(config({ enclaves })).join('\n'))
      .toMatch(/conflicting sensitivities for "Octo\/Private"/);
  });

  it('rejects a normalized configuration with no executor entry', () => {
    const enclaves = normalizeEnclavesConfig([
      { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]);
    enclaves!.executors.script.enabled = false;
    expect(validateEnclavesConfig(config({ enclaves })).join('\n'))
      .toMatch(/no enclave executor entry is configured/);
  });

  it('rejects an empty repository list', () => {
    const enclaves = normalizeEnclavesConfig([
      { script: {} },
    ]);
    expect(validateEnclavesConfig(config({ enclaves })).join('\n')).toMatch(/entries declare no repos/);
  });

  it('rejects script disclosure bounds the container cannot enforce', () => {
    const enclaves = normalizeEnclavesConfig([
      {
        script: { maxScriptBytes: 65_537 },
        maxOutputBytes: 8_193,
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      },
    ]);
    const errors = validateEnclavesConfig(config({ enclaves })).join('\n');
    expect(errors).toMatch(/maxScriptBytes must be at most 65536/);
    expect(errors).toMatch(/maxOutputBytes must be at most 8192/);
  });

  it('requires the API proxy and a usable route for the agent executor', () => {
    const enclaves = normalizeEnclavesConfig([
      { agent: { model: 'gpt-5' }, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]);

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
    const enclaves = normalizeEnclavesConfig([
      {
        script: {
          network: 'bridge' as 'none',
          interpreter: 'ruby' as 'python3',
          maxScriptBytes: 0,
        } as never,
        runtime: 'invalid' as 'docker',
        memoryLimit: 'lots',
        cpuLimit: '0',
        pidsLimit: 0,
        tmpfsLimit: '64',
        maxOutputBytes: 0,
        maxInvocations: 0,
        repos: [{ repo: 'not-a-slug', sensitivity: 'internal' }],
        timeout: 0,
      },
      {
        agent: {
          engine: 'invalid' as 'copilot',
          network: 'bridge' as 'api-proxy-only',
          model: '',
          maxTaskBytes: 0,
        } as never,
        runtime: 'invalid' as 'docker',
        memoryLimit: 'lots',
        cpuLimit: 'all',
        pidsLimit: 0,
        tmpfsLimit: '64',
        maxOutputBytes: 0,
        maxInvocations: 0,
        repos: [{ repo: 'not-a-slug', sensitivity: 'internal' }],
        timeout: 601,
      },
    ]);

    const errors = validateEnclavesConfig(config({ enclaves, enableApiProxy: true })).join('\n');
    expect(errors).toMatch(/not a bare owner\/repo slug/);
    expect(errors).toMatch(/runtime "invalid" is not supported/);
    expect(errors).toMatch(/script.network must be "none"/);
    expect(errors).toMatch(/script.interpreter must be "python3"/);
    expect(errors).toMatch(/timeout must be between/);
    expect(errors).toMatch(/runtime "invalid" is not supported/);
    expect(errors).toMatch(/agent.engine "invalid" is not supported/);
    expect(errors).toMatch(/agent.network must be "api-proxy-only"/);
    expect(errors).toMatch(/agent.model is required/);
    expect(errors).toMatch(/timeout must be between/);
    expect(errors).toMatch(/is not a Docker size/);
    expect(errors).toMatch(/positive Docker --cpus value/);
    expect(errors).toMatch(/must be a positive integer/);
  });

  it('accepts an agent executor with a routed API-proxy model target', () => {
    const enclaves = normalizeEnclavesConfig([
      { agent: { model: 'gpt-test' }, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]);
    expect(validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      copilotGithubToken: 'token',
    }))).toEqual([]);
  });

  it('rejects an agent executor whose engine has no audited enclave image', () => {
    const enclaves = normalizeEnclavesConfig([
      {
        agent: { model: 'claude-test', engine: 'claude' },
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      },
    ]);
    const errors = validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      anthropicApiKey: 'key',
    })).join('\n');
    expect(errors).toMatch(/engine "claude" is not implemented/);
    expect(errors).toMatch(/never fall back to a different engine/);
  });

  it('rejects an agent executor without a configured provider route', () => {
    const enclaves = normalizeEnclavesConfig([
      { agent: { model: 'gpt-test' }, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]);
    expect(validateEnclavesConfig(config({ enclaves, enableApiProxy: true })).join('\n'))
      .toMatch(/requires a configured API target for engine "copilot"/);
  });

  it('rejects a Copilot base URL without a credential', () => {
    const enclaves = normalizeEnclavesConfig([
      { agent: { model: 'gpt-test' }, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]);
    expect(validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      copilotProviderBaseUrl: 'https://models.example.test',
    })).join('\n')).toMatch(/requires a configured API target for engine "copilot"/);
  });

  it('rejects any enclave executor combined with a Docker socket in the primary agent', () => {
    expect(validateEnclavesConfig(config({ enableDind: true })).join('\n'))
      .toMatch(/enclaves cannot be combined with enableDind/);

    const enclaves = normalizeEnclavesConfig([
      { agent: { model: 'gpt-test' }, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]);
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
    const enclaves = normalizeEnclavesConfig([
      { agent: { model: '' }, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]);
    const errors = validateEnclavesConfig(config({ enclaves })).join('\n');
    expect(errors).toMatch(/agent.model is required/);
    expect(errors).toMatch(/agent executor requires the AWF API proxy/);
  });

  it('rejects agent disclosure and resource bounds the enclave cannot enforce', () => {
    const enclaves = normalizeEnclavesConfig([
      {
        agent: { model: 'gpt-test' },
        memoryLimit: 'huge',
        cpuLimit: '0',
        pidsLimit: 0,
        maxOutputBytes: 0,
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
        timeout: 100_000,
      },
    ]);
    const errors = validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      copilotGithubToken: 'token',
    })).join('\n');
    for (const pattern of [
      /timeout must be between/,
      /memoryLimit is not a Docker size/,
      /cpuLimit must be a positive/,
      /pidsLimit must be a positive integer/,
      /maxOutputBytes must be a positive integer/,
    ]) {
      expect(errors).toMatch(pattern);
    }
  });

  it('rejects agent bounds above the server and native-loop hard ceilings', () => {
    const enclaves = normalizeEnclavesConfig([
      {
        agent: { model: 'gpt-test', maxTaskBytes: 65_537 },
        maxOutputBytes: 8193,
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      },
    ]);
    const errors = validateEnclavesConfig(config({
      enclaves,
      enableApiProxy: true,
      copilotGithubToken: 'token',
    })).join('\n');
    expect(errors).toMatch(/maxOutputBytes must be at most 8192/);
    expect(errors).toMatch(/agent.maxTaskBytes must be at most 65536/);
  });

  it('rejects script disclosure bounds the container cannot enforce', () => {
    const enclaves = normalizeEnclavesConfig([
      {
        script: { maxScriptBytes: 65_537 },
        maxOutputBytes: 8_193,
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      },
    ]);
    const errors = validateEnclavesConfig(config({ enclaves })).join('\n');
    expect(errors).toMatch(/maxScriptBytes must be at most 65536/);
    expect(errors).toMatch(/maxOutputBytes must be at most 8192/);
  });
});
