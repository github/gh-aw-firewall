import { isIP } from 'net';
import type { SquidConfig } from '../types';
import { parseDomainConfig } from './domain-acl';
import { generateApiProxyBrokerLogSection } from './api-proxy-upstreams';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: AWF_VERSION } = require('../../package.json') as { version: string };

export function buildLoggingSection(config: SquidConfig): string {
  const { domainsByProto: sensitiveDomainsByProto } = parseDomainConfig(
    (config.sensitiveDomains ?? []).filter(domain => !isIP(domain.replace(/^\[|\]$/g, ''))),
  );
  const brokerLogSection = generateApiProxyBrokerLogSection(config);
  const sensitiveLogAcl = [
    ...sensitiveDomainsByProto.http,
    ...sensitiveDomainsByProto.https,
    ...sensitiveDomainsByProto.both,
  ].map((domain) => `.${domain.replace(/^\./, '')}`);
  const sensitiveLogAclSection = sensitiveLogAcl.length > 0
    ? `acl sensitive_log_domains dstdomain ${sensitiveLogAcl.join(' ')}`
    : '';

  return `# Custom log format with detailed connection information
# Format: timestamp client_ip:port dest_domain dest_ip:port protocol method status decision url user_agent
# Note: For CONNECT requests (HTTPS), the domain is in the URL field
logformat firewall_detailed %ts.%03tu %>a:%>p %{Host}>h %<a:%<p %rv %rm %>Hs %Ss:%Sh %ru "%{User-Agent}>h"

# Structured JSONL audit log for machine-readable analysis
# Note: Squid logformat does not JSON-escape strings, so fields like User-Agent
# could break JSON parsing. We omit User-Agent to reduce breakage risk.
logformat audit_jsonl {"_schema":"audit/v${AWF_VERSION}","timestamp":"%{%Y-%m-%dT%H:%M:%S}tg.%03tuZ","event":"http_access","client":"%>a","host":"%{Host}>h","dest":"%<a:%<p","method":"%rm","status":%>Hs,"decision":"%Ss","url":"%ru"}

# Access log and cache configuration
# Keep logs readable by the host runner for post-run redaction.
umask 022
# Don't log healthcheck probes from localhost (using ACL filter on access_log)
acl healthcheck_localhost src 127.0.0.1 ::1
${sensitiveLogAclSection}
${brokerLogSection.acls}
access_log /var/log/squid/access.log firewall_detailed !healthcheck_localhost ${sensitiveLogAcl.length > 0 ? '!sensitive_log_domains' : ''} ${brokerLogSection.exclusions}
access_log /var/log/squid/audit.jsonl audit_jsonl !healthcheck_localhost ${sensitiveLogAcl.length > 0 ? '!sensitive_log_domains' : ''} ${brokerLogSection.exclusions}
cache_log /var/log/squid/cache.log
cache deny all`;
}
