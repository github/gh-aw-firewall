import execa from 'execa';
import { ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME } from '../constants';
import { getLocalDockerEnv } from '../docker-host';
import {
  ENCLAVE_MCP_GATEWAY_CONTAINER_ENV,
  ENCLAVE_MCP_GATEWAY_IDENTITY_ENV,
  ENCLAVE_MCP_GATEWAY_RUN_LABEL,
} from '../enclave/gateway';
import {
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_GITHUB_MCP_IP,
  ENCLAVE_AGENT_NETWORK,
  ENCLAVE_AGENT_SUBNET,
} from '../enclave/network';
import type { MicrovmNetworkPlanOptions } from '../microvm/network';
import type { CloudHypervisorHostToolPaths } from './preflight';
import { validateCloudHypervisorWorkloadProfile } from './workload-profile';
import type { CloudHypervisorAgentEnclaveProfile } from './workload-profile';
import { resolveEnclaveAgentApiPort } from '../types/enclave-options';
import { HostPreflightReporter, markHostPreflightError, type HostPreflightCheck } from './host-preflight-progress';

interface EnclaveNetworkInspection {
  Name?: string;
  Id?: string;
  Driver?: string;
  Scope?: string;
  Internal?: boolean;
  Options?: Record<string, string>;
  IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> };
  Containers?: Record<string, { Name?: string; IPv4Address?: string }>;
}

export interface EnclaveNetworkInspectionDependencies {
  inspectNetwork(dockerBinaryPath: string): Promise<unknown>;
  inspectContainer(dockerBinaryPath: string, name: string): Promise<unknown>;
  inspectBridge(ipBinaryPath: string, name: string): Promise<unknown>;
}

const defaultInspection: EnclaveNetworkInspectionDependencies = {
  inspectNetwork: async (dockerBinaryPath) => {
    // eslint-disable-next-line local/no-unsafe-execa -- preflight verifies this executable's ownership.
    const result = await execa(dockerBinaryPath, ['network', 'inspect', ENCLAVE_AGENT_NETWORK], {
      env: getLocalDockerEnv(), timeout: 10_000,
    });
    return JSON.parse(result.stdout) as unknown;
  },
  inspectContainer: async (dockerBinaryPath, name) => {
    // eslint-disable-next-line local/no-unsafe-execa -- preflight verifies this executable's ownership.
    const result = await execa(dockerBinaryPath, ['inspect', '--format', '{{json .}}', name], {
      env: getLocalDockerEnv(), timeout: 10_000,
    });
    return JSON.parse(result.stdout) as unknown;
  },
  inspectBridge: async (ipBinaryPath, name) => {
    // eslint-disable-next-line local/no-unsafe-execa -- preflight verifies this executable's ownership.
    const result = await execa(ipBinaryPath, ['-json', '-details', 'link', 'show', 'dev', name], {
      timeout: 5_000,
    });
    return JSON.parse(result.stdout) as unknown;
  },
};

/**
 * Trust only the daemon's exact internal enclave network and its fixed peers.
 * Engine/profile state selects the API port, and only compiler identity can
 * enable the GitHub data plane; callers never choose a bridge or route.
 */
