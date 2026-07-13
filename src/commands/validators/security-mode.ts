import { WrapperConfig } from '../../types';
import { logger } from '../../logger';

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

  // Force network-isolation on
  if (!config.networkIsolation) {
    if (config.networkIsolation === false) {
      // Explicitly set to false via CLI or config — warn and override
      logger.warn(
        '⚠️  network.isolation: false was ignored (incompatible with --security-mode strict, the default).\n' +
        '   Pass --security-mode compat to disable network isolation.',
      );
    }
    config.networkIsolation = true;
  }

  // Force api-proxy on
  if (!config.enableApiProxy) {
    if (config.enableApiProxy === false) {
      logger.warn(
        '⚠️  --enable-api-proxy: false was ignored (incompatible with --security-mode strict, the default).\n' +
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
