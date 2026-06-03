import { type FlagValidationResult } from '../types';

/**
 * Validates that --allow-host-ports is only used with --enable-host-access
 */
export function validateAllowHostPorts(
  allowHostPorts: string | undefined,
  enableHostAccess: boolean | undefined
): FlagValidationResult {
  if (allowHostPorts && !enableHostAccess) {
    return {
      valid: false,
      error: '--allow-host-ports requires --enable-host-access to be set',
    };
  }
  return { valid: true };
}

/**
 * Validates --allow-host-service-ports values.
 * Ports must be numeric and in the range 1-65535.
 * Unlike --allow-host-ports, dangerous ports are intentionally allowed because
 * these ports are restricted to the host gateway IP only (not the internet).
 * Returns an object indicating whether host access should be auto-enabled.
 */
function validateAllowHostServicePorts(
  allowHostServicePorts: string | undefined,
  enableHostAccess: boolean | undefined
): FlagValidationResult & { autoEnableHostAccess?: boolean } {
  if (!allowHostServicePorts) {
    return { valid: true };
  }

  const servicePorts = allowHostServicePorts.split(',').map(p => p.trim());
  for (const port of servicePorts) {
    if (!/^\d+$/.test(port)) {
      return {
        valid: false,
        error: `Invalid port in --allow-host-service-ports: ${port}. Must be a numeric value`,
      };
    }
    const portNum = parseInt(port, 10);
    if (portNum < 1 || portNum > 65535) {
      return {
        valid: false,
        error: `Invalid port in --allow-host-service-ports: ${port}. Must be a number between 1 and 65535`,
      };
    }
  }

  return {
    valid: true,
    autoEnableHostAccess: !enableHostAccess,
  };
}

/**
 * Applies --allow-host-service-ports validation and config mutations.
 */
export function applyHostServicePortsConfig(
  allowHostServicePorts: string | undefined,
  enableHostAccess: boolean | undefined,
  log: { warn: (msg: string) => void; info: (msg: string) => void }
): { valid: true; enableHostAccess: boolean | undefined } | { valid: false; error: string } {
  const validation = validateAllowHostServicePorts(allowHostServicePorts, enableHostAccess);
  if (!validation.valid) {
    return { valid: false, error: validation.error! };
  }

  if (allowHostServicePorts) {
    log.warn('--allow-host-service-ports bypasses dangerous port restrictions for host-local traffic.');
    log.warn('Ensure host services on these ports do not provide external network access.');

    if (validation.autoEnableHostAccess) {
      log.warn('--allow-host-service-ports automatically enabling host access (ports 80/443 to host gateway also opened)');
      enableHostAccess = true;
    }
    log.info(`Host service ports allowed (host gateway only): ${allowHostServicePorts}`);
  }

  return { valid: true, enableHostAccess };
}
