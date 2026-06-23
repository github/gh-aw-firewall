import { API_PROXY_HEALTH_PORT } from '../types';
import { NetworkConfig } from './squid-service';

interface ApiProxyLifecycleConfig {
  networks: {
    'awf-net': {
      ipv4_address: string;
    };
  };
  healthcheck: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
    start_period: string;
  };
}

export function buildApiProxyLifecycleConfig(networkConfig: NetworkConfig): ApiProxyLifecycleConfig {
  if (!networkConfig.proxyIp) {
    throw new Error('buildApiProxyLifecycleConfig: networkConfig.proxyIp is required');
  }

  return {
    networks: {
      'awf-net': {
        ipv4_address: networkConfig.proxyIp,
      },
    },
    healthcheck: {
      test: ['CMD', 'curl', '-f', `http://localhost:${API_PROXY_HEALTH_PORT}/health`],
      interval: '2s',
      timeout: '3s',
      retries: 15,
      start_period: '30s',
    },
  };
}
