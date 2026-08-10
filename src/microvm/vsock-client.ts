import { randomBytes } from 'crypto';
import * as net from 'net';
import { constants as osConstants } from 'os';
import type { Writable } from 'stream';
import {
  GUEST_PROTOCOL_VERSION,
  GUEST_MAX_STREAM_CHUNK_BYTES,
  GuestFrameDecoder,
  GuestProtocolError,
  encodeGuestFrame,
  type GuestErrorFrame,
  type GuestExecuteFrame,
  type GuestProtocolFrame,
  type GuestReadyFrame,
  type GuestResultFrame,
} from './guest-protocol';

const GUEST_VSOCK_HANDSHAKE_LIMIT = 128;

export interface MicrovmVsockClientOptions {
  readonly socketPath: string;
  readonly guestPort: number;
  readonly connectTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
  readonly cancellationGraceMs?: number;
}

export interface GuestExecutionRequest {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly uid: number;
  readonly gid: number;
  readonly tty?: boolean;
  readonly timeoutMs?: number;
  readonly requestId?: string;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

export interface GuestExecutionResult {
  readonly requestId: string;
  readonly exitCode: number;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

interface PendingExecution {
  readonly requestId: string;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly resolve: (result: GuestExecutionResult) => void;
  readonly reject: (error: Error) => void;
  hostTimedOut: boolean;
  timeout?: NodeJS.Timeout;
  cancellation?: NodeJS.Timeout;
}

export class GuestExecutionError extends Error {
  constructor(readonly frame: GuestErrorFrame) {
    super(`guest ${frame.code}: ${frame.message}`);
    this.name = 'GuestExecutionError';
  }
}

/**
 * Host endpoint for a VMM's CONNECT-over-UDS vsock mapping (the convention
 * used by Firecracker and other VMMs that expose vsock via a host UDS
 * socket). Speaks the AWF framed guest protocol once the handshake
 * completes; independent of which VMM backend owns the socket.
 */
export class MicrovmVsockClient {
  private readonly connectTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly cancellationGraceMs: number;
  private readonly decoder = new GuestFrameDecoder();
  private socket: net.Socket | undefined;
  private ready: GuestReadyFrame | undefined;
  private pending: PendingExecution | undefined;
  private handshakeComplete = false;
  private handshakeBuffer = Buffer.alloc(0);
  private processing = Promise.resolve();
  private readyWaiter: {
    resolve: (frame: GuestReadyFrame) => void;
    reject: (error: Error) => void;
  } | undefined;
  private shutdownWaiter: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | undefined;
  private frameReadTimeout: NodeJS.Timeout | undefined;

  constructor(private readonly options: MicrovmVsockClientOptions) {
    if (!Number.isInteger(options.guestPort) || options.guestPort < 1 || options.guestPort > 65_535) {
      throw new Error(`guest vsock port must be in 1-65535: ${options.guestPort}`);
    }
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.readTimeoutMs = options.readTimeoutMs ?? 30_000;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 5_000;
    this.cancellationGraceMs = options.cancellationGraceMs ?? 2_000;
  }

