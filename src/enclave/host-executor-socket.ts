import * as fs from 'fs';
import * as net from 'net';
import type { HostExecutorControlDiagnostics } from './host-executor-diagnostics';
import {
  HOST_EXECUTOR_FRAME_HEADER_BYTES,
  HOST_EXECUTOR_MAX_REQUEST_BYTES,
  type HostExecutorRequest,
  type HostExecutorResponse,
  type HostExecutorRejectionStage,
  canonicalDeniedResponse,
  decodeHostExecutorRequest,
  encodeHostExecutorResponse,
  frameHostExecutorMessage,
} from './host-executor-protocol';

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 16;

export function createHostExecutorSocket(options: {
  socketPath: string;
  capability: Buffer;
  runId: string;
  handle(request: HostExecutorRequest): HostExecutorResponse;
  diagnostics: Pick<HostExecutorControlDiagnostics, 'record'>;
  connectionTimeoutMs?: number;
  maxConnections?: number;
}) {
  const { capability, runId, handle, diagnostics, socketPath } = options;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  const sockets = new Set<net.Socket>();
  let closing = false;

  const recordDecodeRejection = (stage: HostExecutorRejectionStage): void => {
    diagnostics.record('request-rejected', new Error('Invalid request'), 'denied', undefined, stage);
  };

  const processFrame = (payload: Buffer): Buffer => {
    if (closing) return canonicalDeniedResponse();
    const decoded = decodeHostExecutorRequest(payload, {
      capability, runId, onRejection: recordDecodeRejection,
    });
    if (!decoded.ok) {
      return canonicalDeniedResponse();
    }
    return encodeHostExecutorResponse(handle(decoded.request));
  };

  const onConnection = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setTimeout(connectionTimeoutMs, () => {
      recordDecodeRejection('connection-timeout');
      socket.destroy();
    });

    const chunks: Buffer[] = [];
    let received = 0;
    let expected = -1;
    let answered = false;

    const respond = (payload: Buffer): void => {
      if (answered) return;
      answered = true;
      socket.removeListener('data', onData);
      socket.end(frameHostExecutorMessage(payload), () => socket.destroy());
    };

    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      chunks.push(chunk);
      if (expected < 0 && received >= HOST_EXECUTOR_FRAME_HEADER_BYTES) {
        expected = Buffer.concat(chunks).readUInt32BE(0);
        if (expected === 0 || expected > HOST_EXECUTOR_MAX_REQUEST_BYTES) {
          recordDecodeRejection('size');
          respond(canonicalDeniedResponse());
          return;
        }
      }
      if (expected < 0) return;
      const total = HOST_EXECUTOR_FRAME_HEADER_BYTES + expected;
      if (received > total) {
        // Exactly one request per connection; trailing bytes are a violation.
        recordDecodeRejection('framing');
        respond(canonicalDeniedResponse());
        return;
      }
    };

    const onEnd = (): void => {
      if (answered) return;
      if (expected < 0 || received !== HOST_EXECUTOR_FRAME_HEADER_BYTES + expected) {
        recordDecodeRejection('framing');
        respond(canonicalDeniedResponse());
        return;
      }
      const frame = Buffer.concat(chunks);
      respond(processFrame(frame.subarray(HOST_EXECUTOR_FRAME_HEADER_BYTES)));
    };

    socket.on('data', onData);
    socket.on('end', onEnd);
  };

  const server = net.createServer({ allowHalfOpen: true }, onConnection);
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  return {
    async listen(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      fs.chmodSync(socketPath, 0o600);
    },
    stopRequests(): void {
      closing = true;
    },
    closeAfterListenFailure(): void {
      server.close();
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
