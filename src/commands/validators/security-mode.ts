import { WrapperConfig } from '../../types';
import { logger } from '../../logger';
import { runtimeUsesComposeAgent } from '../../container-runtime';

/**
 * Applies security-mode enforcement to the assembled config.
 *
 * In strict mode (the default), incompatible options are overridden with
 * warnings and bundled defaults (network-isolation, api-proxy) are forced on.
 *
 * In compat mode, the legacy iptables-based configuration is preserved and
 * no overrides are applied.
 *
 * Must be called **after** `buildConfig()` assembles the raw config from CLI
 * options and config file, but **before** the downstream validators that
 * check for mutual exclusions (since strict mode resolves those conflicts).
 */
export function applySecurityMode(config: WrapperConfig): void {
  const mode = config.securityMode ?? 'strict';

  if (mode === 'compat') {
    logger.info('Running in compat security mode (legacy iptables-based enforcement).');
    return;
  }

  // --- strict mode (default) ---

  // MicroVM runtimes (e.g. sbx) enforce isolation at the hypervisor layer via
  // DOCKER_SANDBOXES_PROXY; Docker network topology does not apply to them.
  const isMicroVmRuntime = !runtimeUsesComposeAgent(config.containerRuntime);

  if (!isMicroVmRuntime) {
    // Force network-isolation on.
    // Only warn when explicitly disabled (=== false); undefined means "not set by user".
    if (!config.networkIsolation) {
      if (config.networkIsolation === false) {
        logger.warn(
          '⚠️  --no-network-isolation was ignored (incompatible with --security-mode strict, the default).\n' +
          '   Pass --security-mode compat to disable network isolation.',
        );
      }
      config.networkIsolation = true;
    }
  }

  // Force api-proxy on.
  // Only warn when explicitly disabled (=== false); undefined means "not set by user".
  if (!config.enableApiProxy) {
    if (config.enableApiProxy === false) {
      logger.warn(
        '⚠️  --no-enable-api-proxy was ignored (incompatible with --security-mode strict, the default).\n' +
        '   Pass --security-mode compat to disable the API proxy.',
      );
    }
    config.enableApiProxy = true;
  }

  // Override incompatible options
  if (config.enableHostAccess) {
    logger.warn(
      '⚠️  --enable-host-access was ignored (incompatible with --security-mode strict, the default).\n' +
      '   Pass --security-mode compat to enable host access.',
    );
    config.enableHostAccess = false;
    // Also clear allowHostServicePorts: it auto-enables host access in
    // applyHostServicePortsConfig() which runs later in the validator pipeline.
    if (config.allowHostServicePorts) {
      logger.warn(
        '⚠️  --allow-host-service-ports was ignored (incompatible with --security-mode strict, the default).\n' +
        '   Pass --security-mode compat to use host service ports.',
      );
      config.allowHostServicePorts = undefined;
    }
    // Clear allowHostPorts that may have been auto-set by localhost keyword
    if (config.allowHostPorts) {
      config.allowHostPorts = undefined;
    }
  }

  // Similarly, allowHostServicePorts alone (without enableHostAccess) would
  // auto-enable host access downstream — suppress it in strict mode.
  if (config.allowHostServicePorts) {
    logger.warn(
      '⚠️  --allow-host-service-ports was ignored (incompatible with --security-mode strict, the default).\n' +
      '   Pass --security-mode compat to use host service ports.',
    );
    config.allowHostServicePorts = undefined;
  }

  if (config.enableDind) {
    logger.warn(
      '⚠️  --enable-dind was ignored (incompatible with --security-mode strict, the default).\n' +
      '   Pass --security-mode compat to enable Docker-in-Docker.',
    );
    config.enableDind = false;
  }

  if (config.dnsOverHttps) {
    logger.warn(
      '⚠️  --dns-over-https was ignored (incompatible with --security-mode strict, the default).\n' +
      '   Pass --security-mode compat to use DNS-over-HTTPS.',
    );
    config.dnsOverHttps = undefined;
  }
}
