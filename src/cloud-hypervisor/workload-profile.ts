import { isIP } from 'net';
import * as path from 'path';
import type { MicrovmControlPeer } from '../microvm/network';
import type {
  CloudHypervisorManagerGuestConfig,
  CloudHypervisorWorkloadIdentity,
} from './manager-types';
import { validateCloudHypervisorExports } from './exports';
import { hasReadOnlyWorkspaceMountPlan } from './filesystem-write-enforcement';
export type {
  CloudHypervisorWorkloadIdentity,
  CloudHypervisorWorkloadKind,
} from './manager-types';

export interface CloudHypervisorPrimaryNetworkProfile {
  readonly mode: 'primary';
  readonly infrastructureBridge: string;
  readonly enableApiProxy: boolean;
  readonly apiProxyIp?: string;
  readonly controlPeer?: MicrovmControlPeer;
  readonly controlPeers?: readonly MicrovmControlPeer[];
  readonly hostAliases?: Readonly<Record<string, string>>;
}

export interface CloudHypervisorNoNetworkProfile {
  readonly mode: 'none';
}

export interface CloudHypervisorEnclaveAgentNetworkProfile {
  readonly mode: 'enclave-agent';
  readonly apiProxy: {
    readonly ip: string;
    readonly port: number;
  };
  readonly githubDataPlane?: {
    readonly ip: string;
    readonly port: number;
  };
}

interface CloudHypervisorWorkloadProfileBase {
  readonly identity: CloudHypervisorWorkloadIdentity;
  readonly rawOutput: 'capture' | 'discard';
}

export interface CloudHypervisorPrimaryAgentProfile
  extends CloudHypervisorWorkloadProfileBase {
  readonly kind: 'primary-agent';
  readonly identity: CloudHypervisorWorkloadIdentity & {
    readonly kind: 'primary-agent';
    readonly invocationId?: never;
  };
  readonly rootfsRole: 'primary-agent';
  readonly network: CloudHypervisorPrimaryNetworkProfile;
  readonly guest?: CloudHypervisorManagerGuestConfig;
  readonly rawOutput: 'capture';
}

export interface CloudHypervisorScriptEnclaveProfile
  extends CloudHypervisorWorkloadProfileBase {
  readonly kind: 'script-enclave';
  readonly identity: CloudHypervisorWorkloadIdentity & {
    readonly kind: 'script-enclave';
    readonly invocationId: string;
  };
  readonly rootfsRole: 'script-enclave';
  readonly network: CloudHypervisorNoNetworkProfile;
  readonly guest: CloudHypervisorManagerGuestConfig;
  readonly rawOutput: 'discard';
}

export interface CloudHypervisorAgentEnclaveProfile
  extends CloudHypervisorWorkloadProfileBase {
  readonly kind: 'agent-enclave';
  readonly identity: CloudHypervisorWorkloadIdentity & {
    readonly kind: 'agent-enclave';
    readonly invocationId: string;
  };
  readonly rootfsRole: 'agent-enclave';
  readonly network: CloudHypervisorEnclaveAgentNetworkProfile;
  readonly guest: CloudHypervisorManagerGuestConfig;
  readonly rawOutput: 'discard';
}

export type CloudHypervisorWorkloadProfile =
  | CloudHypervisorPrimaryAgentProfile
  | CloudHypervisorScriptEnclaveProfile
  | CloudHypervisorAgentEnclaveProfile;

const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_INTERFACE = /^[A-Za-z0-9_.-]{1,15}$/;

export function createPrimaryAgentCloudHypervisorProfile(options: {
  readonly network: Omit<CloudHypervisorPrimaryNetworkProfile, 'mode'>;
  readonly guest?: CloudHypervisorManagerGuestConfig;
}): CloudHypervisorPrimaryAgentProfile {
  return sealCloudHypervisorWorkloadProfile({
    kind: 'primary-agent',
    identity: { kind: 'primary-agent', ownerId: 'primary-agent' },
    rootfsRole: 'primary-agent',
    network: { mode: 'primary', ...options.network },
    ...(options.guest ? { guest: options.guest } : {}),
    rawOutput: 'capture',
  }) as CloudHypervisorPrimaryAgentProfile;
}

export function createScriptEnclaveCloudHypervisorProfile(options: {
  readonly enclaveId: string;
  readonly invocationId: string;
  readonly guest: CloudHypervisorManagerGuestConfig;
}): CloudHypervisorScriptEnclaveProfile {
  return sealCloudHypervisorWorkloadProfile({
    kind: 'script-enclave',
    identity: {
      kind: 'script-enclave',
      ownerId: options.enclaveId,
      invocationId: options.invocationId,
    },
    rootfsRole: 'script-enclave',
    network: { mode: 'none' },
    guest: options.guest,
    rawOutput: 'discard',
  }) as CloudHypervisorScriptEnclaveProfile;
}

