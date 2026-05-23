import { SslConfig } from '../../host-env';
import { WrapperConfig } from '../../types';
import { NetworkConfig } from '../squid-service';

export interface AgentEnvironmentParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  dnsServers: string[];
  sslConfig?: SslConfig;
}
