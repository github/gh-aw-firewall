import { parseValidPortSpecs } from '../../host-iptables-validation';
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
    // Pre-validate once in TypeScript so setup-iptables.sh can consume normalized specs
    // without duplicating the full parser. The shell uses AWF_VALID_ALLOW_HOST_PORTS
    // with a minimal fail-closed assertion rather than a second full parser.
    const validSpecs = parseValidPortSpecs(config.allowHostPorts, 'port spec');
    if (validSpecs.length > 0) {
      environment.AWF_VALID_ALLOW_HOST_PORTS = validSpecs.join(',');
    }
  }

  if (config.allowHostServicePorts) {
    environment.AWF_HOST_SERVICE_PORTS = config.allowHostServicePorts;
    // Pre-validate once in TypeScript (same rationale as AWF_VALID_ALLOW_HOST_PORTS).
    const validServiceSpecs = parseValidPortSpecs(config.allowHostServicePorts, 'host service port spec');
    if (validServiceSpecs.length > 0) {
      environment.AWF_VALID_HOST_SERVICE_PORTS = validServiceSpecs.join(',');
    }
    if (!environment.AWF_ENABLE_HOST_ACCESS) {
      environment.AWF_ENABLE_HOST_ACCESS = '1';
    }
  }

  environment.AWF_CHROOT_ENABLED = 'true';
  environment.AWF_WORKDIR = config.containerWorkDir || getRealUserHome();
  environment.AWF_USER_UID = getSafeHostUid();
  environment.AWF_USER_GID = getSafeHostGid();

  if (config.geminiApiKey || config.googleApiKey) {
    environment.AWF_GEMINI_ENABLED = '1';
  }
}
