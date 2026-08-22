import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import execa from 'execa';
import { WrapperConfig, API_PROXY_PORTS, DockerComposeConfig } from './types';
import { logger } from './logger';
import { generatePolicyManifest, generateSquidConfig } from './squid-config';
import { resolveTopologyPeerHosts } from './topology-peers';
import { generateSessionCa, initSslDb, isOpenSslAvailable } from './ssl-bump';
import { parseUrlPatterns } from './domain-matchers';
import { SslConfig, SQUID_PORT } from './host-env';
import { generateDockerCompose, redactDockerComposeSecrets } from './compose-generator';
import { collectResolvedRuntimeImages } from './image-resolver';
import { deriveSensitiveEndpointForms, redactSensitiveValues } from './redact-secrets';
import { resolveLogPaths } from './log-paths';
import { DEFAULT_DNS_SERVERS, filterForNetworkIsolation } from './dns-resolver';
import { getSafeHostGid, getSafeHostUid, isNativeRootWithoutSudo } from './host-identity';
import {
  AGENT_IP,
  API_PROXY_IP,
  CLI_PROXY_IP,
  DOH_PROXY_IP,
  NETWORK_SUBNET,
  SQUID_IP,
} from './host-iptables-shared';
import { prepareWorkDirectories } from './workdir-setup';

// When bundled with esbuild, this global is replaced at build time with the
// JSON content of containers/agent/seccomp-profile.json.  In normal (tsc)
// builds the identifier remains undeclared, so the typeof check below is safe.
declare const __AWF_SECCOMP_PROFILE__: string | undefined;

/**
 * Produces a human-readable diagnostic string explaining why EACCES occurred.
 * Walks the path hierarchy to identify which ancestor is not writable/searchable.
 * Returns the diagnostic string and the identified blocking path (if found).
 */
function diagnoseEacces(targetDir: string): { diagnosis: string; blockerPath: string | null } {
  const resolvedTarget = path.resolve(targetDir);
  let current = resolvedTarget;
  const lines: string[] = [];
  let blockerPath: string | null = null;

  // Walk up to find the blocking directory
  while (current !== path.dirname(current)) {
    if (fs.existsSync(current)) {
      try {
        const stat = fs.statSync(current);
        const writable = isWritable(current);
        lines.push(
          `  ${current}: uid=${stat.uid} gid=${stat.gid} mode=${(stat.mode & 0o7777).toString(8)} writable=${writable}`
        );
        if (!writable) {
          blockerPath = current;
          lines.push(`  └─ BLOCKED HERE: current process (uid=${process.getuid?.() ?? '?'}) cannot write to this directory`);
          break;
        }
      } catch {
        lines.push(`  ${current}: (cannot stat)`);
        break;
      }
    }
    current = path.dirname(current);
  }

  const diagnosis = lines.length > 0
    ? `Path diagnosis:\n${lines.join('\n')}`
    : `Path diagnosis: could not determine blocking ancestor`;
  return { diagnosis, blockerPath };
}

function isWritable(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively transfers ownership of `targetPath` without ever dereferencing a
 * symbolic link.
 *
 * Delegates to coreutils `chown`, whose recursive mode performs a physical
 * (`-P`) descriptor-relative traversal. Re-implementing the walk in JavaScript
 * would be racy: Node exposes no `openat`/`fchownat`, so every recursion step
 * has to re-resolve a pathname that a process running as the target uid can
 * swap for a symlink between the check and the chown.
 */
function chownTreeWithoutFollowingSymlink(targetPath: string, uid: number, gid: number): void {
  // Built from numbers validated by the caller; passed as a single argv entry.
  const ownerSpec = [uid, gid].join(':');
  const result = execa.sync(
    'chown',
    // -h: act on symlinks themselves, -P: never traverse symlinks, -R: recurse,
    // --: stop option parsing so paths are never interpreted as flags.
    ['-h', '-P', '-R', '--', ownerSpec, targetPath],
    { reject: false }
  );

  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.exitCode}`;
    throw new Error(detail);
  }
}

/**
 * Resolves the sandbox identity used inside the agent container, or null when
 * it is not a usable unprivileged identity.
 */
function resolveSandboxIdentity(): { uid: number; gid: number } | null {
  const uid = Number.parseInt(getSafeHostUid(), 10);
  const gid = Number.parseInt(getSafeHostGid(), 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid <= 0) {
    return null;
  }
  return { uid, gid };
}

/**
 * Transfers ownership of a host path to the sandbox identity, logging (rather
 * than throwing) when the repair cannot be completed.
 */
function repairPathOwnership(targetPath: string, uid: number, gid: number): void {
  try {
    chownTreeWithoutFollowingSymlink(targetPath, uid, gid);
    logger.debug(`Transferred ${targetPath} ownership to sandbox user (${uid}:${gid}) before container launch`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to transfer ${targetPath} ownership to sandbox user (${uid}:${gid}): ${message}`);
  }
}