export function createAgentEnclaveCloudHypervisorProfile(options: {
  readonly enclaveId: string;
  readonly invocationId: string;
  readonly guest: CloudHypervisorManagerGuestConfig;
  readonly apiProxy: CloudHypervisorEnclaveAgentNetworkProfile['apiProxy'];
  readonly githubDataPlane?: CloudHypervisorEnclaveAgentNetworkProfile['githubDataPlane'];
}): CloudHypervisorAgentEnclaveProfile {
  return sealCloudHypervisorWorkloadProfile({
    kind: 'agent-enclave',
    identity: {
      kind: 'agent-enclave',
      ownerId: options.enclaveId,
      invocationId: options.invocationId,
    },
    rootfsRole: 'agent-enclave',
    network: {
      mode: 'enclave-agent',
      apiProxy: options.apiProxy,
      ...(options.githubDataPlane ? { githubDataPlane: options.githubDataPlane } : {}),
    },
    guest: options.guest,
    rawOutput: 'discard',
  }) as CloudHypervisorAgentEnclaveProfile;
}

export function validateCloudHypervisorWorkloadProfile(
  profile: CloudHypervisorWorkloadProfile,
): CloudHypervisorWorkloadProfile {
  if (!profile || typeof profile !== 'object') {
    throw new Error('Cloud Hypervisor workload profile is required');
  }
  if (profile.kind !== profile.identity?.kind || profile.kind !== profile.rootfsRole) {
    throw new Error('Cloud Hypervisor workload profile identity and rootfs role must match its kind');
  }
  assertClosedObject(profile, ['kind', 'identity', 'rootfsRole', 'network', 'guest', 'rawOutput'],
    'workload profile');
  assertClosedObject(profile.identity, ['kind', 'ownerId', 'invocationId'], 'workload identity');
  assertSafeIdentity(profile.identity.ownerId, 'owner');

  switch (profile.kind) {
    case 'primary-agent':
      if (
        profile.identity.ownerId !== 'primary-agent' ||
        profile.identity.invocationId !== undefined ||
        profile.network.mode !== 'primary' ||
        profile.rawOutput !== 'capture'
      ) {
        throw new Error('Contradictory Cloud Hypervisor primary-agent workload profile');
      }
      validatePrimaryNetwork(profile.network);
      break;
    case 'script-enclave':
      if (
        !profile.identity.invocationId ||
        profile.network.mode !== 'none' ||
        profile.rawOutput !== 'discard'
      ) {
        throw new Error('Contradictory Cloud Hypervisor script-enclave workload profile');
      }
      assertSafeIdentity(profile.identity.invocationId, 'invocation');
      assertClosedObject(profile.network, ['mode'], 'script-enclave network profile');
      break;
    case 'agent-enclave':
      if (
        !profile.identity.invocationId ||
        profile.network.mode !== 'enclave-agent' ||
        profile.rawOutput !== 'discard'
      ) {
        throw new Error('Contradictory Cloud Hypervisor agent-enclave workload profile');
      }
      assertSafeIdentity(profile.identity.invocationId, 'invocation');
      assertClosedObject(
        profile.network,
        ['mode', 'apiProxy', 'githubDataPlane'],
        'agent-enclave network profile',
      );
      validateEndpoint(profile.network.apiProxy, 'dedicated API proxy');
      if (profile.network.githubDataPlane) {
        validateEndpoint(profile.network.githubDataPlane, 'GitHub data plane');
      }
      break;
    default:
      throw new Error(`Unsupported Cloud Hypervisor workload profile: ${String(profile)}`);
  }
  validateGuest(profile);
  return profile;
}

export function sealCloudHypervisorWorkloadProfile(
  profile: CloudHypervisorWorkloadProfile,
): CloudHypervisorWorkloadProfile {
  const snapshot = snapshotCloudHypervisorWorkloadProfile(profile);
  validateCloudHypervisorWorkloadProfile(snapshot);
  return snapshot;
}

export function snapshotCloudHypervisorWorkloadProfile(
  profile: CloudHypervisorWorkloadProfile,
): CloudHypervisorWorkloadProfile {
  return deepFreeze(structuredClone(profile));
}

export function assertCloudHypervisorWorkloadLaunchable(
  profile: CloudHypervisorWorkloadProfile,
): asserts profile is CloudHypervisorPrimaryAgentProfile {
  validateCloudHypervisorWorkloadProfile(profile);
  if (profile.kind !== 'primary-agent') {
    throw new Error(
      `Cloud Hypervisor ${profile.kind} execution is not implemented; refusing to fall back to the primary-agent runtime`,
    );
  }
}

