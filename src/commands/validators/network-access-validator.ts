import { WrapperConfig } from '../../types';
import { logger } from '../../logger';
import {
  validateAllowHostPorts,
  applyHostServicePortsConfig,
  validateSkipPullWithBuildLocal,
} from '../../option-parsers';
import { NetworkOptionsResult } from './network-options';

/**
 * Validates host-access port rules and incompatible flag combinations.
 * Calls `process.exit(1)` on any failure.
 */
export function validateHostAccessConfig(
  config: WrapperConfig,
  networkOptions: NetworkOptionsResult,
): void {
  // Validate --allow-host-service-ports (port format & range)
  const servicePortsResult = applyHostServicePortsConfig(
    config.allowHostServicePorts,
    config.enableHostAccess,
    logger,
  );
  if (!servicePortsResult.valid) {
    logger.error(`❌ ${servicePortsResult.error}`);
    process.exit(1);
  }
  config.enableHostAccess = servicePortsResult.enableHostAccess;

  // Validate --allow-host-ports requires --enable-host-access
  const hostPortsValidation = validateAllowHostPorts(
    config.allowHostPorts,
    config.enableHostAccess,
  );
  if (!hostPortsValidation.valid) {
    logger.error(`❌ ${hostPortsValidation.error}`);
    process.exit(1);
  }

  // Error if --skip-pull is used with --build-local (incompatible flags)
  const skipPullValidation = validateSkipPullWithBuildLocal(config.skipPull, config.buildLocal);
  if (!skipPullValidation.valid) {
    logger.error(`❌ ${skipPullValidation.error}`);
    process.exit(1);
  }

  // Warn if --enable-host-access is used with host.docker.internal in allowed domains
  if (config.enableHostAccess) {
    const hasHostDomain = networkOptions.allowedDomains.some(
      (d) => d === 'host.docker.internal' || d.endsWith('.host.docker.internal'),
    );
    if (hasHostDomain) {
      logger.warn('⚠️  Host access enabled with host.docker.internal in allowed domains');
      logger.warn('   Containers can access ANY service running on the host machine');
      logger.warn('   Only use this for trusted workloads (e.g., MCP gateways)');
    }
  }
}
