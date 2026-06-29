import { WrapperConfig } from '../types';
import { ImageBuildConfig } from './squid-service';

export const DEFAULT_SYSROOT_IMAGE = 'ghcr.io/github/gh-aw-firewall/build-tools:latest';

export function isSysrootTopologyEnabled(config: WrapperConfig): boolean {
  return config.runnerTopology === 'arc-dind';
}

export function resolveSysrootImage(config: WrapperConfig, imageConfig: ImageBuildConfig): string {
  if (config.runnerSysrootImage) {
    return config.runnerSysrootImage;
  }
  return `${imageConfig.registry}/build-tools:${imageConfig.parsedTag.tag}`;
}

export function buildSysrootStageService(config: WrapperConfig, imageConfig: ImageBuildConfig): any {
  return {
    image: resolveSysrootImage(config, imageConfig),
    volumes: ['sysroot:/sysroot'],
    command: [
      '/bin/bash',
      '-lc',
      "set -euo pipefail; rm -rf /sysroot/.awf-tmp; mkdir -p /sysroot/.awf-tmp; tar -C / --exclude='./sysroot' -cf - . | tar -C /sysroot -xf -",
    ],
    restart: 'no',
  };
}