function validateGuest(profile: CloudHypervisorWorkloadProfile): void {
  if (profile.kind === 'primary-agent' && profile.guest === undefined) return;
  if (!profile.guest || typeof profile.guest !== 'object') {
    throw new Error(`Cloud Hypervisor ${profile.kind} guest configuration is required`);
  }
  assertClosedObject(profile.guest, [
    'exports',
    'mountEnforcement',
    'supervisorBinaryPath',
    'supervisorSha256',
    'vsockPort',
    'identity',
    'workspaceMount',
  ], `${profile.kind} guest configuration`);
  if (
    !path.isAbsolute(profile.guest.supervisorBinaryPath) ||
    !/^[a-f0-9]{64}$/.test(profile.guest.supervisorSha256)
  ) {
    throw new Error(`Cloud Hypervisor ${profile.kind} supervisor configuration is incomplete`);
  }
  const workspaceMount = profile.guest.workspaceMount;
  if (profile.kind === 'primary-agent' && workspaceMount !== '/workspace') {
    throw new Error('Cloud Hypervisor primary-agent workspace mount must be /workspace');
  }
  if (profile.kind !== 'primary-agent' && workspaceMount !== null) {
    throw new Error(`Cloud Hypervisor ${profile.kind} must not declare a primary workspace mount`);
  }
  if (
    profile.guest.vsockPort !== undefined &&
    (
      !Number.isInteger(profile.guest.vsockPort) ||
      profile.guest.vsockPort < 1 ||
      profile.guest.vsockPort > 65_535
    )
  ) {
    throw new Error(`Cloud Hypervisor ${profile.kind} vsock port must be in 1-65535`);
  }
  if (profile.guest.identity) {
    assertClosedObject(profile.guest.identity, ['uid', 'gid'], 'guest identity');
    if (
      !Number.isSafeInteger(profile.guest.identity.uid) ||
      profile.guest.identity.uid < 1 ||
      !Number.isSafeInteger(profile.guest.identity.gid) ||
      profile.guest.identity.gid < 1
    ) throw new Error(`Cloud Hypervisor ${profile.kind} guest identity must be non-root`);
  }
  validateCloudHypervisorExports(profile.guest.exports, {
    allowReadOnlyWorkspace: hasReadOnlyWorkspaceMountPlan(profile.guest.mountEnforcement),
    requireWorkspace: workspaceMount !== null,
  });
}

function validatePrimaryNetwork(network: CloudHypervisorPrimaryNetworkProfile): void {
  assertClosedObject(network, [
    'mode',
    'infrastructureBridge',
    'enableApiProxy',
    'apiProxyIp',
    'controlPeer',
    'controlPeers',
    'hostAliases',
  ], 'primary network profile');
  if (!network.infrastructureBridge) {
    throw new Error(
      'Cloud Hypervisor network configuration is required; refusing to launch an unfiltered microVM',
    );
  }
  if (!SAFE_INTERFACE.test(network.infrastructureBridge)) {
    throw new Error(
      `Unsafe Cloud Hypervisor primary infrastructure bridge: ${network.infrastructureBridge}`,
    );
  }
  if (network.apiProxyIp) validateIp(network.apiProxyIp, 'primary API proxy');
  for (const peer of [
    ...(network.controlPeer ? [network.controlPeer] : []),
    ...(network.controlPeers ?? []),
  ]) {
    assertClosedObject(peer, ['ip', 'ports'], 'control peer');
    validateIp(peer.ip, 'control peer');
    if (!Array.isArray(peer.ports) || peer.ports.length === 0) {
      throw new Error('Cloud Hypervisor control peer must specify at least one port');
    }
    for (const port of peer.ports) validateEndpoint({ ip: peer.ip, port }, 'control peer');
  }
  for (const [alias, ip] of Object.entries(network.hostAliases ?? {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(alias)) {
      throw new Error(`Unsafe Cloud Hypervisor host alias: ${alias}`);
    }
    validateIp(ip, `host alias "${alias}"`);
  }
}

function validateEndpoint(
  endpoint: { readonly ip: string; readonly port: number },
  label: string,
): void {
  assertClosedObject(endpoint, ['ip', 'port'], label);
  validateIp(endpoint.ip, label);
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) {
    throw new Error(`Cloud Hypervisor ${label} port must be in 1-65535`);
  }
}

function validateIp(ip: string, label: string): void {
  if (isIP(ip) !== 4) {
    throw new Error(`Cloud Hypervisor ${label} must be an IPv4 address: ${ip}`);
  }
}

function assertSafeIdentity(value: string, label: string): void {
  if (!SAFE_IDENTITY.test(value)) {
    throw new Error(`Unsafe Cloud Hypervisor workload ${label} identity: ${value}`);
  }
}

function assertClosedObject(
  value: object,
  allowedKeys: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown Cloud Hypervisor ${label} field: ${unknown[0]}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
