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