function repairRunnerTempGhAwOwnership(): void {
  if (process.getuid?.() !== 0) {
    return;
  }

  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp || !path.isAbsolute(runnerTemp)) {
    return;
  }

  const ghAwRoot = path.join(runnerTemp, 'gh-aw');
  if (!fs.existsSync(ghAwRoot)) {
    return;
  }

  const identity = resolveSandboxIdentity();
  if (!identity) {
    logger.warn(`Skipping ${ghAwRoot} ownership repair because the sandbox identity is invalid`);
    return;
  }

  repairPathOwnership(ghAwRoot, identity.uid, identity.gid);
}

/**
 * Reports whether the sandbox identity can create entries in `targetDir`.
 *
 * The host process usually runs as root, which bypasses permission checks, so
 * `fs.accessSync` cannot answer this question. The mode bits are inspected
 * directly instead: the sandbox identity has no supplementary groups inside the
 * container, so owner/group/other is the complete picture.
 */
function isDirectoryWritableByIdentity(targetDir: string, uid: number, gid: number): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetDir);
  } catch {
    return false;
  }

  if (!stat.isDirectory()) {
    return false;
  }

  // Write + search permission are both required to create entries in a directory.
  if (stat.uid === uid) {
    return (stat.mode & 0o300) === 0o300;
  }
  if (stat.gid === gid) {
    return (stat.mode & 0o030) === 0o030;
  }
  return (stat.mode & 0o003) === 0o003;
}

/**
 * Repairs ownership of the host workspace mount and verifies the sandbox
 * identity can write to it.
 *
 * On native-root runners (root with no `SUDO_UID`, e.g. AWS CodeBuild-hosted
 * runners) the checkout is root-owned while the agent runs as the fallback
 * sandbox identity, so the workdir is writable by mount but not by ownership.
 * Without this repair the agent silently fails to write and the job reports a
 * false green.
 */
function repairContainerWorkDirOwnership(config: WrapperConfig): void {
  const containerWorkDir = config.containerWorkDir;
  if (!containerWorkDir || !path.isAbsolute(containerWorkDir)) {
    return;
  }

  if (!isNativeRootWithoutSudo()) {
    return;
  }

  const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
  if (!path.isAbsolute(workspaceDir)) {
    return;
  }

  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  const normalizedContainerWorkDir = path.resolve(containerWorkDir);
  const relativeWorkDir = path.relative(normalizedWorkspaceDir, normalizedContainerWorkDir);
  const workDirUsesWorkspaceMount =
    relativeWorkDir === '' ||
    (relativeWorkDir !== '..' &&
      !relativeWorkDir.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeWorkDir));
  if (!workDirUsesWorkspaceMount) {
    return;
  }

  if (!fs.existsSync(normalizedWorkspaceDir)) {
    return;
  }

  const canonicalWorkspaceDir = fs.realpathSync(normalizedWorkspaceDir);
  if (canonicalWorkspaceDir === path.parse(canonicalWorkspaceDir).root) {
    throw new Error(`Refusing to repair ownership of filesystem root: ${canonicalWorkspaceDir}`);
  }

  const identity = resolveSandboxIdentity();
  if (!identity) {
    logger.warn(`Skipping ${canonicalWorkspaceDir} ownership repair because the sandbox identity is invalid`);
    return;
  }

  repairPathOwnership(canonicalWorkspaceDir, identity.uid, identity.gid);

  if (!isDirectoryWritableByIdentity(canonicalWorkspaceDir, identity.uid, identity.gid)) {
    throw new Error(
      `Host workspace is not writable by the sandbox identity ` +
      `(${identity.uid}:${identity.gid}): ${canonicalWorkspaceDir}\n` +
      `AWF is running as root without SUDO_UID, so it attempted to transfer ` +
      `ownership of the host workspace to the sandbox identity, but the ` +
      `workspace is still not writable.\n` +
      `The agent would start and exit successfully without being able to write ` +
      `any files, so AWF is failing early instead.\n` +
      `  Suggested fix: chown -R ${identity.uid}:${identity.gid} ${canonicalWorkspaceDir} before invoking AWF.`
    );
  }
}

