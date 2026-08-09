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

  // Docker sbx enforces isolation through its hypervisor proxy and does not use
  // Docker topology. Firecracker is also a microVM, but explicitly attaches its
  // host-side veth to AWF's proven internal bridge, so topology remains required.
  const isMicroVmRuntime = !runtimeUsesComposeAgent(config.containerRuntime);

  if (isMicroVmRuntime && config.pidsLimit !== undefined) {
    logger.warn(
      '⚠️  --pids-limit/container.pidsLimit is not supported by this microVM runtime and will be ignored.\n' +
      '   The Docker agent cgroup cannot be passed through, so pids.max/pids.current are unavailable.',
    );
  }

  if (!isMicroVmRuntime || config.containerRuntime === 'firecracker') {
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

  // Override host access options that depend on host-level iptables.
  //
  // In network-isolation (topology) mode, the agent is on an internal Docker
  // network with no direct host route, so no iptables-based host access is
  // configured.  Instead, trusted services are reached via topology peers
  // (--topology-attach) attached to awf-net.  --enable-host-access in that
  // mode drives Squid port ACLs and the hosts-file entry for
  // host.docker.internal — both of which are compatible with strict security.
  //
  // NOTE: at this point in the pipeline, networkIsolation has already been
  // forced to true above (for non-microVM runtimes), so
  // !config.networkIsolation is false for standard Docker-compose runs.
  //
  // For microVM runtimes, networkIsolation does not imply topology routing
  // support (the compose agent is not used), so host access remains
  // incompatible and is still suppressed in strict mode.
  if (config.enableHostAccess && (isMicroVmRuntime || !config.networkIsolation)) {
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
  // auto-enable host access downstream via iptables — suppress it in strict
  // mode.  This applies even in network-isolation mode because
  // allowHostServicePorts is specifically for GitHub Actions services
  // containers accessed through host-gateway iptables rules, not topology
  // peers.
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
