import { WrapperConfig } from '../types';
import { validateLogAndLimits } from './validators/log-and-limits';
import { validateNetworkOptions } from './validators/network-options';
import { validateAgentOptions } from './validators/agent-options';
import { assembleAndValidateConfig } from './validators/config-assembly';

/**
 * Validates all CLI options and assembles the {@link WrapperConfig}.
 *
 * Delegates each concern to a focused sub-validator and then assembles the
 * final config.  The function calls `process.exit(1)` (via the sub-validators)
 * on any validation failure so the caller always receives a fully-validated,
 * ready-to-use config object.
 *
 * Sub-validators:
 *  - {@link validateLogAndLimits}   — log level, model multipliers, resource limits
 *  - {@link validateNetworkOptions} — Docker host, domain resolution, network config
 *  - {@link validateAgentOptions}   — env vars, volume mounts, SSL Bump URL patterns
 *  - {@link assembleAndValidateConfig} — config assembly + post-config assertions
 *
 * @param options     Raw Commander options object (already mutated by
 *                    {@link applyConfigFilePrecedence} when a --config file is present).
 * @param agentCommand Shell command string to run inside the container.
 */
export function validateOptions(
  options: Record<string, unknown>,
  agentCommand: string,
): WrapperConfig {
  const logAndLimits = validateLogAndLimits(options);
  const networkOptions = validateNetworkOptions(options);
  const agentOptions = validateAgentOptions(options);
  return assembleAndValidateConfig(options, agentCommand, logAndLimits, networkOptions, agentOptions);
}