/** Resolved network topology passed between setup phases. */
interface NetworkConfig {
  subnet: string;
  squidIp: string;
  agentIp: string;
  proxyIp?: string;
  dohProxyIp?: string;
  cliProxyIp?: string;
}

/**
 * Phase 1 — Validates and hardens the work directory.
 *
 * Creates the directory with restrictive `0o700` permissions, guards against
 * symlink injection, and re-applies the permission mask on pre-existing dirs.
 * Security-critical: docker-compose.yml (which contains plaintext secrets) is
 * written here, so non-root host processes must not be able to read it.
 */
function validateAndPrepareWorkDir(config: WrapperConfig): void {
  // Ensure work directory exists with restricted permissions (owner-only access)
  // Defense-in-depth: even if tmpfs overlay fails, non-root processes on the host
  // cannot read the docker-compose.yml which contains sensitive tokens
  try {
    const workDirCreated = Boolean(
      fs.mkdirSync(config.workDir, { recursive: true, mode: 0o700 })
    );
    const workDirLstat = fs.lstatSync(config.workDir);
    if (workDirLstat.isSymbolicLink()) {
      throw new Error(`Refusing to use symlink as directory: ${config.workDir}`);
    }
    const workDirStat = fs.statSync(config.workDir);
    if (!workDirStat.isDirectory()) {
      throw new Error(`Expected directory but found non-directory path: ${config.workDir}`);
    }
    if (!workDirCreated) {
      fs.chmodSync(config.workDir, 0o700);
    }
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EACCES') {
      const { diagnosis, blockerPath } = diagnoseEacces(config.workDir);
      const suggestedPath = blockerPath ?? config.workDir;
      throw new Error(
        `EACCES: cannot create work directory: ${config.workDir}\n` +
        `${diagnosis}\n` +
        `This typically happens on persistent runners when a previous AWF run ` +
        `left directories owned by root. The calling process (e.g., gh-aw setup) ` +
        `must remove or chown the stale directory before invoking AWF.\n` +
        `  Suggested fix: sudo rm -rf ${suggestedPath} && mkdir -p ${suggestedPath}`
      );
    }
    throw error;
  }
}

/**
 * Phase 3 — Copies the seccomp profile into the work directory.
 *
 * Uses a three-path fallback strategy:
 * 1. Embedded profile (esbuild bundle — `__AWF_SECCOMP_PROFILE__` global)
 * 2. Source tree path: `<root>/containers/agent/seccomp-profile.json`
 * 3. Dist tree path:   `<root>/dist/../containers/agent/seccomp-profile.json`
 *
 * Throws if no profile is found — the container cannot start safely without it.
 */
function copySeccompProfile(config: WrapperConfig): void {
  const seccompDestPath = path.join(config.workDir, 'seccomp-profile.json');

  // Try embedded profile first (available in esbuild bundle)
  if (typeof __AWF_SECCOMP_PROFILE__ !== 'undefined') {
    fs.writeFileSync(seccompDestPath, __AWF_SECCOMP_PROFILE__);
    logger.debug(`Seccomp profile written from embedded data to: ${seccompDestPath}`);
    return;
  }

  const seccompSourcePath = path.join(__dirname, '..', 'containers', 'agent', 'seccomp-profile.json');
  if (fs.existsSync(seccompSourcePath)) {
    fs.copyFileSync(seccompSourcePath, seccompDestPath);
    logger.debug(`Seccomp profile written to: ${seccompDestPath}`);
    return;
  }

  // If running from dist, try relative to dist
  const altSeccompPath = path.join(__dirname, '..', '..', 'containers', 'agent', 'seccomp-profile.json');
  if (fs.existsSync(altSeccompPath)) {
    fs.copyFileSync(altSeccompPath, seccompDestPath);
    logger.debug(`Seccomp profile written to: ${seccompDestPath}`);
    return;
  }

  const message = `Seccomp profile not found at ${seccompSourcePath} or ${altSeccompPath}. Container security hardening requires the seccomp profile.`;
  logger.error(message);
  throw new Error(message);
}

/**
 * Phase 4 — Initialises SSL Bump if enabled.
 *
 * Generates a per-session CA certificate and an SSL database for Squid's
 * SSL-Bump intercept mode. Returns `undefined` when SSL Bump is disabled.
 * Security-critical: the generated CA can sign arbitrary certificates for
 * intercepted HTTPS connections.
 */
