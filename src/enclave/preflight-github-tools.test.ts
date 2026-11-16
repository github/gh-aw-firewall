import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { EnclaveAgentExecutorConfig } from '../types/enclave-options';
import { validateEnclaveAgentGithubConfig } from './preflight-github-tools';

function agent(overrides: Partial<EnclaveAgentExecutorConfig>): EnclaveAgentExecutorConfig {
  return {
    ...normalizeEnclavesConfig([{
      agent: { model: 'trusted' },
      repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
    }])!.executors.agent,
    ...overrides,
  };
}

describe('validateEnclaveAgentGithubConfig', () => {
  it('accepts case-insensitive repository matches without clearing earlier errors', () => {
    const errors = ['previous error'];
    validateEnclaveAgentGithubConfig(agent({
      tools: { github: { allowed: ['issue_read'], allowedRepos: ['Octo/Private'] } },
    }), errors);
    expect(errors).toEqual(['previous error']);
  });

  it.each([null, 'invalid', 1])('rejects malformed legacy and current GitHub controls: %j', value => {
    const legacyErrors: string[] = [];
    validateEnclaveAgentGithubConfig(agent({ github: value as never }), legacyErrors);
    expect(legacyErrors).toEqual(['enclaves[].agent.github.cli must be "issues-read-v1"']);

    const errors: string[] = [];
    validateEnclaveAgentGithubConfig(agent({ tools: { github: value as never } }), errors);
    expect(errors).toEqual(['enclaves[].agent.tools.github must be an object']);
  });

  it('reports conflicting shapes before inspecting either GitHub contract', () => {
    const errors: string[] = [];
    validateEnclaveAgentGithubConfig(agent({
      github: null as never,
      tools: { github: null as never },
    }), errors);
    expect(errors).toEqual([
      'enclaves[].agent.github and enclaves[].agent.tools.github cannot both be set; ' +
      'migrate to enclaves[].agent.tools.github',
    ]);
  });

  it('preserves tool, repository, and integrity error ordering', () => {
    const errors: string[] = [];
    validateEnclaveAgentGithubConfig(agent({
      tools: {
        github: {
          allowed: ['issue_read', 'issue_read'],
          allowedRepos: ['invalid', 'octo/other'],
          minIntegrity: 'invalid' as never,
        },
      },
    }), errors);
    expect(errors).toEqual([
      'enclaves[].agent.tools.github.allowed must be a non-empty, duplicate-free subset of ' +
      '["list_issues","issue_read"]',
      'enclaves[].agent.tools.github.allowedRepos entry "invalid" is not a bare owner/repository slug',
      'enclaves[].agent.tools.github.allowedRepos entry "octo/other" is not declared in the agent entry\'s own enclaves[].repos',
      'enclaves[].agent.tools.github.minIntegrity must be one of ["none","unapproved","approved","merged"]',
    ]);
  });
});
