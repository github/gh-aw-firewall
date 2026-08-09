import { promises as fs } from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import {
  FIRECRACKER_GUEST_PROTOCOL_VERSION,
  FirecrackerFrameDecoder,
  encodeFirecrackerFrame,
  type FirecrackerGuestFrame,
} from './vsock-protocol';
import { FirecrackerVsockClient } from './vsock-client';

async function createServer(
  handler: (frame: FirecrackerGuestFrame, socket: net.Socket) => void,
): Promise<{ socketPath: string; close(): Promise<void> }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-vsock-'));
  const socketPath = path.join(directory, 'vsock.sock');
  const server = net.createServer((socket) => {
    let handshaken = false;
    let handshake = Buffer.alloc(0);
    const decoder = new FirecrackerFrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      if (!handshaken) {
        handshake = Buffer.concat([handshake, chunk]);
        const newline = handshake.indexOf(0x0a);
        if (newline === -1) return;
        expect(handshake.subarray(0, newline).toString()).toBe('CONNECT 52');
        handshaken = true;
        socket.write('OK 1234\n');
        socket.write(encodeFirecrackerFrame({
          version: FIRECRACKER_GUEST_PROTOCOL_VERSION,
          type: 'ready',
          requestId: 'control',
          capabilities: { stdin: true, tty: false, resize: false },
        }));
        chunk = handshake.subarray(newline + 1);
      }
      for (const frame of decoder.push(chunk)) handler(frame, socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

describe('FirecrackerVsockClient', () => {
  it('streams output, stdin, and exact terminal status', async () => {
    const received: FirecrackerGuestFrame[] = [];
    const server = await createServer((frame, socket) => {
      received.push(frame);
      if (frame.type === 'execute') {
        socket.write(Buffer.concat([
          encodeFirecrackerFrame({
            version: 1,
            type: 'stdout',
            requestId: frame.requestId,
            data: Buffer.from('hello').toString('base64'),
          }),
          encodeFirecrackerFrame({
            version: 1,
            type: 'stderr',
            requestId: frame.requestId,
            data: Buffer.from('warning').toString('base64'),
          }),
        ]));
      }
      if (frame.type === 'stdin' && frame.eof) {
        socket.write(encodeFirecrackerFrame({
          version: 1,
          type: 'result',
          requestId: frame.requestId,
          exitCode: 7,
          signal: null,
          timedOut: false,
        }));
      }
    });
    const client = new FirecrackerVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    stderr.on('data', (chunk) => stderrChunks.push(chunk));

    await client.connect();
    const resultPromise = client.execute({
      requestId: 'run-1',
      argv: ['sh', '-c', 'cat'],
      env: { PATH: '/usr/bin' },
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
      stdout,
      stderr,
    });
    await client.writeStdin(Buffer.from('input'));
    await client.endStdin();

    await expect(resultPromise).resolves.toEqual({
      requestId: 'run-1',
      exitCode: 7,
      signal: null,
      timedOut: false,
    });
    expect(Buffer.concat(stdoutChunks).toString()).toBe('hello');
    expect(Buffer.concat(stderrChunks).toString()).toBe('warning');
    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'execute', requestId: 'run-1' }),
      expect.objectContaining({ type: 'stdin', requestId: 'run-1', eof: true }),
    ]));
    client.destroy();
    await server.close();
  });

  it('cancels at the host deadline and deterministically returns 124', async () => {
    const server = await createServer((frame, socket) => {
      if (frame.type === 'cancel') {
        socket.write(encodeFirecrackerFrame({
          version: 1,
          type: 'result',
          requestId: frame.requestId,
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
        }));
      }
    });
    const client = new FirecrackerVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
      cancellationGraceMs: 100,
    });
    await client.connect();
    await expect(client.execute({
      argv: ['sleep', '10'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
      timeoutMs: 10,
    })).resolves.toEqual(expect.objectContaining({
      exitCode: 124,
      timedOut: true,
      signal: 'SIGTERM',
    }));
    client.destroy();
    await server.close();
  });

  it('rejects protocol errors and disconnects during execution', async () => {
    const server = await createServer((frame, socket) => {
      if (frame.type === 'execute') socket.destroy();
    });
    const client = new FirecrackerVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
    });
    await client.connect();
    await expect(client.execute({
      argv: ['true'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).rejects.toThrow(/disconnected/);
    await server.close();
  });

  it('preserves numeric fallback signal exit status from the guest', async () => {
    const server = await createServer((frame, socket) => {
      if (frame.type === 'execute') {
        socket.write(encodeFirecrackerFrame({
          version: 1,
          type: 'result',
          requestId: frame.requestId,
          exitCode: null,
          signal: 'SIG24',
          timedOut: false,
        }));
      }
    });
    const client = new FirecrackerVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
    });
    await client.connect();
    await expect(client.execute({
      argv: ['true'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).resolves.toEqual(expect.objectContaining({
      exitCode: 152,
      signal: 'SIG24',
      timedOut: false,
    }));
    client.destroy();
    await server.close();
  });

  it('requires advertised TTY capability', async () => {
    const server = await createServer(() => undefined);
    const client = new FirecrackerVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
    });
    await client.connect();
    await expect(client.execute({
      argv: ['sh'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
      tty: true,
    })).rejects.toThrow(/does not support TTY/);
    client.destroy();
    await server.close();
  });

  it('uses an acknowledged shutdown frame before closing the transport', async () => {
    const server = await createServer((frame, socket) => {
      if (frame.type === 'shutdown') {
        socket.write(encodeFirecrackerFrame({
          version: 1,
          type: 'shutting_down',
          requestId: frame.requestId,
        }));
      }
    });
    const client = new FirecrackerVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
    });
    await client.connect();
    await expect(client.shutdown()).resolves.toBeUndefined();
    await server.close();
  });

  it('allows silent commands while bounding incomplete frame reads', async () => {
    let execution = 0;
    const server = await createServer((frame, socket) => {
      if (frame.type !== 'execute') return;
      execution += 1;
      const result = encodeFirecrackerFrame({
        version: 1,
        type: 'result',
        requestId: frame.requestId,
        exitCode: 0,
        signal: null,
        timedOut: false,
      });
      if (execution === 1) {
        setTimeout(() => socket.write(result), 30);
      } else {
        socket.write(result.subarray(0, 2));
      }
    });
    const client = new FirecrackerVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
      readTimeoutMs: 10,
    });
    await client.connect();
    await expect(client.execute({
      requestId: 'silent',
      argv: ['sleep', '1'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).resolves.toEqual(expect.objectContaining({ exitCode: 0 }));
    await expect(client.execute({
      requestId: 'partial',
      argv: ['true'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).rejects.toThrow(/frame read timed out/);
    await server.close();
  });
});
