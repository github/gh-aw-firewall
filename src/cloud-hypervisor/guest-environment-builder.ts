import {
  NETWORK_SUBNET,
} from '../config/network-policy';
import type { MicrovmInfrastructureSnapshot } from '../microvm/infrastructure';
import { buildGuestEnvironment } from '../microvm/guest-environment';
import type { WrapperConfig } from '../types';
import type { CloudHypervisorDirectoryExport } from './exports';

const CLOUD_HYPERVISOR_GUEST_WORKSPACE = '/workspace';
const CLOUD_HYPERVISOR_GUEST_HOME = `${CLOUD_HYPERVISOR_GUEST_WORKSPACE}/.awf-home`;

export function buildCloudHypervisorGuestEnvironment(
  config: WrapperConfig,
  infrastructure: Pick<
    MicrovmInfrastructureSnapshot,
    'squidIp' | 'apiProxyIp' | 'topologyPeerIps'
  >,
  guestIp = '100.64.0.2',
  exports: readonly CloudHypervisorDirectoryExport[] = [],
): Record<string, string> {
  const networkConfig = {
    subnet: NETWORK_SUBNET,
    squidIp: infrastructure.squidIp,
    agentIp: guestIp,
    proxyIp: infrastructure.apiProxyIp,
  };
  const environment = buildGuestEnvironment({
    config,
    networkConfig,
    home: CLOUD_HYPERVISOR_GUEST_HOME,
    workspace: CLOUD_HYPERVISOR_GUEST_WORKSPACE,
    runtimeName: 'cloud-hypervisor',
    runtimeDisplayName: 'Cloud Hypervisor',
  });
  const topologyPeerBypasses = Object.entries(infrastructure.topologyPeerIps)
    .flatMap(([name, ip]) => [name, ip]);
  if (topologyPeerBypasses.length > 0) {
    const noProxy = new Set((environment.NO_PROXY ?? '').split(',').filter(Boolean));
    topologyPeerBypasses.forEach((peer) => noProxy.add(peer));
    environment.NO_PROXY = [...noProxy].join(',');
    environment.no_proxy = environment.NO_PROXY;
  }
  environment.GITHUB_WORKSPACE = CLOUD_HYPERVISOR_GUEST_WORKSPACE;
  for (const name of ['RUNNER_TOOL_CACHE', 'AGENT_TOOLSDIRECTORY', 'RUNNER_TEMP'] as const) {
    delete environment[name];
  }
  const toolCache = exports.find((entry) => entry.tag === 'runner-tool-cache');
  if (toolCache) {
    if (process.env.RUNNER_TOOL_CACHE) environment.RUNNER_TOOL_CACHE = toolCache.target;
    else environment.AGENT_TOOLSDIRECTORY = toolCache.target;
  }
  const runnerTemp = exports.find((entry) => entry.tag === 'runner-temp-gh-aw');
  if (runnerTemp) {
    environment.RUNNER_TEMP = runnerTemp.target.slice(0, -'/gh-aw'.length);
  }
  return environment;
}
