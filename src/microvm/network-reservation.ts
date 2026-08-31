import { createHash, randomBytes } from 'crypto';
import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa, { type ExecaChildProcess } from 'execa';
import {
  AGENT_IP,
  API_PROXY_IP,
  CLI_PROXY_IP,
  DOH_PROXY_IP,
  HOST_GATEWAY,
  NETWORK_SUBNET,
  SQUID_IP,
} from '../config/network-policy';
import { createMicrovmNetworkPlan } from './network-plan';
import type {
  MicrovmNetworkHostTools,
  MicrovmNetworkPlanOptions,
  MicrovmNetworkReservation,
} from './network-types';

const RESERVATION_ROOT = '/run/awf-microvm-network';
const RESERVATION_VERSION = 1;
const SUBNET_COUNT = 1 << 20;
const LOCK_TIMEOUT_SECONDS = 30;

interface ProcessIdentity {
  readonly bootId: string;
  readonly pid: number;
  readonly startTimeTicks: string;
}

interface ReservationRecord {
  readonly version: typeof RESERVATION_VERSION;
  readonly leaseId: string;
  readonly owner: ProcessIdentity;
  readonly runId: string;
  readonly resourceToken: string;
  readonly subnetIndex: number;
  readonly guestSubnet: string;
  readonly infrastructureBridge: string;
  readonly infrastructureIp: string;
  readonly namespaceName: string;
  readonly hostVethName: string;
  readonly namespaceVethName: string;
  readonly tapName: string;
  readonly createdAt: string;
}

interface LiveNetworkResources {
  readonly namespaces: ReadonlySet<string>;
  readonly interfaces: ReadonlySet<string>;
  readonly routes: readonly string[];
  readonly addresses: ReadonlySet<string>;
  readonly firewallTokens: ReadonlySet<string>;
}

export interface MicrovmNetworkReservationDependencies {
  readonly expectedOwnerUid: number;
  readProcessIdentity(): Promise<ProcessIdentity>;
  isProcessIdentityAlive(identity: ProcessIdentity): Promise<boolean>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  inspectLiveResources(): Promise<LiveNetworkResources>;
}

export class MicrovmNetworkReservationRegistry {
  private readonly reservationsDirectory: string;

  constructor(
    private readonly tools: MicrovmNetworkHostTools,
    private readonly root = RESERVATION_ROOT,
    private readonly dependencies = createDefaultDependencies(tools, root),
  ) {
    this.reservationsDirectory = path.join(root, 'reservations');
  }

  async reserve(
    runId: string,
    options: MicrovmNetworkPlanOptions,
  ): Promise<MicrovmNetworkReservation> {
    return this.dependencies.withLock(async () => {
      await this.assertPrivateRoot();
      const owner = await this.dependencies.readProcessIdentity();
      const live = await this.dependencies.inspectLiveResources();
      const records = await this.loadAndRecoverRecords(live);
      const reservedSubnets = new Set(records.map(({ record }) => record.guestSubnet));
      const reservedTokens = new Set(records.map(({ record }) => record.resourceToken));
      const reservedInfrastructureIps = new Set(
        records
          .filter(({ record }) => record.infrastructureBridge === options.infrastructureBridge)
          .map(({ record }) => record.infrastructureIp),
      );
      const infrastructureIp = chooseInfrastructureIp(
        options,
        reservedInfrastructureIps,
        live.addresses,
      );
      const initialSubnet = createHash('sha256').update(runId).digest().readUInt32BE(0)
        & (SUBNET_COUNT - 1);

      for (let offset = 0; offset < SUBNET_COUNT; offset += 1) {
        const subnetIndex = (initialSubnet + offset) & (SUBNET_COUNT - 1);
        const resourceToken = this.createUnusedToken(reservedTokens, live);
        const reservationPath = path.join(
          this.reservationsDirectory,
          `${resourceToken}.json`,
        );
        const plan = createMicrovmNetworkPlan(runId, options, {
          resourceToken,
          subnetIndex,
          infrastructureIp,
          reservationPath,
        });
        if (
          reservedSubnets.has(plan.guestSubnet)
          || live.routes.some((route) => cidrsOverlap(route, plan.guestSubnet))
        ) {
          continue;
        }

        const record: ReservationRecord = {
          version: RESERVATION_VERSION,
          leaseId: randomBytes(16).toString('hex'),
          owner,
          runId,
          resourceToken,
          subnetIndex,
          guestSubnet: plan.guestSubnet,
          infrastructureBridge: plan.infrastructureBridge,
          infrastructureIp: plan.infrastructureIp,
          namespaceName: plan.namespaceName,
          hostVethName: plan.hostVethName,
          namespaceVethName: plan.namespaceVethName,
          tapName: plan.tapName,
          createdAt: new Date().toISOString(),
        };
        await this.writeRecordAtomically(reservationPath, record);
        return {
          plan,
          release: () => this.release(record, reservationPath),
        };
      }
      throw new Error('No unused microVM guest subnet is available');
    });
  }

