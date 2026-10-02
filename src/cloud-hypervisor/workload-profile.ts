import { isIP } from 'net';
import * as path from 'path';
import {
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_GITHUB_MCP_IP,
  ENCLAVE_GITHUB_MCP_PORT,
} from '../enclave/network';
import {
  type EnclaveAgentEngine,
  type EnclaveAgentProfile,
} from '../types/enclave-options';
import type { MicrovmControlPeer } from '../microvm/network';
import type {
  CloudHypervisorManagerGuestConfig,
  CloudHypervisorEnclaveResourceProfile,
  CloudHypervisorWorkloadIdentity,
} from './manager-types';
import { validateCloudHypervisorExports } from './exports';
import {
  validateCloudHypervisorEnclaveExportPlan,
  type CloudHypervisorEnclaveExportPlan,
} from './enclave-export-plan';
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
    readonly engine: EnclaveAgentEngine;
    readonly profile: EnclaveAgentProfile;
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
  readonly exportPlan?: never;
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
  readonly exportPlan: CloudHypervisorEnclaveExportPlan;
  readonly guest: CloudHypervisorManagerGuestConfig;
  readonly resources: CloudHypervisorEnclaveResourceProfile;
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
  readonly exportPlan: CloudHypervisorEnclaveExportPlan;
  readonly guest: CloudHypervisorManagerGuestConfig;
  readonly resources: CloudHypervisorEnclaveResourceProfile;
  readonly rawOutput: 'discard';
}

export type CloudHypervisorWorkloadProfile =
  | CloudHypervisorPrimaryAgentProfile
  | CloudHypervisorScriptEnclaveProfile
  | CloudHypervisorAgentEnclaveProfile;

export type CloudHypervisorLaunchableWorkloadProfile =
  | CloudHypervisorPrimaryAgentProfile
  | CloudHypervisorScriptEnclaveProfile;

const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_INTERFACE = /^[A-Za-z0-9_.-]{1,15}$/;
const MIB = 1024 * 1024;

export const CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES = Object.freeze({
  script: Object.freeze({
    role: 'script',
    memoryMiB: 768,
    vcpuCount: 1,
    cpuQuotaMilli: 500,
    maxProcesses: 47,
    tmpfsBytes: 256 * MIB,
    maxFileBytes: 512 * MIB,
    maxOpenFiles: 1024,
    writableStorageBytes: 1024 * MIB,
    uid: 65534,
    gid: 65534,
  }),
  agent: Object.freeze({
    role: 'agent',
    memoryMiB: 768,
    vcpuCount: 1,
    cpuQuotaMilli: 500,
    maxProcesses: 47,
    tmpfsBytes: 96 * MIB,
    maxFileBytes: 256 * MIB,
    maxOpenFiles: 1024,
    writableStorageBytes: 512 * MIB,
    uid: 65534,
    gid: 65534,
  }),
}) satisfies Readonly<Record<'script' | 'agent', CloudHypervisorEnclaveResourceProfile>>;

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
  readonly guest: Omit<CloudHypervisorManagerGuestConfig, 'exports' | 'workspaceMount'>;
  readonly exportPlan: CloudHypervisorEnclaveExportPlan;
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
    exportPlan: options.exportPlan,
    resources: CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.script,
    guest: {
      ...options.guest,
      enclaveResources: CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.script,
      exports: validateCloudHypervisorEnclaveExportPlan(options.exportPlan, 'script', {
        entryId: options.enclaveId,
        invocationId: options.invocationId,
      }),
      workspaceMount: null,
    },
    rawOutput: 'discard',
  }) as CloudHypervisorScriptEnclaveProfile;
}

