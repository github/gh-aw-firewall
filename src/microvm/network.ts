import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import {
  AGENT_IP,
  API_PROXY_IP,
  HOST_GATEWAY,
  NETWORK_SUBNET,
  SQUID_IP,
  SQUID_PORT,
  apiProxyPorts,
} from '../config/network-policy';

const LINUX_INTERFACE_NAME_MAX_LENGTH = 15;
const GUEST_NETWORK_BASE = ipv4ToInteger('100.64.0.0');
const GUEST_SUBNET_COUNT = 1 << 20;
const GUEST_PREFIX_LENGTH = 30;
const NETNS_DIRECTORY = '/var/run/netns';
const BLOCKED_LINK_LOCAL_CIDR = '169.254.0.0/16';
const BLOCKED_MULTICAST_CIDR = '224.0.0.0/4';

/** Minimal host tool paths this module needs; a structural subset so callers
 * (e.g. Firecracker's preflight-derived tool paths) can pass their own
 * richer tool-path record without this module depending on it. */
export interface MicrovmNetworkHostTools {
  readonly ip: string;
  readonly nft: string;
  readonly sysctl: string;
}

/**
 * Generic tap-device descriptor a VMM's network-interface configuration API
 * needs. Field names intentionally match the wire shape already used by
 * Firecracker's `PUT /network-interfaces`; a future backend with a
 * differently-shaped API translates from this structural descriptor.
 */
export interface MicrovmTapInterface {
  readonly iface_id: string;
  readonly host_dev_name: string;
  readonly guest_mac?: string;
}

export interface MicrovmAllowedEndpoint {
  readonly name: string;
  readonly ip: string;
  readonly port: number;
}

export interface MicrovmControlPeer {
  readonly ip: string;
  readonly ports: readonly number[];
}

export interface MicrovmNetworkPlanOptions {
  readonly infrastructureBridge: string;
  readonly enableApiProxy: boolean;
  readonly tapOwnerUid: number;
  readonly tapOwnerGid: number;
  readonly controlPeer?: MicrovmControlPeer;
  /**
   * Create the TAP device with the `vnet_hdr` feature (a `struct
   * virtio_net_hdr` prefix on every frame read from/written to the tap
   * fd). Cloud Hypervisor's own tap handling (`Tap::open_named()` in
   * `net_util/src/tap.rs`) always re-opens the tap with `IFF_VNET_HDR`
   * requested; if the tap wasn't *created* with that feature available,
   * the host kernel and Cloud Hypervisor disagree on frame layout for
   * one direction, and host-to-guest traffic silently fails to reach the
   * guest even though guest-to-host traffic (and the host-side veth/nft
   * layer) keeps working normally -- exactly the asymmetric RX-works/
   * TX-stalls pattern observed live (tap RX=10 packets, TX=1 packet,
   * despite 23 response packets already having arrived on the veth).
   * Firecracker's own tap handling does not request `IFF_VNET_HDR`, so
   * this defaults to `false` (this shared code's prior, Firecracker-only
   * behavior) and Cloud Hypervisor opts in explicitly.
   */
  readonly tapVnetHdr?: boolean;
}

export interface MicrovmNetworkPlan {
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
  readonly tapOwnerUid: number;
  readonly tapOwnerGid: number;
  readonly tapVnetHdr: boolean;
  readonly allowedEndpoints: readonly MicrovmAllowedEndpoint[];
  readonly networkInterface: MicrovmTapInterface;
}

export interface MicrovmConnectivityProbe {
  verify(plan: MicrovmNetworkPlan): Promise<void>;
}

export interface MicrovmNetworkCommandOptions {
  readonly reject: boolean;
  readonly input?: string;
}

export type MicrovmNetworkCommandExecutor = (
  command: string,
  args: readonly string[],
  options: MicrovmNetworkCommandOptions,
) => Promise<unknown>;

const defaultCommandExecutor: MicrovmNetworkCommandExecutor = async (
  command,
  args,
  options,
) => execa(command, [...args], options);

export interface MicrovmNetworkRulesetFile {
  write(contents: string): Promise<string>;
  remove(rulesetPath: string): Promise<void>;
}

/**
 * Writes an nftables ruleset to a real, private temporary file instead of
 * piping it to `nft -f -` over stdin.
 *
 * Some nftables/libnftables builds internally `open("/dev/stdin")` when
 * given `-f -` rather than reading the already-open fd 0, which fails with
 * `Not a regular file: "/dev/stdin"` when stdin is a genuine pipe (as
 * `execa`'s `input` option provides) rather than a terminal or redirected
 * regular file — observed on GitHub-hosted Ubuntu runners. A real temp
 * file sidesteps this entirely and is at least as safe: still argv-only
 * (no shell), mode 0600, and removed immediately after the `nft` call
 * regardless of success or failure.
 */
