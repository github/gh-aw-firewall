/**
 * One capability relay: a host Unix socket that forwards to exactly one host
 * TCP service.
 *
 * The relay is deliberately dumb. It performs **no protocol parsing** — no HTTP
 * framing, no CONNECT handling, no header rewriting — because parsing attacker
 * influenced bytes on the host side of the VM boundary would be the single most
 * dangerous thing this layer could do. It is a byte pump with hard bounds:
 *
 * - a fixed maximum number of concurrent connections, beyond which new guest
 *   connections are dropped immediately rather than queued;
 * - a connect timeout on the upstream dial, so a wedged sidecar cannot pin a
 *   guest connection open forever;
 * - an idle timeout on both halves;
 * - a hard cap on bytes buffered in either direction, on top of ordinary
 *   backpressure, so a slow reader cannot grow host memory without limit.
 *
 * Half-close is preserved in both directions (`allowHalfOpen`), which HTTP
 * proxying depends on: a client that shuts down its write side after a request
 * must still receive the full response.
 *
 * A failed upstream dial closes the guest connection with no data. There is no
 * retry, no queue, and no fallback path — a capability is either connected to
 * its real upstream or it is dead.
 */

import * as fs from 'fs/promises';
import * as net from 'net';

import type {
  AppleContainerCapabilityDefinition,
  AppleContainerUpstreamEndpoint,
} from './transport-capabilities';
import { assertAppleContainerUpstreamEndpoint } from './transport-capabilities';
import {
  assertPrivateSocket,
  assertSocketPathUnused,
} from './transport-socket-dir';

export interface AppleContainerRelayLimits {
  readonly maxConnections: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxBufferedBytes: number;
}

export const APPLE_CONTAINER_RELAY_DEFAULT_LIMITS: AppleContainerRelayLimits = Object.freeze({
  maxConnections: 64,
  connectTimeoutMs: 5_000,
  // Long-running agent turns hold an idle proxy connection open between
  // requests; five minutes is well past any sidecar keep-alive but still bounds
  // a leaked connection.
  idleTimeoutMs: 300_000,
  maxBufferedBytes: 4 * 1024 * 1024,
});

export interface AppleContainerRelayStats {
  readonly accepted: number;
  readonly rejected: number;
  readonly established: number;
  readonly dialFailures: number;
  readonly active: number;
  readonly bytesToUpstream: number;
  readonly bytesToGuest: number;
}

/** Injectable socket factories, so tests never need a real Apple VM. */
export interface AppleContainerRelayDependencies {
  connectUpstream(endpoint: AppleContainerUpstreamEndpoint): net.Socket;
  connectLocal(socketPath: string): net.Socket;
}

const defaultDependencies: AppleContainerRelayDependencies = {
  connectUpstream: (endpoint) =>
    net.connect({ host: endpoint.host, port: endpoint.port, allowHalfOpen: true }),
  connectLocal: (socketPath) => net.connect({ path: socketPath, allowHalfOpen: true }),
};

export interface AppleContainerRelayOptions {
  readonly capability: AppleContainerCapabilityDefinition;
  readonly socketPath: string;
  readonly upstream: AppleContainerUpstreamEndpoint;
  readonly limits?: Partial<AppleContainerRelayLimits>;
  readonly dependencies?: Partial<AppleContainerRelayDependencies>;
}

