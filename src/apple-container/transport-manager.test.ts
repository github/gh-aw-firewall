import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

import {
  APPLE_CONTAINER_TRANSPORT_DEFAULT_HEALTH,
  probeAppleContainerUpstream,
  startAppleContainerTransport,
  type AppleContainerTransportDependencies,
} from './transport-manager';
import { AppleContainerCapabilityRelay } from './transport-relay';

const INIT_IMAGE = 'ghcr.io/github/gh-aw-firewall/apple-init:v1';

interface Upstream {
  readonly port: number;
  close(): Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const server = net.createServer((socket) => socket.on('data', (chunk: Buffer) => {
    socket.write(chunk);
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function silentLogger(): AppleContainerTransportDependencies['logger'] {
  return { debug: jest.fn(), warn: jest.fn() };
}

describe('startAppleContainerTransport', () => {
  const bases: string[] = [];
  const upstreams: Upstream[] = [];

  function newBase(): string {
    const base = fs.mkdtempSync('/tmp/awfmg');
    bases.push(base);
    return base;
  }

  afterEach(async () => {
    for (const upstream of upstreams.splice(0)) await upstream.close();
    for (const base of bases.splice(0)) fs.rmSync(base, { recursive: true, force: true });
  });

  it('binds, verifies, and reports every capability', async () => {
    const squid = await startUpstream();
    const api = await startUpstream();
    upstreams.push(squid, api);
    const base = newBase();

    const transport = await startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [
        { id: 'squid', upstream: { host: '127.0.0.1', port: squid.port } },
        { id: 'api-proxy-openai', upstream: { host: '127.0.0.1', port: api.port } },
      ],
    }, { logger: silentLogger() });

    try {
      const stats = transport.stats();
      expect(Object.keys(stats).sort()).toEqual(['api-proxy-openai', 'squid']);
      expect(stats.squid.established).toBe(1);
      for (const entry of transport.plan.entries) {
        expect(fs.lstatSync(entry.hostSocketPath).isSocket()).toBe(true);
        expect(fs.lstatSync(entry.hostSocketPath).mode & 0o777).toBe(0o600);
      }
      expect(fs.lstatSync(transport.directory.path).mode & 0o777).toBe(0o700);
      await expect(transport.verify()).resolves.toBeUndefined();
    } finally {
      await transport.stop();
    }
  });

  it('waits for an upstream that is not healthy yet', async () => {
    const squid = await startUpstream();
    upstreams.push(squid);
    const base = newBase();
    const probe = jest.fn()
      .mockRejectedValueOnce(new Error('not up'))
      .mockResolvedValue(undefined);
    const sleep = jest.fn().mockResolvedValue(undefined);

    const transport = await startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: squid.port } }],
      health: { attempts: 3, retryDelayMs: 1, timeoutMs: 50 },
    }, { logger: silentLogger(), probeUpstream: probe, sleep });

