'use strict';

const { GitHubApiPointLimiter, createFromEnv, getRequestCost } = require('./github-api-point-limiter');

describe('GitHubApiPointLimiter', () => {
  it.each([
    ['GET', '/api/v3/repos/octo/repo/issues', { kind: 'rest', points: 1 }],
    ['HEAD', '/api/v3/repos/octo/repo', { kind: 'rest', points: 1 }],
    ['OPTIONS', '/api/v3/repos/octo/repo', { kind: 'rest', points: 1 }],
    ['POST', '/api/v3/repos/octo/repo/issues', { kind: 'rest', points: 5 }],
    ['PATCH', '/api/v3/repos/octo/repo/issues/1', { kind: 'rest', points: 5 }],
    ['DELETE', '/api/v3/repos/octo/repo/issues/1', { kind: 'rest', points: 5 }],
    ['INVALID', '/api/v3/repos/octo/repo', { kind: 'rest', points: 5 }],
  ])('classifies actual HTTP %s %s requests', (method, url, expected) => {
    expect(getRequestCost(method, url)).toEqual(expected);
  });

  it.each([
    ['{viewer{login}}', 1],
    ['query Viewer { viewer { login } }', 1],
    ['# mutation in comment\nquery { viewer { login } }', 1],
    ['query { repository(name: "mutation", owner: "octo") { id } }', 1],
    ['query { repository(name: """mutation""", owner: "octo") { id } }', 1],
    ['query { repository(name: "escaped \\"mutation\\"", owner: "octo") { id } }', 1],
    ['query { field(value: """unterminated' + '\\'.repeat(4096), 5],
    ['mutation { addComment(input: {body: "Hello"}) { clientMutationId } }', 5],
    ['query Viewer { viewer { login } } mutation Write { addComment { id } }', 5],
    ['fragment F on User { login } query { viewer { ...F } }', 5],
    ['', 5],
    [null, 5],
  ])('prices GraphQL documents conservatively: %j', (query, points) => {
    expect(getRequestCost('POST', '/api/graphql', Buffer.from(JSON.stringify({ query })))).toEqual({
      kind: 'graphql', points,
    });
  });

  it('cannot hide a selected mutation behind escaped GraphQL block strings', () => {
    const query = String.raw`query Q {
      search(query: """prefix\\"""middle""", type: ISSUE, first: 1) { issueCount }
    }
    mutation M($body: String! = """comment""") {
      addComment(input: {subjectId: "TARGET_NODE_ID", body: $body}) { clientMutationId }
    }`;
    expect(getRequestCost('POST', '/api/graphql', Buffer.from(JSON.stringify({
      query, operationName: 'M',
    })))).toEqual({ kind: 'graphql', points: 5 });
  });

  it.each(['/graphql', '/api/graphql', '/api//graphql', '/api/%67raphql', '/api/x/../graphql'])(
    'recognizes normalized GraphQL request paths: %s', (url) => {
      expect(getRequestCost('POST', url, Buffer.from('{"query":"mutation { write { id } }"}')))
        .toEqual({ kind: 'graphql', points: 5 });
    },
  );

  it('handles GraphQL GET requests and malformed bodies without bypassing accounting', () => {
    expect(getRequestCost('GET', '/graphql?query=%7Bviewer%7Blogin%7D%7D')).toEqual({
      kind: 'graphql', points: 1,
    });
    for (const body of [undefined, Buffer.from('not json'), Buffer.from('null'), Buffer.from('{}')]) {
      expect(getRequestCost('POST', '/api/graphql/', body)).toEqual({ kind: 'graphql', points: 5 });
    }
  });

  it('enforces independent REST and GraphQL budgets', () => {
    const limiter = new GitHubApiPointLimiter({ maxRest: 5, maxGraphql: 1 });

    const query = Buffer.from('{"query":"{viewer{login}}"}');
    expect(limiter.check('GET', '/api/v3/repos/octo/repo').remaining).toBe(4);
    expect(limiter.check('POST', '/api/v3/repos/octo/repo').allowed).toBe(false);
    expect(limiter.check('POST', '/api/graphql', query).remaining).toBe(0);
    expect(limiter.check('POST', '/api/graphql', query)).toMatchObject({
      allowed: false,
      kind: 'graphql',
      limit: 1,
      used: 1,
      remaining: 0,
    });

  });

  it('allows the exact budget and does not charge rejected requests', () => {
    const limiter = new GitHubApiPointLimiter({ maxRest: 5, maxGraphql: 5 });
    const mutation = Buffer.from('{"query":"mutation { write { id } }"}');
    expect(limiter.check('POST', '/api/v3/issues').remaining).toBe(0);
    expect(limiter.check('POST', '/api/graphql', mutation).remaining).toBe(0);
    expect(limiter.check('GET', '/api/v3/issues').allowed).toBe(false);
    expect(limiter.check('POST', '/api/graphql', mutation).allowed).toBe(false);
    expect(limiter.usedRest).toBe(5);
    expect(limiter.usedGraphql).toBe(5);
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
