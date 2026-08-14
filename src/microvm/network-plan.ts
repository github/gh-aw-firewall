import { createHash } from 'crypto';
import {
  AGENT_IP,
  API_PROXY_IP,
  HOST_GATEWAY,
  NETWORK_SUBNET,
  SQUID_IP,
  SQUID_PORT,
  apiProxyPorts,
} from '../config/network-policy';
import type {
  MicrovmAllowedEndpoint,
  MicrovmControlPeer,
  MicrovmNetworkPlan,
  MicrovmNetworkPlanOptions,
} from './network-types';

const LINUX_INTERFACE_NAME_MAX_LENGTH = 15;
const GUEST_NETWORK_BASE = ipv4ToInteger('100.64.0.0');
const GUEST_SUBNET_COUNT = 1 << 20;
const GUEST_PREFIX_LENGTH = 30;
const NETNS_DIRECTORY = '/var/run/netns';
const BLOCKED_LINK_LOCAL_CIDR = '169.254.0.0/16';
const BLOCKED_MULTICAST_CIDR = '224.0.0.0/4';
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
    [
      ...(options.controlPeer ? [options.controlPeer] : []),
      ...(options.controlPeers ?? []),
    ],
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
    // The return-leg accept rule below intentionally has no `ether daddr`
    // condition (an earlier version incorrectly required
    // `ether daddr <guest-mac>` here): at the forward hook, `ether daddr`
    // reflects the *incoming* frame's own L2 destination as it arrived on
    // iifname (this veth), which is this veth's own MAC address (assigned
    // by the kernel/bridge), never the guest's MAC -- the guest's MAC is
    // only ever a real L2 identity on the *other* side of the tap device,
    // a completely separate L2 segment. That condition could therefore
    // never match any real reply packet, silently discarding every
    // response (e.g. Squid's SYN-ACK) via this chain's own default-drop
    // policy with no visible counter anywhere. `ip daddr` (the guest's
    // real, post-un-SNAT IP) plus `ct state established,related` is both
    // necessary and sufficient to identify legitimate return traffic.
    `    iifname "${plan.namespaceVethName}" oifname "${plan.tapName}" ` +
      `ip daddr ${plan.guestIp} ` +
      'ct state established,related counter accept',
    ...allowRules,
    '  }',
    // A `prerouting` chain of type nat is required for the *return* leg
    // of the postrouting SNAT below to ever work: nftables only
    // activates nf_nat's automatic conntrack-based reverse translation
    // (undoing the SNAT for reply packets, e.g. Squid's SYN-ACK) for a
    // given (family, hook) pair once *some* chain registers a hook
    // there -- unlike legacy iptables, which always has both built-in.
    // Without this chain, a reply packet keeps its SNAT'd destination
    // address (the veth's own IP) all the way to the forward chain,
    // never matches the "ct state established,related" accept rule
    // above (which expects the guest's *real* IP), and is silently
    // dropped by this chain's own default policy -- with no visible
    // drop counter anywhere, since it never matched an explicit rule.
    // No explicit rules are needed here: conntrack's own NAT state
    // (recorded when postrouting first SNATs the outbound packet) does
    // the reverse translation automatically once this hook exists.
    '  chain prerouting {',
    '    type nat hook prerouting priority dstnat; policy accept;',
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
  controlPeers: readonly MicrovmControlPeer[],
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
  for (const controlPeer of controlPeers) {
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
  microvmCidrPrefixLength(value, label);
}

export function microvmCidrPrefixLength(cidr: string, label = 'CIDR'): number {
  const [address, rawPrefix, extra] = cidr.split('/');
  assertIpv4(address, label);
  const prefix = Number(rawPrefix);
  if (extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid microVM ${label}: ${cidr}`);
  }
  return prefix;
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
