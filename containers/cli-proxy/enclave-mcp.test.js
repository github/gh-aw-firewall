'use strict';

const { EventEmitter } = require('events');
const { Readable } = require('stream');
jest.mock('./access-log', () => ({ accessLog: jest.fn() }));
const {
  MCP_PROTOCOL_VERSION,
  TOOLS,
  buildUpstreamPath,
  handleEnclaveMcp,
  sessionIdForCapability,
} = require('./enclave-mcp');
const { requestHandler } = require('./server');

const CAPABILITY = `awf-egh1.${Buffer.from(JSON.stringify({
  v: 1,
  aud: 'gh-aw-enclave-github',
  run: 'run-123',
  inv: 'inv-456',
  repo: 'octo/private',
  profile: 'issues-read-v1',
  ops: ['issues.comments.list', 'issues.get', 'issues.list'],
  nbf: 1787594400,
  exp: 1787594520,
})).toString('base64url')}.${'a'.repeat(43)}`;

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.body = Buffer.alloc(0);
    this.headersSent = false;
    this.writableEnded = false;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
  }

  end(body = Buffer.alloc(0)) {
    this.body = Buffer.concat([this.body, Buffer.from(body)]);
    this.writableEnded = true;
  }

  json() {
    return JSON.parse(this.body.toString('utf8'));
  }
}

function mcpRequest(message, headers = {}) {
  const authorization = `Bearer ${CAPABILITY}`;
  return {
    headers: {
      authorization,
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    rawHeaders: ['Authorization', authorization],
  };
}

async function invokeMcp(message, headers = {}, rawHeaders) {
  const req = mcpRequest(message, headers);
  if (rawHeaders) req.rawHeaders = rawHeaders;
  const res = new FakeResponse();
  await handleEnclaveMcp(req, res, Buffer.from(JSON.stringify(message)));
  return res;
}

describe('enclave GitHub MCP bridge', () => {
  it('exposes exactly the bounded issue-read tools', () => {
    expect(TOOLS.map(tool => tool.name)).toEqual(['list_issues', 'issue_read']);
    expect(TOOLS[1].inputSchema.properties.method.enum).toEqual(['get', 'get_comments']);
  });

  it.each([
    [
      'list_issues',
      { owner: 'octo', repo: 'private', state: 'open', perPage: 20 },
      '/repos/octo/private/issues?per_page=20&state=open',
    ],
    [
      'issue_read',
      { owner: 'octo', repo: 'private', method: 'get', issue_number: 42 },
      '/repos/octo/private/issues/42',
    ],
    [
      'issue_read',
      { owner: 'octo', repo: 'private', method: 'get_comments', issue_number: 42, page: 2 },
      '/repos/octo/private/issues/42/comments?page=2',
    ],
  ])('translates %s into the existing capability-protected route', (name, args, expected) => {
    expect(buildUpstreamPath(name, args)).toBe(expected);
  });

  it.each([
    ['search_issues', { owner: 'octo', repo: 'private' }],
    ['issue_read', { owner: 'octo', repo: 'private', method: 'update', issue_number: 42 }],
    ['list_issues', { owner: 'octo', repo: 'private', query: 'secret' }],
    ['list_issues', { owner: 'Octo', repo: 'private' }],
    ['issue_read', { owner: 'octo', repo: 'private', method: 'get', issue_number: 0 }],
  ])('rejects an out-of-profile %s call', (name, args) => {
    expect(buildUpstreamPath(name, args)).toBeUndefined();
  });

  it('binds the MCP session to the invocation capability', async () => {
    const initialized = await invokeMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    });

    const sessionId = sessionIdForCapability(CAPABILITY);
    expect(initialized.statusCode).toBe(200);
    expect(initialized.headers['Mcp-Session-Id']).toBe(sessionId);

    const listed = await invokeMcp(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': sessionId },
    );
    expect(listed.json().result.tools.map(tool => tool.name)).toEqual([
      'list_issues',
      'issue_read',
    ]);
  });

  it('forwards allowed reads and converts upstream denial to a bounded MCP error', async () => {
    const session = { 'mcp-session-id': sessionIdForCapability(CAPABILITY) };
    const allowedForward = jest.fn().mockResolvedValue({
      statusCode: 200,
      body: '{"number":42}',
    });
    const allowedReq = mcpRequest({}, session);
    const allowedRes = new FakeResponse();
    await handleEnclaveMcp(
      allowedReq,
      allowedRes,
      Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'issue_read',
          arguments: {
            owner: 'octo',
            repo: 'private',
            method: 'get',
            issue_number: 42,
          },
        },
      })),
      allowedForward,
    );
    expect(allowedForward).toHaveBeenCalledWith(
      '/repos/octo/private/issues/42',
      CAPABILITY,
      expect.any(AbortSignal),
    );
    expect(allowedRes.json().result).toEqual({
      content: [{ type: 'text', text: '{"number":42}' }],
      isError: false,
    });

    const deniedForward = jest.fn().mockResolvedValue({
      statusCode: 403,
      body: 'sensitive upstream detail',
    });
    const deniedReq = mcpRequest({}, session);
    const deniedRes = new FakeResponse();
    await handleEnclaveMcp(
      deniedReq,
      deniedRes,
      Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'list_issues',
          arguments: { owner: 'octo', repo: 'other-private' },
        },
      })),
      deniedForward,
    );
    expect(deniedRes.json().result).toEqual({
      content: [{ type: 'text', text: 'GitHub MCP request denied' }],
      isError: true,
    });
    expect(deniedRes.body.toString()).not.toContain('sensitive upstream detail');
  });

  it('rejects malformed, duplicate, and mismatched authorization', async () => {
    const malformed = await invokeMcp(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { authorization: 'Bearer invalid' },
      ['Authorization', 'Bearer invalid'],
    );
    expect(malformed.statusCode).toBe(401);

    const duplicate = await invokeMcp(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      {},
      ['Authorization', `Bearer ${CAPABILITY}`, 'Authorization', `Bearer ${CAPABILITY}`],
    );
    expect(duplicate.statusCode).toBe(401);

    const mismatched = await invokeMcp(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': 'wrong-session' },
    );
    expect(mismatched.statusCode).toBe(400);
  });

  it('does not expose /exec in enclave MCP mode', async () => {
    const previousMode = process.env.AWF_CLI_PROXY_MODE;
    process.env.AWF_CLI_PROXY_MODE = 'enclave-mcp';
    try {
      const req = Readable.from([Buffer.from('{}')]);
      req.method = 'POST';
      req.url = '/exec';
      const res = new FakeResponse();
      await requestHandler(req, res);
      expect(res.statusCode).toBe(404);
    } finally {
      if (previousMode === undefined) delete process.env.AWF_CLI_PROXY_MODE;
      else process.env.AWF_CLI_PROXY_MODE = previousMode;
    }
  });
});
