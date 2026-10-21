import { spawn, type ChildProcess } from 'child_process';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';

const fixture = path.resolve(__dirname, 'cloud-hypervisor-enclave-gateway.js');
const apiKey = 'k'.repeat(40);
const capability = 'a'.repeat(64);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function post(port: number, body: unknown): Promise<{ status: number; body: unknown }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const request = http.request({
          host: '127.0.0.1', port, path: '/mcp/awf-enclave', method: 'POST',
          headers: { authorization: apiKey, 'content-type': 'application/json' },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({
            status: response.statusCode ?? 0,
            body: chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }));
        });
        request.on('error', reject);
        request.end(payload);
      });
    } catch (error) {
      if (attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe('Cloud Hypervisor enclave gateway fixture', () => {
  let gateway: ChildProcess | undefined;
  let upstream: http.Server | undefined;

  afterEach(async () => {
    gateway?.kill();
    gateway = undefined;
    if (upstream) await new Promise((resolve) => upstream?.close(resolve));
    upstream = undefined;
  });

  async function startGateway(upstreamPort: number): Promise<number> {
    const port = await freePort();
    gateway = spawn(process.execPath, [fixture], {
      env: {
        PATH: process.env.PATH,
        MCP_GATEWAY_PORT: String(port),
        MCP_GATEWAY_API_KEY: apiKey,
        AWF_ENCLAVE_MCP_CAPABILITY: capability,
        AWF_ENCLAVE_GATEWAY_FIXTURE_UPSTREAM: `http://127.0.0.1:${upstreamPort}/mcp`,
      },
      stdio: 'ignore',
    });
    return port;
  }

  it('reports an unreachable backend with the retryable mcpg backend_unavailable contract', async () => {
    const port = await startGateway(await freePort());
    await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toEqual({
      status: 503, body: { error: 'backend_unavailable', retryable: true },
    });
  });

  it('completes initialize, the empty initialized acknowledgment, and routed tool discovery', async () => {
    const methods: string[] = [];
    upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        methods.push(message.method);
        if (message.method === 'notifications/initialized') {
          response.writeHead(202, { 'content-length': '0' });
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: message.method === 'initialize' ? { serverInfo: { name: 'inner' } }
            : { tools: [{ name: 'enclave_run_script', description: 'bounded script', inputSchema: {} }] },
        }));
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toEqual({
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'awmg-awf-enclave', version: 'live-test' } } },
    });
    await expect(post(port, { jsonrpc: '2.0', method: 'notifications/initialized' })).resolves.toEqual({
      status: 202, body: undefined,
    });
    await expect(post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).resolves.toEqual({
      status: 200,
      body: { jsonrpc: '2.0', id: 2, result: { tools: [{
        name: 'enclave_run_script', description: '[awf-enclave] bounded script', inputSchema: {},
      }] } },
    });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });

  it('keeps an invalid backend response permanent', async () => {
    upstream = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => response.end('not json'));
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toEqual({
      status: 502, body: { error: 'invalid upstream response' },
    });
  });

  it.each([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } },
  ])('preserves empty notification acknowledgments for $method', async (notification) => {
    const received: unknown[] = [];
    upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        expect(request.headers.authorization).toBe(`Bearer ${capability}`);
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(202, { 'content-length': '0' });
        response.end();
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    await expect(post(port, notification)).resolves.toEqual({ status: 202, body: undefined });
    expect(received).toEqual([notification]);
    expect(gateway?.exitCode).toBeNull();
  });

  it.each([
    { status: 202, request: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
    { status: 202, request: { jsonrpc: '2.0', id: null, method: 'initialize' } },
    { status: 202, request: { method: 'notifications/initialized' } },
    { status: 202, request: { jsonrpc: '2.0' } },
    { status: 200, request: { jsonrpc: '2.0', method: 'notifications/initialized' } },
    { status: 401, request: { jsonrpc: '2.0', method: 'notifications/initialized' } },
    { status: 503, request: { jsonrpc: '2.0', method: 'notifications/initialized' } },
  ])('does not accept an empty $status response for $request', async ({ status, request }) => {
    upstream = http.createServer((incoming, response) => {
      incoming.resume();
      incoming.on('end', () => {
        response.writeHead(status, { 'content-length': '0' });
        response.end();
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    await expect(post(port, request)).resolves.toEqual({
      status: 502, body: { error: 'invalid upstream response' },
    });
  });

  it('returns permanent failures for truncated backend responses without terminating the gateway', async () => {
    upstream = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
        response.write('{"jsonrpc":');
        setTimeout(() => response.destroy(), 20);
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toEqual({
        status: 502, body: { error: 'upstream unavailable' },
      });
    }
    expect(gateway?.exitCode).toBeNull();
  });

  it('keeps oversized backend responses permanent without terminating the gateway', async () => {
    upstream = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => response.end('x'.repeat(420 * 1024 + 1)));
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toEqual({
        status: 502, body: { error: 'upstream response exceeded its bound' },
      });
    }
    expect(gateway?.exitCode).toBeNull();
  });

  it.each([
    'http://example.com:80/mcp',
    'http://127.0.0.1:0/mcp',
    'http://127.0.0.1:65536/mcp',
    'http://127.0.0.1:99999/mcp',
    'http://awf-enclave-mcp:0/mcp',
    'http://awf-enclave-mcp:65536/mcp',
    'http://awf-enclave-mcp:99999/mcp',
  ])('refuses invalid test upstream override %s at startup', async (upstreamUrl) => {
    const child = spawn(process.execPath, [fixture], {
      env: {
        PATH: process.env.PATH, MCP_GATEWAY_API_KEY: apiKey, AWF_ENCLAVE_MCP_CAPABILITY: capability,
        AWF_ENCLAVE_GATEWAY_FIXTURE_UPSTREAM: upstreamUrl,
      },
      stdio: 'ignore',
    });
    await expect(new Promise((resolve) => child.once('exit', resolve))).resolves.not.toBe(0);
  });
});