async function initializeSslBump(config: WrapperConfig): Promise<SslConfig | undefined> {
  if (!config.sslBump) {
    return undefined;
  }

  logger.info('SSL Bump enabled - generating per-session CA certificate...');
  try {
    if (!(await isOpenSslAvailable())) {
      throw new Error('openssl is not available on this system');
    }
    const caFiles = await generateSessionCa({ workDir: config.workDir });
    const sslDbPath = await initSslDb(config.workDir);
    const sslConfig: SslConfig = { caFiles, sslDbPath };
    logger.info('SSL Bump CA certificate generated successfully');
    logger.warn('⚠️  SSL Bump mode: HTTPS traffic will be intercepted for URL inspection');
    logger.warn('   A per-session CA certificate has been generated (valid for 1 day)');
    return sslConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to generate SSL Bump CA: ${message}`);
    throw new Error(`SSL Bump initialization failed: ${message}`);
  }
}

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
function writeAuditArtifacts(
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
  const sensitiveEndpointForms = deriveSensitiveEndpointForms(config.sensitiveAllowedDomains);

  // Save squid.conf for audit (domain ACLs and proxy config, sensitive hosts redacted)
  writeAuditArtifact(
    auditDir,
    'squid.conf',
    redactSensitiveValues(squidConfig, sensitiveEndpointForms)
  );

  // Save redacted docker-compose.yml (strip env vars that may contain secrets)
  const redactedCompose = redactDockerComposeSecrets(dockerCompose, sensitiveEndpointForms);
  writeAuditArtifact(
    auditDir,
    'docker-compose.redacted.yml',
    yaml.dump(redactedCompose, { lineWidth: -1 })
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
    } : {}),
    // Include topology peer allow rules so the audit log correctly attributes
    // allowed connections to topology-attached containers (e.g. awmg-mcpg:8080)
    // rather than misidentifying them as "unknown" or blocked.
    topologyPeers: resolveTopologyPeerHosts(config),
  });
  writeAuditArtifact(
    auditDir,
    'policy-manifest.json',
    JSON.stringify(policyManifest, null, 2)
  );

  logger.debug(`Audit artifacts written to: ${auditDir}`);
}

function writeAuditArtifact(auditDir: string, filename: string, contents: string): void {
  const artifactPath = path.join(auditDir, filename);
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_TRUNC |
    (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number | undefined;

  try {
    // Create privately and refuse a symlink target. Existing artifacts are
    // tightened before truncation so readers cannot observe partial content.
    fd = fs.openSync(artifactPath, flags, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, contents, { encoding: 'utf8' });
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o644);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/**
 * Writes all configuration files to disk.
 *
 * Orchestrates the seven sequential setup phases:
 * 1. Work-directory security hardening ({@link validateAndPrepareWorkDir})
 * 2. Log-path resolution and directory preparation
 * 3. Seccomp profile copy ({@link copySeccompProfile})
 * 4. SSL-Bump initialisation ({@link initializeSslBump})
 * 5. Squid ACL config generation and write
 * 6. Docker Compose generation and write
 * 7. Audit artifact writing ({@link writeAuditArtifacts})
 *
 * Uses fixed network configuration defined in host-iptables-shared.ts
 */
export async function writeConfigs(config: WrapperConfig): Promise<void> {
  logger.debug('Writing configuration files...');

  // Phase 1: Work-directory security hardening
  validateAndPrepareWorkDir(config);

  // Phase 2: Log-path resolution and directory preparation
  const logPaths = resolveLogPaths(config);
  prepareWorkDirectories(config, logPaths);
  repairRunnerTempGhAwOwnership();
  repairContainerWorkDirOwnership(config);

  // Use fixed network configuration (network is created by host-iptables.ts)
  const networkConfig: NetworkConfig = {
    subnet: NETWORK_SUBNET,
    squidIp: SQUID_IP,
    agentIp: AGENT_IP,
    proxyIp: API_PROXY_IP,  // Envoy API proxy sidecar
    dohProxyIp: DOH_PROXY_IP,  // DoH proxy sidecar
    cliProxyIp: CLI_PROXY_IP,  // CLI proxy sidecar
  };
  logger.debug(`Using network config: ${networkConfig.subnet} (squid: ${networkConfig.squidIp}, agent: ${networkConfig.agentIp}, api-proxy: ${networkConfig.proxyIp})`);

  // Phase 3: Seccomp profile copy (security-critical)
  copySeccompProfile(config);

  // Phase 4: SSL-Bump initialisation (security-critical)
  const sslConfig = await initializeSslBump(config);

  // Phase 5: Squid ACL config generation and write (security-critical)
  // Transform user URL patterns to regex patterns for Squid ACLs
  let urlPatterns: string[] | undefined;
  if (config.allowedUrls && config.allowedUrls.length > 0) {
    urlPatterns = parseUrlPatterns(config.allowedUrls);
    logger.debug(`Parsed ${urlPatterns.length} URL pattern(s) for SSL Bump filtering`);
  }

  // In network-isolation (topology) mode, preserve auto-detected DNS resolvers
  // as operator-controlled runner network settings. Enterprise and cloud
  // resolvers may be private or virtual-network-specific, and replacing them
  // with public defaults can break environments where public DNS is blocked.
  // Explicitly-specified servers are also trusted as-is.
  const resolvedDnsServers = config.dnsServers ?? DEFAULT_DNS_SERVERS;
  const squidDnsServers = config.networkIsolation && !config.dnsServersExplicit
    ? await filterForNetworkIsolation(resolvedDnsServers, logger)
    : resolvedDnsServers;

  // Note: Use container path for SSL database since it's mounted at /var/spool/squid_ssl_db
  const squidConfig = generateSquidConfig({
    // Combine non-sensitive and sensitive (secret-derived) domains so Squid allows
    // all necessary egress without exposing the sensitive hostnames in logs or
    // the audit artifact (where only config.allowedDomains is serialised).
    domains: [...config.allowedDomains, ...(config.sensitiveAllowedDomains ?? [])],
    sensitiveDomains: config.sensitiveAllowedDomains,
    blockedDomains: config.blockedDomains,
    port: SQUID_PORT,
    sslBump: config.sslBump,
    caFiles: sslConfig?.caFiles,
    sslDbPath: sslConfig ? '/var/spool/squid_ssl_db' : undefined,
    urlPatterns,
    enableHostAccess: config.enableHostAccess,
    allowHostPorts: config.allowHostPorts,
    enableDlp: config.enableDlp,
    dnsServers: squidDnsServers,
    upstreamProxy: config.upstreamProxy,
    // Allow the api-proxy sidecar IP through Squid before the raw-IP deny rule.
    // Some HTTP clients (e.g., Node.js fetch / undici ProxyAgent) route requests
    // to the api-proxy via HTTP_PROXY without honouring NO_PROXY for raw IPs.
    ...(config.enableApiProxy && networkConfig.proxyIp ? {
      apiProxyIp: networkConfig.proxyIp,
      apiProxyPorts: Object.values(API_PROXY_PORTS),
    } : {}),
    ...(config.difcProxyHost && networkConfig.cliProxyIp ? {
      cliProxyIp: networkConfig.cliProxyIp,
    } : {}),
    // Allow trusted topology peers (MCP gateway, DIFC/cli-proxy) on any port in
    // network-isolation mode, for proxy clients that ignore NO_PROXY. DNS for
    // these Docker-only names is provided via the squid-proxy extra_hosts patch
    // (see patchComposeWithTopologyHosts in topology.ts).
    topologyPeers: resolveTopologyPeerHosts(config),
  });
  const squidConfigPath = path.join(config.workDir, 'squid.conf');
  fs.writeFileSync(squidConfigPath, squidConfig, { mode: 0o644 });
  logger.debug(`Squid config written to: ${squidConfigPath}`);

  // Phase 6: Docker Compose generation and write
  // Uses mode 0o600 (owner-only read/write) because this file contains sensitive
  // environment variables (tokens, API keys) in plaintext
  const dockerCompose = generateDockerCompose(config, networkConfig, sslConfig, squidConfig);
  const dockerComposePath = path.join(config.workDir, 'docker-compose.yml');
  // lineWidth: -1 disables line wrapping to prevent base64-encoded values
  // (like AWF_SQUID_CONFIG_B64) from being split across multiple lines
  fs.writeFileSync(dockerComposePath, yaml.dump(dockerCompose, { lineWidth: -1 }), { mode: 0o600 });
  logger.debug(`Docker Compose config written to: ${dockerComposePath}`);

  // Phase 7: Audit artifact writing
  // These files contain no secrets (redacted compose, domain ACLs, policy rules)
  // and are made world-readable so the gh-aw post-run audit step (running as
  // non-root runner user) can stat/read them even if AWF cleanup is interrupted.
  writeAuditArtifacts(config, networkConfig, dockerCompose, squidConfig, squidDnsServers);
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const configWriterTestHelpers = {
  validateAndPrepareWorkDir,
  copySeccompProfile,
  initializeSslBump,
  writeAuditArtifacts,
};
