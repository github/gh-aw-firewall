import { isIP } from 'net';
import type { SquidConfig } from '../types';
import { validateApiProxyPort } from './validation';

export function generateApiProxyUpstreamSection(
  config: SquidConfig,
  blockedAccessRules: string[]
): string {
  if (!config.apiProxyIp || !config.apiProxyUpstreams?.length) return '';

  const lines = [
    '# Exact custom-port upstreams for the trusted API proxy only.',
    `acl api_upstream_source src ${config.apiProxyIp}/32`,
  ];
  const guards = blockedAccessRules.map(rule => `!${rule.split(' ').pop()}`).join(' ');
  for (const [index, endpoint] of config.apiProxyUpstreams.entries()) {
    if (endpoint.port === 80 || endpoint.port === 443) continue;
    validateApiProxyPort(endpoint.port);
    const hostname = endpoint.hostname.replace(/\.$/, '');
    if (isIP(hostname) || hostname.length > 253 || !hostname.split('.').every(label =>
      label.length > 0 && label.length <= 63 && !/[^a-z\d-]/i.test(label) &&
      !label.startsWith('-') && !label.endsWith('-')
    )) {
      throw new Error('SECURITY: API proxy upstream must be an exact DNS hostname');
    }
    const acl = `api_upstream_${index}`;
    // -n prevents reverse DNS from turning raw-IP requests into hostname matches.
    const escapedHostname = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    lines.push(`acl ${acl}_host dstdom_regex -i -n ^${escapedHostname}$`);
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
      `http_access allow api_upstream_source ${acl}_host ${acl}_port${guards ? ` ${guards}` : ''}${config.enableDlp ? ' !dlp_blocked' : ''}`
    );
  }
  return lines.length > 2 ? lines.join('\n') + '\n\n' : '';
}
