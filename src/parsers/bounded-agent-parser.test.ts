import { normalizeBoundedAgentsConfig } from './bounded-agent-parser';
import { BOUNDED_AGENT_DEFAULTS } from '../types/bounded-agent-options';
import { validateAwfFileConfig } from '../config-file';

/**
 * Config/schema coverage for the `boundedAgents` section: defaults, explicit
 * overrides, and the fail-closed JSON Schema rules that the normalizer assumes
 * already hold.
 */
describe('normalizeBoundedAgentsConfig', () => {
  it('returns undefined when the section is absent', () => {
    expect(normalizeBoundedAgentsConfig(undefined)).toBeUndefined();
  });

  it('applies every centralized default for an empty section', () => {
    const normalized = normalizeBoundedAgentsConfig({});
    expect(normalized).toEqual({ ...BOUNDED_AGENT_DEFAULTS, privateRepos: [] });
  });

  it('only enables on an explicit true', () => {
    expect(normalizeBoundedAgentsConfig({})!.enabled).toBe(false);
    expect(normalizeBoundedAgentsConfig({ enabled: false })!.enabled).toBe(false);
    expect(normalizeBoundedAgentsConfig({ enabled: true })!.enabled).toBe(true);
  });

  it('preserves explicitly configured values', () => {
    const normalized = normalizeBoundedAgentsConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/Alpha', sensitivity: 'confidential' }],
      runtime: 'gvisor',
      engine: 'copilot',
      profile: 'anthropic',
      model: 'claude-sonnet-4',
      timeout: 240,
      memoryLimit: '1g',
      cpuLimit: '0.5',
      pidsLimit: 64,
      tmpfsLimit: '32m',
      maxOutputBytes: 512,
      maxTaskBytes: 1024,
      maxInvocations: 3,
      maxModelRequests: 4,
      maxModelTokens: 256,
    });

    expect(normalized).toEqual({
      enabled: true,
      privateRepos: [{ repo: 'octo/Alpha', sensitivity: 'confidential' }],
      runtime: 'gvisor',
      engine: 'copilot',
      profile: 'anthropic',
      model: 'claude-sonnet-4',
      timeout: 240,
      memoryLimit: '1g',
      cpuLimit: '0.5',
      pidsLimit: 64,
      tmpfsLimit: '32m',
      maxOutputBytes: 512,
      maxTaskBytes: 1024,
      maxInvocations: 3,
      maxModelRequests: 4,
      maxModelTokens: 256,
    });
  });
});

describe('boundedAgents JSON Schema', () => {
  const valid = {
    boundedAgents: {
      enabled: true,
      privateRepos: [{ repo: 'octo/alpha', sensitivity: 'internal' }],
      engine: 'copilot',
      model: 'gpt-4o-mini',
    },
  };

  it('accepts a minimal enabled configuration', () => {
    expect(validateAwfFileConfig(valid)).toEqual([]);
  });

  it('requires privateRepos, engine, and model when enabled', () => {
    expect(validateAwfFileConfig({ boundedAgents: { enabled: true } }).length).toBeGreaterThan(0);
    expect(
      validateAwfFileConfig({ boundedAgents: { enabled: true, model: 'gpt-4o-mini' } }).length,
    ).toBeGreaterThan(0);
    expect(
      validateAwfFileConfig({
        boundedAgents: { enabled: true, privateRepos: valid.boundedAgents.privateRepos },
      }).length,
    ).toBeGreaterThan(0);
  });

  it('accepts known native engines and rejects unknown engines', () => {
    for (const engine of ['copilot', 'claude', 'codex', 'gemini']) {
      expect(validateAwfFileConfig({ boundedAgents: { ...valid.boundedAgents, engine } })).toEqual([]);
    }
    expect(
      validateAwfFileConfig({ boundedAgents: { ...valid.boundedAgents, engine: 'custom' } }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects unknown keys', () => {
    expect(
      validateAwfFileConfig({ boundedAgents: { ...valid.boundedAgents, image: 'evil:latest' } }).length,
    ).toBeGreaterThan(0);
    expect(
      validateAwfFileConfig({ boundedAgents: { ...valid.boundedAgents, tools: ['shell'] } }).length,
    ).toBeGreaterThan(0);
  });

  it('accepts docker, gvisor, and sbx runtimes (sbx is blocked later, at preflight)', () => {
    for (const runtime of ['docker', 'gvisor', 'sbx']) {
      expect(validateAwfFileConfig({ boundedAgents: { ...valid.boundedAgents, runtime } })).toEqual([]);
    }
    expect(
      validateAwfFileConfig({ boundedAgents: { ...valid.boundedAgents, runtime: 'firecracker' } }).length,
    ).toBeGreaterThan(0);
  });

  it('accepts only the implemented provider profiles', () => {
    for (const profile of ['openai', 'anthropic']) {
      expect(validateAwfFileConfig({ boundedAgents: { ...valid.boundedAgents, profile } })).toEqual([]);
    }
    expect(
      validateAwfFileConfig({ boundedAgents: { ...valid.boundedAgents, profile: 'gemini' } }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects repository slugs that are not bare owner/repo', () => {
    for (const repo of [
      'https://github.com/octo/alpha',
      'octo/alpha/../../etc',
      'octo/*',
      'octo',
      'user:token@octo/alpha',
    ]) {
      expect(
        validateAwfFileConfig({
          boundedAgents: { ...valid.boundedAgents, privateRepos: [{ repo, sensitivity: 'internal' }] },
        }).length,
      ).toBeGreaterThan(0);
    }
  });

  it('rejects a legacy bare-string privateRepos entry', () => {
    expect(
      validateAwfFileConfig({
        boundedAgents: { ...valid.boundedAgents, privateRepos: ['octo/alpha'] },
      }).length,
    ).toBeGreaterThan(0);
  });

  it('bounds the conservative resource and budget fields', () => {
    const outOfRange: Array<Record<string, unknown>> = [
      { timeout: 0 },
      { timeout: 541 },
      { memoryLimit: 'lots' },
      { cpuLimit: 'all' },
      { pidsLimit: 0 },
      { tmpfsLimit: '64' },
      { maxOutputBytes: 0 },
      { maxOutputBytes: 8193 },
      { maxTaskBytes: 0 },
      { maxTaskBytes: 65537 },
      { maxInvocations: 0 },
      { maxModelRequests: 0 },
      { maxModelRequests: 65 },
      { maxModelTokens: 0 },
      { maxModelTokens: 32769 },
    ];
    for (const patch of outOfRange) {
      expect(
        validateAwfFileConfig({ boundedAgents: { ...valid.boundedAgents, ...patch } }).length,
      ).toBeGreaterThan(0);
    }
  });

  it('leaves boundedQueries untouched (no regression)', () => {
    expect(
      validateAwfFileConfig({
        boundedQueries: {
          enabled: true,
          privateRepos: [{ repo: 'octo/alpha', sensitivity: 'internal' }],
        },
        ...valid,
      }),
    ).toEqual([]);
  });
});
