import type { SquidConfig } from '../types';
import { generateDlpSquidConfig } from '../dlp';
import { DEFAULT_DNS_SERVERS } from '../dns-resolver';
import { generateSslBumpSection } from './ssl-bump';
import { validateAndSanitizeHostAccessPort, validateApiProxyPort } from './validation';
import { formatDomainForSquid } from './domain-acl';

type DomainsByProto = ReturnType<typeof import('./domain-acl').parseDomainConfig>['domainsByProto'];
type PatternsByProto = ReturnType<typeof import('./domain-acl').parseDomainConfig>['patternsByProto'];

function generateDlpSections(enableDlp?: boolean): {
  aclSection: string;
  accessSection: string;
} {
  if (!enableDlp) {
    return { aclSection: '', accessSection: '' };
  }

  const dlp = generateDlpSquidConfig();
  return {
    aclSection: '\n' + dlp.aclLines.join('\n') + '\n',
    accessSection: '\n' + dlp.accessRules.join('\n') + '\n',
  };
}

function generateSslSections(options: {
  port: number;
  sslBump?: boolean;
  caFiles?: SquidConfig['caFiles'];
  sslDbPath?: string;
  urlPatterns?: string[];
  domainsByProto: DomainsByProto;
  patternsByProto: PatternsByProto;
}): {
  portConfig: string;
  sslBumpSection: string;
  sslBumpUrlAccessSection: string;
} {
  const { port, sslBump, caFiles, sslDbPath, urlPatterns, domainsByProto, patternsByProto } = options;

  let sslBumpSection = '';
  let sslBumpUrlAccessSection = '';
  let portConfig = `http_port ${port}\nhttp_port [::]:${port}`;

  const hasPlainDomainsForSslBump = domainsByProto.both.length > 0;
  const hasPatternsForSslBump = patternsByProto.both.length > 0;

  if (sslBump && caFiles && sslDbPath) {
    sslBumpSection = generateSslBumpSection(
      caFiles,
      sslDbPath,
      hasPlainDomainsForSslBump,
      hasPatternsForSslBump,
      urlPatterns
    );
    if (urlPatterns && urlPatterns.length > 0) {
      const urlAccessLines = urlPatterns
        .map((_, i) => `http_access allow allowed_url_${i}`)
        .join('\n');

      const denyNonMatching = hasPlainDomainsForSslBump
        ? 'http_access deny !CONNECT allowed_domains'
        : hasPatternsForSslBump
          ? 'http_access deny !CONNECT allowed_domains_regex'
          : '';

      sslBumpUrlAccessSection = `
# Allow HTTPS requests matching URL patterns
${urlAccessLines}

# Deny requests that don't match URL patterns
${denyNonMatching}
`;
    }
    portConfig = '';
  }

  return {
    portConfig,
    sslBumpSection,
    sslBumpUrlAccessSection,
  };
}

function generatePortAclsAndRules(
  enableHostAccess?: boolean,
  allowHostPorts?: string,
  apiProxyPorts?: number[]
): string {
  let portAclsSection = `# Port ACLs
acl SSL_ports port 443
acl Safe_ports port 80          # HTTP
acl Safe_ports port 443         # HTTPS`;

  if (enableHostAccess && allowHostPorts) {
    const ports = allowHostPorts.split(',').map(p => p.trim());
    for (const port of ports) {
      const sanitizedPort = validateAndSanitizeHostAccessPort(port);
      portAclsSection += `\nacl Safe_ports port ${sanitizedPort}      # User-specified via --allow-host-ports`;
    }
  }

  portAclsSection += `\nacl CONNECT method CONNECT`;

  if (apiProxyPorts && apiProxyPorts.length > 0) {
    for (const proxyPort of apiProxyPorts) {
      validateApiProxyPort(proxyPort);
      portAclsSection += `\nacl Safe_ports port ${proxyPort}     # AWF api-proxy sidecar`;
    }
  }

  return `${portAclsSection}

# Access rules
# Deny unsafe ports (only allow Safe_ports defined above)
http_access deny !Safe_ports
# Allow CONNECT to Safe_ports instead of just SSL_ports (443)
# This is required because some HTTP clients (e.g., Node.js fetch) use CONNECT
# method even for HTTP connections when going through a proxy.
# See: gh-aw-firewall issue #189
http_access deny CONNECT !Safe_ports`;
}

function generateApiProxySection(apiProxyIp?: string): string {
  return apiProxyIp ? `
# Allow connections to the AWF api-proxy sidecar before raw-IP deny rules.
# Some HTTP clients (e.g., Node.js fetch / undici ProxyAgent) route requests to
# the api-proxy via HTTP_PROXY without honouring NO_PROXY for raw IP addresses,
# causing them to arrive at Squid and be rejected by the raw-IP deny rule below.
# This allow rule fires first for the known api-proxy IP.
acl allow_api_proxy_ip dst ${apiProxyIp}
http_access allow allow_api_proxy_ip

# Allow the api-proxy sidecar unrestricted outbound through Squid.
# The sidecar must reach upstream API endpoints (e.g. api.anthropic.com for
# WIF/OIDC token exchange) that may not be in the agent's allow-list.
# The api-proxy is a trusted AWF component (not the agent threat model).
acl from_api_proxy src ${apiProxyIp}/32
http_access allow from_api_proxy
` : '';
}

