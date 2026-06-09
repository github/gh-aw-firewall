import { describe, expect, it } from '@jest/globals';
import net from 'net';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';

function supportsIpv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => {
      probe.close(() => resolve(true));
    });
  });
}

function createTcpServer(host: string): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('ok');
    });
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to acquire port'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function getFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to acquire free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function waitForTunnelReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null) => reject(new Error(`Tunnel exited before ready (code=${code})`));
    const onStdout = (chunk: Buffer) => {
      if (chunk.toString().includes('Forwarding localhost:')) {
        child.stdout?.off('data', onStdout);
        child.off('exit', onExit);
        resolve();
      }
    };
    child.on('exit', onExit);
    child.stdout?.on('data', onStdout);
  });
}

function connect(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}`));
    }, 1000);

    socket.on('connect', () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve();
    });

    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      if (error.code === 'ECONNRESET') {
        settled = true;
        clearTimeout(timeout);
        resolve();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function connectWithRetry(host: string, port: number, attempts = 5): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await connect(host, port);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

describe('cli-proxy tcp tunnel', () => {
  it('binds localhost tunnel on both IPv4 and IPv6 loopback when IPv6 is available', async () => {
    if (!await supportsIpv6Loopback()) {
      return;
    }

    const upstream = await createTcpServer('127.0.0.1');
    const tunnelPort = await getFreePort('127.0.0.1');
    const tunnelScript = path.join(process.cwd(), 'containers/cli-proxy/tcp-tunnel.js');
    const tunnel = spawn(process.execPath, [tunnelScript, String(tunnelPort), '127.0.0.1', String(upstream.port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForTunnelReady(tunnel);
      await connect('127.0.0.1', tunnelPort);
      await connectWithRetry('::1', tunnelPort);
    } finally {
      tunnel.kill('SIGTERM');
      await Promise.all([
        new Promise((resolve) => tunnel.once('exit', resolve)),
        new Promise((resolve) => upstream.server.close(() => resolve(undefined))),
      ]);
    }
  }, 10000);
});
