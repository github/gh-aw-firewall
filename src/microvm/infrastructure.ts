import execa from 'execa';
import {
  API_PROXY_IP,
  HOST_GATEWAY,
  NETWORK_NAME,
  NETWORK_SUBNET,
  SQUID_IP,
} from '../config/network-policy';
import {
  AGENT_CONTAINER_NAME,
  API_PROXY_CONTAINER_NAME,
  SQUID_CONTAINER_NAME,
} from '../constants';
import { getLocalDockerEnv } from '../docker-host';

interface DockerNetworkContainer {
  readonly Name?: string;
  readonly IPv4Address?: string;
}

interface DockerNetworkInspection {
  readonly Name?: string;
  readonly Id?: string;
  readonly Driver?: string;
  readonly Scope?: string;
  readonly Internal?: boolean;
  readonly Options?: Readonly<Record<string, string>>;
  readonly IPAM?: {
    readonly Config?: ReadonlyArray<{
      readonly Subnet?: string;
      readonly Gateway?: string;
    }>;
  };
  readonly Containers?: Readonly<Record<string, DockerNetworkContainer>>;
}

interface IpLinkInspection {
  readonly ifname?: string;
  readonly linkinfo?: {
    readonly info_kind?: string;
  };
}

export interface MicrovmInfrastructureSnapshot {
  readonly networkId: string;
  readonly bridgeName: string;
  readonly subnet: string;
  readonly gateway: string;
  readonly squidIp: string;
  readonly apiProxyIp?: string;
  revalidate(): Promise<void>;
}

export interface MicrovmInfrastructureDependencies {
  inspectNetwork(): Promise<unknown>;
  inspectLink(bridgeName: string, ipPath?: string): Promise<unknown>;
}

const defaultDependencies: MicrovmInfrastructureDependencies = {
  inspectNetwork: async () => {
    const result = await execa('docker', ['network', 'inspect', NETWORK_NAME], {
      env: getLocalDockerEnv(),
      reject: false,
      timeout: 10_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not inspect microVM infrastructure network "${NETWORK_NAME}": ` +
        result.stderr.trim(),
      );
    }
    return JSON.parse(result.stdout) as unknown;
  },
  inspectLink: async (bridgeName, ipPath = 'ip') => {
    const result = await execa(ipPath, ['-json', '-details', 'link', 'show', 'dev', bridgeName], {
      reject: false,
      timeout: 5_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not inspect microVM infrastructure bridge "${bridgeName}": ` +
        result.stderr.trim(),
      );
    }
    return JSON.parse(result.stdout) as unknown;
  },
};

/**
 * Resolves and proves the exact host bridge and service addresses used by the
 * Compose infrastructure that any microVM backend attaches its network
 * namespace to. No default bridge name or daemon-local assumption is
 * accepted.
 */
export async function resolveMicrovmInfrastructure(
  enableApiProxy: boolean,
  dependencies: MicrovmInfrastructureDependencies = defaultDependencies,
  ipPath?: string,
): Promise<MicrovmInfrastructureSnapshot> {
  const resolved = await inspectInfrastructure(enableApiProxy, dependencies, ipPath);
  return {
    ...resolved,
    revalidate: async () => {
      const live = await inspectInfrastructure(enableApiProxy, dependencies, ipPath);
      if (
        live.networkId !== resolved.networkId ||
        live.bridgeName !== resolved.bridgeName ||
        live.subnet !== resolved.subnet ||
        live.gateway !== resolved.gateway ||
        live.squidIp !== resolved.squidIp ||
        live.apiProxyIp !== resolved.apiProxyIp
      ) {
        throw new Error(
          `microVM infrastructure topology changed after discovery; ` +
          `refusing to attach the microVM`,
        );
      }
    },
  };
}

