import { WrapperConfig } from '../../types';
import { logger } from '../../logger';
import {
  buildRateLimitConfig,
  validateRateLimitFlags,
  validateEnableTokenSteeringFlag,
  isLoopbackTcpDockerHostUri,
} from '../../option-parsers';

/**
 * Validates docker-host URI format, docker-host-path-prefix, and chroot
 * binaries source path.  Calls `process.exit(1)` on any failure.
 */
export function validateInfrastructureOptions(config: WrapperConfig): void {
  if (config.awfDockerHost &&
      !config.awfDockerHost.startsWith('unix://') &&
      !isLoopbackTcpDockerHostUri(config.awfDockerHost)) {
    logger.error(`❌ --docker-host must be a unix:// socket URI or a loopback TCP URI (tcp://localhost:PORT or tcp://127.0.0.1:PORT), got: ${config.awfDockerHost}`);
    logger.error('   Examples: --docker-host unix:///run/user/1000/docker.sock');
    logger.error('             --docker-host tcp://localhost:2375');
    process.exit(1);
  }
  if (config.dockerHostPathPrefix && !config.dockerHostPathPrefix.startsWith('/')) {
    logger.error(
      `❌ --docker-host-path-prefix must be an absolute path, got: ${config.dockerHostPathPrefix}`,
    );
    logger.error('   Example: --docker-host-path-prefix /host');
    process.exit(1);
  }
  if (config.chrootBinariesSourcePath && !config.chrootBinariesSourcePath.startsWith('/')) {
    logger.error(
      `❌ chroot.binariesSourcePath must be an absolute path, got: ${config.chrootBinariesSourcePath}`,
    );
    logger.error('   Example (stdin config): {"chroot":{"binariesSourcePath":"/tmp/gh-aw/runner-bin"}}');
    process.exit(1);
  }
  if (config.chrootBinariesSourcePath === '/') {
    logger.error('❌ chroot.binariesSourcePath cannot be "/"');
    logger.error('   Provide a specific binaries directory, for example /tmp/gh-aw/runner-bin');
    process.exit(1);
  }
  if (config.chrootBinariesSourcePath && /[:\n\r]/.test(config.chrootBinariesSourcePath)) {
    logger.error(
      `❌ chroot.binariesSourcePath must not contain ":" or newline characters, got: ${config.chrootBinariesSourcePath}`,
    );
    logger.error('   Example (stdin config): {"chroot":{"binariesSourcePath":"/tmp/gh-aw/runner-bin"}}');
    process.exit(1);
  }
}

/**
 * Builds and validates the rate-limit configuration when API proxy is enabled.
 * Also validates that rate-limit flags are not used without `--enable-api-proxy`.
 * Calls `process.exit(1)` on any failure.
 */
export function applyRateLimitConfig(config: WrapperConfig, options: Record<string, unknown>): void {
  if (config.enableApiProxy) {
    const rateLimitResult = buildRateLimitConfig(options);
    if ('error' in rateLimitResult) {
      logger.error(`❌ ${rateLimitResult.error}`);
      process.exit(1);
    }
    config.rateLimitConfig = rateLimitResult.config;
    logger.debug(
      `Rate limiting: enabled=${rateLimitResult.config.enabled}, rpm=${rateLimitResult.config.rpm}, rph=${rateLimitResult.config.rph}, bytesPm=${rateLimitResult.config.bytesPm}`,
    );
  }

  // Error if rate limit flags are used without --enable-api-proxy
  const rateLimitFlagValidation = validateRateLimitFlags(config.enableApiProxy ?? false, options);
  if (!rateLimitFlagValidation.valid) {
    logger.error(rateLimitFlagValidation.error!);
    process.exit(1);
  }
}

/**
 * Validates feature-flag compatibility constraints (token steering) and logs
 * environment-forwarding warnings.  Calls `process.exit(1)` on any failure.
 */
export function validateFeatureFlagCompatibility(config: WrapperConfig): void {
  // Error if --enable-token-steering is used without --enable-api-proxy
  const enableTokenSteeringValidation = validateEnableTokenSteeringFlag(
    config.enableApiProxy ?? false,
    config.enableTokenSteering ?? false,
  );
  if (!enableTokenSteeringValidation.valid) {
    logger.error(enableTokenSteeringValidation.error!);
    process.exit(1);
  }

  // Warn if --env-all is used
  if (config.envAll) {
    logger.warn('⚠️  Using --env-all: All host environment variables will be passed to container');
    logger.warn('   This may expose sensitive credentials if logs or configs are shared');
  }

  // Log --env-file usage
  if (config.envFile) {
    logger.debug(`Loading environment variables from file: ${config.envFile}`);
  }

  // Network-isolation (topology) mode: reject combinations that are not
  // supported because they depend on host-iptables or a sidecar that needs
  // direct external connectivity bypassing the dual-homed proxy.
  if (config.networkIsolation) {
    if (config.dnsOverHttps) {
      logger.error('❌ --network-isolation is not supported with --dns-over-https.');
      logger.error('   The DoH proxy needs direct external connectivity, which the internal network does not provide.');
      process.exit(1);
    }
    if (config.enableHostAccess) {
      logger.error('❌ --network-isolation is not supported with --enable-host-access.');
      logger.error('   Host access relies on host-level iptables, which network-isolation mode does not configure.');
      process.exit(1);
    }
  } else if (config.topologyAttach && config.topologyAttach.length > 0) {
    logger.error('❌ --topology-attach requires --network-isolation.');
    logger.error('   Trusted containers can only be attached to the internal topology network in network-isolation mode.');
    process.exit(1);
  }
}
