import * as http from 'http';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CloudHypervisorApiClient,
  CloudHypervisorApiError,
} from './api-client';

describe('CloudHypervisorApiClient', () => {
  let directory: string;
  let socketPath: string;
  let server: http.Server;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-ch-api-'));
    socketPath = path.join(directory, 'api.socket');
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function listen(
    handler: http.RequestListener,
  ): Promise<void> {
    server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  }

  it('sends typed JSON requests over the Unix socket under /api/v1', async () => {
    const received: Array<{ method?: string; url?: string; body: string }> = [];
    await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (request.url === '/api/v1/vmm.ping') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ version: '53.0' }));
          return;
        }
        if (request.url === '/api/v1/vm.info') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            config: { cpus: { boot_vcpus: 2, max_vcpus: 2 }, memory: { size: 1 }, payload: { kernel: '/kernel' } },
            state: 'Running',
          }));
          return;
        }
        response.writeHead(204).end();
      });
    });

    const client = new CloudHypervisorApiClient({ socketPath });
    expect(await client.ping()).toEqual({ version: '53.0' });
    await client.vmCreate({
      cpus: { boot_vcpus: 2, max_vcpus: 2 },
      memory: { size: 512 * 1024 * 1024 },
      payload: { kernel: '/kernel', cmdline: 'console=ttyS0' },
      disks: [{ id: 'rootfs', path: '/rootfs', readonly: false }],
      net: [{ id: 'net0', tap: 'chtap0', mac: '02:00:00:00:00:01' }],
      vsock: { cid: 3, socket: '/run/vsock.socket' },
      landlock_enable: true,
      landlock_rules: [{ path: '/kernel', access: 'r' }],
    });
    await client.vmBoot();
    const info = await client.vmInfo();
    expect(info.state).toBe('Running');
    await client.vmShutdown();
    await client.vmmShutdown();

    expect(received[0]).toMatchObject({ method: 'GET', url: '/api/v1/vmm.ping' });
    expect(received[1]).toMatchObject({ method: 'PUT', url: '/api/v1/vm.create' });
    expect(JSON.parse(received[1].body)).toMatchObject({
      cpus: { boot_vcpus: 2, max_vcpus: 2 },
      landlock_enable: true,
    });
    expect(received[2]).toMatchObject({ method: 'PUT', url: '/api/v1/vm.boot', body: '' });
    expect(received[3]).toMatchObject({ method: 'GET', url: '/api/v1/vm.info' });
    expect(received[4]).toMatchObject({ method: 'PUT', url: '/api/v1/vm.shutdown', body: '' });
    expect(received[5]).toMatchObject({ method: 'PUT', url: '/api/v1/vmm.shutdown', body: '' });
  });

  it('parses Cloud Hypervisor chained-error-message arrays', async () => {
    await listen((_request, response) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(['failed to create VM', 'invalid disk path']));
    });

    const client = new CloudHypervisorApiClient({ socketPath });
    const error = await client.vmCreate({
      cpus: { boot_vcpus: 1, max_vcpus: 1 },
      memory: { size: 1 },
      payload: { kernel: '/kernel' },
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(CloudHypervisorApiError);
    expect(error).toMatchObject({
      method: 'PUT',
      requestPath: '/api/v1/vm.create',
      statusCode: 500,
    });
    expect(error.message).toContain('failed to create VM: invalid disk path');
  });

  it('falls back to the raw body when the error is not a string array', async () => {
    await listen((_request, response) => {
      response.writeHead(400, { 'Content-Type': 'text/plain' });
      response.end('not json');
    });

    const client = new CloudHypervisorApiClient({ socketPath });
    const error = await client.vmBoot().catch((caught) => caught);
    expect(error.message).toContain('not json');
  });

  it('resolves undefined for empty 204 responses', async () => {
    await listen((_request, response) => {
      response.writeHead(204).end();
    });
    const client = new CloudHypervisorApiClient({ socketPath });
    await expect(client.vmBoot()).resolves.toBeUndefined();
  });

  it('enforces a wall-clock timeout even when the peer keeps sending data', async () => {
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const interval = setInterval(() => {
        response.write(' ');
      }, 5);
      response.on('close', () => clearInterval(interval));
    });

    const client = new CloudHypervisorApiClient({ socketPath, timeoutMs: 30 });
    await expect(client.vmInfo()).rejects.toThrow(/timed out after 30ms/);
  });

  it('rejects when the response stream errors before completion', async () => {
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"state":"Running"');
      response.destroy(new Error('socket closed'));
    });

    const client = new CloudHypervisorApiClient({ socketPath });
    await expect(client.vmInfo()).rejects.toThrow();
  });

  it('rejects when the response exceeds the bounded size limit', async () => {
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write(Buffer.alloc(2 * 1024 * 1024, 'a'));
    });

    const client = new CloudHypervisorApiClient({ socketPath });
    await expect(client.vmInfo()).rejects.toThrow(/exceeded 1 MiB/);
  });

  it('rejects with invalid JSON error message on malformed success body', async () => {
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{not-json');
    });

    const client = new CloudHypervisorApiClient({ socketPath });
    await expect(client.vmInfo()).rejects.toThrow(/returned invalid JSON/);
  });
});
