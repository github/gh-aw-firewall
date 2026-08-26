import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

import {
  APPLE_CONTAINER_RELAY_DEFAULT_LIMITS,
  AppleContainerCapabilityRelay,
} from './transport-relay';
import { getAppleContainerCapability } from './transport-capabilities';

const SQUID = getAppleContainerCapability('squid');

function shortBase(): string {
  return fs.mkdtempSync('/tmp/awfrl');
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A stand-in for an AWF sidecar: echoes back what it receives. */
async function startEchoUpstream(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('data', (chunk: Buffer) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])));
    socket.on('end', () => socket.end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function connectAndExchange(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ path: socketPath });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('timed out'));
    }, 5_000);
    client.on('connect', () => client.write(payload));
    client.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      clearTimeout(timer);
      client.destroy();
      resolve(Buffer.concat(chunks).toString());
    });
    client.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.on('close', () => {
      clearTimeout(timer);
      if (chunks.length === 0) reject(new Error('closed with no data'));
    });
  });
}

describe('AppleContainerCapabilityRelay', () => {
  const bases: string[] = [];
  const relays: AppleContainerCapabilityRelay[] = [];

  afterEach(async () => {
    for (const relay of relays.splice(0)) {
      await relay.stop().catch(() => undefined);
    }
    for (const base of bases.splice(0)) {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  function newRelay(
    socketPath: string,
    port: number,
    limits?: Partial<typeof APPLE_CONTAINER_RELAY_DEFAULT_LIMITS>,
  ): AppleContainerCapabilityRelay {
    const relay = new AppleContainerCapabilityRelay({
      capability: SQUID,
      socketPath,
      upstream: { host: '127.0.0.1', port },
      ...(limits ? { limits } : {}),
    });
    relays.push(relay);
    return relay;
  }

  it('rejects an upstream that is not an AWF-owned address at construction time', () => {
    expect(() => new AppleContainerCapabilityRelay({
      capability: SQUID,
      socketPath: '/tmp/x.sock',
      upstream: { host: '169.254.169.254', port: 80 },
    })).toThrow(/not a loopback or private address/);
  });

  it('binds a 0600 socket and forwards bytes to the upstream', async () => {
    const base = shortBase();
    bases.push(base);
    const upstream = await startEchoUpstream();
    try {
      const socketPath = path.join(base, 'squid.sock');
      const relay = newRelay(socketPath, upstream.port);
      await relay.start();

      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      expect(fs.lstatSync(socketPath).mode & 0o777).toBe(0o600);

      await expect(connectAndExchange(socketPath, 'hello')).resolves.toBe('echo:hello');
      expect(relay.stats.established).toBe(1);
      expect(relay.stats.bytesToUpstream).toBe(5);
      expect(relay.stats.bytesToGuest).toBe(10);
    } finally {
      await upstream.close();
    }
  });

  it('verifies end to end with probe() when the upstream is reachable', async () => {
    const base = shortBase();
    bases.push(base);
    const upstream = await startEchoUpstream();
    try {
      const relay = newRelay(path.join(base, 'squid.sock'), upstream.port);
      await relay.start();
      await expect(relay.probe()).resolves.toBeUndefined();
      expect(relay.stats.established).toBe(1);
    } finally {
      await upstream.close();
    }
  });

  it('fails probe() when the upstream is gone, with no fallback path', async () => {
    const base = shortBase();
    bases.push(base);
    const upstream = await startEchoUpstream();
    const port = upstream.port;
    await upstream.close();

    const relay = newRelay(path.join(base, 'squid.sock'), port);
    await relay.start();
    await expect(relay.probe()).rejects.toThrow(/could not reach 127\.0\.0\.1:/);
    expect(relay.stats.dialFailures).toBe(1);
    expect(relay.stats.established).toBe(0);
  });

  it('times out a hanging upstream dial instead of pinning the connection', async () => {
    const base = shortBase();
    bases.push(base);
    const socketPath = path.join(base, 'squid.sock');
    const relay = new AppleContainerCapabilityRelay({
      capability: SQUID,
      socketPath,
      upstream: { host: '127.0.0.1', port: 3128 },
      limits: { connectTimeoutMs: 30 },
      dependencies: {
        // A socket that never connects and never errors.
        connectUpstream: () => new net.Socket(),
      },
    });
    relays.push(relay);
    await relay.start();
    await expect(relay.probe(2_000)).rejects.toThrow(/connect timed out after 30ms/);
    expect(relay.stats.dialFailures).toBe(1);
  });

  it('refuses to bind over a stale or planted socket path', async () => {
    const base = shortBase();
    bases.push(base);
    const socketPath = path.join(base, 'squid.sock');
    fs.writeFileSync(socketPath, 'stale');

    const relay = newRelay(socketPath, 1);
    await expect(relay.start()).rejects.toThrow(/already exists/);
    // The planted file must survive: binding never unlinks.
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('stale');

    // ...and stopping a relay that never bound must not delete it either.
    await relay.stop();
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('stale');
  });

  it('fails every probe after the listener errors, instead of reporting healthy', async () => {
    const base = shortBase();
    bases.push(base);
    const upstream = await startEchoUpstream();
    try {
      const relay = newRelay(path.join(base, 'squid.sock'), upstream.port);
      await relay.start();
      await expect(relay.probe()).resolves.toBeUndefined();

      // Simulate a post-listen listener fault by emitting on the underlying
      // server; the relay records it and must never report healthy again.
      const server = (relay as unknown as { server: NodeJS.EventEmitter }).server;
      server.emit('error', new Error('listener exploded'));
      await expect(relay.probe()).rejects.toThrow(/listener failed: listener exploded/);
    } finally {
      await upstream.close();
    }
  });

  it('refuses to start twice', async () => {
    const base = shortBase();
    bases.push(base);
    const upstream = await startEchoUpstream();
    try {
      const relay = newRelay(path.join(base, 'squid.sock'), upstream.port);
      await relay.start();
      await expect(relay.start()).rejects.toThrow(/already started/);
    } finally {
      await upstream.close();
    }
  });

  it('drops connections beyond the concurrency cap', async () => {
    const base = shortBase();
    bases.push(base);
    const upstream = await startEchoUpstream();
    try {
      const socketPath = path.join(base, 'squid.sock');
      const relay = newRelay(socketPath, upstream.port, { maxConnections: 1 });
      await relay.start();

      const held = net.connect({ path: socketPath });
      await new Promise<void>((resolve, reject) => {
        held.once('connect', resolve);
        held.once('error', reject);
      });
      // Give the relay time to establish the first pair.
      await new Promise((resolve) => setTimeout(resolve, 50));

      await expect(connectAndExchange(socketPath, 'second')).rejects.toThrow();
      expect(relay.stats.rejected).toBeGreaterThanOrEqual(1);
      held.destroy();
    } finally {
      await upstream.close();
    }
  });

  it('tears down a pair whose peer stops reading, bounding buffered bytes', async () => {
    const base = shortBase();
    bases.push(base);
    const socketPath = path.join(base, 'squid.sock');

    // A controllable upstream: the relay's dial resolves when we emit
    // 'connect', and payload is injected on demand, so the buffer cap is
    // exercised deterministically rather than by racing a real flood.
    const upstream = new net.Socket();
    upstream.on('error', () => undefined);
    const relay = new AppleContainerCapabilityRelay({
      capability: SQUID,
      socketPath,
      upstream: { host: '127.0.0.1', port: 3128 },
      limits: { maxBufferedBytes: 1024 },
      dependencies: {
        connectUpstream: () => {
          // The relay attaches its 'connect' listener synchronously after this
          // returns, so the event is deferred by one tick.
          setImmediate(() => upstream.emit('connect'));
          return upstream;
        },
      },
    });
    relays.push(relay);
    await relay.start();

    const client = net.connect({ path: socketPath });
    client.pause(); // never read, so the relay must buffer
    client.on('error', () => undefined); // the relay resets the pair
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));

    await waitFor(() => relay.stats.established === 1);
    const blob = Buffer.alloc(64 * 1024, 0x61);
    let emitted = 0;
    for (let index = 0; index < 512 && !upstream.destroyed; index += 1) {
      upstream.emit('data', blob);
      emitted += 1;
    }
    // The relay must have cut the pair off long before the whole flood landed.
    expect(emitted).toBeLessThan(512);

    // The paused client never processes EOF, so readiness is observed on the
    // relay side: the pair is gone and only a bounded prefix was copied.
    await waitFor(() => relay.stats.active === 0);
    expect(relay.stats.bytesToGuest).toBeLessThan(512 * blob.length);
    client.destroy();
  });

  it('stops deterministically, unlinks its own socket, and is idempotent', async () => {
    const base = shortBase();
    bases.push(base);
    const upstream = await startEchoUpstream();
    try {
      const socketPath = path.join(base, 'squid.sock');
      const relay = newRelay(socketPath, upstream.port);
      await relay.start();

      const held = net.connect({ path: socketPath });
      await new Promise<void>((resolve) => held.once('connect', () => resolve()));

      await relay.stop();
      expect(fs.existsSync(socketPath)).toBe(false);
      expect(relay.stats.active).toBe(0);
      await expect(relay.stop()).resolves.toBeUndefined();
      await expect(relay.probe()).rejects.toThrow(/is not running/);
    } finally {
      await upstream.close();
    }
  });

  it('leaves a socket it never bound alone when stopped', async () => {
    const base = shortBase();
    bases.push(base);
    const socketPath = path.join(base, 'squid.sock');
    fs.writeFileSync(socketPath, 'not-ours');
    const relay = newRelay(socketPath, 1);
    await relay.stop();
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('not-ours');
  });

  it('rejects out-of-range limits', () => {
    for (const limits of [
      { maxConnections: 0 },
      { connectTimeoutMs: 0 },
      { idleTimeoutMs: -1 },
      { maxBufferedBytes: 1.5 },
    ]) {
      expect(() => new AppleContainerCapabilityRelay({
        capability: SQUID,
        socketPath: '/tmp/x.sock',
        upstream: { host: '127.0.0.1', port: 3128 },
        limits,
      })).toThrow(/must be an integer in/);
    }
  });

  it('refuses concurrent probes', async () => {
    const base = shortBase();
    bases.push(base);
    const upstream = await startEchoUpstream();
    try {
      const relay = newRelay(path.join(base, 'squid.sock'), upstream.port);
      await relay.start();
      const first = relay.probe();
      await expect(relay.probe()).rejects.toThrow(/probe already in flight/);
      await first;
    } finally {
      await upstream.close();
    }
  });
});
