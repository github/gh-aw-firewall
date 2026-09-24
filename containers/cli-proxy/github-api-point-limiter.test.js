'use strict';

const { GitHubApiPointLimiter, createFromEnv, getApiInvocation } = require('./github-api-point-limiter');

describe('GitHubApiPointLimiter', () => {
  it.each([
    [['api', 'repos/octo/repo/issues'], { kind: 'rest', points: 1 }],
    [['api', '--method', 'POST', 'repos/octo/repo/issues'], { kind: 'rest', points: 5 }],
    [['api', '--method=DELETE', 'repos/octo/repo/issues/1'], { kind: 'rest', points: 5 }],
    [['api', '-X', 'GET', 'repos/octo/repo/issues'], { kind: 'rest', points: 1 }],
    [['api', 'repos/octo/repo/issues', '--field', 'title=Hello'], { kind: 'rest', points: 5 }],
    [['api', 'graphql', '-f', 'query={viewer{login}}'], { kind: 'graphql', points: 1 }],
  ])('classifies GitHub API point costs for %j', (args, expected) => {
    expect(getApiInvocation(args)).toEqual(expected);
  });

  it('does not charge non-api gh commands', () => {
    expect(getApiInvocation(['pr', 'list'])).toBeNull();
  });

  it('enforces independent REST and GraphQL budgets', () => {
    const limiter = new GitHubApiPointLimiter({ maxRest: 5, maxGraphql: 1 });

    expect(limiter.check(['api', 'repos/octo/repo']).remaining).toBe(4);
    expect(limiter.check(['api', '--method', 'POST', 'repos/octo/repo']).allowed).toBe(false);
    expect(limiter.check(['api', 'graphql']).remaining).toBe(0);
    expect(limiter.check(['api', 'graphql'])).toMatchObject({
      allowed: false,
      kind: 'graphql',
      limit: 1,
      used: 1,
      remaining: 0,
    });
  });

  it('creates configured budgets from valid environment values only', () => {
    const limiter = createFromEnv({
      AWF_MAX_GITHUB_API_POINTS_REST: '10',
      AWF_MAX_GITHUB_API_POINTS_GRAPHQL: 'invalid',
    });
    expect(limiter.maxRest).toBe(10);
    expect(limiter.maxGraphql).toBeNull();
  });
});
