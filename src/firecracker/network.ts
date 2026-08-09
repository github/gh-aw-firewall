import { createHash } from 'crypto';
import execa from 'execa';
import type { FirecrackerHostToolPaths } from './preflight';
import {
  AGENT_IP,
  API_PROXY_IP,
  HOST_GATEWAY,
  NETWORK_SUBNET,
  SQUID_IP,
  SQUID_PORT,
  apiProxyPorts,
} from '../config/network-policy';
import type { FirecrackerNetworkInterface } from './api-client';

const LINUX_INTERFACE_NAME_MAX_LENGTH = 15;
const FIRECRACKER_GUEST_NETWORK_BASE = ipv4ToInteger('100.64.0.0');
const FIRECRACKER_GUEST_SUBNET_COUNT = 1 << 20;
const FIRECRACKER_GUEST_PREFIX_LENGTH = 30;
const NETNS_DIRECTORY = '/var/run/netns';
const BLOCKED_LINK_LOCAL_CIDR = '169.254.0.0/16';
const BLOCKED_MULTICAST_CIDR = '224.0.0.0/4';

export interface FirecrackerAllowedEndpoint {
  readonly name: string;
  readonly ip: string;
  readonly port: number;
}

export interface FirecrackerControlPeer {
  readonly ip: string;
  readonly ports: readonly number[];
}

export interface FirecrackerNetworkPlanOptions {
  readonly infrastructureBridge: string;
  readonly enableApiProxy: boolean;
  readonly jailerUid: number;
  readonly jailerGid: number;
  readonly controlPeer?: FirecrackerControlPeer;
}

export interface FirecrackerNetworkPlan {
  readonly runId: string;
  readonly namespaceName: string;
  readonly netnsPath: string;
  readonly nftTableName: string;
  readonly infrastructureBridge: string;
  readonly hostVethName: string;
  readonly namespaceVethName: string;
  readonly tapName: string;
  readonly infrastructureIp: string;
  readonly infrastructureCidr: string;
  readonly hostGatewayIp: string;
  readonly guestSubnet: string;
  readonly guestIp: string;
  readonly guestGatewayIp: string;
  readonly guestPrefixLength: number;
  readonly guestMac: string;
  readonly jailerUid: number;
  readonly jailerGid: number;
  readonly allowedEndpoints: readonly FirecrackerAllowedEndpoint[];
  readonly networkInterface: FirecrackerNetworkInterface;
}

export interface FirecrackerConnectivityProbe {
  verify(plan: FirecrackerNetworkPlan): Promise<void>;
}

export interface FirecrackerNetworkCommandOptions {
  readonly reject: boolean;
  readonly input?: string;
}

export type FirecrackerNetworkCommandExecutor = (
  command: string,
  args: readonly string[],
  options: FirecrackerNetworkCommandOptions,
) => Promise<unknown>;

const defaultCommandExecutor: FirecrackerNetworkCommandExecutor = async (
  command,
  args,
  options,
) => {
  await execa(command, [...args], options);
};

/**
 * Dependency-injected argv-only Linux networking operations.
 */
export class FirecrackerLinuxNetworkCommands {
  constructor(
    private readonly execute: FirecrackerNetworkCommandExecutor = defaultCommandExecutor,
    private readonly tools: Pick<FirecrackerHostToolPaths, 'ip' | 'nft' | 'sysctl'> = {
      ip: 'ip',
      nft: 'nft',
      sysctl: 'sysctl',
    },
  ) {}

  ip(args: readonly string[], reject = true): Promise<unknown> {
    return this.execute(this.tools.ip, args, { reject });
  }

  ipInNamespace(
    namespaceName: string,
    args: readonly string[],
    reject = true,
  ): Promise<unknown> {
    return this.execute(this.tools.ip, ['netns', 'exec', namespaceName, this.tools.ip, ...args], { reject });
  }

  sysctlInNamespace(
    namespaceName: string,
    setting: string,
    reject = true,
  ): Promise<unknown> {
    return this.execute(
      this.tools.ip,
      ['netns', 'exec', namespaceName, this.tools.sysctl, '-q', '-w', setting],
      { reject },
    );
  }

