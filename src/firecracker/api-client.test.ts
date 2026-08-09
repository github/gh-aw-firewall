import * as http from 'http';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FirecrackerApiClient,
  FirecrackerApiError,
} from './api-client';

describe('FirecrackerApiClient', () => {
  let directory: string;
  let socketPath: string;
  let server: http.Server;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-fc-api-'));
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

  it('sends typed JSON requests over the Unix socket', async () => {
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
        response.writeHead(204).end();
      });
    });

    const client = new FirecrackerApiClient({ socketPath });
    await client.putMachineConfig({ vcpu_count: 2, mem_size_mib: 512 });
    await client.putDrive({
      drive_id: 'root drive',
      path_on_host: '/rootfs',
      is_root_device: true,
      is_read_only: false,
    });
    await client.putNetworkInterface({
      iface_id: 'primary interface',
      host_dev_name: 'fct123456789012',
      guest_mac: '02:00:00:00:00:01',
    });
    await client.putLogger({
      log_path: '/run/firecracker.log',
      level: 'Info',
      show_level: true,
    });
    await client.putMetrics({
      metrics_path: '/run/firecracker.metrics.jsonl',
    });
    await client.putAction('FlushMetrics');
    await client.instanceStart();

    expect(received).toEqual([
      {
        method: 'PUT',
        url: '/machine-config',
        body: JSON.stringify({ vcpu_count: 2, mem_size_mib: 512 }),
      },
      {
        method: 'PUT',
        url: '/drives/root%20drive',
        body: JSON.stringify({
          drive_id: 'root drive',
          path_on_host: '/rootfs',
          is_root_device: true,
          is_read_only: false,
        }),
      },
      {
        method: 'PUT',
        url: '/network-interfaces/primary%20interface',
        body: JSON.stringify({
          iface_id: 'primary interface',
          host_dev_name: 'fct123456789012',
          guest_mac: '02:00:00:00:00:01',
        }),
      },
      {
        method: 'PUT',
        url: '/logger',
        body: JSON.stringify({
          log_path: '/run/firecracker.log',
          level: 'Info',
          show_level: true,
        }),
      },
      {
        method: 'PUT',
        url: '/metrics',
        body: JSON.stringify({
          metrics_path: '/run/firecracker.metrics.jsonl',
        }),
      },
      {
        method: 'PUT',
        url: '/actions',
        body: JSON.stringify({ action_type: 'FlushMetrics' }),
      },
      {
        method: 'PUT',
        url: '/actions',
        body: JSON.stringify({ action_type: 'InstanceStart' }),
      },
    ]);
  });

  it('returns structured Firecracker API errors', async () => {
    await listen((_request, response) => {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ fault_message: 'invalid machine config' }));
    });

    const client = new FirecrackerApiClient({ socketPath });
    const error = await client.putMachineConfig({
      vcpu_count: 0,
      mem_size_mib: 512,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(FirecrackerApiError);
    expect(error).toMatchObject({
      method: 'PUT',
      requestPath: '/machine-config',
      statusCode: 400,
    });
    expect(error.message).toContain('invalid machine config');
  });

  it('enforces a wall-clock timeout even when the peer keeps sending data', async () => {
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const interval = setInterval(() => {
        response.write(' ');
      }, 5);
      response.on('close', () => clearInterval(interval));
    });

    const client = new FirecrackerApiClient({ socketPath, timeoutMs: 30 });
    await expect(client.getInstanceInfo()).rejects.toThrow(/timed out after 30ms/);
  });

  it('rejects when the response stream errors before completion', async () => {
    await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"id":"vm"');
      response.destroy(new Error('socket closed'));
    });

    const client = new FirecrackerApiClient({ socketPath });
    await expect(client.getInstanceInfo()).rejects.toThrow();
  });
});