async function inspectInfrastructure(
  enableApiProxy: boolean,
  dependencies: MicrovmInfrastructureDependencies,
  ipPath?: string,
): Promise<Omit<MicrovmInfrastructureSnapshot, 'revalidate'>> {
  const raw = await dependencies.inspectNetwork();
  if (!Array.isArray(raw) || raw.length !== 1) {
    throw new Error(
      `Expected exactly one Docker network inspection for "${NETWORK_NAME}"`,
    );
  }
  const network = asRecord(raw[0], 'Docker network') as DockerNetworkInspection;
  if (
    network.Name !== NETWORK_NAME ||
    network.Driver !== 'bridge' ||
    network.Scope !== 'local' ||
    network.Internal !== true
  ) {
    throw new Error(
      `Unexpected microVM infrastructure topology for "${NETWORK_NAME}": ` +
      `name=${String(network.Name)} driver=${String(network.Driver)} ` +
      `scope=${String(network.Scope)} internal=${String(network.Internal)}`,
    );
  }
  if (!network.Id || !/^[a-f0-9]{64}$/i.test(network.Id)) {
    throw new Error(`Docker network "${NETWORK_NAME}" returned an invalid network ID`);
  }

  const ipv4Configs = (network.IPAM?.Config ?? []).filter((entry) => entry.Subnet?.includes('.'));
  if (
    ipv4Configs.length !== 1 ||
    ipv4Configs[0].Subnet !== NETWORK_SUBNET ||
    ipv4Configs[0].Gateway !== HOST_GATEWAY
  ) {
    throw new Error(
      `Docker network "${NETWORK_NAME}" must have exactly ${NETWORK_SUBNET} ` +
      `with gateway ${HOST_GATEWAY}`,
    );
  }

  const configuredBridge =
    network.Options?.['com.docker.network.bridge.name'];
  const bridgeName = configuredBridge || `br-${network.Id.slice(0, 12)}`;
  assertInterfaceName(bridgeName);
  const rawLinks = await dependencies.inspectLink(bridgeName, ipPath);
  if (!Array.isArray(rawLinks) || rawLinks.length !== 1) {
    throw new Error(`Expected exactly one host bridge named "${bridgeName}"`);
  }
  const link = asRecord(rawLinks[0], 'host bridge') as IpLinkInspection;
  if (link.ifname !== bridgeName || link.linkinfo?.info_kind !== 'bridge') {
    throw new Error(`Host interface "${bridgeName}" is not the Docker bridge for "${NETWORK_NAME}"`);
  }

  const containers = Object.values(network.Containers ?? {});
  assertContainerAbsent(containers, AGENT_CONTAINER_NAME);
  const squidIp = resolveContainerIp(containers, SQUID_CONTAINER_NAME, SQUID_IP);
  const apiProxyIp = enableApiProxy
    ? resolveContainerIp(containers, API_PROXY_CONTAINER_NAME, API_PROXY_IP)
    : undefined;

  return {
    networkId: network.Id,
    bridgeName,
    subnet: NETWORK_SUBNET,
    gateway: HOST_GATEWAY,
    squidIp,
    ...(apiProxyIp ? { apiProxyIp } : {}),
  };
}

function resolveContainerIp(
  containers: readonly DockerNetworkContainer[],
  name: string,
  expectedIp: string,
): string {
  const matches = containers.filter((container) => container.Name === name);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one "${name}" endpoint on "${NETWORK_NAME}", found ${matches.length}`,
    );
  }
  const address = matches[0].IPv4Address;
  const ip = address?.split('/')[0];
  if (ip !== expectedIp) {
    throw new Error(
      `Unexpected "${name}" address on "${NETWORK_NAME}": ` +
      `expected ${expectedIp}, found ${String(address)}`,
    );
  }
  return ip;
}

function assertContainerAbsent(
  containers: readonly DockerNetworkContainer[],
  name: string,
): void {
  if (containers.some((container) => container.Name === name)) {
    throw new Error(
      `Unexpected Compose agent "${name}" is attached during microVM execution`,
    );
  }
}

function assertInterfaceName(name: string): void {
  if (name.length < 1 || name.length > 15 || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`Unsafe microVM infrastructure bridge name: ${name}`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} inspection is not an object`);
  }
  return value as Record<string, unknown>;
}
