import { isIP } from 'net';
import type { SquidConfig } from '../types';
import { validateApiProxyPort } from './validation';

function destinationAcl(name: string, hostname: string, allowIp: boolean): string {
  const address = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(address);
  if (allowIp && family) return `acl ${name} dst ${address}/${family === 4 ? 32 : 128}`;
  if (family || hostname.length > 253 || !hostname.split('.').every(label =>
    label.length > 0 && label.length <= 63 && !/[^a-z\d-]/i.test(label) &&
    !label.startsWith('-') && !label.endsWith('-')
  )) {
    throw new Error('SECURITY: API proxy upstream must be an exact DNS hostname');
  }
  // -n prevents reverse DNS from turning raw-IP requests into hostname matches.
  const escapedHostname = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `acl ${name} dstdom_regex -i -n ^${escapedHostname}$`;
}

export function generateApiProxyUpstreamSection(
  config: SquidConfig,
  blockedAccessRules: string[]
): string {
  if (!config.apiProxyIp) return '';
  const endpoints = [
    ...(config.apiProxyUpstreams ?? []).map(endpoint => ({ ...endpoint, broker: false })),
    ...(config.apiProxyBrokerUpstreams ?? []).map(endpoint => ({ ...endpoint, broker: true })),
  ];
  if (!endpoints.length) return '';

  const lines = [
    '# Exact custom-port upstreams for the trusted API proxy only.',
    `acl api_upstream_source src ${config.apiProxyIp}/32`,
    ...(config.apiProxyBrokerUpstreams?.length ? ['acl api_broker_connect method CONNECT'] : []),
  ];
  const guards = blockedAccessRules.map(rule => `!${rule.split(' ').pop()}`).join(' ');
  for (const [index, endpoint] of endpoints.entries()) {
    if (!endpoint.broker && (endpoint.port === 80 || endpoint.port === 443)) continue;
    validateApiProxyPort(endpoint.port);
    const hostname = endpoint.hostname.replace(/\.$/, '');
    const acl = `api_upstream_${index}`;
    lines.push(destinationAcl(`${acl}_host`, hostname, endpoint.broker));
    lines.push(`acl ${acl}_port port ${endpoint.port}`);
    for (const rule of blockedAccessRules) {
      const blockedAcl = rule.split(' ').pop();
      if (blockedAcl) {
        lines.push(`http_access deny api_upstream_source ${acl}_host ${acl}_port ${blockedAcl}`);
      }
    }
    if (config.enableDlp) {
      lines.push(`http_access deny api_upstream_source ${acl}_host ${acl}_port dlp_blocked`);
    }
    lines.push(
      `http_access allow api_upstream_source ${endpoint.broker ? 'api_broker_connect ' : ''}${acl}_host ${acl}_port${guards ? ` ${guards}` : ''}${config.enableDlp ? ' !dlp_blocked' : ''}`
    );
  }
  return lines.length > 2 ? lines.join('\n') + '\n\n' : '';
}

export function generateApiProxyBrokerSpliceSection(config: SquidConfig): string {
  if (!config.apiProxyIp || !config.apiProxyBrokerUpstreams?.length) return '';
  const lines = [
    '# Keep trusted broker authentication encrypted, before any TLS inspection.',
    `acl api_broker_tls_source src ${config.apiProxyIp}/32`,
  ];
  for (const [index, endpoint] of config.apiProxyBrokerUpstreams.entries()) {
    validateApiProxyPort(endpoint.port);
    lines.push(
      destinationAcl(`api_broker_tls_${index}_host`, endpoint.hostname, true),
      `acl api_broker_tls_${index}_port port ${endpoint.port}`,
      `ssl_bump splice api_broker_tls_source api_broker_tls_${index}_host api_broker_tls_${index}_port`,
    );
  }
  return lines.join('\n') + '\n\n';
}

export function generateApiProxyBrokerLogSection(config: SquidConfig): { acls: string; exclusions: string } {
  if (!config.apiProxyIp) return { acls: '', exclusions: '' };
  const lines: string[] = [];
  const exclusions: string[] = [];
  for (const [index, endpoint] of (config.apiProxyBrokerUpstreams ?? []).entries()) {
    if (!isIP(endpoint.hostname.replace(/^\[|\]$/g, ''))) continue;
    validateApiProxyPort(endpoint.port);
    const name = `api_broker_log_${index}`;
    lines.push(
      `acl ${name}_source src ${config.apiProxyIp}/32`,
      destinationAcl(`${name}_destination`, endpoint.hostname, true),
      `acl ${name}_port port ${endpoint.port}`,
      `acl ${name}_private all-of ${name}_source ${name}_destination ${name}_port`,
    );
    exclusions.push(`!${name}_private`);
  }
  return { acls: lines.join('\n'), exclusions: exclusions.join(' ') };
}
