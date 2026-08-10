import { promises as fs } from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough, Writable } from 'stream';
import {
  GUEST_PROTOCOL_VERSION,
  GUEST_MAX_STREAM_CHUNK_BYTES,
  GuestFrameDecoder,
  encodeGuestFrame,
  type GuestProtocolFrame,
} from './guest-protocol';
import { GuestExecutionError, MicrovmVsockClient } from './vsock-client';

async function createServer(
  handler: (frame: GuestProtocolFrame, socket: net.Socket) => void,
  capabilities = { stdin: true, tty: false, resize: false },
): Promise<{ socketPath: string; close(): Promise<void> }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-vsock-'));
  const socketPath = path.join(directory, 'vsock.sock');
  const server = net.createServer((socket) => {
    let handshaken = false;
    let handshake = Buffer.alloc(0);
    const decoder = new GuestFrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      if (!handshaken) {
        handshake = Buffer.concat([handshake, chunk]);
        const newline = handshake.indexOf(0x0a);
        if (newline === -1) return;
        expect(handshake.subarray(0, newline).toString()).toBe('CONNECT 52');
        handshaken = true;
        socket.write('OK 1234\n');
        socket.write(encodeGuestFrame({
          version: GUEST_PROTOCOL_VERSION,
          type: 'ready',
          requestId: 'control',
          capabilities,
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

async function createRawServer(
  handler: (socket: net.Socket) => void,
): Promise<{ socketPath: string; close(): Promise<void> }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-vsock-raw-'));
  const socketPath = path.join(directory, 'vsock.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

describe('MicrovmVsockClient', () => {
  it('streams output, stdin, and exact terminal status', async () => {
    const received: GuestProtocolFrame[] = [];
    const server = await createServer((frame, socket) => {
      received.push(frame);
      if (frame.type === 'execute') {
        socket.write(Buffer.concat([
          encodeGuestFrame({
            version: 1,
            type: 'stdout',
            requestId: frame.requestId,
            data: Buffer.from('hello').toString('base64'),
          }),
          encodeGuestFrame({
            version: 1,
            type: 'stderr',
            requestId: frame.requestId,
            data: Buffer.from('warning').toString('base64'),
          }),
        ]));
      }
      if (frame.type === 'stdin' && frame.eof) {
        socket.write(encodeGuestFrame({
          version: 1,
          type: 'result',
          requestId: frame.requestId,
          exitCode: 7,
          signal: null,
          timedOut: false,
        }));
      }
    });
    const client = new MicrovmVsockClient({
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
        socket.write(encodeGuestFrame({
          version: 1,
          type: 'result',
          requestId: frame.requestId,
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
        }));
      }
    });
    const client = new MicrovmVsockClient({
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
    const client = new MicrovmVsockClient({
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
        socket.write(encodeGuestFrame({
          version: 1,
          type: 'result',
          requestId: frame.requestId,
          exitCode: null,
          signal: 'SIG24',
          timedOut: false,
        }));
      }
    });
    const client = new MicrovmVsockClient({
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
    const client = new MicrovmVsockClient({
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
    await expect(client.resize(80, 24, 'run')).rejects.toThrow(/does not support TTY resize/);
    client.destroy();
    await server.close();
  });

  it('uses an acknowledged shutdown frame before closing the transport', async () => {
    const server = await createServer((frame, socket) => {
      if (frame.type === 'shutdown') {
        socket.write(encodeGuestFrame({
          version: 1,
          type: 'shutting_down',
          requestId: frame.requestId,
        }));
      }
    });
    const client = new MicrovmVsockClient({
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
      const result = encodeGuestFrame({
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
    const client = new MicrovmVsockClient({
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

  it('guards disconnected control methods and invalid ports', async () => {
    expect(() => new MicrovmVsockClient({
      socketPath: '/tmp/unused',
      guestPort: 0,
    })).toThrow(/1-65535/);
    const client = new MicrovmVsockClient({
      socketPath: '/tmp/unused',
      guestPort: 52,
    });
    await expect(client.execute({
      argv: ['true'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).rejects.toThrow(/not ready/);
    await expect(client.writeStdin(Buffer.from('input'))).rejects.toThrow(/No active/);
    await expect(client.endStdin()).rejects.toThrow(/No active/);
    await expect(client.cancel()).rejects.toThrow(/No active/);
    await expect(client.resize(80, 24)).rejects.toThrow(/No active/);
    await expect(client.endStdin('explicit')).rejects.toThrow(/handshake is not complete/);
    await expect(client.shutdown()).resolves.toBeUndefined();
    client.destroy();
  });

  it('supports chunked stdin, cancellation, resize, and pending request guards', async () => {
    const received: GuestProtocolFrame[] = [];
    const server = await createServer((frame, socket) => {
      received.push(frame);
      if (frame.type === 'stdin' && frame.eof) {
        socket.write(encodeGuestFrame({
          version: 1,
          type: 'result',
          requestId: frame.requestId,
          exitCode: 0,
          signal: null,
          timedOut: false,
        }));
      }
      if (frame.type === 'shutdown') {
        socket.write(encodeGuestFrame({
          version: 1,
          type: 'shutting_down',
          requestId: frame.requestId,
        }));
      }
    }, { stdin: true, tty: false, resize: true });
    const client = new MicrovmVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
    });
    await client.connect();
    const execution = client.execute({
      argv: ['cat'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    });
    await expect(client.execute({
      requestId: 'second',
      argv: ['true'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).rejects.toThrow(/still running/);
    await expect(client.shutdown()).rejects.toThrow(/while a request is running/);
    await client.resize(100, 40);
    await client.cancel('manual cancellation');
    await client.writeStdin(Buffer.alloc(GUEST_MAX_STREAM_CHUNK_BYTES + 1, 1));
    await client.endStdin();
    await expect(execution).resolves.toEqual(expect.objectContaining({ exitCode: 0 }));

    const executeFrame = received.find((frame) => frame.type === 'execute');
    expect(executeFrame?.requestId).toMatch(/^exec-/);
    expect(received.filter((frame) => frame.type === 'stdin' && frame.data)).toHaveLength(2);
    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'resize', columns: 100, rows: 40 }),
      expect.objectContaining({ type: 'cancel', reason: 'manual cancellation' }),
    ]));
    await client.shutdown();
    await server.close();
  });

  it('returns 124 when cancellation grace expires without a guest result', async () => {
    const server = await createServer(() => undefined);
    const client = new MicrovmVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
      cancellationGraceMs: 5,
    });
    await client.connect();
    await expect(client.execute({
      requestId: 'timeout',
      argv: ['sleep', '10'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
      timeoutMs: 5,
    })).resolves.toEqual({
      requestId: 'timeout',
      exitCode: 124,
      signal: null,
      timedOut: true,
    });
    await server.close();
  });

  it('propagates typed guest errors for matching and unexpected requests', async () => {
    let request = 0;
    const server = await createServer((frame, socket) => {
      if (frame.type !== 'execute') return;
      request += 1;
      socket.write(encodeGuestFrame({
        version: 1,
        type: 'error',
        requestId: request === 1 ? frame.requestId : 'different',
        code: 'invalid_request',
        message: 'rejected',
      }));
    });
    const client = new MicrovmVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
    });
    await client.connect();
    await expect(client.execute({
      requestId: 'matching',
      argv: ['false'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).rejects.toBeInstanceOf(GuestExecutionError);
    await expect(client.execute({
      requestId: 'unexpected',
      argv: ['false'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).rejects.toThrow(/rejected/);
    await server.close();
  });

  it('bounds and validates the CONNECT handshake and readiness wait', async () => {
    const invalid = await createRawServer((socket) => {
      socket.once('data', () => setTimeout(() => socket.write('DENIED\n'), 5));
    });
    const invalidClient = new MicrovmVsockClient({
      socketPath: invalid.socketPath,
      guestPort: 52,
      connectTimeoutMs: 100,
    });
    await expect(invalidClient.connect()).rejects.toThrow(/CONNECT failed/);
    invalidClient.destroy();
    await invalid.close();

    const oversized = await createRawServer((socket) => {
      socket.once('data', () => setTimeout(() => socket.write('x'.repeat(129)), 5));
    });
    const oversizedClient = new MicrovmVsockClient({
      socketPath: oversized.socketPath,
      guestPort: 52,
      connectTimeoutMs: 100,
    });
    await expect(oversizedClient.connect()).rejects.toThrow(/exceeded 128 bytes/);
    oversizedClient.destroy();
    await oversized.close();

    const silent = await createRawServer(() => undefined);
    const silentClient = new MicrovmVsockClient({
      socketPath: silent.socketPath,
      guestPort: 52,
      connectTimeoutMs: 5,
    });
    await expect(silentClient.connect()).rejects.toThrow(/readiness timed out/);
    silentClient.destroy();
    await silent.close();

    const disconnected = await createRawServer((socket) => {
      socket.once('data', () => setTimeout(() => socket.destroy(), 5));
    });
    const disconnectedClient = new MicrovmVsockClient({
      socketPath: disconnected.socketPath,
      guestPort: 52,
      connectTimeoutMs: 100,
    });
    await expect(disconnectedClient.connect()).rejects.toThrow(/before readiness/);
    await disconnected.close();
  });

  it('rejects unexpected guest frames and request identifiers', async () => {
    const unexpected = await createServer((frame, socket) => {
      if (frame.type === 'execute') {
        socket.write(encodeGuestFrame({
          version: 1,
          type: 'shutdown',
          requestId: frame.requestId,
        }));
      }
    });
    const unexpectedClient = new MicrovmVsockClient({
      socketPath: unexpected.socketPath,
      guestPort: 52,
    });
    await unexpectedClient.connect();
    await expect(unexpectedClient.execute({
      requestId: 'unexpected-frame',
      argv: ['true'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).rejects.toThrow(/Unexpected shutdown frame/);
    await unexpected.close();

    const mismatched = await createServer((frame, socket) => {
      if (frame.type === 'execute') {
        socket.write(encodeGuestFrame({
          version: 1,
          type: 'stdout',
          requestId: 'different',
          data: Buffer.from('output').toString('base64'),
        }));
      }
    });
    const mismatchedClient = new MicrovmVsockClient({
      socketPath: mismatched.socketPath,
      guestPort: 52,
    });
    await mismatchedClient.connect();
    await expect(mismatchedClient.execute({
      requestId: 'expected',
      argv: ['true'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
    })).rejects.toThrow(/Unexpected guest request id/);
    await mismatched.close();
  });

  it('honors output backpressure and unknown signal fallback status', async () => {
    const server = await createServer((frame, socket) => {
      if (frame.type !== 'execute') return;
      socket.write(encodeGuestFrame({
        version: 1,
        type: 'stdout',
        requestId: frame.requestId,
        data: Buffer.alloc(1024, 1).toString('base64'),
      }));
      socket.write(encodeGuestFrame({
        version: 1,
        type: 'result',
        requestId: frame.requestId,
        exitCode: null,
        signal: 'SIGUNKNOWN',
        timedOut: false,
      }));
    });
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setImmediate(callback);
      },
    });
    const client = new MicrovmVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
    });
    await client.connect();
    await expect(client.execute({
      requestId: 'backpressure',
      argv: ['true'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
      stdout: output,
    })).resolves.toEqual({
      requestId: 'backpressure',
      exitCode: 128,
      signal: 'SIGUNKNOWN',
      timedOut: false,
    });
    client.destroy();
    await server.close();
  });

  it('rejects writes after a connected transport is destroyed', async () => {
    const server = await createServer(() => undefined);
    const client = new MicrovmVsockClient({
      socketPath: server.socketPath,
      guestPort: 52,
    });
    await client.connect();
    client.destroy();
    await expect(client.endStdin('run')).rejects.toThrow(/not writable/);
    await server.close();
  });
});