const defaultRulesetFile: MicrovmNetworkRulesetFile = {
  write: async (contents) => {
    const rulesetPath = path.join(os.tmpdir(), `awf-nft-${randomBytes(8).toString('hex')}.nft`);
    await fs.writeFile(rulesetPath, contents, { mode: 0o600 });
    return rulesetPath;
  },
  remove: (rulesetPath) => fs.rm(rulesetPath, { force: true }),
};

/**
 * Dependency-injected argv-only Linux networking operations.
 */
export class LinuxNetworkCommands {
  constructor(
    private readonly execute: MicrovmNetworkCommandExecutor = defaultCommandExecutor,
    private readonly tools: MicrovmNetworkHostTools = {
      ip: 'ip',
      nft: 'nft',
      sysctl: 'sysctl',
    },
    private readonly rulesetFile: MicrovmNetworkRulesetFile = defaultRulesetFile,
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

  async nftInNamespace(
    namespaceName: string,
    args: readonly string[],
    input?: string,
    reject = true,
  ): Promise<unknown> {
    if (input === undefined) {
      return this.execute(
        this.tools.ip,
        ['netns', 'exec', namespaceName, this.tools.nft, ...args],
        { reject },
      );
    }
    const rulesetPath = await this.rulesetFile.write(input);
    try {
      // Substitute the "read from stdin" placeholder ("-") with the real
      // ruleset file path; any other args pass through unchanged.
      const resolvedArgs = args.map((arg) => (arg === '-' ? rulesetPath : arg));
      return await this.execute(
        this.tools.ip,
        ['netns', 'exec', namespaceName, this.tools.nft, ...resolvedArgs],
        { reject },
      );
    } finally {
      await this.rulesetFile.remove(rulesetPath);
    }
  }

  /**
   * Best-effort, read-only diagnostic dump of the live nftables ruleset,
   * per-interface packet/byte counters, routes/neighbors, and the TAP/veth
   * bridge-forwarding database inside the given namespace. Used to
   * diagnose a connectivity failure (e.g. is the forward-chain rule
   * actually installed and matching packets, are packets reaching the
   * tap/veth at all, does ARP/neighbor resolution look right) without
   * guessing from the guest side alone. Never throws -- folds any command
   * failure into an empty string for that command.
   */
  async captureDiagnosticsInNamespace(namespaceName: string): Promise<string> {
    const run = async (tool: string, args: readonly string[]): Promise<string> => {
      const result = await this.execute(
        this.tools.ip,
        ['netns', 'exec', namespaceName, tool, ...args],
        { reject: false },
      ).catch(() => undefined);
      const stdout = (result as { stdout?: unknown } | undefined)?.stdout;
      return typeof stdout === 'string' ? stdout : '';
    };
    const [nftRuleset, linkStats, linkDetail, routes, neighbors, fdb] = await Promise.all([
      // -a includes rule handles so a specific rule can be identified/
      // referenced; the counters attached in generateMicrovmNftRuleset
      // make hit counts visible per rule (not just per interface).
      run(this.tools.nft, ['-a', 'list', 'ruleset']),
      run(this.tools.ip, ['-s', 'link', 'show']),
      run(this.tools.ip, ['-d', 'link', 'show']),
      run(this.tools.ip, ['route', 'show']),
      run(this.tools.ip, ['neigh', 'show']),
      // 'bridge' (iproute2) is not user-configurable like ip/nft/sysctl
      // above -- it is only used here, best-effort, for diagnostics.
      run('bridge', ['fdb', 'show']),
    ]);
    return [
      '--- nft -a list ruleset (handles + hit counters) ---',
      nftRuleset.trim() || '(empty or unavailable)',
      '--- ip -s link show (packet/byte/error counters) ---',
      linkStats.trim() || '(empty or unavailable)',
      '--- ip -d link show (detailed link info, incl. vnet_hdr/multiqueue flags) ---',
      linkDetail.trim() || '(empty or unavailable)',
      '--- ip route show ---',
      routes.trim() || '(empty or unavailable)',
      '--- ip neigh show (ARP/neighbor table) ---',
      neighbors.trim() || '(empty or unavailable)',
      '--- bridge fdb show (forwarding database) ---',
      fdb.trim() || '(empty or unavailable)',
    ].join('\n');
  }

  /**
   * Best-effort, read-only diagnostic dump of the host-side (outside any
   * netns) bridge forwarding database for the infrastructure bridge that
   * Squid/API-proxy containers are attached to. MAC learning for
   * guest<->container traffic happens on this bridge, not inside the
   * microVM's own namespace, so this is a separate capture point. Never
   * throws -- folds any command failure into an empty string.
   */
  async captureHostBridgeDiagnostics(bridgeName: string): Promise<string> {
    const result = await this.execute(
      'bridge',
      ['fdb', 'show', 'br', bridgeName],
      { reject: false },
    ).catch(() => undefined);
    const stdout = (result as { stdout?: unknown } | undefined)?.stdout;
    const fdb = typeof stdout === 'string' ? stdout.trim() : '';
    return [
      `--- bridge fdb show br ${bridgeName} (host-side, outside any netns) ---`,
      fdb || '(empty or unavailable)',
    ].join('\n');
  }
}

export interface MicrovmNetworkLifecycle {
  readonly plan: MicrovmNetworkPlan;
  setup(): Promise<MicrovmNetworkPlan>;
  cleanup(): Promise<void>;
  /**
   * Optional, best-effort, read-only diagnostic dump (live nftables
   * ruleset + interface counters) for troubleshooting a connectivity
   * failure while the namespace still exists (i.e. called before
   * `cleanup()`). Not required by every implementer/mock.
   */
  captureDiagnostics?(): Promise<string>;
}

/**
 * Owns the host-side network resources for exactly one microVM run.
 */
export class MicrovmNetworkManager implements MicrovmNetworkLifecycle {
  private setupComplete = false;
  private namespaceCreated = false;
  private hostVethCreated = false;

