import { validateAwfFileConfig } from '../config-file';
import {
  ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
  ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
  ENCLAVES_DEFAULTS,
} from '../types/enclave-options';
import { normalizeEnclavesConfig } from './enclave-parser';

const repository = { repo: 'octo-org/private-service', sensitivity: 'confidential' as const };

describe('normalizeEnclavesConfig', () => {
  it('is absent unless the section is configured', () => {
    expect(normalizeEnclavesConfig(undefined)).toBeUndefined();
  });

  it('applies conservative defaults without enabling executors', () => {
    expect(normalizeEnclavesConfig([])).toEqual(ENCLAVES_DEFAULTS);
    expect(ENCLAVES_DEFAULTS).toEqual({
      enabled: false,
      privateRepos: [],
      executors: {
        script: ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
        agent: ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
      },
    });
  });

  it('normalizes the keyed-array contract into trusted executor config', () => {
    expect(normalizeEnclavesConfig([
      { script: {}, repos: [repository], timeout: 45 },
      { agent: { model: 'gpt-5' }, repos: [repository], timeout: 180 },
    ])).toMatchObject({
      enabled: true,
      privateRepos: [repository],
      executors: {
        script: { enabled: true, network: 'none', interpreter: 'python3', timeout: 45 },
        agent: { enabled: true, network: 'api-proxy-only', model: 'gpt-5', timeout: 180 },
      },
    });
  });

  it('defaults script and agent timeouts to 30 and 120 seconds', () => {
    const config = normalizeEnclavesConfig([
      { script: {}, repos: [repository] },
      { agent: { model: 'gpt-5' }, repos: [repository] },
    ]);
    expect(config?.executors.script.timeout).toBe(30);
    expect(config?.executors.agent.timeout).toBe(120);
  });

  it('preserves trusted executor overrides', () => {
    expect(normalizeEnclavesConfig([
      { script: {}, runtime: 'gvisor', image: 'registry/script@sha256:abc', repos: [repository] },
    ])).toMatchObject({
      executors: {
        script: { enabled: true, runtime: 'gvisor', image: 'registry/script@sha256:abc' },
        agent: { enabled: false },
      },
    });
  });

  it('keeps a repository shared by both entries as one budgeted catalog entry', () => {
    expect(normalizeEnclavesConfig([
      { script: {}, repos: [repository] },
      { agent: { model: 'gpt-5' }, repos: [repository] },
    ])?.privateRepos).toEqual([repository]);
  });

  it('keeps conflicting sensitivities so validation can reject them', () => {
    expect(normalizeEnclavesConfig([
      { script: {}, repos: [repository] },
      { agent: { model: 'gpt-5' }, repos: [{ repo: 'octo-org/private-service', sensitivity: 'internal' }] },
    ])?.privateRepos).toHaveLength(2);
  });

  it('rejects entries that do not declare exactly one executor key', () => {
    expect(() => normalizeEnclavesConfig([{ repos: [repository] } as never])).toThrow(/exactly one/);
    expect(() => normalizeEnclavesConfig([
      { script: {}, agent: { model: 'gpt-5' }, repos: [repository] } as never,
    ])).toThrow(/exactly one/);
  });

  it('rejects more than one entry per executor kind', () => {
    expect(() => normalizeEnclavesConfig([
      { script: {}, repos: [repository] },
      { script: {}, repos: [repository] },
    ])).toThrow(/at most one "script" entry/);
    expect(() => normalizeEnclavesConfig([
      { agent: { model: 'gpt-5' }, repos: [repository] },
      { agent: { model: 'gpt-5' }, repos: [repository] },
    ])).toThrow(/at most one "agent" entry/);
  });
});

describe('enclaves JSON Schema', () => {
  it('accepts the gh-aw keyed-array contract', () => {
    expect(validateAwfFileConfig({
      enclaves: [
        { script: {}, repos: [repository], timeout: 45 },
        { agent: { model: 'gpt-5' }, repos: [repository], timeout: 180 },
      ],
    })).toEqual([]);
    expect(validateAwfFileConfig({ enclaves: [{ script: {}, repos: [repository] }] })).toEqual([]);
    expect(validateAwfFileConfig({
      enclaves: [{ agent: { model: 'gpt-5' }, repos: [repository] }],
    })).toEqual([]);
  });

  it('requires repos and exactly one executor key per entry', () => {
    expect(validateAwfFileConfig({ enclaves: [{ script: {} }] }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ enclaves: [{ repos: [repository] }] }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{ script: {}, agent: { model: 'gpt-5' }, repos: [repository] }],
    }).length).toBeGreaterThan(0);
  });

  it('allows at most one entry per executor kind', () => {
    expect(validateAwfFileConfig({
      enclaves: [
        { script: {}, repos: [repository] },
        { script: {}, repos: [repository] },
      ],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [
        { agent: { model: 'gpt-5' }, repos: [repository] },
        { agent: { model: 'gpt-4' }, repos: [repository] },
      ],
    }).length).toBeGreaterThan(0);
  });

  it('requires agent.model and rejects legacy shapes', () => {
    expect(validateAwfFileConfig({ enclaves: [{ agent: {}, repos: [repository] }] }).length)
      .toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: { enabled: true, privateRepos: [repository], executors: { script: { enabled: true } } },
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{ script: {}, repositories: [repository] }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{ script: { enabled: true }, repos: [repository] }],
    }).length).toBeGreaterThan(0);
  });

  it('keeps trusted controls closed and bounded', () => {
    expect(validateAwfFileConfig({
      enclaves: [{ script: { maxScriptBytes: 65_537 }, repos: [repository] }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{ agent: { model: 'gpt-5', tools: ['shell'] }, repos: [repository] }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5', maxModelRequests: 3, maxModelTokens: 10_000 },
        runtime: 'gvisor',
        image: 'registry/agent@sha256:abc',
        memoryLimit: '256m',
        cpuLimit: '0.5',
        pidsLimit: 32,
        tmpfsLimit: '24m',
        maxOutputBytes: 2048,
        maxInvocations: 3,
        repos: [repository],
      }],
    })).toEqual([]);
    expect(validateAwfFileConfig({
      enclaves: [{ script: {}, repos: [repository], timeout: 541 }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{ agent: { model: 'gpt-5' }, repos: [repository], timeout: 541 }],
    }).length).toBeGreaterThan(0);
  });
});
