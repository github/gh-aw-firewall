import { WrapperConfig } from '../../types';
import { NetworkConfig } from '../squid-service';

interface ProxyEnvironmentParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  environment: Record<string, string>;
}

export function buildProxyEnvironment(params: ProxyEnvironmentParams): void {
  const { config, networkConfig, environment } = params;

  environment.NO_PROXY = `localhost,127.0.0.1,::1,0.0.0.0,${networkConfig.squidIp},${networkConfig.agentIp}`;
  environment.no_proxy = environment.NO_PROXY;

  if (config.enableHostAccess) {
    const subnetBase = networkConfig.subnet.split('/')[0];
    const parts = subnetBase.split('.');
    const networkGatewayIp = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
    environment.NO_PROXY += `,host.docker.internal,${networkGatewayIp}`;
    environment.no_proxy = environment.NO_PROXY;
  }

  if (config.enableApiProxy && networkConfig.proxyIp) {
    environment.NO_PROXY += `,${networkConfig.proxyIp}`;
    environment.no_proxy = environment.NO_PROXY;
  }
}