  async connect(): Promise<GuestReadyFrame> {
    if (this.socket) throw new Error('guest vsock client is already connected');
    const socket = net.createConnection({ path: this.options.socketPath });
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.onClose());
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      }),
      this.connectTimeoutMs,
      `guest vsock UDS connect timed out after ${this.connectTimeoutMs}ms`,
    );
    await this.writeRaw(Buffer.from(`CONNECT ${this.options.guestPort}\n`, 'ascii'));

    return withTimeout(
      new Promise<GuestReadyFrame>((resolve, reject) => {
        this.readyWaiter = { resolve, reject };
        if (this.ready) {
          this.readyWaiter = undefined;
          resolve(this.ready);
        }
      }),
      this.connectTimeoutMs,
      `guest readiness timed out after ${this.connectTimeoutMs}ms`,
    );
  }

  execute(request: GuestExecutionRequest): Promise<GuestExecutionResult> {
    if (!this.ready || !this.socket) {
      return Promise.reject(new Error('guest supervisor is not ready'));
    }
    if (this.pending) {
      return Promise.reject(new Error(
        `guest request ${this.pending.requestId} is still running`,
      ));
    }
    if (request.tty && !this.ready.capabilities.tty) {
      return Promise.reject(new Error('guest supervisor does not support TTY execution'));
    }
    const requestId = request.requestId ??
      `exec-${process.pid}-${randomBytes(8).toString('hex')}`;
    const frame: GuestExecuteFrame = {
      version: GUEST_PROTOCOL_VERSION,
      type: 'execute',
      requestId,
      argv: request.argv,
      env: request.env,
      cwd: request.cwd,
      uid: request.uid,
      gid: request.gid,
      tty: request.tty ?? false,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    };

    return new Promise<GuestExecutionResult>((resolve, reject) => {
      const pending: PendingExecution = {
        requestId,
        stdout: request.stdout,
        stderr: request.stderr,
        resolve,
        reject,
        hostTimedOut: false,
      };
      this.pending = pending;
      if (request.timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          pending.hostTimedOut = true;
          void this.send({
            version: GUEST_PROTOCOL_VERSION,
            type: 'cancel',
            requestId,
            reason: `host timeout after ${request.timeoutMs}ms`,
          }).catch((error) => this.fail(toError(error)));
          pending.cancellation = setTimeout(() => {
            if (this.pending !== pending) return;
            this.completePending({
              version: GUEST_PROTOCOL_VERSION,
              type: 'result',
              requestId,
              exitCode: 124,
              signal: null,
              timedOut: true,
            });
            this.socket?.destroy();
          }, this.cancellationGraceMs);
        }, request.timeoutMs);
      }
      void this.send(frame).catch((error) => this.fail(toError(error)));
    });
  }

  async writeStdin(data: Buffer, requestId = this.pending?.requestId): Promise<void> {
    if (!requestId) throw new Error('No active guest request');
    for (let offset = 0; offset < data.length; offset += GUEST_MAX_STREAM_CHUNK_BYTES) {
      await this.send({
        version: GUEST_PROTOCOL_VERSION,
        type: 'stdin',
        requestId,
        data: data.subarray(offset, offset + GUEST_MAX_STREAM_CHUNK_BYTES)
          .toString('base64'),
      });
    }
  }

  endStdin(requestId = this.pending?.requestId): Promise<void> {
    if (!requestId) return Promise.reject(new Error('No active guest request'));
    return this.send({
      version: GUEST_PROTOCOL_VERSION,
      type: 'stdin',
      requestId,
      eof: true,
    });
  }

  cancel(reason = 'host cancellation', requestId = this.pending?.requestId): Promise<void> {
    if (!requestId) return Promise.reject(new Error('No active guest request'));
    return this.send({
      version: GUEST_PROTOCOL_VERSION,
      type: 'cancel',
      requestId,
      reason,
    });
  }

  resize(columns: number, rows: number, requestId = this.pending?.requestId): Promise<void> {
    if (!requestId) return Promise.reject(new Error('No active guest request'));
    if (!this.ready?.capabilities.resize) {
      return Promise.reject(new Error('guest supervisor does not support TTY resize'));
    }
    return this.send({
      version: GUEST_PROTOCOL_VERSION,
      type: 'resize',
      requestId,
      columns,
      rows,
    });
  }

  async shutdown(): Promise<void> {
    if (!this.socket) return;
    if (this.pending) throw new Error('Cannot shut down guest while a request is running');
    const requestId = 'shutdown';
    const acknowledgment = withTimeout(
      new Promise<void>((resolve, reject) => {
        this.shutdownWaiter = { resolve, reject };
      }),
      this.connectTimeoutMs,
      `guest shutdown acknowledgment timed out after ${this.connectTimeoutMs}ms`,
    );
    await this.send({
      version: GUEST_PROTOCOL_VERSION,
      type: 'shutdown',
      requestId,
    });
    await acknowledgment;
    this.socket.end();
    this.socket = undefined;
  }

  destroy(error?: Error): void {
    this.socket?.destroy(error);
    this.socket = undefined;
  }

  private onData(chunk: Buffer): void {
    this.processing = this.processing.then(async () => {
      let protocolData = chunk;
      if (!this.handshakeComplete) {
        this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
        if (this.handshakeBuffer.length > GUEST_VSOCK_HANDSHAKE_LIMIT) {
          throw new Error('vsock CONNECT response exceeded 128 bytes');
        }
        const newline = this.handshakeBuffer.indexOf(0x0a);
        if (newline === -1) return;
        const response = this.handshakeBuffer.subarray(0, newline).toString('ascii');
        if (!/^OK(?: \d+)?$/.test(response)) {
          throw new Error(`vsock CONNECT failed: ${response}`);
        }
        this.handshakeComplete = true;
        protocolData = this.handshakeBuffer.subarray(newline + 1);
        this.handshakeBuffer = Buffer.alloc(0);
      }
      for (const frame of this.decoder.push(protocolData)) {
        await this.handleFrame(frame);
      }
      clearTimeout(this.frameReadTimeout);
      this.frameReadTimeout = undefined;
      if (this.decoder.pendingBytes > 0) {
        this.frameReadTimeout = setTimeout(() => {
          this.fail(new Error(
            `guest frame read timed out after ${this.readTimeoutMs}ms`,
          ));
        }, this.readTimeoutMs);
      }
    }).catch((error) => this.fail(toError(error)));
  }

  private async handleFrame(frame: GuestProtocolFrame): Promise<void> {
    if (frame.type === 'ready') {
      if (this.ready) throw new GuestProtocolError('invalid_frame', 'Duplicate ready frame');
      this.ready = frame;
      this.readyWaiter?.resolve(frame);
      this.readyWaiter = undefined;
      return;
    }
    if (frame.type === 'error') {
      const error = new GuestExecutionError(frame);
      if (this.pending?.requestId === frame.requestId) {
        this.rejectPending(error);
      } else {
        this.fail(error);
      }
      return;
    }
    if (frame.type === 'stdout' || frame.type === 'stderr') {
      const pending = this.requirePending(frame.requestId);
      const destination = frame.type === 'stdout' ? pending.stdout : pending.stderr;
      if (destination) await writeWithBackpressure(destination, Buffer.from(frame.data, 'base64'));
      return;
    }
    if (frame.type === 'result') {
      this.requirePending(frame.requestId);
      this.completePending(frame);
      return;
    }
    if (frame.type === 'shutting_down') {
      this.shutdownWaiter?.resolve();
      this.shutdownWaiter = undefined;
      return;
    }
    throw new GuestProtocolError(
      'invalid_frame',
      `Unexpected ${frame.type} frame from guest`,
    );
  }

  private requirePending(requestId: string): PendingExecution {
    if (!this.pending || this.pending.requestId !== requestId) {
      throw new GuestProtocolError(
        'request_not_found',
        `Unexpected guest request id: ${requestId}`,
      );
    }
    return this.pending;
  }

  private completePending(frame: GuestResultFrame): void {
    const pending = this.requirePending(frame.requestId);
    clearTimeout(pending.timeout);
    clearTimeout(pending.cancellation);
    this.pending = undefined;
    if (pending.hostTimedOut || frame.timedOut) {
      pending.resolve({
        requestId: frame.requestId,
        exitCode: 124,
        signal: frame.signal,
        timedOut: true,
      });
      return;
    }
    pending.resolve({
      requestId: frame.requestId,
      exitCode: frame.exitCode ?? 128 + signalNumber(frame.signal),
      signal: frame.signal,
      timedOut: false,
    });
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timeout);
    clearTimeout(this.pending.cancellation);
    const pending = this.pending;
    this.pending = undefined;
    pending.reject(error);
  }

  private send(frame: GuestProtocolFrame): Promise<void> {
    if (!this.handshakeComplete) {
      return Promise.reject(new Error('vsock CONNECT handshake is not complete'));
    }
    return this.writeRaw(encodeGuestFrame(frame));
  }

  private writeRaw(data: Buffer): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) {
      return Promise.reject(new Error('guest connection is not writable'));
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(
          `guest write timed out after ${this.writeTimeoutMs}ms`,
        ));
        socket.destroy();
      }, this.writeTimeoutMs);
      socket.write(data, (error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private fail(error: Error): void {
    clearTimeout(this.frameReadTimeout);
    this.frameReadTimeout = undefined;
    this.readyWaiter?.reject(error);
    this.readyWaiter = undefined;
    this.shutdownWaiter?.reject(error);
    this.shutdownWaiter = undefined;
    this.rejectPending(error);
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
  }

  private onClose(): void {
    if (this.pending) {
      this.rejectPending(new Error(
        `guest disconnected while request ${this.pending.requestId} was running`,
      ));
    }
    if (!this.ready) {
      this.readyWaiter?.reject(new Error('guest disconnected before readiness'));
      this.readyWaiter = undefined;
    }
  }
}

async function writeWithBackpressure(destination: Writable, data: Buffer): Promise<void> {
  if (destination.write(data)) return;
  await new Promise<void>((resolve, reject) => {
    destination.once('drain', resolve);
    destination.once('error', reject);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function signalNumber(signal: string | null): number {
  if (!signal) return 0;
  const numericFallback = /^SIG(\d+)$/.exec(signal);
  if (numericFallback) return Number(numericFallback[1]);
  return osConstants.signals[signal as keyof typeof osConstants.signals] ?? 0;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
