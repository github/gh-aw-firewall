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
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
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

  it('forwards a reachable backend and rewrites the initialize server identity', async () => {
    upstream = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'inner' } } }));
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
    const port = await startGateway((upstream.address() as AddressInfo).port);
    await expect(post(port, { jsonrpc: '2.0', id: 1, method: 'initialize' })).resolves.toEqual({
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'awmg-awf-enclave', version: 'live-test' } } },
    });
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

  it('refuses non-loopback test upstream overrides', async () => {
    const child = spawn(process.execPath, [fixture], {
      env: {
        PATH: process.env.PATH, MCP_GATEWAY_API_KEY: apiKey, AWF_ENCLAVE_MCP_CAPABILITY: capability,
        AWF_ENCLAVE_GATEWAY_FIXTURE_UPSTREAM: 'http://example.com:80/mcp',
      },
      stdio: 'ignore',
    });
    await expect(new Promise((resolve) => child.once('exit', resolve))).resolves.not.toBe(0);
  });
});