  nftInNamespace(
    namespaceName: string,
    args: readonly string[],
    input?: string,
    reject = true,
  ): Promise<unknown> {
    return this.execute(
      this.tools.ip,
      ['netns', 'exec', namespaceName, this.tools.nft, ...args],
      { reject, ...(input === undefined ? {} : { input }) },
    );
  }
}

export interface FirecrackerNetworkLifecycle {
  readonly plan: FirecrackerNetworkPlan;
  setup(): Promise<FirecrackerNetworkPlan>;
  cleanup(): Promise<void>;
}

/**
 * Owns the host-side network resources for exactly one Firecracker run.
 */
export class FirecrackerNetworkManager implements FirecrackerNetworkLifecycle {
  private setupComplete = false;
  private namespaceCreated = false;
  private hostVethCreated = false;

  constructor(
    readonly plan: FirecrackerNetworkPlan,
    private readonly commands = new FirecrackerLinuxNetworkCommands(),
    private readonly probe?: FirecrackerConnectivityProbe,
  ) {}

  async setup(): Promise<FirecrackerNetworkPlan> {
    if (this.setupComplete) return this.plan;

    try {
      await this.commands.ip(['netns', 'add', this.plan.namespaceName]);
      this.namespaceCreated = true;
      await this.commands.ip([
        'link', 'add', this.plan.hostVethName,
        'type', 'veth',
        'peer', 'name', this.plan.namespaceVethName,
      ]);
      this.hostVethCreated = true;
      await this.commands.ip([
        'link', 'set', this.plan.namespaceVethName,
        'netns', this.plan.namespaceName,
      ]);
      await this.commands.ip([
        'link', 'set', this.plan.hostVethName,
        'master', this.plan.infrastructureBridge,
      ]);
      await this.commands.ip(['link', 'set', this.plan.hostVethName, 'up']);

      await this.commands.ipInNamespace(this.plan.namespaceName, [
        'tuntap', 'add',
        'dev', this.plan.tapName,
        'mode', 'tap',
        'user', String(this.plan.jailerUid),
        'group', String(this.plan.jailerGid),
      ]);
      await this.commands.ipInNamespace(this.plan.namespaceName, [
        'addr', 'add',
        `${this.plan.guestGatewayIp}/${this.plan.guestPrefixLength}`,
        'dev', this.plan.tapName,
      ]);
      await this.commands.ipInNamespace(
        this.plan.namespaceName,
        ['link', 'set', this.plan.tapName, 'up'],
      );
      await this.commands.ipInNamespace(this.plan.namespaceName, [
        'addr', 'add',
        `${this.plan.infrastructureIp}/${prefixLength(this.plan.infrastructureCidr)}`,
        'dev', this.plan.namespaceVethName,
      ]);
      await this.commands.ipInNamespace(
        this.plan.namespaceName,
        ['link', 'set', this.plan.namespaceVethName, 'up'],
      );
      await this.commands.ipInNamespace(
        this.plan.namespaceName,
        ['link', 'set', 'lo', 'up'],
      );
      await this.commands.sysctlInNamespace(
        this.plan.namespaceName,
        'net.ipv4.ip_forward=1',
      );
      await this.commands.sysctlInNamespace(
        this.plan.namespaceName,
        'net.ipv6.conf.all.disable_ipv6=1',
      );
      await this.commands.sysctlInNamespace(
        this.plan.namespaceName,
        'net.ipv6.conf.default.disable_ipv6=1',
      );
      await this.commands.nftInNamespace(
        this.plan.namespaceName,
        ['-f', '-'],
        generateFirecrackerNftRuleset(this.plan),
      );
      await this.probe?.verify(this.plan);
      this.setupComplete = true;
      return this.plan;
    } catch (error) {
      try {
        await this.cleanup();
      } catch (cleanupError) {
        throw new Error(
          `Firecracker network setup failed: ${formatError(error)}; ` +
          `rollback also failed: ${formatError(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    if (this.hostVethCreated) {
      await attempt(async () => {
        await this.commands.ip(['link', 'delete', this.plan.hostVethName]);
        this.hostVethCreated = false;
      });
    }
    if (this.namespaceCreated && !this.hostVethCreated) {
      await attempt(async () => {
        await this.commands.ip(['netns', 'delete', this.plan.namespaceName]);
        this.namespaceCreated = false;
      });
    }
    this.setupComplete = false;

    if (errors.length > 0) {
      throw new Error(
        `Failed to clean up Firecracker network: ${errors.map(formatError).join('; ')}`,
      );
    }
  }
}

export function createFirecrackerNetworkPlan(
  runId: string,
  options: FirecrackerNetworkPlanOptions,
): FirecrackerNetworkPlan {
  assertSafeFirecrackerRunId(runId);
  assertInterfaceName(options.infrastructureBridge, 'infrastructure bridge');
  assertPositiveIdentity(options.jailerUid, 'jailer uid');
  assertPositiveIdentity(options.jailerGid, 'jailer gid');

  const digest = createHash('sha256').update(runId).digest();
  const token = digest.toString('hex').slice(0, 12);
  const subnetIndex = digest.readUInt32BE(0) & (FIRECRACKER_GUEST_SUBNET_COUNT - 1);
  const subnetBase = FIRECRACKER_GUEST_NETWORK_BASE + subnetIndex * 4;
  const guestGatewayIp = integerToIpv4(subnetBase + 1);
  const guestIp = integerToIpv4(subnetBase + 2);
  const guestMac = [
    0x02,
    digest[4],
    digest[5],
    digest[6],
    digest[7],
    digest[8],
  ].map((byte) => byte.toString(16).padStart(2, '0')).join(':');

  const namespaceName = `awffc-${token}`;
  const tapName = `fct${token}`;
  const hostVethName = `fch${token}`;
  const namespaceVethName = `fcn${token}`;
  const nftTableName = `awf_fc_${token}`;
  for (const [label, name] of [
    ['TAP', tapName],
    ['host veth', hostVethName],
    ['namespace veth', namespaceVethName],
  ] as const) {
    assertInterfaceName(name, label);
  }

  const allowedEndpoints = createAllowedEndpoints(
    options.enableApiProxy,
    options.controlPeer,
  );
  const plan: FirecrackerNetworkPlan = {
    runId,
    namespaceName,
    netnsPath: `${NETNS_DIRECTORY}/${namespaceName}`,
    nftTableName,
    infrastructureBridge: options.infrastructureBridge,
    hostVethName,
    namespaceVethName,
    tapName,
    infrastructureIp: AGENT_IP,
    infrastructureCidr: NETWORK_SUBNET,
    hostGatewayIp: HOST_GATEWAY,
    guestSubnet: `${integerToIpv4(subnetBase)}/${FIRECRACKER_GUEST_PREFIX_LENGTH}`,
    guestIp,
    guestGatewayIp,
    guestPrefixLength: FIRECRACKER_GUEST_PREFIX_LENGTH,
    guestMac,
    jailerUid: options.jailerUid,
    jailerGid: options.jailerGid,
    allowedEndpoints,
    networkInterface: {
      iface_id: 'eth0',
      host_dev_name: tapName,
      guest_mac: guestMac,
    },
  };
  validatePlan(plan);
  return plan;
}

export function generateFirecrackerNftRuleset(plan: FirecrackerNetworkPlan): string {
  validatePlan(plan);
  const allowRules = plan.allowedEndpoints.flatMap((endpoint) => [
    `    iifname "${plan.tapName}" oifname "${plan.namespaceVethName}" ` +
      `ether saddr ${plan.guestMac} ip saddr ${plan.guestIp} ` +
      `ip daddr ${endpoint.ip} tcp dport ${endpoint.port} ` +
      'ct state new,established accept',
  ]);
  const snatRules = plan.allowedEndpoints.map((endpoint) =>
    `    iifname "${plan.tapName}" oifname "${plan.namespaceVethName}" ` +
    `ip saddr ${plan.guestIp} ip daddr ${endpoint.ip} tcp dport ${endpoint.port} ` +
    `snat to ${plan.infrastructureIp}`,
  );

  return [
    `table inet ${plan.nftTableName} {`,
    '  chain input {',
    '    type filter hook input priority filter; policy drop;',
    '    iifname "lo" accept',
    '    ct state established,related accept',
    '  }',
    '  chain output {',
    '    type filter hook output priority filter; policy drop;',
    '    oifname "lo" accept',
    '    ct state established,related accept',
    '  }',
    '  chain forward {',
    '    type filter hook forward priority filter; policy drop;',
    '    ct state invalid drop',
    `    iifname "${plan.tapName}" ether saddr != ${plan.guestMac} drop`,
    `    iifname "${plan.tapName}" ip saddr != ${plan.guestIp} drop`,
    `    iifname "${plan.tapName}" ip daddr ${BLOCKED_LINK_LOCAL_CIDR} drop`,
    `    iifname "${plan.tapName}" ip daddr ${BLOCKED_MULTICAST_CIDR} drop`,
    `    iifname "${plan.tapName}" ip daddr ${plan.hostGatewayIp} drop`,
    `    iifname "${plan.tapName}" ip daddr ${plan.infrastructureIp} drop`,
    `    iifname "${plan.tapName}" udp dport 53 drop`,
    `    iifname "${plan.tapName}" tcp dport 53 drop`,
    `    iifname "${plan.namespaceVethName}" oifname "${plan.tapName}" ` +
      `ether daddr ${plan.guestMac} ip daddr ${plan.guestIp} ` +
      'ct state established,related accept',
    ...allowRules,
    '  }',
    '  chain postrouting {',
    '    type nat hook postrouting priority srcnat; policy accept;',
    ...snatRules,
    '  }',
    '}',
    '',
  ].join('\n');
}

function createAllowedEndpoints(
  enableApiProxy: boolean,
  controlPeer?: FirecrackerControlPeer,
): readonly FirecrackerAllowedEndpoint[] {
  const endpoints: FirecrackerAllowedEndpoint[] = [{
    name: 'squid',
    ip: SQUID_IP,
    port: SQUID_PORT,
  }];
  if (enableApiProxy) {
    for (const [provider, port] of Object.entries(apiProxyPorts())) {
      endpoints.push({
        name: `api-proxy-${provider}`,
        ip: API_PROXY_IP,
        port,
      });
    }
  }
  if (controlPeer) {
    assertPrivateIpv4(controlPeer.ip, 'control peer IP');
    if (
      !isInCidr(controlPeer.ip, NETWORK_SUBNET) ||
      controlPeer.ip === HOST_GATEWAY ||
      controlPeer.ip === AGENT_IP ||
      isInCidr(controlPeer.ip, BLOCKED_LINK_LOCAL_CIDR) ||
      isInCidr(controlPeer.ip, BLOCKED_MULTICAST_CIDR)
    ) {
      throw new Error(
        `Unsafe Firecracker control peer IP outside ${NETWORK_SUBNET}: ${controlPeer.ip}`,
      );
    }
    if (controlPeer.ports.length === 0) {
      throw new Error('Firecracker control peer must specify at least one TCP port');
    }
    for (const port of controlPeer.ports) {
      assertPort(port, 'control peer port');
      if (port === 53) {
        throw new Error('Firecracker control peer cannot enable direct DNS');
      }
      endpoints.push({ name: 'control-peer', ip: controlPeer.ip, port });
    }
  }

  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key = `${endpoint.ip}:${endpoint.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validatePlan(plan: FirecrackerNetworkPlan): void {
  assertSafeFirecrackerRunId(plan.runId);
  assertSafeObjectName(plan.namespaceName, 'network namespace');
  assertSafeObjectName(plan.nftTableName, 'nftables table');
  assertInterfaceName(plan.infrastructureBridge, 'infrastructure bridge');
  assertInterfaceName(plan.hostVethName, 'host veth');
  assertInterfaceName(plan.namespaceVethName, 'namespace veth');
  assertInterfaceName(plan.tapName, 'TAP');
  assertIpv4(plan.infrastructureIp, 'infrastructure IP');
  assertCidr(plan.infrastructureCidr, 'infrastructure CIDR');
  assertIpv4(plan.hostGatewayIp, 'host gateway IP');
  assertCidr(plan.guestSubnet, 'guest subnet');
  assertIpv4(plan.guestIp, 'guest IP');
  assertIpv4(plan.guestGatewayIp, 'guest gateway IP');
  const guestNetworkIp = plan.guestSubnet.split('/')[0];
  const infrastructureNetworkIp = plan.infrastructureCidr.split('/')[0];
  if (
    isInCidr(guestNetworkIp, plan.infrastructureCidr) ||
    isInCidr(infrastructureNetworkIp, plan.guestSubnet)
  ) {
    throw new Error(
      `Firecracker guest subnet overlaps infrastructure: ` +
      `${plan.guestSubnet} and ${plan.infrastructureCidr}`,
    );
  }
  const macOctets = plan.guestMac.split(':');
  if (
    macOctets.length !== 6 ||
    macOctets[0] !== '02' ||
    macOctets.some((octet) => (
      octet.length !== 2 ||
      [...octet].some((character) => (
        !'0123456789abcdef'.includes(character)
      ))
    ))
  ) {
    throw new Error(`Unsafe Firecracker guest MAC: ${plan.guestMac}`);
  }
  for (const endpoint of plan.allowedEndpoints) {
    assertSafeObjectName(endpoint.name, 'endpoint name');
    assertIpv4(endpoint.ip, 'endpoint IP');
    assertPort(endpoint.port, 'endpoint port');
    if (isInCidr(endpoint.ip, plan.guestSubnet)) {
      throw new Error(
        `Firecracker endpoint ${endpoint.ip}:${endpoint.port} overlaps the guest subnet`,
      );
    }
  }
}

export function assertSafeFirecrackerRunId(runId: string): void {
  if (runId.length < 1 || runId.length > 64 || !/^[A-Za-z0-9-]+$/.test(runId)) {
    throw new Error(`Unsafe Firecracker run id: ${runId}`);
  }
}

function assertSafeObjectName(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`Unsafe Firecracker ${label}: ${value}`);
  }
}

function assertInterfaceName(value: string, label: string): void {
  assertSafeObjectName(value, label);
  if (value.length > LINUX_INTERFACE_NAME_MAX_LENGTH) {
    throw new Error(
      `Firecracker ${label} exceeds Linux IFNAMSIZ: ${value}`,
    );
  }
}

function assertPositiveIdentity(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Firecracker ${label} must be a positive integer`);
  }
}

function assertPort(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Firecracker ${label} must be an integer in 1-65535`);
  }
}

function assertPrivateIpv4(value: string, label: string): void {
  assertIpv4(value, label);
  if (
    !isInCidr(value, '10.0.0.0/8') &&
    !isInCidr(value, '172.16.0.0/12') &&
    !isInCidr(value, '192.168.0.0/16')
  ) {
    throw new Error(`Firecracker ${label} must be an RFC1918 address: ${value}`);
  }
}

function assertIpv4(value: string, label: string): void {
  const rawOctets = value.split('.');
  if (
    rawOctets.length !== 4 ||
    rawOctets.some((octet) => (
      octet.length < 1 ||
      octet.length > 3 ||
      [...octet].some((character) => (
        character < '0' || character > '9'
      )) ||
      Number(octet) > 255
    ))
  ) {
    throw new Error(`Invalid Firecracker ${label}: ${value}`);
  }
}

function assertCidr(value: string, label: string): void {
  const [address, rawPrefix, extra] = value.split('/');
  assertIpv4(address, label);
  const prefix = Number(rawPrefix);
  if (extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid Firecracker ${label}: ${value}`);
  }
}

function prefixLength(cidr: string): number {
  assertCidr(cidr, 'CIDR');
  return Number(cidr.split('/')[1]);
}

function isInCidr(ip: string, cidr: string): boolean {
  const [network, rawPrefix] = cidr.split('/');
  const prefix = Number(rawPrefix);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInteger(ip) & mask) === (ipv4ToInteger(network) & mask);
}

function ipv4ToInteger(ip: string): number {
  assertIpv4(ip, 'IPv4 address');
  return ip.split('.').reduce((value, octet) => (
    ((value << 8) | Number(octet)) >>> 0
  ), 0);
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
