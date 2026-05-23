import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';

interface WorkspaceMountsParams {
  config: WrapperConfig;
  projectRoot: string;
  effectiveHome: string;
  workspaceDir: string;
  agentLogsPath: string;
  sessionStatePath: string;
  initSignalDir: string;
}

export function buildWorkspaceMounts(params: WorkspaceMountsParams): string[] {
  const { config, projectRoot, effectiveHome, workspaceDir, agentLogsPath, sessionStatePath, initSignalDir } = params;

  const mounts: string[] = [
    '/tmp:/tmp:rw',
    `${workspaceDir}:${workspaceDir}:rw`,
    `${agentLogsPath}:${effectiveHome}/.copilot/logs:rw`,
    `${sessionStatePath}:${effectiveHome}/.copilot/session-state:rw`,
    `${initSignalDir}:/tmp/awf-init:rw`,
  ];

  if (config.enableApiProxy) {
    const healthCheckScript = path.resolve(projectRoot, 'containers/agent/api-proxy-health-check.sh');
    try {
      if (fs.statSync(healthCheckScript).isFile()) {
        mounts.push(`${healthCheckScript}:/usr/local/bin/api-proxy-health-check.sh:ro`);
      }
    } catch {
      // Optional mount — skip if the source file is unavailable.
    }
  }

  return mounts;
}

export function buildCustomVolumeMounts(volumeMounts?: string[]): string[] {
  if (!volumeMounts || volumeMounts.length === 0) {
    return [];
  }

  logger.debug(`Adding ${volumeMounts.length} custom volume mount(s)`);

  return volumeMounts.map(mount => {
    const parts = mount.split(':');
    if (parts.length >= 2) {
      const hostPath = parts[0];
      const containerPath = parts[1];
      const mode = parts[2] || '';
      const chrootContainerPath = `/host${containerPath}`;
      const transformedMount = mode
        ? `${hostPath}:${chrootContainerPath}:${mode}`
        : `${hostPath}:${chrootContainerPath}`;
      logger.debug(`Adding custom volume mount: ${mount} -> ${transformedMount} (chroot-adjusted)`);
      return transformedMount;
    }

    return mount;
  });
}
