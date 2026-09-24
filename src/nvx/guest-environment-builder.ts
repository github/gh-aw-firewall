import { NETWORK_SUBNET } from '../config/network-policy';
import type { MicrovmInfrastructureSnapshot } from '../microvm/infrastructure';
import { buildGuestEnvironment } from '../microvm/guest-environment';
import type { WrapperConfig } from '../types';
import {
  NVX_GUEST_HOME,
  NVX_GUEST_WORKSPACE,
  type NvxDirectoryExport,
} from './workspace-export';

/**
 * Builds the per-run NVX guest environment.
 *
 * This is the NVX counterpart of
 * `src/cloud-hypervisor/guest-environment-builder.ts`: it resolves the same
 * runtime-neutral guest environment (which already folds in `--env`,
 * `--env-all`, and `--env-file`) and then rewrites the runner-provided
 * workspace/tool-cache variables to their guest-visible paths.
 */
export function buildNvxGuestEnvironment(
  config: WrapperConfig,
  infrastructure: Pick<
    MicrovmInfrastructureSnapshot,
    'squidIp' | 'apiProxyIp' | 'topologyPeerIps'
  >,
  guestIp: string,
  exports: readonly NvxDirectoryExport[] = [],
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const guestEnvironment = buildGuestEnvironment({
    config,
    networkConfig: {
      subnet: NETWORK_SUBNET,
      squidIp: infrastructure.squidIp,
      agentIp: guestIp,
      proxyIp: infrastructure.apiProxyIp,
    },
    home: NVX_GUEST_HOME,
    workspace: NVX_GUEST_WORKSPACE,
    runtimeName: 'nvx',
    runtimeDisplayName: 'NVX',
  });
  const topologyPeerBypasses = Object.entries(infrastructure.topologyPeerIps)
    .flatMap(([name, ip]) => [name, ip]);
  if (topologyPeerBypasses.length > 0) {
    const noProxy = new Set((guestEnvironment.NO_PROXY ?? '').split(',').filter(Boolean));
    topologyPeerBypasses.forEach((peer) => noProxy.add(peer));
    guestEnvironment.NO_PROXY = [...noProxy].join(',');
    guestEnvironment.no_proxy = guestEnvironment.NO_PROXY;
  }
  guestEnvironment.GITHUB_WORKSPACE = NVX_GUEST_WORKSPACE;
  for (const name of ['RUNNER_TOOL_CACHE', 'AGENT_TOOLSDIRECTORY', 'RUNNER_TEMP'] as const) {
    delete guestEnvironment[name];
  }
  const toolCache = exports.find((entry) => entry.tag === 'runner-tool-cache');
  if (toolCache) {
    if (environment.RUNNER_TOOL_CACHE) guestEnvironment.RUNNER_TOOL_CACHE = toolCache.target;
    else guestEnvironment.AGENT_TOOLSDIRECTORY = toolCache.target;
  }
  return guestEnvironment;
}
