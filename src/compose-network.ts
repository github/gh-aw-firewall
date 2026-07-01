import { DockerComposeConfig } from './types';
import { TOPOLOGY_NETWORK_NAME } from './topology';
import { NetworkConfig } from './services/squid-service';

interface BuildComposeNetworksParams {
  services: Record<string, any>;
  squidService: any;
  agentService: any;
  networkIsolation: boolean;
  networkConfig: NetworkConfig;
  namedVolumes: Record<string, any> | undefined;
}

/**
 * Assembles the final Docker Compose result by selecting the correct network
 * topology and attaching it to the already-assembled `services` map.
 *
 * Two code paths:
 *
 * - **Network-isolation (topology) mode** (`networkIsolation = true`): creates
 *   an `internal` `awf-net` plus an `awf-ext` bridge. Squid is dual-homed so
 *   it is the sole egress path. Agent DNS is locked to the Docker embedded
 *   resolver because external DNS is unreachable from an internal network.
 *
 * - **Standard iptables mode** (`networkIsolation = false`): uses a pre-created
 *   external `awf-net` managed by `host-iptables.ts`.
 */
export function buildComposeNetworks(params: BuildComposeNetworksParams): DockerComposeConfig {
  const { services, squidService, agentService, networkIsolation, networkConfig, namedVolumes } = params;

  if (networkIsolation) {
    // Topology enforcement: the agent (and sidecars) live on an `internal`
    // network with no route to the internet. Squid is dual-homed — attached to
    // both the internal network and an external bridge network — so it is the
    // sole egress path. No host iptables and no NET_ADMIN are involved.
    squidService.networks = {
      ...(squidService.networks || {}),
      'awf-ext': {},
    };

    // The agent must resolve names via Docker's embedded resolver (127.0.0.11),
    // which forwards through the daemon's network rather than the agent's, so it
    // still works on an internal network. The configured external DNS servers are
    // unreachable from an internal network.
    agentService.dns = ['127.0.0.11'];

    return {
      services,
      networks: {
        'awf-net': {
          name: TOPOLOGY_NETWORK_NAME,
          internal: true,
          ipam: {
            config: [{ subnet: networkConfig.subnet }],
          },
        },
        'awf-ext': {
          driver: 'bridge',
        },
      },
      ...(namedVolumes && { volumes: namedVolumes }),
    };
  }

  return {
    services,
    networks: {
      'awf-net': {
        external: true,
      },
    },
    ...(namedVolumes && { volumes: namedVolumes }),
  };
}
