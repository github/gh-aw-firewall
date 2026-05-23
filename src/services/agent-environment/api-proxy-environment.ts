import { getRealUserHome, getSafeHostGid, getSafeHostUid } from '../../host-identity';
import { AgentEnvironmentParams } from './types';

interface ApiProxyEnvironmentParams extends AgentEnvironmentParams {
  environment: Record<string, string>;
}

export function buildApiProxyEnvironment(params: ApiProxyEnvironmentParams): void {
  const { config, networkConfig, dnsServers, environment } = params;

  environment.AWF_DNS_SERVERS = dnsServers.join(',');

  if (config.dnsOverHttps && networkConfig.dohProxyIp) {
    environment.AWF_DOH_ENABLED = 'true';
    environment.AWF_DOH_PROXY_IP = networkConfig.dohProxyIp;
  }

  if (config.allowHostPorts) {
    environment.AWF_ALLOW_HOST_PORTS = config.allowHostPorts;
  }

  if (config.allowHostServicePorts) {
    environment.AWF_HOST_SERVICE_PORTS = config.allowHostServicePorts;
    if (!environment.AWF_ENABLE_HOST_ACCESS) {
      environment.AWF_ENABLE_HOST_ACCESS = '1';
    }
  }

  environment.AWF_CHROOT_ENABLED = 'true';
  environment.AWF_WORKDIR = config.containerWorkDir || getRealUserHome();
  environment.AWF_USER_UID = getSafeHostUid();
  environment.AWF_USER_GID = getSafeHostGid();

  if (config.geminiApiKey) {
    environment.AWF_GEMINI_ENABLED = '1';
  }
}
