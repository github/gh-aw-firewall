import { DOH_PROXY_CONTAINER_NAME } from '../host-env';
import { logger } from '../logger';
import { WrapperConfig } from '../types';
import { NetworkConfig } from './squid-service';

interface DohProxyServiceParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
}

/**
 * Builds the DNS-over-HTTPS proxy sidecar service configuration for Docker Compose.
 */
export function buildDohProxyService(params: DohProxyServiceParams): any {
  const { config, networkConfig } = params;

  if (!networkConfig.dohProxyIp || !config.dnsOverHttps) {
    throw new Error('buildDohProxyService: dohProxyIp and dnsOverHttps are required');
  }

  const dohService: any = {
    container_name: DOH_PROXY_CONTAINER_NAME,
    image: 'cloudflare/cloudflared:latest',
    networks: {
      'awf-net': {
        ipv4_address: networkConfig.dohProxyIp,
      },
    },
    command: ['proxy-dns', '--address', '0.0.0.0', '--port', '53', '--upstream', config.dnsOverHttps],
    healthcheck: {
      test: ['CMD', 'nslookup', '-port=53', 'cloudflare.com', '127.0.0.1'],
      interval: '1s',
      timeout: '3s',
      retries: 5,
      start_period: '2s',
    },
    // Security hardening: Drop all capabilities
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    mem_limit: '128m',
    memswap_limit: '128m',
    pids_limit: 50,
  };

  logger.info(`DNS-over-HTTPS proxy sidecar enabled - DNS queries encrypted via ${config.dnsOverHttps}`);

  return dohService;
}
