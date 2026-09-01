'use strict';

const crypto = require('crypto');
const https = require('https');
const { accessLog } = require('./access-log');
const {
  capabilityAuditContext,
  extractInvocationCapability,
} = require('./security');

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_UPSTREAM_RESPONSE_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const OWNER_REPO_PATTERN = /^[a-z0-9_.-]+$/;

const TOOLS = Object.freeze([
  {
    name: 'list_issues',
    description: 'List issues in the assigned GitHub repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        perPage: { type: 'integer', minimum: 1, maximum: 100 },
        page: { type: 'integer', minimum: 1, maximum: 999 },
        state: { enum: ['open', 'closed', 'all'] },
        labels: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'issue_read',
    description: 'Read one issue or its comments from the assigned GitHub repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'integer', minimum: 1 },
        method: { enum: ['get', 'get_comments'] },
        perPage: { type: 'integer', minimum: 1, maximum: 100 },
        page: { type: 'integer', minimum: 1, maximum: 999 },
      },
      required: ['owner', 'repo', 'issue_number', 'method'],
      additionalProperties: false,
    },
  },
]);

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function sendJson(res, statusCode, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function isExactKeys(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key))
    && keys.every(key => allowed.includes(key));
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validateRepositoryArgs(args) {
  return OWNER_REPO_PATTERN.test(args.owner || '')
    && OWNER_REPO_PATTERN.test(args.repo || '');
}

function buildUpstreamPath(name, args) {
  if (name === 'list_issues') {
    if (
      !isExactKeys(args, ['owner', 'repo', 'perPage', 'page', 'state', 'labels'], ['owner', 'repo'])
      || !validateRepositoryArgs(args)
      || (args.perPage !== undefined && !boundedInteger(args.perPage, 1, 100))
      || (args.page !== undefined && !boundedInteger(args.page, 1, 999))
      || (args.state !== undefined && !['open', 'closed', 'all'].includes(args.state))
      || (args.labels !== undefined && (
        typeof args.labels !== 'string'
        || args.labels.length < 1
        || args.labels.length > 256
        || /[\u0000-\u001f\u007f]/.test(args.labels)
      ))
    ) {
      return undefined;
    }
    const query = new URLSearchParams();
    if (args.perPage !== undefined) query.set('per_page', String(args.perPage));
    if (args.page !== undefined) query.set('page', String(args.page));
    if (args.state !== undefined) query.set('state', args.state);
    if (args.labels !== undefined) query.set('labels', args.labels);
    const suffix = query.size > 0 ? `?${query}` : '';
    return `/repos/${args.owner}/${args.repo}/issues${suffix}`;
  }

  if (name === 'issue_read') {
    if (
      !isExactKeys(
        args,
        ['owner', 'repo', 'issue_number', 'method', 'perPage', 'page'],
        ['owner', 'repo', 'issue_number', 'method'],
      )
      || !validateRepositoryArgs(args)
      || !boundedInteger(args.issue_number, 1, Number.MAX_SAFE_INTEGER)
      || !['get', 'get_comments'].includes(args.method)
      || (args.perPage !== undefined && !boundedInteger(args.perPage, 1, 100))
      || (args.page !== undefined && !boundedInteger(args.page, 1, 999))
    ) {
      return undefined;
    }
    const comments = args.method === 'get_comments' ? '/comments' : '';
    const query = new URLSearchParams();
    if (args.perPage !== undefined) query.set('per_page', String(args.perPage));
    if (args.page !== undefined) query.set('page', String(args.page));
    const suffix = query.size > 0 ? `?${query}` : '';
    return `/repos/${args.owner}/${args.repo}/issues/${args.issue_number}${comments}${suffix}`;
  }

  return undefined;
}

function sessionIdForCapability(capability) {
  return `egh-${crypto.createHash('sha256').update(capability, 'utf8').digest('hex')}`;
}

