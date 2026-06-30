import { SslConfig } from '../../host-env';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';
import { applyHostPathPrefixToVolumes } from '../host-path-prefix';
import { buildCredentialHidingOverlays } from './credential-hiding';
import { buildDockerSocketMount } from './docker-socket';
import { buildEtcMounts } from './etc-mounts';
import { buildHomeMounts } from './home-strategy';
import { generateHostsFileMount } from './hosts-file';
import { buildSslMounts } from './ssl-mounts';
import { buildSystemMounts } from './system-mounts';
import { buildCustomVolumeMounts, buildWorkspaceMounts } from './workspace-mounts';

interface AgentVolumesParams {
  config: WrapperConfig;
  sslConfig?: SslConfig;
  projectRoot: string;
  effectiveHome: string;
  workspaceDir: string;
  agentLogsPath: string;
  sessionStatePath: string;
  initSignalDir: string;
}

export function buildAgentVolumes(params: AgentVolumesParams): string[] {
  const { config, sslConfig, projectRoot, effectiveHome, workspaceDir, agentLogsPath, sessionStatePath, initSignalDir } = params;

  const agentVolumes: string[] = [];
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
  agentVolumes.push(...buildHomeMounts({ config, effectiveHome, agentLogsPath, sessionStatePath }));
  agentVolumes.push(...buildEtcMounts(config));
  // When sysroot-stage is active, the sysroot volume provides /etc/hosts.
  // The generated chroot hosts file lives on the runner's /tmp which the
  // Docker daemon cannot see on split-fs. DNS pre-resolution is skipped;
  // the agent resolves domains at runtime via the container's DNS config.
  if (!useSysroot) {
    agentVolumes.push(generateHostsFileMount(config));
  }
  agentVolumes.push(...buildDockerSocketMount(config));
  agentVolumes.push(...buildSslMounts(sslConfig));
  agentVolumes.push(...buildCustomVolumeMounts(config.volumeMounts));

  logger.debug('Using selective mounting for security (credential files hidden)');

  agentVolumes.push(...buildCredentialHidingOverlays(effectiveHome));

  if (config.dockerHostPathPrefix) {
    return applyHostPathPrefixToVolumes(agentVolumes, config.dockerHostPathPrefix);
  }

  return agentVolumes;
}
