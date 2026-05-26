import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';
import {
  extractCommandBinaryName,
  shouldUseDockerHostStaging,
  stageHostFile,
} from './docker-host-staging';

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

  if (shouldUseDockerHostStaging(config.dockerHostPathPrefix)) {
    const commandExecutable = config.agentCommand.trim().split(/\s+/, 1)[0] || '';
    const binaryName = extractCommandBinaryName(config.agentCommand);
    const binarySourcePath = binaryName ? resolveBinaryPath(binaryName, commandExecutable) : undefined;
    if (binaryName && binarySourcePath) {
      const stagedBinaryPath = stageHostFile(config, binarySourcePath, `bin/${binaryName}`, 0o755);
      if (stagedBinaryPath) {
        mounts.push(`${stagedBinaryPath}:/tmp/awf-runner-bin/${binaryName}:ro`);
      }
    }
  }

  return mounts;
}

function resolveBinaryPath(binaryName: string, commandExecutable: string): string | undefined {
  if (!binaryName) {
    return undefined;
  }

  if (commandExecutable.includes('/') || commandExecutable.includes('\\')) {
    const candidate = path.resolve(commandExecutable);
    return isExecutableFile(candidate) ? candidate : undefined;
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, binaryName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
