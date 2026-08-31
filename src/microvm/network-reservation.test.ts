import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MicrovmNetworkReservationRegistry,
  type MicrovmNetworkReservationDependencies,
} from './network-reservation';
import type { MicrovmNetworkHostTools, MicrovmNetworkPlanOptions } from './network-types';

const tools: MicrovmNetworkHostTools = {
  ip: '/usr/bin/ip',
  nft: '/usr/sbin/nft',
  sysctl: '/usr/sbin/sysctl',
  flock: '/usr/bin/flock',
};
const options: MicrovmNetworkPlanOptions = {
  infrastructureBridge: 'awfbr0',
  enableApiProxy: true,
  tapOwnerUid: 1000,
  tapOwnerGid: 1000,
};

function serializedLock(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let unlock!: () => void;
    tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
    }
  };
}

describe('microVM network reservation registry', () => {
  let root: string;
  let alive: boolean;
  let namespaces: Set<string>;
  let interfaces: Set<string>;
  let routes: string[];
  let addresses: Set<string>;
  let firewallTokens: Set<string>;
  let dependencies: MicrovmNetworkReservationDependencies;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-network-reservation-'));
    alive = true;
    namespaces = new Set();
    interfaces = new Set();
    routes = [];
    addresses = new Set();
    firewallTokens = new Set();
    dependencies = {
      expectedOwnerUid: process.getuid?.() ?? 0,
      readProcessIdentity: jest.fn().mockResolvedValue({
        bootId: 'boot-a',
        pid: 4242,
        startTimeTicks: '98765',
      }),
      isProcessIdentityAlive: jest.fn(async () => alive),
      withLock: serializedLock(),
      inspectLiveResources: jest.fn(async () => ({
        namespaces,
        interfaces,
        routes,
        addresses,
        firewallTokens,
      })),
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('atomically gives concurrent independent runs disjoint subnets and tokens', async () => {
    const firstRegistry = new MicrovmNetworkReservationRegistry(tools, root, dependencies);
    const secondRegistry = new MicrovmNetworkReservationRegistry(tools, root, dependencies);

    const [first, second] = await Promise.all([
      firstRegistry.reserve('same-hash-input', options),
      secondRegistry.reserve('same-hash-input', options),
    ]);

    expect(first.plan.guestSubnet).not.toBe(second.plan.guestSubnet);
    expect(first.plan.infrastructureIp).not.toBe(second.plan.infrastructureIp);
    expect(first.plan.resourceToken).not.toBe(second.plan.resourceToken);
    expect(first.plan.namespaceName).not.toBe(second.plan.namespaceName);
    expect(await fs.readdir(path.join(root, 'reservations'))).toHaveLength(2);

    await first.release();
    expect(await fs.readdir(path.join(root, 'reservations'))).toEqual([
      `${second.plan.resourceToken}.json`,
    ]);
    await second.release();
    expect(await fs.readdir(path.join(root, 'reservations'))).toEqual([]);
  });

  it('never releases a reservation after its durable lease identity changes', async () => {
    const reservation = await new MicrovmNetworkReservationRegistry(
      tools,
      root,
      dependencies,
    ).reserve('owner-a', options);
    const reservationPath = reservation.plan.reservationPath!;
    const record = JSON.parse(await fs.readFile(reservationPath, 'utf8')) as {
      leaseId: string;
    };
    record.leaseId = 'different-owner';
    await fs.writeFile(reservationPath, `${JSON.stringify(record)}\n`);

    await expect(reservation.release()).rejects.toThrow(/not owned/);
    await expect(fs.access(reservationPath)).resolves.toBeUndefined();
  });

  it('recovers a dead owner only after its namespace, interfaces, and route are gone', async () => {
    const registry = new MicrovmNetworkReservationRegistry(tools, root, dependencies);
    const stale = await registry.reserve('recover-stale', options);
    alive = false;
    namespaces.add(stale.plan.namespaceName);
    interfaces.add(stale.plan.hostVethName);
    routes.push(stale.plan.guestSubnet);
    firewallTokens.add(stale.plan.resourceToken);

    const whileLive = await registry.reserve('recover-stale', options);
    expect(whileLive.plan.guestSubnet).not.toBe(stale.plan.guestSubnet);

    namespaces.clear();
    interfaces.clear();
    routes = [];
    firewallTokens.clear();
    addresses.clear();
    const recovered = await registry.reserve('recover-stale', options);
    expect(recovered.plan.guestSubnet).toBe(stale.plan.guestSubnet);
    const files = await fs.readdir(path.join(root, 'reservations'));
    expect(files).not.toContain(`${stale.plan.resourceToken}.json`);
  });

  it('does not claim a live or reserved address on the shared infrastructure bridge', async () => {
    addresses.add('172.30.0.20');
    const registry = new MicrovmNetworkReservationRegistry(tools, root, dependencies);
    const first = await registry.reserve('bridge-address-first', options);
    const second = await registry.reserve('bridge-address-second', options);

    expect(first.plan.infrastructureIp).not.toBe('172.30.0.20');
    expect(second.plan.infrastructureIp).not.toBe(first.plan.infrastructureIp);
  });

  it('skips a candidate subnet already covered by a live route', async () => {
    const baseline = await new MicrovmNetworkReservationRegistry(
      tools,
      root,
      dependencies,
    ).reserve('route-collision', options);
    await baseline.release();
    routes = [baseline.plan.guestSubnet];

    const reservation = await new MicrovmNetworkReservationRegistry(
      tools,
      root,
      dependencies,
    ).reserve('route-collision', options);

    expect(reservation.plan.guestSubnet).not.toBe(baseline.plan.guestSubnet);
  });
});