function forwardGithubRead(path, capability, signal) {
  const host = process.env.AWF_DIFC_PROXY_HOST;
  const port = Number(process.env.AWF_DIFC_PROXY_PORT || '18443');
  if (!host || !boundedInteger(port, 1, 65535)) {
    return Promise.reject(new Error('GitHub MCP upstream is not configured'));
  }

  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: host,
      port,
      path,
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${capability}`,
      },
      timeout: UPSTREAM_TIMEOUT_MS,
    }, response => {
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
          request.destroy(new Error('GitHub MCP response exceeded its bound'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode || 502,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error('GitHub MCP request timed out')));
    request.on('error', reject);
    const abort = () => request.destroy(new Error('GitHub MCP client disconnected'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    request.end();
  });
}

function readAuthorization(req) {
  const names = req.rawHeaders.filter(
    (_value, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization',
  );
  if (names.length !== 1) return undefined;
  return extractInvocationCapability(req.headers.authorization);
}

async function handleEnclaveMcp(req, res, body, forward = forwardGithubRead) {
  const capability = readAuthorization(req);
  if (!capability) {
    sendJson(res, 401, { error: 'Invalid invocation authorization' });
    return;
  }

  let message;
  try {
    message = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, jsonRpcError(null, -32700, 'Invalid JSON'));
    return;
  }
  if (
    !message
    || typeof message !== 'object'
    || Array.isArray(message)
    || message.jsonrpc !== '2.0'
    || typeof message.method !== 'string'
  ) {
    sendJson(res, 400, jsonRpcError(message?.id, -32600, 'Invalid MCP request'));
    return;
  }

  const expectedSessionId = sessionIdForCapability(capability);
  if (message.method !== 'initialize' && req.headers['mcp-session-id'] !== expectedSessionId) {
    sendJson(res, 400, jsonRpcError(message.id, -32600, 'Invalid MCP session'));
    return;
  }

  if (message.method === 'initialize') {
    sendJson(res, 200, jsonRpcResult(message.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'awf-enclave-github', version: '1.0.0' },
    }), { 'Mcp-Session-Id': expectedSessionId });
    return;
  }
  if (message.method === 'notifications/initialized') {
    res.writeHead(202);
    res.end();
    return;
  }
  if (message.method === 'tools/list') {
    sendJson(res, 200, jsonRpcResult(message.id, { tools: TOOLS }));
    return;
  }
  if (message.method !== 'tools/call') {
    sendJson(res, 200, jsonRpcError(message.id, -32601, 'Method not found'));
    return;
  }

  const params = message.params;
  if (!isExactKeys(params, ['name', 'arguments'], ['name', 'arguments'])) {
    sendJson(res, 200, jsonRpcError(message.id, -32602, 'Invalid tool call'));
    return;
  }
  const upstreamPath = buildUpstreamPath(params.name, params.arguments);
  if (!upstreamPath) {
    accessLog({
      event: 'mcp_denied',
      ...capabilityAuditContext(capability),
      tool: typeof params.name === 'string' ? params.name : 'invalid',
    });
    sendJson(res, 200, jsonRpcResult(message.id, {
      content: [{ type: 'text', text: 'GitHub MCP request is outside issues-read-v1' }],
      isError: true,
    }));
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  const startedAt = Date.now();
  try {
    const upstream = await forward(upstreamPath, capability, controller.signal);
    const allowed = upstream.statusCode >= 200 && upstream.statusCode < 300;
    accessLog({
      event: allowed ? 'mcp_done' : 'mcp_denied',
      ...capabilityAuditContext(capability),
      tool: params.name,
      statusCode: upstream.statusCode,
      durationMs: Date.now() - startedAt,
      responseBytes: Buffer.byteLength(upstream.body),
    });
    sendJson(res, 200, jsonRpcResult(message.id, {
      content: [{
        type: 'text',
        text: allowed ? upstream.body : 'GitHub MCP request denied',
      }],
      isError: !allowed,
    }));
  } catch {
    accessLog({
      event: 'mcp_error',
      ...capabilityAuditContext(capability),
      tool: params.name,
      durationMs: Date.now() - startedAt,
    });
    if (!res.headersSent) {
      sendJson(res, 200, jsonRpcResult(message.id, {
        content: [{ type: 'text', text: 'GitHub MCP request failed' }],
        isError: true,
      }));
    }
  } finally {
    res.removeListener('close', abort);
  }
}

module.exports = {
  MCP_PROTOCOL_VERSION,
  TOOLS,
  buildUpstreamPath,
  handleEnclaveMcp,
  sessionIdForCapability,
};