    try {
      expect(probe).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(1);
    } finally {
      await transport.stop();
    }
  });

  it('never binds a relay when an upstream stays unhealthy', async () => {
    const base = newBase();
    const createRelay = jest.fn();

    await expect(startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: 3128 } }],
      health: { attempts: 2, retryDelayMs: 0, timeoutMs: 10 },
    }, {
      logger: silentLogger(),
      probeUpstream: jest.fn().mockRejectedValue(new Error('refused')),
      sleep: jest.fn().mockResolvedValue(undefined),
      createRelay: createRelay as never,
    })).rejects.toThrow(/never became healthy after 2 attempts/);

    expect(createRelay).not.toHaveBeenCalled();
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('rolls back completely when a later relay fails to bind', async () => {
    const squid = await startUpstream();
    const api = await startUpstream();
    upstreams.push(squid, api);
    const base = newBase();

    let created = 0;
    const createRelay: AppleContainerTransportDependencies['createRelay'] = (options) => {
      created += 1;
      if (created === 2) {
        // Simulate a bind failure on the second capability.
        const relay = new AppleContainerCapabilityRelay(options);
        jest.spyOn(relay, 'start').mockRejectedValue(new Error('bind refused'));
        return relay;
      }
      return new AppleContainerCapabilityRelay(options);
    };

    await expect(startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [
        { id: 'squid', upstream: { host: '127.0.0.1', port: squid.port } },
        { id: 'api-proxy-openai', upstream: { host: '127.0.0.1', port: api.port } },
      ],
    }, { logger: silentLogger(), createRelay })).rejects.toThrow('bind refused');

    // Nothing survives a partial startup: no sockets, no run directory.
    expect(fs.readdirSync(base)).toEqual([]);
  });

  // Regression: start() binds the listener and *then* verifies its mode and
  // ownership. A failure in that tail must not strand a bound, still-accepting
  // relay that nothing holds a reference to.
  it('rolls back a relay that bound but failed its post-bind verification', async () => {
    const squid = await startUpstream();
    upstreams.push(squid);
    const base = newBase();

    let leaked: AppleContainerCapabilityRelay | undefined;
    const createRelay: AppleContainerTransportDependencies['createRelay'] = (options) => {
      const relay = new AppleContainerCapabilityRelay(options);
      const realStart = relay.start.bind(relay);
      jest.spyOn(relay, 'start').mockImplementation(async () => {
        await realStart();
        leaked = relay;
        throw new Error('post-bind verification failed');
      });
      return relay;
    };

    await expect(startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: squid.port } }],
    }, { logger: silentLogger(), createRelay }))
      .rejects.toThrow('post-bind verification failed');

    expect(leaked).toBeDefined();
    expect(leaked!.isBound).toBe(true);
    // Nothing bound survives: no socket, no run directory, no live listener.
    expect(fs.readdirSync(base)).toEqual([]);
    await expect(new Promise((resolve, reject) => {
      const client = net.connect({ path: leaked!.socketPath });
      client.once('connect', () => { client.destroy(); resolve('connected'); });
      client.once('error', reject);
    })).rejects.toThrow();
  });

  it('leaves a pre-existing file alone when a relay fails before binding', async () => {
    const squid = await startUpstream();
    upstreams.push(squid);
    const base = newBase();
    const runId = 'aaaabbbbcccc';
    // Plant a file exactly where the squid relay would bind.
    const runDirectory = path.join(base, `awf-apple-${runId}`);

    const createRelay: AppleContainerTransportDependencies['createRelay'] = (options) => {
      fs.mkdirSync(runDirectory, { recursive: true });
      fs.writeFileSync(options.socketPath, 'planted');
      return new AppleContainerCapabilityRelay(options);
    };

    await expect(startAppleContainerTransport({
      baseDirectory: base,
      runId,
      initImage: INIT_IMAGE,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: squid.port } }],
    }, { logger: silentLogger(), createRelay })).rejects.toThrow(/already exists/);

    expect(fs.readFileSync(path.join(runDirectory, 'squid.sock'), 'utf8')).toBe('planted');
  });

  it('rolls back when end-to-end verification fails, even though binding worked', async () => {
    const squid = await startUpstream();
    const api = await startUpstream();
    upstreams.push(squid, api);
    const deadPort = api.port;
    await api.close();
    upstreams.pop();
    const base = newBase();

    await expect(startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [
        { id: 'squid', upstream: { host: '127.0.0.1', port: squid.port } },
        { id: 'api-proxy-openai', upstream: { host: '127.0.0.1', port: deadPort } },
      ],
      // The upstream health gate is bypassed so the failure lands on the
      // end-to-end probe rather than on the pre-flight check.
      health: { attempts: 1, retryDelayMs: 0, timeoutMs: 10 },
    }, {
      logger: silentLogger(),
      probeUpstream: jest.fn().mockResolvedValue(undefined),
    })).rejects.toThrow(/could not reach 127\.0\.0\.1:/);

    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('forwards data end to end through a published socket', async () => {
    const squid = await startUpstream();
    upstreams.push(squid);
    const base = newBase();

    const transport = await startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: squid.port } }],
    }, { logger: silentLogger() });

    try {
      const socketPath = transport.plan.entries[0].hostSocketPath;
      const echoed = await new Promise<string>((resolve, reject) => {
        const client = net.connect({ path: socketPath });
        client.on('connect', () => client.write('ping'));
        client.on('data', (chunk: Buffer) => {
          client.destroy();
          resolve(chunk.toString());
        });
        client.on('error', reject);
      });
      expect(echoed).toBe('ping');
    } finally {
      await transport.stop();
    }
  });

  it('removes every socket and the run directory on stop, idempotently', async () => {
    const squid = await startUpstream();
    upstreams.push(squid);
    const base = newBase();

    const transport = await startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: squid.port } }],
    }, { logger: silentLogger() });

    await transport.stop();
    expect(fs.existsSync(transport.directory.path)).toBe(false);
    await expect(transport.stop()).resolves.toBeUndefined();
    await expect(transport.verify()).rejects.toThrow(/has been stopped/);
    expect(() => transport.applyTo({ image: 'x' })).toThrow(/has been stopped/);
  });

  it('shares one shutdown between concurrent stop() calls', async () => {
    const squid = await startUpstream();
    upstreams.push(squid);
    const base = newBase();

    const transport = await startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: squid.port } }],
    }, { logger: silentLogger() });

    await Promise.all([transport.stop(), transport.stop(), transport.stop()]);
    expect(fs.existsSync(transport.directory.path)).toBe(false);
  });

  it('preserves diagnostics without leaving an active access path', async () => {
    const squid = await startUpstream();
    upstreams.push(squid);
    const base = newBase();

    const transport = await startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: squid.port } }],
    }, { logger: silentLogger() });

    const socketPath = transport.plan.entries[0].hostSocketPath;
    await transport.stop({ preserveDiagnostics: true });

    expect(fs.existsSync(transport.directory.path)).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(false);

    const summaryPath = path.join(transport.directory.path, 'transport-summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(summary.capabilities[0].id).toBe('squid');
    expect(summary.capabilities[0].stats.established).toBe(1);
    expect(fs.lstatSync(summaryPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(summary).toLowerCase()).not.toContain('key');
  });

  it('applies the plan to a run spec and keeps the guest isolated', async () => {
    const squid = await startUpstream();
    upstreams.push(squid);
    const base = newBase();

    const transport = await startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: squid.port } }],
    }, { logger: silentLogger() });

    try {
      const spec = transport.applyTo({ image: 'ghcr.io/github/gh-aw-firewall/agent:latest' });
      expect(spec.network).toEqual({ kind: 'none' });
      expect(spec.initImage).toBe(INIT_IMAGE);
      expect(spec.capDrop).toEqual(expect.arrayContaining(['NET_RAW']));
    } finally {
      await transport.stop();
    }
  });

  it('rejects nonsensical health options before touching the filesystem', async () => {
    const base = newBase();
    await expect(startAppleContainerTransport({
      baseDirectory: base,
      initImage: INIT_IMAGE,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: 3128 } }],
      health: { attempts: 0 },
    }, { logger: silentLogger() })).rejects.toThrow(/health attempts must be an integer/);
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('exposes sensible default health settings', () => {
    expect(APPLE_CONTAINER_TRANSPORT_DEFAULT_HEALTH.attempts).toBeGreaterThan(1);
    expect(APPLE_CONTAINER_TRANSPORT_DEFAULT_HEALTH.timeoutMs).toBeGreaterThan(0);
  });
});

describe('probeAppleContainerUpstream', () => {
  it('resolves for a listening service and rejects for a dead one', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    await expect(probeAppleContainerUpstream({ host: '127.0.0.1', port }, 2_000))
      .resolves.toBeUndefined();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(probeAppleContainerUpstream({ host: '127.0.0.1', port }, 2_000))
      .rejects.toThrow();
  });
});