  constructor(
    readonly plan: MicrovmNetworkPlan,
    private readonly commands = new LinuxNetworkCommands(),
    private readonly probe?: MicrovmConnectivityProbe,
  ) {}

  async setup(): Promise<MicrovmNetworkPlan> {
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
        'user', String(this.plan.tapOwnerUid),
        'group', String(this.plan.tapOwnerGid),
        ...(this.plan.tapVnetHdr ? ['vnet_hdr'] : []),
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
        generateMicrovmNftRuleset(this.plan),
      );
      await this.probe?.verify(this.plan);
      this.setupComplete = true;
      return this.plan;
    } catch (error) {
      try {
        await this.cleanup();
      } catch (cleanupError) {
        throw new Error(
          `microVM network setup failed: ${formatError(error)}; ` +
          `rollback also failed: ${formatError(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  async captureDiagnostics(): Promise<string> {
    if (!this.setupComplete) return '';
    const [namespaceDiagnostics, hostBridgeDiagnostics] = await Promise.all([
      this.commands.captureDiagnosticsInNamespace(this.plan.namespaceName),
      this.commands.captureHostBridgeDiagnostics(this.plan.infrastructureBridge),
    ]);
    return [namespaceDiagnostics, hostBridgeDiagnostics].join('\n');
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
        `Failed to clean up microVM network: ${errors.map(formatError).join('; ')}`,
      );
    }
  }
}

export function createMicrovmNetworkPlan(
  runId: string,
  options: MicrovmNetworkPlanOptions,
): MicrovmNetworkPlan {
  assertSafeMicrovmRunId(runId);
  assertInterfaceName(options.infrastructureBridge, 'infrastructure bridge');
  assertPositiveIdentity(options.tapOwnerUid, 'tap owner uid');
  assertPositiveIdentity(options.tapOwnerGid, 'tap owner gid');

  const digest = createHash('sha256').update(runId).digest();
  const token = digest.toString('hex').slice(0, 12);
  const subnetIndex = digest.readUInt32BE(0) & (GUEST_SUBNET_COUNT - 1);
  const subnetBase = GUEST_NETWORK_BASE + subnetIndex * 4;
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
  const plan: MicrovmNetworkPlan = {
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
    guestSubnet: `${integerToIpv4(subnetBase)}/${GUEST_PREFIX_LENGTH}`,
    guestIp,
    guestGatewayIp,
    guestPrefixLength: GUEST_PREFIX_LENGTH,
    guestMac,
    tapOwnerUid: options.tapOwnerUid,
    tapOwnerGid: options.tapOwnerGid,
    tapVnetHdr: options.tapVnetHdr ?? false,
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

export function generateMicrovmNftRuleset(plan: MicrovmNetworkPlan): string {
  validatePlan(plan);
  const allowRules = plan.allowedEndpoints.flatMap((endpoint) => [
    `    iifname "${plan.tapName}" oifname "${plan.namespaceVethName}" ` +
      `ether saddr ${plan.guestMac} ip saddr ${plan.guestIp} ` +
      `ip daddr ${endpoint.ip} tcp dport ${endpoint.port} ` +
      'ct state new,established counter accept',
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
    '    ct state invalid counter drop',
    // `counter` on the anti-spoof/reverse-path rules below is purely
    // diagnostic (nftables does not track packet/byte hits on a rule
    // unless it includes an explicit `counter` object); it does not
    // change any accept/drop decision. This makes `nft -a list ruleset`
    // (captured in diagnostics) show exactly which rule is or isn't
    // matching guest<->host traffic without guessing.
    `    iifname "${plan.tapName}" ether saddr != ${plan.guestMac} counter drop`,
    `    iifname "${plan.tapName}" ip saddr != ${plan.guestIp} counter drop`,
    `    iifname "${plan.tapName}" ip daddr ${BLOCKED_LINK_LOCAL_CIDR} counter drop`,
    `    iifname "${plan.tapName}" ip daddr ${BLOCKED_MULTICAST_CIDR} counter drop`,
    `    iifname "${plan.tapName}" ip daddr ${plan.hostGatewayIp} counter drop`,
    `    iifname "${plan.tapName}" ip daddr ${plan.infrastructureIp} counter drop`,
    `    iifname "${plan.tapName}" udp dport 53 counter drop`,
    `    iifname "${plan.tapName}" tcp dport 53 counter drop`,
    `    iifname "${plan.namespaceVethName}" oifname "${plan.tapName}" ` +
      `ether daddr ${plan.guestMac} ip daddr ${plan.guestIp} ` +
      'ct state established,related counter accept',
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
  controlPeer?: MicrovmControlPeer,
): readonly MicrovmAllowedEndpoint[] {
  const endpoints: MicrovmAllowedEndpoint[] = [{
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
        `Unsafe microVM control peer IP outside ${NETWORK_SUBNET}: ${controlPeer.ip}`,
      );
    }
    if (controlPeer.ports.length === 0) {
      throw new Error('microVM control peer must specify at least one TCP port');
    }
    for (const port of controlPeer.ports) {
      assertPort(port, 'control peer port');
      if (port === 53) {
        throw new Error('microVM control peer cannot enable direct DNS');
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

function validatePlan(plan: MicrovmNetworkPlan): void {
  assertSafeMicrovmRunId(plan.runId);
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
      `microVM guest subnet overlaps infrastructure: ` +
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
    throw new Error(`Unsafe microVM guest MAC: ${plan.guestMac}`);
  }
  for (const endpoint of plan.allowedEndpoints) {
    assertSafeObjectName(endpoint.name, 'endpoint name');
    assertIpv4(endpoint.ip, 'endpoint IP');
    assertPort(endpoint.port, 'endpoint port');
    if (isInCidr(endpoint.ip, plan.guestSubnet)) {
      throw new Error(
        `microVM endpoint ${endpoint.ip}:${endpoint.port} overlaps the guest subnet`,
      );
    }
  }
}

export function assertSafeMicrovmRunId(runId: string): void {
  if (runId.length < 1 || runId.length > 64 || !/^[A-Za-z0-9-]+$/.test(runId)) {
    throw new Error(`Unsafe microVM run id: ${runId}`);
  }
}

function assertSafeObjectName(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`Unsafe microVM ${label}: ${value}`);
  }
}

function assertInterfaceName(value: string, label: string): void {
  assertSafeObjectName(value, label);
  if (value.length > LINUX_INTERFACE_NAME_MAX_LENGTH) {
    throw new Error(
      `microVM ${label} exceeds Linux IFNAMSIZ: ${value}`,
    );
  }
}

function assertPositiveIdentity(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`microVM ${label} must be a positive integer`);
  }
}

function assertPort(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`microVM ${label} must be an integer in 1-65535`);
  }
}

function assertPrivateIpv4(value: string, label: string): void {
  assertIpv4(value, label);
  if (
    !isInCidr(value, '10.0.0.0/8') &&
    !isInCidr(value, '172.16.0.0/12') &&
    !isInCidr(value, '192.168.0.0/16')
  ) {
    throw new Error(`microVM ${label} must be an RFC1918 address: ${value}`);
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
    throw new Error(`Invalid microVM ${label}: ${value}`);
  }
}

function assertCidr(value: string, label: string): void {
  const [address, rawPrefix, extra] = value.split('/');
  assertIpv4(address, label);
  const prefix = Number(rawPrefix);
  if (extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid microVM ${label}: ${value}`);
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
