import { WrapperConfig } from '../../types';
import { logger } from '../../logger';
import { runtimeUsesComposeAgent } from '../../container-runtime';

/**
 * Applies security enforcement to the assembled config.
 *
 * Default behavior (strict): incompatible options are overridden with
 * warnings and bundled defaults (network-isolation, api-proxy) are forced on.
 *
 * Legacy security (--legacy-security): the legacy iptables-based configuration
 * is preserved and no overrides are applied (except api-proxy, which is always on).
 *
 * Must be called **after** `buildConfig()` assembles the raw config from CLI
 * options and config file, but **before** the downstream validators that
 * check for mutual exclusions (since strict mode resolves those conflicts).
 */
export function applySecurityMode(config: WrapperConfig): void {
  // Handle deprecated --enable-api-proxy / --no-enable-api-proxy
  handleApiProxyDeprecation(config);

  const isLegacy = config.legacySecurity === true;

  if (isLegacy) {
    logger.info('Running in legacy security mode (iptables-based enforcement).');
    // API proxy is still always forced on in legacy mode
    config.enableApiProxy = true;
    return;
  }

  // --- strict security (default) ---

  // MicroVM runtimes (e.g. sbx) enforce isolation at the hypervisor layer via
  // DOCKER_SANDBOXES_PROXY; Docker network topology does not apply to them.
  const isMicroVmRuntime = !runtimeUsesComposeAgent(config.containerRuntime);

  if (!isMicroVmRuntime) {
    // Force network-isolation on.
    // Only warn when explicitly disabled (=== false); undefined means "not set by user".
    if (!config.networkIsolation) {
      if (config.networkIsolation === false) {
        logger.warn(
          '⚠️  --no-network-isolation was ignored (incompatible with strict security, the default).\n' +
          '   Pass --legacy-security to disable network isolation.',
        );
      }
      config.networkIsolation = true;
    }
  }

  // Force api-proxy on (always, regardless of flags).
  config.enableApiProxy = true;

  // Override incompatible options
  if (config.enableHostAccess) {
    logger.warn(
      '⚠️  --enable-host-access was ignored (incompatible with strict security, the default).\n' +
      '   Pass --legacy-security to enable host access.',
    );
    config.enableHostAccess = false;
    // Also clear allowHostServicePorts: it auto-enables host access in
    // applyHostServicePortsConfig() which runs later in the validator pipeline.
    if (config.allowHostServicePorts) {
      logger.warn(
        '⚠️  --allow-host-service-ports was ignored (incompatible with strict security, the default).\n' +
        '   Pass --legacy-security to use host service ports.',
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
      '⚠️  --allow-host-service-ports was ignored (incompatible with strict security, the default).\n' +
      '   Pass --legacy-security to use host service ports.',
    );
    config.allowHostServicePorts = undefined;
  }

  if (config.enableDind) {
    logger.warn(
      '⚠️  --enable-dind was ignored (incompatible with strict security, the default).\n' +
      '   Pass --legacy-security to enable Docker-in-Docker.',
    );
    config.enableDind = false;
  }

  if (config.dnsOverHttps) {
    logger.warn(
      '⚠️  --dns-over-https was ignored (incompatible with strict security, the default).\n' +
      '   Pass --legacy-security to use DNS-over-HTTPS.',
    );
    config.dnsOverHttps = undefined;
  }
}

/**
 * Handles the deprecated --enable-api-proxy / --no-enable-api-proxy flags.
 *
 * - --enable-api-proxy: emit deprecation warning, continue normally
 * - --no-enable-api-proxy: hard error (not allowed)
 */
function handleApiProxyDeprecation(config: WrapperConfig): void {
  if (config.enableApiProxy === false) {
    logger.error(
      '❌ --no-enable-api-proxy is not allowed. The API proxy is always enabled for credential isolation.',
    );
    logger.error(
      '   Remove the --no-enable-api-proxy flag from your command.',
    );
    process.exit(1);
  }
  if (config.enableApiProxy === true) {
    logger.warn(
      '⚠️  --enable-api-proxy is deprecated and no longer needed. The API proxy is always enabled.',
    );
  }
}
