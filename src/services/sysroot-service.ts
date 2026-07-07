import { WrapperConfig } from '../types';
import { logger } from '../logger';
import { ParsedImageTag, buildRuntimeImageRef, parseImageTag } from '../image-tag';

/**
 * Default sysroot image when runner.topology is 'arc-dind' and no explicit
 * sysrootImage is configured.
 */
function defaultSysrootImage(registry: string, parsedTag: ParsedImageTag): string {
  return buildRuntimeImageRef(registry, 'build-tools', parsedTag);
}

interface SysrootServiceParams {
  config: WrapperConfig;
  registry: string;
  parsedTag: ParsedImageTag;
}

/**
 * Builds the sysroot-stage init service for ARC/DinD deployments.
 *
 * This service runs once before the agent starts: it copies the build-tools
 * image's filesystem (compilers, linkers, dev libraries) into a named volume
 * that the agent then mounts read-only at /host.
 *
 * The copy uses `cp -a` to preserve permissions, symlinks, and timestamps.
 * /lib64 is conditionally copied (exists on amd64, not on arm64).
 */
export function buildSysrootStageService(params: SysrootServiceParams): any {
  const { config, registry, parsedTag } = params;
  const image = config.sysrootImage || defaultSysrootImage(registry, parsedTag);

  logger.info(`ARC/DinD: sysroot-stage will use image ${image}`);

  return {
    container_name: 'awf-sysroot-stage',
    image,
    volumes: ['sysroot:/sysroot'],
    entrypoint: ['/bin/sh', '-c'],
    command: [
      'set -eu; ' +
      'if [ -f /sysroot/.awf-sysroot-ready ]; then ' +
      '  echo "Sysroot volume already populated, skipping copy"; ' +
      '  exit 0; ' +
      'fi; ' +
      'echo "Copying sysroot filesystem..."; ' +
      'for d in usr lib bin sbin etc; do ' +
      // Use $$ to escape Docker Compose variable interpolation — Compose
      // treats bare $d as a variable reference and replaces it with "".
      '  [ -d "/$$d" ] && cp -a "/$$d" /sysroot/; ' +
      'done; ' +
      'if [ -d /lib64 ]; then cp -a /lib64 /sysroot/; fi; ' +
      'touch /sysroot/.awf-sysroot-ready; ' +
      'echo "Sysroot copy complete"',
    ],
    network_mode: 'none',
  };
}

/**
 * Returns true when the config indicates ARC/DinD topology with sysroot
 * staging enabled.
 */
export function isSysrootEnabled(config: WrapperConfig): boolean {
  return config.runnerTopology === 'arc-dind';
}

/**
 * Resolves the effective sysroot image reference for diagnostics/logging.
 */
export function resolveSysrootImage(config: WrapperConfig): string | undefined {
  if (!isSysrootEnabled(config)) return undefined;
  const registry = config.imageRegistry || 'ghcr.io/github/gh-aw-firewall';
  if (config.sysrootImage) return config.sysrootImage;
  const parsedTag = parseImageTag(config.imageTag || 'latest');
  return buildRuntimeImageRef(registry, 'build-tools', parsedTag);
}
