import { SslConfig } from '../../host-env';
import { getSafeHostGid, getSafeHostUid } from '../../host-env';
import { getRealUserHome } from '../../host-identity';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';
import { FOUNDRY_ENV } from '../../api-proxy-env-constants';
import { readEnvFile } from '../../github-env';
import { applyHostPathPrefixToVolumes } from '../host-path-prefix';
import { buildCredentialHidingOverlays, pruneUnmountableCredentialOverlays } from './credential-hiding';
import { buildExposedHomeSecretOverlays } from './exposed-home-secrets';
import { createLocalSourceResolver, parseMount } from './mount-topology';
import { ensureNestedMountpoints } from './nested-mountpoints';
import { buildDockerSocketMount } from './docker-socket';
import { buildEtcMounts } from './etc-mounts';
import { buildHomeMounts } from './home-strategy';
import { generateHostsFileMount } from './hosts-file';
import { buildSslMounts } from './ssl-mounts';
import { buildSystemMounts } from './system-mounts';
import { buildCustomVolumeMounts, buildTemporaryHandoffMounts, buildWorkspaceMounts } from './workspace-mounts';
import { applyFilesystemWritePolicy, resolveComposeFilesystemAllowWrite } from './filesystem-write-policy';
import type { LocalSourceResolver } from './mount-topology';
import type { NestedMountpointOptions } from './nested-mountpoints';

interface AgentVolumesParams {
  config: WrapperConfig;
  internalServiceHosts?: Record<string, string>;
  sslConfig?: SslConfig;
  projectRoot: string;
  effectiveHome: string;
  workspaceDir: string;
  agentLogsPath: string;
  sessionStatePath: string;
  initSignalDir: string;
  pathExists?: (candidate: string) => boolean;
  prepareNestedMountpoints?: (
    volumes: string[],
    uid: number,
    gid: number,
    localSourceResolver: LocalSourceResolver,
    options?: NestedMountpointOptions,
  ) => string[];
  additionalMounts?: string[];
  nestedMountpointOptions?: NestedMountpointOptions;
  filterVolumes?: (volumes: string[]) => string[];
}

