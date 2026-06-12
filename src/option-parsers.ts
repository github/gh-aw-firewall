import { type FlagValidationResult, type WrapperConfig } from './types';

export {
  buildRateLimitConfig,
  validateRateLimitFlags,
  validateEnableTokenSteeringFlag,
} from './parsers/rate-limit-parsers';
export {
  validateAllowHostPorts,
  applyHostServicePortsConfig,
} from './parsers/host-port-parsers';
export {
  parseDnsServers,
  parseDnsOverHttps,
  processLocalhostKeyword,
} from './parsers/dns-parsers';
export {
  joinShellArgs,
} from './parsers/shell-utils';
export { parseVolumeMounts } from './parsers/volume-parsers';
export { parseEnvironmentVariables } from './parsers/env-parsers';

/**
 * Commander option accumulator for repeatable --ruleset-file flag.
 * Collects multiple values into an array.
 */
export function collectRulesetFile(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * Validates that --skip-pull is not used with --build-local
 * @param skipPull - Whether --skip-pull flag was provided
 * @param buildLocal - Whether --build-local flag was provided
 * @returns FlagValidationResult with validation status and error message
 */
export function validateSkipPullWithBuildLocal(
  skipPull: boolean | undefined,
  buildLocal: boolean | undefined
): FlagValidationResult {
  if (skipPull && buildLocal) {
    return {
      valid: false,
      error: '--skip-pull cannot be used with --build-local. Building images requires pulling base images from the registry.',
    };
  }
  return { valid: true };
}

/**
 * Parses and validates a Docker memory limit string.
 * Valid formats: positive integer followed by b, k, m, or g (e.g., "2g", "512m", "4g").
 */
export function parseMemoryLimit(input: string): { value: string; error?: undefined } | { value?: undefined; error: string } {
  const pattern = /^(\d+)([bkmg])$/i;
  const match = input.match(pattern);
  if (!match) {
    return { error: `Invalid --memory-limit value "${input}". Expected format: <number><unit> (e.g., 2g, 512m, 4g)` };
  }
  const num = parseInt(match[1], 10);
  if (num <= 0) {
    return { error: `Invalid --memory-limit value "${input}". Memory limit must be a positive number.` };
  }
  return { value: input.toLowerCase() };
}

/**
 * Parses and validates the --agent-timeout option
 * @param value - The raw string value from the CLI option
 * @returns The parsed timeout in minutes, or an error
 */
function parseAgentTimeout(value: string): { minutes: number } | { error: string } {
  if (!/^[1-9]\d*$/.test(value)) {
    return { error: '--agent-timeout must be a positive integer (minutes)' };
  }
  const timeoutMinutes = parseInt(value, 10);
  return { minutes: timeoutMinutes };
}

/**
 * Applies the --agent-timeout option to the config if present.
 * Exits with code 1 if the value is invalid.
 */
export function applyAgentTimeout(
  agentTimeout: string | undefined,
  config: WrapperConfig,
  logger: { error: (msg: string) => void; info: (msg: string) => void }
): void {
  if (agentTimeout === undefined) return;
  const result = parseAgentTimeout(agentTimeout);
  if ('error' in result) {
    logger.error(result.error);
    process.exit(1);
  }
  config.agentTimeout = result.minutes;
  logger.info(`Agent timeout set to ${result.minutes} minutes`);
}

/**
 * Returns `true` when `dockerHost` is a TCP endpoint on the loopback
 * interface — either `tcp://localhost:*` or `tcp://127.0.0.1:*`.  These are
 * the standard ARC/DinD sidecar endpoints and are fully supported by AWF.
 *
 * Also exported as `isLoopbackTcpDockerHostUri` for callers that receive a
 * Docker host URI string directly.
 */
function isLoopbackTcpDockerHost(dockerHost: string): boolean {
  if (!dockerHost.startsWith('tcp://')) return false;
  const rest = dockerHost.slice('tcp://'.length);
  return rest.startsWith('localhost:') || rest.startsWith('localhost/') ||
         rest === 'localhost' ||
         rest.startsWith('127.0.0.1:') || rest.startsWith('127.0.0.1/') ||
         rest === '127.0.0.1';
}

/** Public alias for use by callers outside this module. */
export const isLoopbackTcpDockerHostUri = isLoopbackTcpDockerHost;

/**
 * Checks whether DOCKER_HOST is set to an external daemon that is incompatible
 * with AWF.
 *
 * AWF manages its own Docker network (`172.30.0.0/24`) and iptables rules that
 * require direct access to the host's Docker socket.  When DOCKER_HOST points
 * at an external TCP daemon on a remote host, Docker Compose routes all
 * container creation through that daemon's network namespace, which may break:
 *  - AWF's fixed subnet routing
 *  - The iptables DNAT rules set up by awf-iptables-init
 *  - Port-binding expectations between containers
 *
 * Any unix socket (standard or non-standard path) is considered local and
 * valid.  TCP endpoints on the loopback address (`localhost` or `127.0.0.1`)
 * are also considered valid — they are the standard way to reach the DinD
 * sidecar daemon in ARC RunnerScaleSet pods.
 *
 * @param env - Environment variables to inspect (defaults to process.env)
 * @returns `{ valid: true }` when DOCKER_HOST is absent, points at a local
 *          unix socket, or is a loopback TCP endpoint; `{ valid: false, error:
 *          string }` for non-loopback TCP endpoints.
 */
export function checkDockerHost(
  env: Record<string, string | undefined> = process.env
): { valid: true } | { valid: false; error: string } {
  const dockerHost = env['DOCKER_HOST'];

  if (!dockerHost) {
    return { valid: true };
  }

  if (dockerHost.startsWith('unix://')) {
    return { valid: true };
  }

  // tcp://localhost:* and tcp://127.0.0.1:* are the standard ARC/DinD sidecar
  // endpoints and are fully supported for AWF's own docker/compose operations.
  if (isLoopbackTcpDockerHost(dockerHost)) {
    return { valid: true };
  }

  return {
    valid: false,
    error:
      `DOCKER_HOST is set to an external daemon (${dockerHost}). ` +
      'AWF requires the local Docker daemon (default socket or loopback TCP). ' +
      'Workflow-scope DinD is incompatible with AWF\'s network isolation model. ' +
      'See the "Workflow-Scope DinD Incompatibility" section in docs/usage.md for details and workarounds.',
  };
}

/**
 * Standard Docker socket paths that indicate a local daemon on the same
 * filesystem as the runner.  Any other unix:// path is treated as a potential
 * sibling-daemon (ARC/DinD) socket that may use a split filesystem.
 */
const DEFAULT_DOCKER_SOCKET_URIS = [
  'unix:///var/run/docker.sock',
  'unix:///run/docker.sock',
];

/**
 * Returns `true` when `DOCKER_HOST` indicates a sibling daemon in ARC/DinD
 * deployments, where the runner and daemon may have separate root filesystems.
 *
 * This covers two patterns:
 *  - A unix socket on a non-default path (socket bind-mounted from DinD pod)
 *  - A loopback TCP endpoint (`tcp://localhost:*` / `tcp://127.0.0.1:*`),
 *    which is the standard ARC RunnerScaleSet DinD sidecar configuration
 */
function isSiblingDaemonSocket(env: Record<string, string | undefined>): boolean {
  const dockerHost = env['DOCKER_HOST'];
  if (!dockerHost) return false;
  if (dockerHost.startsWith('unix://')) {
    return !DEFAULT_DOCKER_SOCKET_URIS.includes(dockerHost);
  }
  return isLoopbackTcpDockerHost(dockerHost);
}

/**
 * Resolves the effective Docker host path prefix for bind mount translation.
 *
 * If an explicit prefix is provided, it wins.  Otherwise the function inspects
 * the environment for DinD indicators:
 *  - `DOCKER_HOST` pointing at a non-standard unix socket (sibling daemon pod)
 *  - `AWF_DIND=1` set explicitly by the operator
 *
 * When a DinD indicator is found, `dindHint` is set to `true` so callers can
 * emit actionable warnings.  The actual prefix is NOT auto-applied here — the
 * `probeSplitFilesystem` probe in `main-action.ts` discovers it at runtime.
 *
 * @param _dockerHostCheck - Result of {@link checkDockerHost} (unused; kept for
 *   interface symmetry with the caller in {@link validateNetworkOptions}).
 * @param explicitPrefix - Value from the `--docker-host-path-prefix` flag.
 * @param env - Environment variables to inspect (defaults to `process.env`).
 */
export function resolveDockerHostPathPrefix(
  _dockerHostCheck: { valid: true } | { valid: false; error: string },
  explicitPrefix: string | undefined,
  env: Record<string, string | undefined> = process.env
): { dockerHostPathPrefix?: string; autoApplied: boolean; dindHint: boolean } {
  const trimmedExplicitPrefix = explicitPrefix?.trim();

  if (trimmedExplicitPrefix) {
    return { dockerHostPathPrefix: trimmedExplicitPrefix, autoApplied: false, dindHint: false };
  }

  const dindHint = env['AWF_DIND'] === '1' || isSiblingDaemonSocket(env);

  return { dockerHostPathPrefix: undefined, autoApplied: false, dindHint };
}

/**
 * Parses and validates the --max-model-multiplier CLI option.
 *
 * Accepts a comma-separated list of `model:multiplier` pairs, e.g.
 * `claude-opus-4-5-200k:2.5,claude-opus-4-5-1m:10`.
 *
 * Each multiplier must be a positive finite number.
 * Invalid entries are silently ignored; an empty or missing value returns `{}`.
 *
 * @param input - Raw string from the CLI option (may be undefined)
 * @returns Parsed multiplier map, or an error string
 */
export function parseModelMultipliersCli(
  input: string | undefined
): { multipliers: Record<string, number> } | { error: string } {
  if (!input || input.trim() === '') {
    return { multipliers: {} };
  }

  const result: Record<string, number> = {};
  const entries = input.split(',').map(e => e.trim()).filter(Boolean);

  for (const entry of entries) {
    // Split on the last colon to allow colons in model names
    const lastColon = entry.lastIndexOf(':');
    if (lastColon <= 0) {
      return { error: `--max-model-multiplier: invalid entry "${entry}" (expected model:multiplier)` };
    }
    const model = entry.slice(0, lastColon).trim();
    const rawValue = entry.slice(lastColon + 1).trim();

    if (!model) {
      return { error: `--max-model-multiplier: empty model name in "${entry}"` };
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `--max-model-multiplier: multiplier for "${model}" must be a positive number (got "${rawValue}")` };
    }
    result[model] = value;
  }

  return { multipliers: result };
}

export function formatItem(
  term: string,
  description: string,
  termWidth: number,
  indent: number,
  sep: number,
  _helpWidth: number
): string {
  const indentStr = ' '.repeat(indent);
  const fullWidth = termWidth + sep;
  if (description) {
    if (term.length < fullWidth - sep) {
      return `${indentStr}${term.padEnd(fullWidth)}${description}`;
    }
    return `${indentStr}${term}\n${' '.repeat(indent + fullWidth)}${description}`;
  }
  return `${indentStr}${term}`;
}
