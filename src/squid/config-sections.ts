import type { SquidConfig } from '../types';
import { generateDlpSquidConfig } from '../dlp';
import { DEFAULT_DNS_SERVERS } from '../dns-resolver';
import { generateSslBumpSection } from './ssl-bump';
import { validateAndSanitizeHostAccessPort, validateApiProxyPort } from './validation';

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
  domainsByProto: DomainsByProto;
  patternsByProto: PatternsByProto;
  enableHostAccess?: boolean;
  allowHostPorts?: string;
  apiProxyPorts?: number[];
  apiProxyIp?: string;
  dnsServers?: string[];
}): {
  dlpAclSection: string;
  dlpAccessSection: string;
  portConfig: string;
  sslBumpSection: string;
  sslBumpUrlAccessSection: string;
  portAclsAndRules: string;
  apiProxySection: string;
  dnsSection: string;
} {
  const {
    enableDlp,
    port,
    sslBump,
    caFiles,
    sslDbPath,
    urlPatterns,
    domainsByProto,
    patternsByProto,
    enableHostAccess,
    allowHostPorts,
    apiProxyPorts,
    apiProxyIp,
    dnsServers,
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
  const dnsSection = generateDnsSection(dnsServers);

  return {
    dlpAclSection,
    dlpAccessSection,
    portConfig,
    sslBumpSection,
    sslBumpUrlAccessSection,
    portAclsAndRules,
    apiProxySection,
    dnsSection,
  };
}

export { generateConfigSections as buildConfigSections };
