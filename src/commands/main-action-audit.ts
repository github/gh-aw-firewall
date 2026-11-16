import { logger } from '../logger';
import { redactSecrets } from '../redact-secrets';
import {
  exportResolvedConfigPath,
  publishEarlyResolvedConfig,
} from '../resolved-config-artifact';
import { applyHostPathPrefixToVolumes, resolveRunnerMountPaths } from '../services/host-path-prefix';
import { buildCustomVolumeMounts } from '../services/agent-volumes/workspace-mounts';
import { buildCredentialHidingOverlays } from '../services/agent-volumes/credential-hiding';
import { createLocalSourceResolver } from '../services/agent-volumes/mount-topology';
import { filterAgentVolumesForSysroot } from '../services/optional-services';
import { getRealUserHome } from '../host-identity';
import { runtimeUsesComposeAgent } from '../container-runtime';
import type { WrapperConfig } from '../types';
import { COPILOT_BROKER_PRIVATE_ENV } from '../copilot-token-broker';

const SENSITIVE_CONFIG_KEYS = new Set([
  'openaiApiKey',
  'anthropicApiKey',
  'copilotGithubToken',
  'copilotProviderApiKey',
  'geminiApiKey',
  'googleApiKey',
  'githubToken',
  // Secret-derived allowlist entries must not appear in logs or the audit artifact.
  'sensitiveAllowedDomains',
]);

const resolvedConfigSnapshots = new WeakMap<WrapperConfig, string>();

export function getResolvedConfigSnapshot(config: WrapperConfig): string | undefined {
  return resolvedConfigSnapshots.get(config);
}

export function redactConfigForLogging(config: WrapperConfig): Record<string, unknown> {
  const redactedConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_CONFIG_KEYS.has(key)) continue;

    if (key === 'agentCommand') {
      redactedConfig[key] = redactSecrets(value as string);
      continue;
    }

    if (key === 'additionalEnv' && value && typeof value === 'object') {
      redactedConfig[key] = Object.fromEntries(
        Object.keys(value as Record<string, string>)
          .filter(envKey => !COPILOT_BROKER_PRIVATE_ENV.some(name => name === envKey))
          .map((envKey) => [envKey, '[REDACTED]']),
      );
      continue;
    }

    redactedConfig[key] = value;
  }
  return redactedConfig;
}

export function persistConfigAuditArtifact(
  config: WrapperConfig,
  redactedConfig: Record<string, unknown>,
): void {
  try {
    let runnerMountPaths: ReturnType<typeof resolveRunnerMountPaths> | undefined;
    if (config.runnerTopology === 'arc-dind') {
      const customMounts = applyHostPathPrefixToVolumes(
        buildCustomVolumeMounts(config.volumeMounts, config.dockerHostPathPrefix, { quiet: true }),
        config.dockerHostPathPrefix,
      );
      const retained = new Set(filterAgentVolumesForSysroot(customMounts, config, getRealUserHome()));
      const localCustomMounts = buildCustomVolumeMounts(config.volumeMounts, undefined, { quiet: true });
      const customSourceRoots = new Map(
        customMounts.map((spec, index) => [
          spec.split(':')[0] ?? '',
          localCustomMounts[index]?.split(':')[0] ?? '',
        ]),
      );
      let credentialOverlayTargets: string[];
      try {
        credentialOverlayTargets = buildCredentialHidingOverlays(
          getRealUserHome(),
          customMounts,
          createLocalSourceResolver(customSourceRoots, config.dockerHostPathPrefix),
        ).flatMap((spec) => {
          const parts = spec.split(':');
          return parts[0] === '/dev/null' && parts[1] ? [parts[1]] : [];
        });
      } catch {
        // If effective credential masks cannot be determined, do not publish
        // runner paths that might point through one.
        credentialOverlayTargets = customMounts.flatMap((spec) => {
          const target = spec.split(':')[1];
          return target ? [target] : [];
        });
      }
      const runnerBackedMounts = config.volumeMounts?.filter((_, index) => {
        const mount = customMounts[index];
        if (!retained.has(mount)) return false;
        const target = mount.split(':')[1];
        if (!target) return false;
        return !credentialOverlayTargets.some((overlayTarget) =>
          overlayTarget === target || overlayTarget.startsWith(`${target}/`) || target.startsWith(`${overlayTarget}/`)
        );
      });
      runnerMountPaths = resolveRunnerMountPaths(
        runnerBackedMounts,
        config.dockerHostPathPrefix,
      );
      if (runtimeUsesComposeAgent(config.containerRuntime)) {
        runnerMountPaths = runnerMountPaths.filter(({ sandboxPath }) => sandboxPath !== '/');
      }
    }
    const contents = JSON.stringify({
      ...redactedConfig,
      ...(runnerMountPaths !== undefined ? { runnerMountPaths } : {}),
    }, null, 2) + '\n';
    resolvedConfigSnapshots.set(config, contents);
    if (process.platform === 'linux' && process.geteuid?.() === 0) {
      const file = publishEarlyResolvedConfig(contents);
      exportResolvedConfigPath(file);
    }
  } catch (err) {
    logger.warn('Failed to publish resolved config artifact:', err);
  }
}