export async function resolveCloudHypervisorEnclaveNetwork(
  profile: CloudHypervisorAgentEnclaveProfile,
  tools: Pick<CloudHypervisorHostToolPaths, 'docker' | 'ip'>,
  inspection: EnclaveNetworkInspectionDependencies = defaultInspection,
  env: NodeJS.ProcessEnv = process.env,
  report?: HostPreflightReporter,
): Promise<Pick<MicrovmNetworkPlanOptions, 'infrastructureBridge' | 'enableApiProxy' | 'enclaveAgent'>> {
  const check = <T>(id: HostPreflightCheck, operation: () => Promise<T> | T): Promise<T> =>
    report ? report.check(id, operation) : Promise.resolve().then(operation);
  const invalid = (message: string): Error => markHostPreflightError(new Error(message), 'requirement-not-met');
  validateCloudHypervisorWorkloadProfile(profile);
  const gatewayName = profile.network.githubDataPlane
    ? env[ENCLAVE_MCP_GATEWAY_CONTAINER_ENV]
    : undefined;
  const gatewayIdentity = profile.network.githubDataPlane
    ? env[ENCLAVE_MCP_GATEWAY_IDENTITY_ENV]
    : undefined;
  if (!profile.network.githubDataPlane) report?.notRequired('gateway-identity');
  else await check('gateway-identity', () => {
    if (
      !gatewayName || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(gatewayName) ||
      !gatewayIdentity || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(gatewayIdentity)
    ) {
      throw invalid('Compiler-owned GitHub gateway identity is missing or invalid');
    }
  });
  const raw = await check('network-inspect', () => inspection.inspectNetwork(tools.docker));
  const { network, bridge } = await check('network-topology', () => {
    if (!Array.isArray(raw) || raw.length !== 1 || !raw[0] || typeof raw[0] !== 'object') {
      throw invalid('Expected one dedicated agent-enclave Docker network');
    }
    const network = raw[0] as EnclaveNetworkInspection;
    if (
      network.Name !== ENCLAVE_AGENT_NETWORK ||
      network.Driver !== 'bridge' ||
      network.Scope !== 'local' ||
      network.Internal !== true ||
      !network.Id || !/^[a-f0-9]{64}$/i.test(network.Id) ||
      network.IPAM?.Config?.length !== 1 ||
      network.IPAM.Config[0].Subnet !== ENCLAVE_AGENT_SUBNET ||
      (network.IPAM.Config[0].Gateway !== undefined &&
        network.IPAM.Config[0].Gateway !== '172.31.0.1')
    ) {
      throw invalid('Unexpected agent-enclave Docker network topology');
    }
    return { network, bridge: network.Options?.['com.docker.network.bridge.name'] || `br-${network.Id.slice(0, 12)}` };
  });
  const members = Object.values(network.Containers ?? {});
  const expected = [
    [ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME, ENCLAVE_AGENT_API_PROXY_IP],
    ...(gatewayName ? [[gatewayName, ENCLAVE_AGENT_GITHUB_MCP_IP]] : []),
  ];
  await check('network-membership', () => {
    if (
      members.length !== expected.length ||
      expected.some(([name, ip]) =>
        members.filter((member) => member.Name === name && member.IPv4Address === `${ip}/24`).length !== 1)
    ) {
      throw invalid('Unexpected agent-enclave Docker network membership');
    }
  });
  await check('api-proxy-ready', async () => {
    const proxy = await inspection.inspectContainer(tools.docker, ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME) as {
      Name?: string; State?: { Running?: boolean; Health?: { Status?: string } };
    };
    if (proxy.Name !== `/${ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME}`
        || proxy.State?.Running !== true || proxy.State.Health?.Status !== 'healthy') {
      throw invalid('Dedicated enclave API proxy is not running and healthy');
    }
  });
  if (gatewayName && gatewayIdentity) {
    await check('gateway-ready', async () => {
      const inspected = await inspection.inspectContainer(tools.docker, gatewayName) as {
        Name?: string;
        State?: { Running?: boolean };
        Config?: { Labels?: Record<string, string> };
      };
      if (
        inspected.Name !== `/${gatewayName}` ||
        inspected.State?.Running !== true ||
        inspected.Config?.Labels?.[ENCLAVE_MCP_GATEWAY_RUN_LABEL] !== gatewayIdentity
      ) {
        throw invalid('Trusted enclave MCP gateway did not match the compiler handoff');
      }
    });
  } else report?.notRequired('gateway-ready');
  await check('bridge-ready', async () => {
    if (!/^[A-Za-z0-9_.-]{1,15}$/.test(bridge)) {
      throw invalid('Unsafe agent-enclave Docker bridge');
    }
    const links = await inspection.inspectBridge(tools.ip, bridge);
    if (
      !Array.isArray(links) || links.length !== 1 ||
      links[0]?.ifname !== bridge || links[0]?.linkinfo?.info_kind !== 'bridge'
    ) {
      throw invalid('Agent-enclave Docker bridge is unavailable');
    }
  });
  return {
    infrastructureBridge: bridge,
    enableApiProxy: false,
    enclaveAgent: {
      apiProxyPort: resolveEnclaveAgentApiPort(
        profile.network.apiProxy.engine,
        profile.network.apiProxy.profile,
      ),
      githubDataPlane: Boolean(profile.network.githubDataPlane),
    },
  };
}