export function buildAgentVolumes(params: AgentVolumesParams): string[] {
  const {
    config,
    internalServiceHosts,
    sslConfig,
    projectRoot,
    effectiveHome,
    workspaceDir,
    agentLogsPath,
    sessionStatePath,
    initSignalDir,
  } = params;

  let agentVolumes: string[] = [];
  agentVolumes.push(...(params.additionalMounts ?? []));
  agentVolumes.push(...buildWorkspaceMounts({
    config,
    projectRoot,
    effectiveHome,
    workspaceDir,
    agentLogsPath,
    sessionStatePath,
    initSignalDir,
  }));

  logger.debug('Using selective path mounts for security');

  const useSysroot = config.runnerTopology === 'arc-dind';
  agentVolumes.push(...buildSystemMounts(workspaceDir, config.chrootBinariesSourcePath, useSysroot));
  agentVolumes.push(...buildHomeMounts({
    config, effectiveHome, agentLogsPath, sessionStatePath, pathExists: params.pathExists,
  }));
  agentVolumes.push(...buildEtcMounts(config, params.pathExists));
  // When sysroot-stage is active, the sysroot volume provides /etc/hosts.
  // The generated chroot hosts file lives on the runner's /tmp which the
  // Docker daemon cannot see on split-fs. DNS pre-resolution is skipped;
  // the agent resolves domains at runtime via the container's DNS config.
  if (!useSysroot) {
    agentVolumes.push(generateHostsFileMount(config, internalServiceHosts));
  }
  agentVolumes.push(...buildDockerSocketMount(config));
  agentVolumes.push(...buildSslMounts(sslConfig));
  const alwaysWritableMounts = new Set(agentVolumes.filter((spec) =>
    spec.startsWith(`${agentLogsPath}:`) ||
    spec.startsWith(`${sessionStatePath}:`) ||
    spec.startsWith(`${initSignalDir}:`) ||
    spec === '/dev/null:/host/dev/null:rw'
  ));
  const customMounts = buildCustomVolumeMounts(config.volumeMounts, config.dockerHostPathPrefix);
  // Explicit handoffs may replace an automatic mount (notably /tmp/gh-aw on
  // ARC/DinD). Docker rejects duplicate destinations, so retain the override.
  const customTargets = new Set(customMounts.map((spec) => parseMount(spec)?.target).filter(Boolean));
  agentVolumes = agentVolumes.filter((spec) => !customTargets.has(parseMount(spec)?.target));
  agentVolumes.push(...customMounts);

  logger.debug('Using selective mounting for security (credential files hidden)');

  const localCustomMounts = buildCustomVolumeMounts(config.volumeMounts, undefined, { quiet: true });
  const localSourceRoots = new Map([
    ...buildTemporaryHandoffMounts(config.dockerHostPathPrefix)
      .map((spec): [string, string] => [spec, '/tmp/gh-aw']),
    ...customMounts.map((spec, index): [string, string] =>
      [spec, localCustomMounts[index]?.split(':')[0] ?? '']),
  ]);
  // The same provenance is needed by credential masking and topology passes,
  // not just write policy: automatic handoffs are already daemon-translated too.
  const runnerSourceRoots = new Map(
    [...localSourceRoots].map(([spec, localRoot]) => [
      spec.split(':')[0] ?? '', localRoot,
    ]),
  );
  const localSourceResolver = createLocalSourceResolver(runnerSourceRoots, config.dockerHostPathPrefix);
  const envFileValues = config.enableApiProxy && config.envFile ? readEnvFile(config.envFile) : {};
  const foundryEnvFile = [FOUNDRY_ENV.KEY, FOUNDRY_ENV.ENTRA_TOKEN]
    .some((key) => Object.prototype.hasOwnProperty.call(envFileValues, key))
    ? config.envFile
    : undefined;
  const credentialOverlays = buildCredentialHidingOverlays(
    effectiveHome, agentVolumes, localSourceResolver, process.env, foundryEnvFile,
  );
  const runnerHome = getRealUserHome();
  credentialOverlays.push(...buildExposedHomeSecretOverlays(
    [effectiveHome, runnerHome], agentVolumes, localSourceResolver, sessionStatePath,
    config.homeDir !== undefined && runnerHome !== effectiveHome ? runnerHome : undefined,
  ));
  const credentialTargets = new Set(credentialOverlays.map((spec) => parseMount(spec)?.target));
  const maskedVolumes = agentVolumes.filter((spec) => !credentialTargets.has(parseMount(spec)?.target));
  maskedVolumes.push(...new Set(credentialOverlays));

  const policyVolumes = applyFilesystemWritePolicy(
    maskedVolumes,
    resolveComposeFilesystemAllowWrite(config),
    alwaysWritableMounts,
    localSourceRoots,
  );
  const volumeFilter = params.filterVolumes;
  const filterBeforePruning = volumeFilter !== undefined;
  const topologyVolumes = filterBeforePruning
    ? volumeFilter(applyHostPathPrefixToVolumes(policyVolumes, config.dockerHostPathPrefix))
    : policyVolumes;
  const prunedVolumes = pruneUnmountableCredentialOverlays(topologyVolumes, localSourceResolver);

  // A read-only bind cannot host a mountpoint runc still has to create, so any
  // internal mount nested inside one must exist up front. Derived from the final
  // topology, so mounts added later are covered without another targeted fix.
  (params.prepareNestedMountpoints ?? ensureNestedMountpoints)(
    prunedVolumes,
    parseInt(getSafeHostUid(), 10),
    parseInt(getSafeHostGid(), 10),
    localSourceResolver,
    params.nestedMountpointOptions,
  );

  return filterBeforePruning
    ? prunedVolumes
    : applyHostPathPrefixToVolumes(prunedVolumes, config.dockerHostPathPrefix);
}
