'use strict';

const crypto = require('crypto');
const http = require('http');

const port = Number(process.env.MCP_GATEWAY_PORT || 8080);
const apiKey = process.env.MCP_GATEWAY_API_KEY || '';
const capability = process.env.AWF_ENCLAVE_MCP_CAPABILITY || '';
const maxBodyBytes = 420 * 1024;
// Tests point the fixture at a loopback stand-in; CI always uses the AWF alias.
const upstreamUrl = process.env.AWF_ENCLAVE_GATEWAY_FIXTURE_UPSTREAM || 'http://awf-enclave-mcp:8080/mcp';
const upstreamMatch = /^http:\/\/(awf-enclave-mcp|127\.0\.0\.1):(\d{1,5})\/mcp$/.exec(upstreamUrl);
const upstreamPort = Number(upstreamMatch?.[2]);
let githubCapability;
if (process.env.AWF_ENCLAVE_GITHUB_EXECUTOR_CAPABILITY !== undefined) {
  try {
    githubCapability = JSON.parse(process.env.AWF_ENCLAVE_GITHUB_EXECUTOR_CAPABILITY);
    const value = githubCapability;
    if (!value || Object.keys(value).sort().join(',') !== [
      'version', 'gatewayIdentity', 'executor', 'agentId', 'bearer', 'issuedAt',
      'expiresAt', 'allowedTools', 'allowedRepos', 'minIntegrity',
    ].sort().join(',')
        || value.version !== 1 || value.executor !== 'agent'
        || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(value.gatewayIdentity)
        || value.gatewayIdentity !== process.env.AWF_ENCLAVE_MCP_GATEWAY_IDENTITY
        || typeof value.agentId !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value.agentId)
        || value.agentId !== process.env.AWF_ENCLAVE_GITHUB_MCP_AGENT_ID
        || typeof value.bearer !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(value.bearer)
        || [apiKey, capability, value.agentId].includes(value.bearer)
        || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
        || value.issuedAt > Date.now() || value.expiresAt <= value.issuedAt
        || value.expiresAt - value.issuedAt > 3600_000
        || JSON.stringify(value.allowedTools) !== '["issue_read","list_issues"]'
        || JSON.stringify(value.allowedRepos) !== '["github/gh-aw-firewall"]'
        || value.minIntegrity !== null) throw new Error();
  } catch {
    throw new Error('Scoped GitHub fixture capability is invalid');
  }
}

if (!Number.isSafeInteger(port) || port < 1 || port > 65535
    || !/^[A-Za-z0-9_-]{32,256}$/.test(apiKey)
    || !/^[a-f0-9]{64}$/.test(capability)
    || !Number.isSafeInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
  throw new Error('Live enclave gateway fixture configuration is invalid');
}

function authorized(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function transformResponse(request, response) {
  if (!response || typeof response !== 'object' || !response.result) return response;
  if (request.method === 'initialize') {
    response.result.serverInfo = { name: 'awmg-awf-enclave', version: 'live-test' };
  }
  if (request.method === 'tools/list' && Array.isArray(response.result.tools)) {
    response.result.tools = response.result.tools.map((tool) => ({
      name: tool.name,
      description: `[awf-enclave] ${tool.description}`,
      inputSchema: tool.inputSchema,
    }));
  }
  return response;
}

// Controlled data only: this route never forwards GitHub or provider credentials.
function serveGithub(request, response, payload) {
  const value = githubCapability;
  if (!value || Date.now() < value.issuedAt || Date.now() >= value.expiresAt
      || !authorized(request.headers.authorization, value.bearer)) {
    sendJson(response, 403, { error: 'forbidden' });
    return;
  }
  let message;
  try {
    message = JSON.parse(payload);
    if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) throw new Error();
  } catch {
    sendJson(response, 400, { error: 'invalid request' });
    return;
  }
  response.setHeader('mcp-session-id', 'awf-controlled-github-fixture');
  const reply = (result) => sendJson(response, 200, { jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    reply({
      protocolVersion: message.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'controlled-github-fixture', version: '1' },
    });
  } else if (message.method === 'notifications/initialized') {
    response.writeHead(202, { 'content-length': '0' });
    response.end();
  } else if (message.method === 'tools/list') {
    reply({ tools: value.allowedTools.map((name) => ({
      name, description: 'Controlled static GitHub fixture',
      inputSchema: {
        type: 'object', properties: {
          owner: { type: 'string' }, repo: { type: 'string' },
          ...(name === 'issue_read' ? { method: { type: 'string', enum: ['get'] },
            issue_number: { type: 'integer', enum: [1] } } : {}),
        }, required: name === 'issue_read' ? ['owner', 'repo', 'method', 'issue_number'] : ['owner', 'repo'],
        additionalProperties: false,
      },
    })) });
  } else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params || {};
    const fields = name === 'issue_read' ? ['owner', 'repo', 'method', 'issue_number'] : ['owner', 'repo'];
    if (!value.allowedTools.includes(name) || !args || typeof args !== 'object'
        || typeof args.owner !== 'string' || typeof args.repo !== 'string'
        || !value.allowedRepos.includes(`${args.owner}/${args.repo}`)
        || Object.keys(args).sort().join(',') !== fields.sort().join(',')
        || (name === 'issue_read' && (args.method !== 'get' || args.issue_number !== 1))) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }
    const issue = { number: 1, title: 'AWF controlled scoped issue', repository: value.allowedRepos[0] };
    const result = name === 'issue_read' ? issue : { issues: [issue] };
    reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
  } else {
    sendJson(response, 403, { error: 'forbidden' });
  }
}

