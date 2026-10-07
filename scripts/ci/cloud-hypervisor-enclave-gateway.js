'use strict';

const crypto = require('crypto');
const http = require('http');

const port = Number(process.env.MCP_GATEWAY_PORT || 8080);
const apiKey = process.env.MCP_GATEWAY_API_KEY || '';
const capability = process.env.AWF_ENCLAVE_MCP_CAPABILITY || '';
const maxBodyBytes = 420 * 1024;

if (!Number.isSafeInteger(port) || port < 1 || port > 65535
    || !/^[A-Za-z0-9_-]{32,256}$/.test(apiKey)
    || !/^[a-f0-9]{64}$/.test(capability)) {
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

const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/mcp/awf-enclave'
      || !authorized(request.headers.authorization, apiKey)) {
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
    const upstream = http.request('http://awf-enclave-mcp:8080/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${capability}`,
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
      timeout: 4860_000,
    }, (upstreamResponse) => {
      const responseChunks = [];
      let responseBytes = 0;
      upstreamResponse.on('data', (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > maxBodyBytes) {
          upstream.destroy();
          return;
        }
        responseChunks.push(chunk);
      });
      upstreamResponse.on('end', () => {
        if (responseBytes > maxBodyBytes) {
          sendJson(response, 502, { error: 'upstream response exceeded its bound' });
          return;
        }
        let parsed;
        let forwarded;
        try {
          parsed = JSON.parse(payload.toString('utf8'));
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
      if (!response.headersSent) sendJson(response, 502, { error: 'upstream unavailable' });
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
