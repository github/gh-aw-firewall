import * as fs from 'fs';
import * as path from 'path';
import { WrapperConfig, DockerComposeConfig } from './types';
import { logger } from './logger';
import { generatePolicyManifest } from './squid-config';
import { resolveTopologyPeerHosts } from './topology-peers';
import { SQUID_PORT } from './host-env';
import { redactDockerComposeSecrets } from './compose-generator';
import { renderDockerCompose } from './compose-renderer';
import { collectResolvedRuntimeImages } from './image-resolver';
import { deriveSensitiveEndpointForms, redactSensitiveValues } from './redact-secrets';
import { writeFileNoFollow } from './fs-utils';
import {
  createSensitivePathAudit,
  dockerSensitivePathTargets,
  resolveSensitivePaths,
} from './sensitive-paths';
import { writeSensitivePathAudit } from './sensitive-path-audit';
import { resolveApiProxyUpstreams } from './services/api-proxy-env-config';
import { copilotBrokerSensitiveValues, resolveCopilotBrokerUpstreams } from './copilot-token-broker';
import type { NetworkConfig } from './services/squid-service';

/**
 * Phase 7 — Writes audit artifacts to the audit directory.
 *
 * Artifacts are world-readable snapshots that contain no secrets:
 * - `squid.conf`                  — domain ACLs and proxy config
 * - `docker-compose.redacted.yml` — compose file with secrets stripped
 * - `policy-manifest.json`        — structured firewall policy description
 *
 * World-readable so the gh-aw post-run audit step (running as the non-root
 * runner user) can stat/read them even if AWF cleanup is interrupted.
 */
export function writeAuditArtifacts(
  config: WrapperConfig,
  networkConfig: NetworkConfig,
  dockerCompose: DockerComposeConfig,
  squidConfig: string,
  squidDnsServers?: string[]
): void {
  const auditDir = config.auditDir || path.join(config.workDir, 'audit');
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o755 });
  const auditDirLstat = fs.lstatSync(auditDir);
  if (auditDirLstat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink as directory: ${auditDir}`);
  }
  const auditDirStat = fs.statSync(auditDir);
  if (!auditDirStat.isDirectory()) {
    throw new Error(`Expected directory but found non-directory path: ${auditDir}`);
  }
  fs.chmodSync(auditDir, 0o755);

  // Secret-derived endpoints (e.g. an OpenAI base URL supplied through
  // `apiProxy.targets.openai.baseUrlEnv`) must never appear in audit artifacts,
  // so redact their URL/host/host:port forms from the snapshots below.
  const sensitiveEndpointForms = [
    ...deriveSensitiveEndpointForms(config.sensitiveAllowedDomains),
    ...copilotBrokerSensitiveValues(config),
  ];

  // Save squid.conf for audit (domain ACLs and proxy config, sensitive hosts redacted)
  writeAuditArtifact(
    auditDir,
    'squid.conf',
    redactSensitiveValues(squidConfig, sensitiveEndpointForms)
  );

  // Save a default-redacted snapshot, leaving runtime config intact.
  const redactedCompose = redactDockerComposeSecrets(dockerCompose);
  writeAuditArtifact(
    auditDir,
    'docker-compose.redacted.yml',
    renderDockerCompose(redactedCompose)
  );

  // Effective infrastructure images, recorded centrally by the image resolver
  // so consumers that never appear in Compose (e.g. DinD staging) are included.
  writeAuditArtifact(
    auditDir,
    'image-manifest.json',
    JSON.stringify(collectResolvedRuntimeImages(config), null, 2),
  );

  // Generate and save policy manifest (structured description of all firewall rules)
  const policyManifest = generatePolicyManifest({
    domains: config.allowedDomains,
    blockedDomains: config.blockedDomains,
    port: SQUID_PORT,
    sslBump: config.sslBump,
    enableHostAccess: config.enableHostAccess,
    allowHostPorts: config.allowHostPorts,
    enableDlp: config.enableDlp,
    dnsServers: squidDnsServers ?? config.dnsServers,
    ...(config.enableApiProxy && networkConfig.proxyIp ? {
      apiProxyIp: networkConfig.proxyIp,
      apiProxyUpstreams: resolveApiProxyUpstreams(config),
      apiProxyBrokerUpstreams: resolveCopilotBrokerUpstreams(config),
    } : {}),
    // Include topology peer allow rules so the audit log correctly attributes
    // allowed connections to topology-attached containers (e.g. awmg-mcpg:8080)
    // rather than misidentifying them as "unknown" or blocked.
    topologyPeers: resolveTopologyPeerHosts(config),
    // Effective awf-net subnet (relocated by --network-subnet when set), so
    // log analysis classifies denied in-subnet IPs as AWF-internal rather
    // than external blocked domains.
    networkSubnet: networkConfig.subnet,
  });
  writeAuditArtifact(
    auditDir,
    'policy-manifest.json',
    redactSensitiveValues(JSON.stringify(policyManifest, null, 2), sensitiveEndpointForms)
  );

  if (config.nvx) {
    const deferredPaths = resolveSensitivePaths('nvx').map(({ id, path: sensitivePath, reason }) => ({
      id,
      path: sensitivePath,
      reason,
    }));
    writeSensitivePathAudit(auditDir, {
      ...createSensitivePathAudit('nvx', []),
      enforcement: 'deferred',
      deferredPaths,
    });
  } else if (!config.cloudHypervisor) {
    const maskedPaths = resolveSensitivePaths('docker', { workDir: config.workDir }).map((entry) => ({
      id: entry.id,
      path: entry.path,
      reason: entry.reason,
      targets: dockerSensitivePathTargets(entry.path),
    }));
    writeSensitivePathAudit(auditDir, createSensitivePathAudit('docker', maskedPaths));
  }

  logger.debug(`Audit artifacts written to: ${auditDir}`);
}

function writeAuditArtifact(auditDir: string, filename: string, contents: string): void {
  const artifactPath = path.join(auditDir, filename);
  writeFileNoFollow(artifactPath, contents, 0o644);
}