type ProbeSettler = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export class AppleContainerCapabilityRelay {
  readonly capability: AppleContainerCapabilityDefinition;
  readonly socketPath: string;
  readonly upstream: AppleContainerUpstreamEndpoint;

  private readonly limits: AppleContainerRelayLimits;
  private readonly deps: AppleContainerRelayDependencies;
  private readonly live = new Set<net.Socket>();
  private server?: net.Server;
  private started = false;
  /**
   * Set only after `listen()` succeeds. `stop()` unlinks the socket path only
   * when this is true, so a `start()` that aborted on a pre-existing path never
   * deletes a file this relay did not create.
   */
  private bound = false;
  private stopped = false;
  private serverError?: Error;
  private pendingProbe?: ProbeSettler;

  private pairs = 0;
  private accepted = 0;
  private rejected = 0;
  private established = 0;
  private dialFailures = 0;
  private bytesToUpstream = 0;
  private bytesToGuest = 0;

  constructor(options: AppleContainerRelayOptions) {
    this.capability = options.capability;
    this.socketPath = options.socketPath;
    this.upstream = assertAppleContainerUpstreamEndpoint(
      options.upstream,
      `capability ${options.capability.id}`,
    );
    this.limits = normalizeLimits(options.limits);
    this.deps = { ...defaultDependencies, ...options.dependencies };
  }

  /**
   * Whether the listening socket was actually bound.
   *
   * Cleanup uses this to remove only paths this relay created: a `start()` that
   * aborted before `listen()` must never cause an unlink.
   */
  get isBound(): boolean {
    return this.bound;
  }

  get stats(): AppleContainerRelayStats {
    return {
      accepted: this.accepted,
      rejected: this.rejected,
      established: this.established,
      dialFailures: this.dialFailures,
      active: this.pairs,
      bytesToUpstream: this.bytesToUpstream,
      bytesToGuest: this.bytesToGuest,
    };
  }

  /**
   * Binds the Unix socket.
   *
   * The path must not already exist: binding never unlinks, so a stale or
   * planted socket is a hard failure rather than a hijack opportunity.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error(`Apple Container relay ${this.capability.id} is already started`);
    }
    this.started = true;

    await assertSocketPathUnused(this.socketPath);

    const server = net.createServer({ allowHalfOpen: true }, (guest) => {
      this.handleConnection(guest);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        reject(new Error(
          `Apple Container relay ${this.capability.id} could not bind ${this.socketPath}: ` +
          error.message,
        ));
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.socketPath);
    });

    this.bound = true;

    // The listening socket inherits the process umask, so the mode is forced
    // here. The enclosing directory is already 0700, so the intervening window
    // is not reachable by another user.
    await fs.chmod(this.socketPath, 0o600);
    await assertPrivateSocket(this.socketPath);

    // A post-listen server error must not become an unhandled 'error' event,
    // but it must not be swallowed either: it is recorded and makes every
    // subsequent probe fail, so a degraded listener can never be reported ready.
    server.on('error', (error: Error) => {
      this.serverError = error;
    });
  }

  /**
   * End-to-end self test: connects to this relay's own Unix socket and waits
   * for the upstream dial to complete.
   *
   * This is what lets startup assert that a capability actually works instead of
   * merely that a socket file exists.
   */
  async probe(timeoutMs = this.limits.connectTimeoutMs): Promise<void> {
    if (!this.server || this.stopped) {
      throw new Error(`Apple Container relay ${this.capability.id} is not running`);
    }
    if (this.serverError) {
      throw new Error(
        `Apple Container relay ${this.capability.id} listener failed: ${this.serverError.message}`,
      );
    }
    if (this.pendingProbe) {
      throw new Error(`Apple Container relay ${this.capability.id} probe already in flight`);
    }

    const client = this.deps.connectLocal(this.socketPath);
    client.on('error', () => { /* settled through the probe promise */ });

    try {
      await new Promise<void>((resolve, reject) => {
        let done = false;
        // `settle` is referenced by the timer callback, which can only run on a
        // later tick, so the const is always initialised by then.
        const timer = setTimeout(() => settle(new Error(
          `Apple Container relay ${this.capability.id} probe timed out after ${timeoutMs}ms`,
        )), timeoutMs);
        timer.unref?.();

        const settle = (error?: Error): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.pendingProbe = undefined;
          if (error) reject(error); else resolve();
        };

        this.pendingProbe = {
          resolve: () => settle(),
          reject: (error) => settle(error),
        };
        client.once('error', (error: Error) => settle(new Error(
          `Apple Container relay ${this.capability.id} probe could not reach ` +
          `${this.socketPath}: ${error.message}`,
        )));
      });
    } finally {
      client.destroy();
    }
  }

  /**
   * Closes the listener, tears down every live connection, and unlinks the
   * socket this relay created. Safe to call repeatedly and safe to call on a
   * relay that never started.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    this.pendingProbe?.reject(
      new Error(`Apple Container relay ${this.capability.id} stopped during probe`),
    );
    this.pendingProbe = undefined;

    const server = this.server;
    this.server = undefined;
    if (server) {
      // `close()` only completes once every connection is gone, so the close is
      // initiated first and the live sockets are destroyed immediately after;
      // awaiting close before destroying would deadlock.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of [...this.live]) {
        socket.destroy();
      }
      this.live.clear();
      await closed;
    }

    for (const socket of [...this.live]) {
      socket.destroy();
    }
    this.live.clear();

    if (this.bound) {
      try {
        await fs.unlink(this.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private handleConnection(guest: net.Socket): void {
    const probe = this.pendingProbe;
    this.pendingProbe = undefined;

    this.accepted += 1;
    if (this.stopped || this.pairs >= this.limits.maxConnections) {
      this.rejected += 1;
      guest.destroy();
      probe?.reject(new Error(
        `Apple Container relay ${this.capability.id} refused a connection at capacity`,
      ));
      return;
    }

    this.pairs += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.pairs -= 1;
    };

    this.track(guest);
    const upstream = this.deps.connectUpstream(this.upstream);
    this.track(upstream);

    let connected = false;
    // `failDial` is referenced by the timer callback, which can only run on a
    // later tick, so the const is always initialised by then.
    const connectTimer = setTimeout(
      () => failDial(`upstream connect timed out after ${this.limits.connectTimeoutMs}ms`),
      this.limits.connectTimeoutMs,
    );
    connectTimer.unref?.();

    const failDial = (reason: string): void => {
      clearTimeout(connectTimer);
      if (!connected) {
        connected = true;
        this.dialFailures += 1;
        probe?.reject(new Error(
          `Apple Container relay ${this.capability.id} could not reach ` +
          `${this.upstream.host}:${this.upstream.port}: ${reason}`,
        ));
      }
      release();
      upstream.destroy();
      guest.destroy();
    };

    guest.on('error', (error: Error) => failDial(`guest connection failed: ${error.message}`));
    upstream.on('error', (error: Error) => failDial(error.message));
    guest.on('close', release);

    upstream.on('connect', () => {
      clearTimeout(connectTimer);
      if (connected) {
        // The dial already failed or timed out; do not resurrect the pair.
        upstream.destroy();
        return;
      }
      connected = true;
      this.established += 1;
      probe?.resolve();

      guest.setTimeout(this.limits.idleTimeoutMs);
      upstream.setTimeout(this.limits.idleTimeoutMs);
      const onIdle = (): void => {
        guest.destroy();
        upstream.destroy();
      };
      guest.on('timeout', onIdle);
      upstream.on('timeout', onIdle);

      this.pump(guest, upstream, 'toUpstream');
      this.pump(upstream, guest, 'toGuest');
    });
  }

  private track(socket: net.Socket): void {
    this.live.add(socket);
    socket.on('close', () => this.live.delete(socket));
  }

  /**
   * Copies one direction with explicit backpressure plus a hard buffer cap.
   *
   * `write()` returning false pauses the source, which is ordinary
   * backpressure; the additional `writableLength` check destroys the pair if a
   * peer stops reading entirely, bounding host memory per connection.
   */
  private pump(from: net.Socket, to: net.Socket, direction: 'toUpstream' | 'toGuest'): void {
    from.on('data', (chunk: Buffer) => {
      if (from.destroyed || to.destroyed) return;
      if (direction === 'toUpstream') {
        this.bytesToUpstream += chunk.length;
      } else {
        this.bytesToGuest += chunk.length;
      }
      const flushed = to.write(chunk);
      if (to.writableLength > this.limits.maxBufferedBytes) {
        from.destroy();
        to.destroy();
        return;
      }
      if (!flushed) from.pause();
    });
    to.on('drain', () => from.resume());
    from.on('end', () => {
      if (!to.writableEnded) to.end();
    });
    from.on('close', () => {
      if (!to.writableEnded) to.destroy();
    });
  }
}

function normalizeLimits(
  overrides: Partial<AppleContainerRelayLimits> | undefined,
): AppleContainerRelayLimits {
  const merged = { ...APPLE_CONTAINER_RELAY_DEFAULT_LIMITS, ...overrides };
  assertPositive(merged.maxConnections, 'maxConnections', 4096);
  assertPositive(merged.connectTimeoutMs, 'connectTimeoutMs', 600_000);
  assertPositive(merged.idleTimeoutMs, 'idleTimeoutMs', 86_400_000);
  assertPositive(merged.maxBufferedBytes, 'maxBufferedBytes', 256 * 1024 * 1024);
  return Object.freeze(merged);
}

function assertPositive(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(
      `Apple Container relay ${label} must be an integer in 1..${maximum}; got ${value}`,
    );
  }
}