const IPV4_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * Generate allow rules for trusted topology-peer hostnames in network-isolation
 * (topology) mode.
 *
 * Docker-internal peers such as an MCP gateway (`awmg-mcpg`) are typically
 * served on non-standard ports (e.g. 8080). The normal domain allowlist cannot
 * reach them because `http_access deny !Safe_ports` (80/443) fires first. These
 * peers are operator-attached and trusted (the same trust level as the direct
 * NO_PROXY connection), so we emit an explicit `http_access allow` per peer
 * *before* the Safe_ports and raw-IP deny rules, permitting any port.
 *
 * Scoped by dstdomain to the exact peer hostnames, so this does not widen access
 * to arbitrary internet destinations.
 */
function generateTopologyPeersSection(topologyPeers?: string[]): string {
  if (!topologyPeers || topologyPeers.length === 0) return '';

  const lines = [
    '# Allow trusted topology peers (network-isolation mode) on any port before',
    '# the Safe_ports and raw-IP deny rules. These are operator-attached',
    '# containers (e.g. an MCP gateway) served on non-standard ports; clients',
    '# that honour HTTP(S)_PROXY but ignore NO_PROXY reach them through Squid.',
  ];
  for (const peer of topologyPeers) {
    const aclName = `topology_peer_${peer.replace(/[^a-zA-Z0-9]/g, '_')}`;
    lines.push(`acl ${aclName} dstdomain ${formatDomainForSquid(peer)}`);
    lines.push(`http_access allow ${aclName}`);
  }
  return lines.join('\n') + '\n\n';
}

/**
 * Generate allow rules for raw IP addresses that appear in the allowed domains list.
 *
 * Squid's raw-IP deny rules (`http_access deny dst_ipv4/dst_ipv6`) block all
 * requests to IP addresses to prevent bypassing domain-based filtering.  However,
 * when the operator explicitly whitelists an IP (e.g. `172.30.0.1` for the MCP
 * gateway), those requests must be allowed.  This function emits `dst`-based
 * allow rules that fire *before* the blanket raw-IP deny.
 */
function generateAllowedIpSection(domains: string[]): string {
  const ips = domains.filter(d => IPV4_REGEX.test(d));
  if (ips.length === 0) return '';

  const lines = [
    '# Allow explicitly whitelisted IP addresses before raw-IP deny rules.',
    '# When an operator adds a raw IP to --allow-domains (e.g. for the MCP gateway),',
    '# it must be allowed through before the blanket dst_ipv4/dst_ipv6 deny.',
  ];
  for (const ip of ips) {
    lines.push(`acl allow_ip_${ip.replace(/\./g, '_')} dst ${ip}`);
    lines.push(`http_access allow allow_ip_${ip.replace(/\./g, '_')}`);
  }
  return lines.join('\n') + '\n';
}

function generateDnsSection(dnsServers?: string[]): string {
  return `dns_nameservers ${(dnsServers && dnsServers.length > 0) ? dnsServers.join(' ') : DEFAULT_DNS_SERVERS.join(' ')}`;
}

function generateConfigSections(options: {
  enableDlp?: boolean;
  port: number;
  sslBump?: boolean;
  caFiles?: SquidConfig['caFiles'];
  sslDbPath?: string;
  urlPatterns?: string[];
  domains?: string[];
  domainsByProto: DomainsByProto;
  patternsByProto: PatternsByProto;
  enableHostAccess?: boolean;
  allowHostPorts?: string;
  apiProxyPorts?: number[];
  apiProxyIp?: string;
  dnsServers?: string[];
  topologyPeers?: string[];
}): {
  dlpAclSection: string;
  dlpAccessSection: string;
  portConfig: string;
  sslBumpSection: string;
  sslBumpUrlAccessSection: string;
  portAclsAndRules: string;
  apiProxySection: string;
  allowedIpSection: string;
  dnsSection: string;
  topologyPeersSection: string;
} {
  const {
    enableDlp,
    port,
    sslBump,
    caFiles,
    sslDbPath,
    urlPatterns,
    domains,
    domainsByProto,
    patternsByProto,
    enableHostAccess,
    allowHostPorts,
    apiProxyPorts,
    apiProxyIp,
    dnsServers,
    topologyPeers,
  } = options;

  const { aclSection: dlpAclSection, accessSection: dlpAccessSection } = generateDlpSections(enableDlp);
  const { portConfig, sslBumpSection, sslBumpUrlAccessSection } = generateSslSections({
    port,
    sslBump,
    caFiles,
    sslDbPath,
    urlPatterns,
    domainsByProto,
    patternsByProto,
  });
  const portAclsAndRules = generatePortAclsAndRules(enableHostAccess, allowHostPorts, apiProxyPorts);
  const apiProxySection = generateApiProxySection(apiProxyIp);
  const allowedIpSection = generateAllowedIpSection(domains ?? []);
  const topologyPeersSection = generateTopologyPeersSection(topologyPeers);
  const dnsSection = generateDnsSection(dnsServers);

  return {
    dlpAclSection,
    dlpAccessSection,
    portConfig,
    sslBumpSection,
    sslBumpUrlAccessSection,
    portAclsAndRules,
    apiProxySection,
    allowedIpSection,
    dnsSection,
    topologyPeersSection,
  };
}

export { generateConfigSections as buildConfigSections };