export function createAgentEnclaveCloudHypervisorProfile(options: {
  readonly enclaveId: string;
  readonly invocationId: string;
  readonly guest: Omit<CloudHypervisorManagerGuestConfig, 'exports' | 'workspaceMount'>;
  readonly exportPlan: CloudHypervisorEnclaveExportPlan;
  readonly apiProxy: {
    readonly ip: string;
    readonly engine: EnclaveAgentEngine;
    readonly profile: EnclaveAgentProfile;
  };
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
    exportPlan: options.exportPlan,
    resources: CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.agent,
    guest: {
      ...options.guest,
      enclaveResources: CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.agent,
      exports: validateCloudHypervisorEnclaveExportPlan(options.exportPlan, 'agent', {
        entryId: options.enclaveId,
        invocationId: options.invocationId,
      }),
      workspaceMount: null,
    },
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
  assertClosedObject(profile, [
    'kind',
    'identity',
    'rootfsRole',
    'network',
    'guest',
    'exportPlan',
    'resources',
    'rawOutput',
  ],
    'workload profile');
  assertClosedObject(profile.identity, ['kind', 'ownerId', 'invocationId'], 'workload identity');
  assertSafeIdentity(profile.identity.ownerId, 'owner');

  switch (profile.kind) {
    case 'primary-agent':
      if (
        profile.identity.ownerId !== 'primary-agent' ||
        profile.identity.invocationId !== undefined ||
        profile.network.mode !== 'primary' ||
        profile.rawOutput !== 'capture' ||
        profile.exportPlan !== undefined
      ) {
        throw new Error('Contradictory Cloud Hypervisor primary-agent workload profile');
      }
      validatePrimaryNetwork(profile.network);
      break;
    case 'script-enclave':
      if (
        !profile.identity.invocationId ||
        profile.network.mode !== 'none' ||
        profile.rawOutput !== 'discard' ||
        !sameResourceProfile(profile.resources, CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.script)
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
        profile.rawOutput !== 'discard' ||
        !sameResourceProfile(profile.resources, CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.agent)
      ) {
        throw new Error('Contradictory Cloud Hypervisor agent-enclave workload profile');
      }
      assertSafeIdentity(profile.identity.invocationId, 'invocation');
      assertClosedObject(
        profile.network,
        ['mode', 'apiProxy', 'githubDataPlane'],
        'agent-enclave network profile',
      );
      assertClosedObject(
        profile.network.apiProxy,
        ['ip', 'engine', 'profile'],
        'dedicated API proxy',
      );
      validateIp(profile.network.apiProxy.ip, 'dedicated API proxy');
      if (
        profile.network.apiProxy.ip !== ENCLAVE_AGENT_API_PROXY_IP ||
        !['copilot', 'claude', 'codex', 'gemini'].includes(profile.network.apiProxy.engine) ||
        !['openai', 'anthropic'].includes(profile.network.apiProxy.profile)
      ) {
        throw new Error('Cloud Hypervisor agent-enclave requires a supported dedicated API proxy engine profile');
      }
      if (profile.network.githubDataPlane) {
        validateEndpoint(profile.network.githubDataPlane, 'GitHub data plane');
        if (
          profile.network.githubDataPlane.ip !== ENCLAVE_AGENT_GITHUB_MCP_IP ||
          profile.network.githubDataPlane.port !== ENCLAVE_GITHUB_MCP_PORT
        ) {
          throw new Error('Cloud Hypervisor agent-enclave requires the compiler-owned GitHub data plane');
        }
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
): void {
  validateCloudHypervisorWorkloadProfile(profile);
  if (profile.kind !== 'primary-agent') {
    throw new Error(
      `Cloud Hypervisor ${profile.kind} execution is not implemented; refusing to fall back to another runtime`,
    );
  }
}

function sameResourceProfile(
  actual: CloudHypervisorEnclaveResourceProfile | undefined,
  expected: CloudHypervisorEnclaveResourceProfile,
): boolean {
  if (!actual || typeof actual !== 'object') return false;
  const keys = Object.keys(expected) as (keyof CloudHypervisorEnclaveResourceProfile)[];
  return Object.keys(actual).length === keys.length &&
    keys.every((key) => actual[key] === expected[key]);
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
    'enclaveResources',
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
  if (
    profile.kind !== 'primary-agent' &&
    (workspaceMount !== null || profile.guest.exports.some((entry) => (
      entry.tag === 'workspace' || entry.target === '/workspace' || entry.target.startsWith('/workspace/')
    )))
  ) {
    throw new Error(`Cloud Hypervisor ${profile.kind} must not declare a primary workspace mount`);
  }
  if (profile.kind !== 'primary-agent') {
    if (!sameResourceProfile(profile.guest.enclaveResources, profile.resources)) {
      throw new Error(`Cloud Hypervisor ${profile.kind} guest resource profile is missing or inconsistent`);
    }
    if (profile.guest.mountEnforcement !== undefined) {
      throw new Error(`Cloud Hypervisor ${profile.kind} must use its closed export access modes`);
    }

    const role = profile.kind === 'script-enclave' ? 'script' : 'agent';
    const plannedExports = validateCloudHypervisorEnclaveExportPlan(profile.exportPlan, role, {
      entryId: profile.identity.ownerId,
      invocationId: profile.identity.invocationId!,
    });
    if (
      profile.guest.exports.length !== plannedExports.length ||
      plannedExports.some((entry) => !profile.guest.exports.some((actual) => (
        actual.tag === entry.tag &&
        actual.source === entry.source &&
        actual.target === entry.target &&
        actual.mode === entry.mode
      )))
    ) {
      throw new Error(`Cloud Hypervisor ${profile.kind} guest exports do not match its trusted export plan`);
    }
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
    ...(profile.kind !== 'primary-agent' ? { maxExports: 6 } : {}),
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
