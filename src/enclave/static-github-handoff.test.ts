import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import {
  ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV,
  getStaticGithubExecutorCapability,
  releaseStaticGithubExecutorCapability,
  takeStaticGithubExecutorCapability,
} from './static-github-handoff';

describe('Cloud Hypervisor scoped GitHub compiler handoff', () => {
  const now = 1_800_000_000_000;
  const agentId = 'a'.repeat(48);
  const bearer = 'scoped-executor-capability-'.repeat(2);
  let config: WrapperConfig;
  const capability = () => ({
    version: 1, gatewayIdentity: 'compiler-run-123', executor: 'agent', agentId, bearer,
    issuedAt: now - 1000, expiresAt: now + 60_000,
    allowedTools: ['issue_read'], allowedRepos: ['octo/private'], minIntegrity: 'approved',
  });
  const environment = (value: unknown = capability()): NodeJS.ProcessEnv => ({
    AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: 'compiler-run-123',
    AWF_ENCLAVE_GITHUB_MCP_AGENT_ID: agentId,
    [ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV]: JSON.stringify(value),
  });

  beforeEach(() => {
    config = {
      enclaves: normalizeEnclavesConfig([{
        runtime: 'cloud-hypervisor',
        agent: { model: 'trusted', tools: { github: {
          allowed: ['issue_read'], allowedRepos: ['octo/private'], minIntegrity: 'approved',
        } } },
        repos: [{ repo: 'octo/private', sensitivity: 'confidential' }],
      }]),
    } as WrapperConfig;
  });

  it('takes immutable host-only custody and erases the inherited value', () => {
    const env = environment();
    takeStaticGithubExecutorCapability(config, env, now);
    expect(env[ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV]).toBeUndefined();
    expect(env.AWF_ENCLAVE_GITHUB_MCP_AGENT_ID).toBeUndefined();
    expect(getStaticGithubExecutorCapability(config, now)).toEqual(capability());
    expect(getStaticGithubExecutorCapability(config, now)?.agentId).toBe(agentId);
    expect(Object.isFrozen(getStaticGithubExecutorCapability(config, now)?.allowedTools)).toBe(true);
    takeStaticGithubExecutorCapability(config, env, now);
    releaseStaticGithubExecutorCapability(config);
    expect(() => getStaticGithubExecutorCapability(config, now)).toThrow(/missing or expired/);
  });

  it.each([
    ['version', { version: 2 }],
    ['run', { gatewayIdentity: 'another-run-123' }],
    ['executor', { executor: 'primary' }],
    ['identity', { agentId: 'b'.repeat(48) }],
    ['other tool', { allowedTools: ['issue_read', 'create_issue'] }],
    ['missing tool', { allowedTools: [] }],
    ['duplicate tool', { allowedTools: ['issue_read', 'issue_read'] }],
    ['other repo', { allowedRepos: ['octo/other'] }],
    ['wider repo policy', { allowedRepos: ['octo/private', 'octo/other'] }],
    ['duplicate repo', { allowedRepos: ['octo/private', 'octo/private'] }],
    ['integrity downgrade', { minIntegrity: 'none' }],
    ['expired', { expiresAt: now }],
    ['future issue time', { issuedAt: now + 1 }],
    ['excessive lifetime', { expiresAt: now + 3_600_000 }],
    ['static identity as bearer', { bearer: agentId }],
    ['invalid bearer', { bearer: 'bad\ncredential' }],
    ['GitHub PAT as bearer', { bearer: `ghp_${'a'.repeat(40)}` }],
    ['unknown field', { token: 'unexpected' }],
  ])('rejects %s without retaining authority', (_label, patch) => {
    const env = environment({ ...capability(), ...patch });
    expect(() => takeStaticGithubExecutorCapability(config, env, now)).toThrow(/compiler-scoped/);
    expect(env[ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV]).toBeUndefined();
    expect(() => getStaticGithubExecutorCapability(config, now)).toThrow(/missing/);
  });

  it.each([
    ['missing', undefined], ['empty', ''], ['invalid JSON', '{'],
    ['oversized', 'x'.repeat(65_537)], ['null', 'null'], ['array', '[]'],
  ])(
    'rejects %s handoff', (_label, raw) => {
      const env = { ...environment(), [ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV]: raw };
      expect(() => takeStaticGithubExecutorCapability(config, env, now)).toThrow(/compiler-scoped/);
      expect(env[ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV]).toBeUndefined();
    },
  );

  it.each(['MCP_GATEWAY_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN',
    'GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_API_TOKEN', 'GITHUB_PAT', 'GH_ACCESS_TOKEN'])(
    'never accepts the host credential from %s', (name) => {
      const env = { ...environment(), [name]: bearer };
      expect(() => takeStaticGithubExecutorCapability(config, env, now)).toThrow();
      expect(env[ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV]).toBeUndefined();
      expect(() => getStaticGithubExecutorCapability(config, now)).toThrow();
    },
  );

  it('expires locally and cannot be reused by a different configuration', () => {
    takeStaticGithubExecutorCapability(config, environment(), now);
    expect(() => getStaticGithubExecutorCapability(config, now + 60_000)).toThrow(/expired/);
    expect(() => getStaticGithubExecutorCapability({ ...config }, now)).toThrow(/missing/);
  });

  it('supports the legacy policy without broadening its trusted catalog', () => {
    const agent = config.enclaves!.executors.agent;
    delete agent.tools;
    agent.github = { cli: 'issues-read-v1' };
    takeStaticGithubExecutorCapability(config, environment({
      ...capability(), allowedTools: ['list_issues', 'issue_read'], minIntegrity: null,
    }), now);
    expect(getStaticGithubExecutorCapability(config, now)?.allowedTools)
      .toEqual(['list_issues', 'issue_read']);
  });

  it('discards the handoff for Docker and disabled tool configurations', () => {
    config.enclaves!.executors.agent.runtime = 'docker';
    const env = environment();
    takeStaticGithubExecutorCapability(config, env, now);
    expect(env[ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV]).toBeUndefined();
    expect(getStaticGithubExecutorCapability(config, now)).toBeUndefined();
  });
});
