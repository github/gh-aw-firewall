import execa from 'execa';
import { ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME } from '../constants';
import { getLocalDockerEnv } from '../docker-host';
import {
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_GITHUB_MCP_IP,
  ENCLAVE_AGENT_NETWORK,
  ENCLAVE_AGENT_SUBNET,
} from '../enclave/network';
import type { MicrovmNetworkPlanOptions } from '../microvm/network';
import { validateCloudHypervisorWorkloadProfile } from './workload-profile';
import type { CloudHypervisorAgentEnclaveProfile } from './workload-profile';

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
  inspectNetwork(): Promise<unknown>;
  inspectBridge(name: string): Promise<unknown>;
}

const defaultInspection: EnclaveNetworkInspectionDependencies = {
  inspectNetwork: async () => {
    const result = await execa('docker', ['network', 'inspect', ENCLAVE_AGENT_NETWORK], {
      env: getLocalDockerEnv(), timeout: 10_000,
    });
    return JSON.parse(result.stdout) as unknown;
  },
  inspectBridge: async (name) => {
    const result = await execa('ip', ['-json', '-details', 'link', 'show', 'dev', name], {
      timeout: 5_000,
    });
    return JSON.parse(result.stdout) as unknown;
  },
};

/**
 * Trust only the daemon's exact internal enclave network and its fixed peers.
 * The caller chooses an engine port and GitHub policy, never a bridge or route.
 */
export async function resolveCloudHypervisorEnclaveNetwork(
  profile: CloudHypervisorAgentEnclaveProfile,
  inspection: EnclaveNetworkInspectionDependencies = defaultInspection,
): Promise<Pick<MicrovmNetworkPlanOptions, 'infrastructureBridge' | 'enableApiProxy' | 'enclaveAgent'>> {
  validateCloudHypervisorWorkloadProfile(profile);
  const raw = await inspection.inspectNetwork();
  if (!Array.isArray(raw) || raw.length !== 1 || !raw[0] || typeof raw[0] !== 'object') {
    throw new Error('Expected one dedicated agent-enclave Docker network');
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
    throw new Error('Unexpected agent-enclave Docker network topology');
  }
  const bridge = network.Options?.['com.docker.network.bridge.name'] || `br-${network.Id.slice(0, 12)}`;
  if (!/^[A-Za-z0-9_.-]{1,15}$/.test(bridge)) {
    throw new Error('Unsafe agent-enclave Docker bridge');
  }
  const members = Object.values(network.Containers ?? {});
  const expected = [
    [ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME, ENCLAVE_AGENT_API_PROXY_IP],
    ...(profile.network.githubDataPlane ? [['awmg-mcpg', ENCLAVE_AGENT_GITHUB_MCP_IP]] : []),
  ];
  if (
    members.length !== expected.length ||
    expected.some(([name, ip]) =>
      members.filter((member) => member.Name === name && member.IPv4Address === `${ip}/24`).length !== 1)
  ) {
    throw new Error('Unexpected agent-enclave Docker network membership');
  }
  const links = await inspection.inspectBridge(bridge);
  if (
    !Array.isArray(links) || links.length !== 1 ||
    links[0]?.ifname !== bridge || links[0]?.linkinfo?.info_kind !== 'bridge'
  ) {
    throw new Error('Agent-enclave Docker bridge is unavailable');
  }
  return {
    infrastructureBridge: bridge,
    enableApiProxy: false,
    enclaveAgent: {
      apiProxyPort: profile.network.apiProxy.port,
      githubDataPlane: Boolean(profile.network.githubDataPlane),
    },
  };
}
