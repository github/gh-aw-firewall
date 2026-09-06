import { validateAwfFileConfig } from '../config-file';
import {
  ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
  ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
  ENCLAVES_DEFAULTS,
} from '../types/enclave-options';
import { normalizeEnclavesConfig } from './enclave-parser';
import {
  GH_AW_DYNAMIC_ENCLAVE_POLICY_FIXTURE,
  dynamicEnclavePolicyFixture,
  typedDynamicEnclavePolicyFixture,
} from '../enclave/dynamic-policy.test-utils';

/** The exact envelope the gh-aw compiler emits (see the fixture's provenance). */
const dynamicPolicy = typedDynamicEnclavePolicyFixture;

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

  it('provides memory headroom beyond the bounded agent tmpfs mounts', () => {
    const config = normalizeEnclavesConfig([
      { agent: { model: 'gpt-5' }, repos: [repository] },
    ]);
    expect(config?.executors.agent.memoryLimit).toBe('1g');
    expect(config?.executors.agent.tmpfsLimit).toBe('256m');
    expect(config?.executors.script.memoryLimit).toBe('512m');
    expect(config?.executors.script.tmpfsLimit).toBe('64m');
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

  it('preserves the closed enclave GitHub CLI profile', () => {
    expect(normalizeEnclavesConfig([
      {
        agent: {
          model: 'gpt-5',
          github: { cli: 'issues-read-v1' },
        },
        repos: [repository],
      },
    ])?.executors.agent.github).toEqual({ cli: 'issues-read-v1' });
  });

  it('preserves the tools.github shape', () => {
    expect(normalizeEnclavesConfig([
      {
        agent: {
          model: 'gpt-5',
          tools: {
            github: {
              allowed: ['list_issues', 'issue_read'],
              allowedRepos: ['octo-org/repo-b'],
              minIntegrity: 'none',
            },
          },
        },
        repos: [repository],
      },
    ])?.executors.agent.tools).toEqual({
      github: {
        allowed: ['list_issues', 'issue_read'],
        allowedRepos: ['octo-org/repo-b'],
        minIntegrity: 'none',
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

  it('rejects a "dynamic" policy declared on a "script" entry', () => {
    expect(() => normalizeEnclavesConfig([
      { script: {}, dynamic: dynamicPolicy() } as never,
    ])).toThrow(/agent-only/);
  });

  it('rejects "dynamic" and "repos" declared together on the same entry', () => {
    expect(() => normalizeEnclavesConfig([
      { agent: { model: 'gpt-5' }, repos: [repository], dynamic: dynamicPolicy() },
    ])).toThrow(/mutually exclusive/);
  });

  it('normalizes an agent entry with a dynamic policy and no static repos', () => {
    const config = normalizeEnclavesConfig([
      { agent: { model: 'gpt-5' }, dynamic: dynamicPolicy() },
    ]);
    expect(config?.privateRepos).toEqual([]);
    expect(config?.executors.agent.repos).toEqual([]);
    expect(config?.executors.agent.dynamic).toEqual(dynamicPolicy());
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
      enclaves: [{
        agent: { model: 'gpt-5', github: { cli: 'issues-read-v1' } },
        repos: [repository],
      }],
    })).toEqual([]);
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: {
          model: 'gpt-5',
          tools: {
            github: {
              allowed: ['list_issues', 'issue_read'],
              allowedRepos: ['octo-org/repo-b'],
              minIntegrity: 'none',
            },
          },
        },
        repos: [repository],
      }],
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
      enclaves: [{ script: { github: { cli: 'issues-read-v1' } }, repos: [repository] }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{ agent: { model: 'gpt-5', github: { cli: 'read-only' } }, repos: [repository] }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: {
          model: 'gpt-5',
          github: { cli: 'issues-read-v1', endpoint: 'https://example.test' },
        },
        repos: [repository],
      }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5', tools: { github: { allowed: ['delete_issue'], allowedRepos: ['o/r'] } } },
        repos: [repository],
      }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5', tools: { github: { allowed: ['list_issues'] } } },
        repos: [repository],
      }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: {
          model: 'gpt-5',
          tools: { github: { allowed: ['list_issues'], allowedRepos: ['o/r'], minIntegrity: 'bogus' } },
        },
        repos: [repository],
      }],
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
      enclaves: [{ agent: { model: 'gpt-5' }, repos: [repository], timeout: 4740 }],
    })).toEqual([]);
    expect(validateAwfFileConfig({
      enclaves: [{ script: {}, repos: [repository], timeout: 4741 }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{ agent: { model: 'gpt-5' }, repos: [repository], timeout: 4741 }],
    }).length).toBeGreaterThan(0);
  });

  it('accepts the exact gh-aw compiler dynamic envelope verbatim', () => {
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5' },
        dynamic: GH_AW_DYNAMIC_ENCLAVE_POLICY_FIXTURE,
      }],
    })).toEqual([]);
  });

  it('rejects the superseded pre-gh-aw#58880 field names', () => {
    const legacyLimits = validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5' },
        dynamic: dynamicEnclavePolicyFixture({
          limits: {
            timeout: 120,
            memoryLimit: '1g',
            cpuLimit: '1',
            pidsLimit: 128,
            tmpfsLimit: '256m',
            maxOutputBytes: 8192,
            maxTaskBytes: 4096,
          },
        }),
      }],
    });
    expect(legacyLimits.length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5' },
        dynamic: dynamicEnclavePolicyFixture({
          quotas: { totalInvocations: 10, totalBytes: 1_000_000, totalSeconds: 3600 },
        }),
      }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5' },
        dynamic: dynamicEnclavePolicyFixture({ auditLabels: { run: 'test-run' } }),
      }],
    }).length).toBeGreaterThan(0);
  });

  it('accepts a dynamic-only agent entry and rejects malformed dynamic envelopes', () => {
    expect(validateAwfFileConfig({
      enclaves: [{ agent: { model: 'gpt-5' }, dynamic: dynamicPolicy() }],
    })).toEqual([]);
    // dynamic on a script entry is rejected
    expect(validateAwfFileConfig({
      enclaves: [{ script: {}, dynamic: dynamicPolicy() }],
    }).length).toBeGreaterThan(0);
    // dynamic and repos together on the same entry are rejected
    expect(validateAwfFileConfig({
      enclaves: [{ agent: { model: 'gpt-5' }, repos: [repository], dynamic: dynamicPolicy() }],
    }).length).toBeGreaterThan(0);
    // an entry with neither repos nor dynamic is rejected
    expect(validateAwfFileConfig({
      enclaves: [{ agent: { model: 'gpt-5' } }],
    }).length).toBeGreaterThan(0);
    // unknown policy version fails closed
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5' },
        dynamic: {
          ...dynamicPolicy(),
          githubPolicy: { version: 'github-repository-read-v2', tools: ['list_issues', 'issue_read'] },
        },
      }],
    }).length).toBeGreaterThan(0);
    // a wider tool set than the closed v1 pair fails closed
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5' },
        dynamic: {
          ...dynamicPolicy(),
          githubPolicy: { version: 'github-repository-read-v1', tools: ['list_issues'] },
        },
      }],
    }).length).toBeGreaterThan(0);
    // an unknown field on the envelope fails closed
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5' },
        dynamic: { ...dynamicPolicy(), unknownField: true },
      }],
    }).length).toBeGreaterThan(0);
    // a non-canonical (uppercase) selector fails closed
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5' },
        dynamic: { ...dynamicPolicy(), allowedOwners: [], allowedRepositories: ['Octo-Org/Repo'] },
      }],
    }).length).toBeGreaterThan(0);
    // an empty or duplicated audit-label array fails closed
    expect(validateAwfFileConfig({
      enclaves: [{ agent: { model: 'gpt-5' }, dynamic: dynamicEnclavePolicyFixture({ auditLabels: [] }) }],
    }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5' },
        dynamic: dynamicEnclavePolicyFixture({ auditLabels: ['dup', 'dup'] }),
      }],
    }).length).toBeGreaterThan(0);
    // quotas beyond the compiler's own bounds fail closed
    expect(validateAwfFileConfig({
      enclaves: [{
        agent: { model: 'gpt-5' },
        dynamic: dynamicEnclavePolicyFixture({
          quotas: { maxInvocations: 10_001, maxOutputBytes: 1, maxExecutionSeconds: 1 },
        }),
      }],
    }).length).toBeGreaterThan(0);
  });
});
