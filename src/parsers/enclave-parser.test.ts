import { validateAwfFileConfig } from '../config-file';
import {
  ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
  ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
  ENCLAVES_DEFAULTS,
} from '../types/enclave-options';
import { normalizeEnclavesConfig } from './enclave-parser';

describe('normalizeEnclavesConfig', () => {
  it('is absent unless the section is configured', () => {
    expect(normalizeEnclavesConfig(undefined)).toBeUndefined();
  });

  it('applies conservative defaults without enabling executors', () => {
    expect(normalizeEnclavesConfig({})).toEqual(ENCLAVES_DEFAULTS);
    expect(ENCLAVES_DEFAULTS).toEqual({
      enabled: false,
      privateRepos: [],
      executors: {
        script: ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
        agent: ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
      },
    });
  });

  it('preserves trusted executor overrides and shared repositories', () => {
    expect(normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'confidential' }],
      executors: {
        script: { enabled: true, runtime: 'gvisor', image: 'registry/script@sha256:abc' },
        agent: { enabled: true, model: 'gpt-5' },
      },
    })).toMatchObject({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'confidential' }],
      executors: {
        script: {
          enabled: true,
          runtime: 'gvisor',
          image: 'registry/script@sha256:abc',
          network: 'none',
        },
        agent: {
          enabled: true,
          model: 'gpt-5',
          network: 'api-proxy-only',
        },
      },
    });
  });
});

describe('enclaves JSON Schema', () => {
  const repository = { repo: 'octo/private', sensitivity: 'internal' as const };

  it('accepts script, agent, and combined executor definitions', () => {
    expect(validateAwfFileConfig({
      enclaves: {
        enabled: true,
        privateRepos: [repository],
        executors: { script: { enabled: true } },
      },
    })).toEqual([]);
    expect(validateAwfFileConfig({
      enclaves: {
        enabled: true,
        privateRepos: [repository],
        executors: { agent: { enabled: true, model: 'gpt-5' } },
      },
    })).toEqual([]);
    expect(validateAwfFileConfig({
      enclaves: {
        enabled: true,
        privateRepos: [repository],
        executors: {
          script: { enabled: true },
          agent: { enabled: true, model: 'gpt-5' },
        },
      },
    })).toEqual([]);
  });

  it('requires repositories and at least one explicitly enabled executor', () => {
    expect(validateAwfFileConfig({ enclaves: { enabled: true } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: { enabled: true, privateRepos: [repository], executors: {} },
    }).length).toBeGreaterThan(0);
  });

  it('keeps trusted controls closed and constrained', () => {
    expect(validateAwfFileConfig({
      enclaves: {
        enabled: true,
        privateRepos: [repository],
        executors: { script: { enabled: true, network: 'bridge' } },
      },
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: {
        enabled: true,
        privateRepos: [repository],
        executors: { agent: { enabled: true, model: 'gpt-5', tools: ['shell'] } },
      },
    }).length).toBeGreaterThan(0);
  });

});