const server = http.createServer((request, response) => {
  const githubRoute = githubCapability && request.url === '/mcp/github';
  if (request.method !== 'POST' || (!githubRoute && (request.url !== '/mcp/awf-enclave'
      || !authorized(request.headers.authorization, apiKey)))) {
    request.resume();
    sendJson(response, 404, { error: 'not found' });
    return;
  }

  const chunks = [];
  let bytes = 0;
  request.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (bytes > maxBodyBytes) return;
    const payload = Buffer.concat(chunks);
    if (githubRoute) {
      serveGithub(request, response, payload.toString('utf8'));
      return;
    }
    let upstreamResponded = false;
    const upstream = http.request(upstreamUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${capability}`,
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
      timeout: 4860_000,
    }, (upstreamResponse) => {
      upstreamResponded = true;
      const responseChunks = [];
      let responseBytes = 0;
      const failResponse = () => {
        if (!response.headersSent && !response.destroyed) {
          sendJson(response, 502, { error: 'upstream unavailable' });
        }
      };
      upstreamResponse.on('aborted', failResponse);
      upstreamResponse.on('error', failResponse);
      upstreamResponse.on('data', (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > maxBodyBytes) {
          if (!response.headersSent && !response.destroyed) {
            sendJson(response, 502, { error: 'upstream response exceeded its bound' });
          }
          upstream.destroy();
          return;
        }
        responseChunks.push(chunk);
      });
      upstreamResponse.on('end', () => {
        if (response.headersSent || response.destroyed) return;
        let parsed;
        let forwarded;
        try {
          parsed = JSON.parse(payload.toString('utf8'));
          // MCP notifications are acknowledged without a JSON-RPC response body.
          if (upstreamResponse.statusCode === 202 && responseBytes === 0
              && parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              && parsed.jsonrpc === '2.0' && typeof parsed.method === 'string'
              && !Object.prototype.hasOwnProperty.call(parsed, 'id')) {
            response.writeHead(202, { 'cache-control': 'no-store', 'content-length': '0' });
            response.end();
            return;
          }
          forwarded = transformResponse(parsed, JSON.parse(Buffer.concat(responseChunks).toString('utf8')));
        } catch {
          sendJson(response, 502, { error: 'invalid upstream response' });
          return;
        }
        sendJson(response, upstreamResponse.statusCode || 502, forwarded);
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (response.headersSent || response.destroyed) return;
      // Match mcpg's late-backend contract: a backend that has not answered yet is
      // retryable, so AWF keeps polling within its readiness deadline.
      if (!upstreamResponded) {
        sendJson(response, 503, { error: 'backend_unavailable', retryable: true });
        return;
      }
      sendJson(response, 502, { error: 'upstream unavailable' });
    });
    response.once('close', () => {
      if (!response.writableEnded) upstream.destroy();
    });
    upstream.end(payload);
  });
});

server.headersTimeout = 5000;
server.requestTimeout = 10_000;
server.keepAliveTimeout = 1000;
server.listen(port, '0.0.0.0');