  private async release(record: ReservationRecord, reservationPath: string): Promise<void> {
    await this.dependencies.withLock(async () => {
      await this.assertPrivateRoot();
      const current = await this.readRecord(reservationPath);
      if (
        current.leaseId !== record.leaseId
        || current.resourceToken !== record.resourceToken
        || current.owner.bootId !== record.owner.bootId
        || current.owner.pid !== record.owner.pid
        || current.owner.startTimeTicks !== record.owner.startTimeTicks
      ) {
        throw new Error(
          `Refusing to release microVM network reservation not owned by lease ${record.leaseId}`,
        );
      }
      await fs.rm(reservationPath);
    });
  }

  private async assertPrivateRoot(): Promise<void> {
    await fs.mkdir(this.reservationsDirectory, { recursive: true, mode: 0o700 });
    for (const directory of [this.root, this.reservationsDirectory]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.dependencies.expectedOwnerUid) {
        throw new Error(`Unsafe microVM network reservation directory: ${directory}`);
      }
      if ((stat.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
    }
  }

  private async loadAndRecoverRecords(
    live: LiveNetworkResources,
  ): Promise<Array<{ path: string; record: ReservationRecord }>> {
    const entries = await fs.readdir(this.reservationsDirectory, { withFileTypes: true });
    const records: Array<{ path: string; record: ReservationRecord }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f]{12}\.json$/.test(entry.name)) continue;
      const reservationPath = path.join(this.reservationsDirectory, entry.name);
      const record = await this.readRecord(reservationPath);
      const ownerAlive = await this.dependencies.isProcessIdentityAlive(record.owner);
      if (!ownerAlive && !recordHasLiveResources(record, live)) {
        await fs.rm(reservationPath);
        continue;
      }
      records.push({ path: reservationPath, record });
    }
    return records;
  }

  private async readRecord(reservationPath: string): Promise<ReservationRecord> {
    const raw = await fs.readFile(reservationPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ReservationRecord>;
    if (
      parsed.version !== RESERVATION_VERSION
      || typeof parsed.leaseId !== 'string'
      || typeof parsed.runId !== 'string'
      || typeof parsed.resourceToken !== 'string'
      || typeof parsed.subnetIndex !== 'number'
      || typeof parsed.guestSubnet !== 'string'
      || typeof parsed.infrastructureBridge !== 'string'
      || typeof parsed.infrastructureIp !== 'string'
      || typeof parsed.namespaceName !== 'string'
      || typeof parsed.hostVethName !== 'string'
      || typeof parsed.namespaceVethName !== 'string'
      || typeof parsed.tapName !== 'string'
      || typeof parsed.createdAt !== 'string'
      || !parsed.owner
      || typeof parsed.owner.bootId !== 'string'
      || typeof parsed.owner.pid !== 'number'
      || typeof parsed.owner.startTimeTicks !== 'string'
    ) {
      throw new Error(`Invalid microVM network reservation: ${reservationPath}`);
    }
    return parsed as ReservationRecord;
  }

  private createUnusedToken(
    reservedTokens: ReadonlySet<string>,
    live: LiveNetworkResources,
  ): string {
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const token = randomBytes(6).toString('hex');
      if (reservedTokens.has(token)) continue;
      const names = [`awfvm-${token}`, `vmh${token}`, `vmn${token}`, `vmt${token}`];
      if (
        names.some((name) => live.namespaces.has(name) || live.interfaces.has(name))
        || live.firewallTokens.has(token)
      ) continue;
      return token;
    }
    throw new Error('Unable to allocate a unique microVM network resource token');
  }

  private async writeRecordAtomically(
    reservationPath: string,
    record: ReservationRecord,
  ): Promise<void> {
    const temporaryPath = `${reservationPath}.${record.leaseId}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await fs.rename(temporaryPath, reservationPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

export function reserveMicrovmNetworkPlan(
  runId: string,
  options: MicrovmNetworkPlanOptions,
  tools: MicrovmNetworkHostTools,
): Promise<MicrovmNetworkReservation> {
  return new MicrovmNetworkReservationRegistry(tools).reserve(runId, options);
}

function createDefaultDependencies(
  tools: MicrovmNetworkHostTools,
  root: string,
): MicrovmNetworkReservationDependencies {
  const lockPath = path.join(root, 'allocation.lock');
  return {
    expectedOwnerUid: 0,
    readProcessIdentity: () => readProcessIdentity(process.pid),
    isProcessIdentityAlive: async (identity) => {
      try {
        const current = await readProcessIdentity(identity.pid);
        return current.bootId === identity.bootId
          && current.startTimeTicks === identity.startTimeTicks;
      } catch {
        return false;
      }
    },
    withLock: async <T>(operation: () => Promise<T>): Promise<T> => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const rootStat = await fs.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== 0) {
        throw new Error(`Unsafe microVM network reservation directory: ${root}`);
      }
      if ((rootStat.mode & 0o077) !== 0) await fs.chmod(root, 0o700);
      const lockFile = await fs.open(lockPath, constants.O_CREAT | constants.O_RDWR, 0o600);
      await lockFile.close();
      await fs.chmod(lockPath, 0o600);
      const child = execa(
        tools.flock,
        [
          '--exclusive',
          '--wait', String(LOCK_TIMEOUT_SECONDS),
          lockPath,
          '/bin/sh', '-c',
          'printf "locked\\n"; cat >/dev/null',
        ],
        { reject: false, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      );
      await waitForLock(child);
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await operation() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      child.stdin?.end();
      const result = await child;
      if (result.exitCode !== 0) {
        const lockError = new Error(
          `microVM network allocation lock exited with code ${result.exitCode}: ${result.stderr.trim()}`,
        );
        if (!outcome.ok) {
          throw new Error(
            `${formatError(outcome.error)}; additionally, ${lockError.message}`,
          );
        }
        throw lockError;
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
    inspectLiveResources: () => inspectLiveResources(tools),
  };
}

async function waitForLock(child: ExecaChildProcess<string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(
      new Error(`Timed out acquiring microVM network allocation lock after ${LOCK_TIMEOUT_SECONDS}s`),
    ), (LOCK_TIMEOUT_SECONDS + 1) * 1000);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes('locked\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (!output.includes('locked\n')) {
        clearTimeout(timer);
        reject(new Error(`Failed to acquire microVM network allocation lock (exit ${code})`));
      }
    });
  });
}

async function readProcessIdentity(pid: number): Promise<ProcessIdentity> {
  const [bootId, stat] = await Promise.all([
    fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    fs.readFile(`/proc/${pid}/stat`, 'utf8'),
  ]);
  const commandEnd = stat.lastIndexOf(') ');
  if (commandEnd < 0) throw new Error(`Invalid /proc/${pid}/stat`);
  const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const startTimeTicks = fieldsAfterCommand[19];
  if (!startTimeTicks) throw new Error(`Missing process start time in /proc/${pid}/stat`);
  return { bootId: bootId.trim(), pid, startTimeTicks };
}

async function inspectLiveResources(
  tools: MicrovmNetworkHostTools,
): Promise<LiveNetworkResources> {
  const namespacesResult = await execa(tools.ip, ['netns', 'list'], { reject: false });
  if (namespacesResult.exitCode !== 0) {
    throw new Error(`Unable to inspect live network namespaces: ${namespacesResult.stderr.trim()}`);
  }
  const namespaces = new Set(
    namespacesResult.stdout.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter(Boolean),
  );
  const interfaces = new Set<string>();
  const routes: string[] = [];
  const addresses = new Set<string>();
  const firewallTokens = new Set<string>();
  const inspect = async (namespace?: string): Promise<void> => {
    const linkArgs = namespace
      ? ['netns', 'exec', namespace, tools.ip, '-o', 'link', 'show']
      : ['-o', 'link', 'show'];
    const routeArgs = namespace
      ? ['netns', 'exec', namespace, tools.ip, '-o', '-4', 'route', 'show', 'table', 'all']
      : ['-o', '-4', 'route', 'show', 'table', 'all'];
    const addressArgs = namespace
      ? ['netns', 'exec', namespace, tools.ip, '-o', '-4', 'addr', 'show']
      : ['-o', '-4', 'addr', 'show'];
    const [links, routeOutput, addressOutput] = await Promise.all([
      execa(tools.ip, linkArgs, { reject: false }),
      execa(tools.ip, routeArgs, {
        reject: false,
      }),
      execa(tools.ip, addressArgs, { reject: false }),
    ]);
    if (links.exitCode !== 0 || routeOutput.exitCode !== 0 || addressOutput.exitCode !== 0) {
      throw new Error(`Unable to inspect live network resources${namespace ? ` in ${namespace}` : ''}`);
    }
    for (const line of links.stdout.split('\n')) {
      const match = line.match(/^\d+:\s+([^:@]+)(?:@[^:]+)?:/);
      if (match) interfaces.add(match[1]);
    }
    for (const line of routeOutput.stdout.split('\n')) {
      const destination = line.trim().split(/\s+/)[0];
      if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(destination)) routes.push(destination);
    }
    for (const match of addressOutput.stdout.matchAll(/\binet\s+(\d+\.\d+\.\d+\.\d+)\//g)) {
      addresses.add(match[1]);
    }
  };
  await inspect();
  for (const namespace of namespaces) await inspect(namespace);
  const firewall = await execa('iptables', ['-S', 'DOCKER-USER'], { reject: false });
  if (firewall.exitCode !== 0) {
    throw new Error(`Unable to inspect live microVM firewall rules: ${firewall.stderr.trim()}`);
  }
  for (const match of firewall.stdout.matchAll(/\bawf-microvm-([0-9a-f]{12})\b/g)) {
    firewallTokens.add(match[1]);
  }
  return { namespaces, interfaces, routes, addresses, firewallTokens };
}

function recordHasLiveResources(
  record: ReservationRecord,
  live: LiveNetworkResources,
): boolean {
  return live.namespaces.has(record.namespaceName)
    || live.interfaces.has(record.hostVethName)
    || live.interfaces.has(record.namespaceVethName)
    || live.interfaces.has(record.tapName)
    || live.firewallTokens.has(record.resourceToken)
    || live.routes.some((route) => cidrsOverlap(route, record.guestSubnet));
}

function cidrsOverlap(first: string, second: string): boolean {
  const [firstIp, firstPrefixRaw] = first.split('/');
  const [secondIp, secondPrefixRaw] = second.split('/');
  const firstPrefix = Number(firstPrefixRaw);
  const secondPrefix = Number(secondPrefixRaw);
  if (!isIpv4(firstIp) || !isIpv4(secondIp)) return false;
  if (!Number.isInteger(firstPrefix) || !Number.isInteger(secondPrefix)) return false;
  const prefix = Math.min(firstPrefix, secondPrefix);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInteger(firstIp) & mask) === (ipv4ToInteger(secondIp) & mask);
}

function isIpv4(value: string): boolean {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((octet) => (
    /^\d{1,3}$/.test(octet) && Number(octet) <= 255
  ));
}

function ipv4ToInteger(ip: string): number {
  return ip.split('.').reduce(
    (value, octet) => ((value << 8) | Number(octet)) >>> 0,
    0,
  );
}

function chooseInfrastructureIp(
  options: MicrovmNetworkPlanOptions,
  reserved: ReadonlySet<string>,
  live: ReadonlySet<string>,
): string {
  const [networkIp, rawPrefix] = NETWORK_SUBNET.split('/');
  const prefix = Number(rawPrefix);
  if (prefix !== 24) {
    throw new Error(`Unsupported microVM infrastructure subnet: ${NETWORK_SUBNET}`);
  }
  const base = ipv4ToInteger(networkIp);
  const unavailable = new Set([
    HOST_GATEWAY,
    SQUID_IP,
    API_PROXY_IP,
    DOH_PROXY_IP,
    CLI_PROXY_IP,
    ...reserved,
    ...live,
    ...(options.controlPeer ? [options.controlPeer.ip] : []),
    ...(options.controlPeers ?? []).map((peer) => peer.ip),
  ]);
  const preferredOffset = Number(AGENT_IP.split('.')[3]);
  for (let attempt = 0; attempt < 253; attempt += 1) {
    const offset = 2 + ((preferredOffset - 2 + attempt) % 253);
    const candidate = integerToIpv4(base + offset);
    if (!unavailable.has(candidate)) return candidate;
  }
  throw new Error(`No unused microVM infrastructure address is available on ${NETWORK_SUBNET}`);
}

function integerToIpv4(value: number): string {
  const normalized = value >>> 0;
  return [
    normalized >>> 24,
    (normalized >>> 16) & 0xff,
    (normalized >>> 8) & 0xff,
    normalized & 0xff,
  ].join('.');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
