import type { SquidConfig } from '../types';
import { assertSafeForSquidConfig } from './domain-acl';

export function buildOtlpAclSections(otlpEndpoints: SquidConfig['otlpEndpoints']): {
  aclLines: string[];
  accessRules: string;
} {
  const aclLines = (otlpEndpoints ?? []).flatMap((endpoint, index) => [
    `acl otlp_endpoint_${index}_host dstdomain ${assertSafeForSquidConfig(endpoint.hostname)}`,
    `acl otlp_endpoint_${index}_port port ${endpoint.port}`,
  ]);
  if (aclLines.length > 0) {
    aclLines.unshift('', '# Exact host and port ACLs for configured OTLP collectors');
  }
  const accessRules = (otlpEndpoints ?? []).map((endpoint, index) =>
    `http_access allow ${endpoint.protocol === 'http' ? '!CONNECT ' : 'CONNECT '}otlp_endpoint_${index}_host otlp_endpoint_${index}_port`
  ).join('\n');

  return { aclLines, accessRules };
}
