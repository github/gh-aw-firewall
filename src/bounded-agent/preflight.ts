import execa from 'execa';
import { getLocalDockerEnv } from '../host-env';
import type { BoundedAgentsConfig, WrapperConfig } from '../types';
import { normalizeRepoKey } from './paths';
import {
  BOUNDED_AGENT_REPO_PATTERN,
  MAX_BOUNDED_AGENT_TIMEOUT_SECONDS,
  MAX_RESULT_BYTES,
  MAX_TASK_BYTES,
} from './protocol';
import { resolveStagingToken } from '../bounded-query/staging';
import { runtimeUsesComposeAgent } from '../container-runtime';

/**
 * Fail-closed preflight for bounded agents.
 *
 * JSON Schema already constrains the *shape* of `boundedAgents`. This module
 * covers everything the schema cannot: credential availability, the mandatory
 * API-proxy model route, sandbox runtime availability, and combinations of AWF
 * settings under which a bounded agent cannot be exposed securely.
 *
 * Every check here is fatal. A bounded-agent run that cannot satisfy its
 * isolation guarantees must abort before the primary agent starts rather than
 * silently downgrading — in particular, an unavailable `runsc` never falls
 * back to the default Docker runtime, and the not-yet-implemented `sbx`
 * backend never falls back to Docker or gVisor.
 */

/** Enclave runtimes with a safe, implemented launcher. */
const IMPLEMENTED_ENCLAVE_RUNTIMES = new Set(['docker', 'gvisor']);

/** Enclave runtimes the schema accepts but preflight blocks. */
const BLOCKED_ENCLAVE_RUNTIMES = new Set(['sbx']);

/** Docker OCI runtime name required for the `gvisor` enclave runtime. */
const GVISOR_DOCKER_RUNTIME = 'runsc';

/** Detects whether the Docker daemon exposes a named OCI runtime. */
export type DockerRuntimeQuery = (runtimeName: string) => Promise<boolean>;

/** Detects whether the Docker daemon required by the enclave backend is reachable. */
export type DockerAvailabilityQuery = () => Promise<boolean>;

const defaultDockerRuntimeQuery: DockerRuntimeQuery = async (runtimeName) => {
  const result = await execa('docker', ['info', '--format', '{{json .Runtimes}}'], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 30_000,
  });
  if (result.exitCode !== 0) return false;
  try {
    const runtimes = JSON.parse(result.stdout) as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(runtimes, runtimeName);
  } catch {
    return false;
  }
};

const defaultDockerAvailabilityQuery: DockerAvailabilityQuery = async () => {
  const result = await execa('docker', ['info', '--format', '{{.ServerVersion}}'], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 30_000,
  });
  return result.exitCode === 0;
};

/**
 * Resolves whether the configured profile has a usable API-proxy model route.
 *
 * A bounded agent has no credentials of its own: it can only reach a model
 * through the AWF API proxy, which injects the real key. If the profile's
 * provider is not routed by the sidecar for this run, the enclave would sit on
 * an internal network with nothing to talk to — so the run is rejected rather
 * than started in a state where every invocation would return the canonical
 * error.
 */
export function resolveApiProxyRoute(
  config: WrapperConfig,
  profile: BoundedAgentsConfig['profile'],
): { routed: boolean; detail: string } {
  if (profile === 'anthropic') {
    return {
      routed: Boolean(config.anthropicApiKey),
      detail: 'apiProxy.targets.anthropic (ANTHROPIC_API_KEY) is not configured',
    };
  }
  return {
    routed: Boolean(config.openaiApiKey),
    detail: 'apiProxy.targets.openai (OPENAI_API_KEY) is not configured',
  };
}

/** Parses a Docker-style size string (e.g. `512m`) into bytes. */
function isDockerSize(value: string): boolean {
  return /^[1-9][0-9]*[bkmgBKMG]$/.test(value);
}

/**
 * Validates everything about a bounded-agent configuration that can be decided
 * without touching Docker or the network.
 *
 * @returns human-readable errors; empty when the configuration is acceptable.
 */
export function validateBoundedAgentConfig(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const boundedAgents = config.boundedAgents;
  if (!boundedAgents?.enabled) return [];

  const errors: string[] = [];

  if (!runtimeUsesComposeAgent(config.containerRuntime)) {
    errors.push(
      `bounded agents require a Docker Compose primary agent, but container runtime ` +
      `"${config.containerRuntime}" uses an external microVM agent. No audited bounded-agent ` +
      'ingress exists for that execution model, so AWF fails closed before staging.',
    );
  }

  if (config.enableDind) {
    errors.push(
      'bounded agents cannot be combined with enableDind: exposing the Docker socket to the primary ' +
      'agent would allow it to inspect credentials, mount private seeds, join enclave networks, and ' +
      'bypass the finite-disclosure ledger',
    );
  }

  if (boundedAgents.privateRepos.length === 0) {
    errors.push('boundedAgents.enabled is true but boundedAgents.privateRepos is empty');
  }

  const seenKeys = new Set<string>();
  for (const entry of boundedAgents.privateRepos) {
    const repo = entry.repo;
    if (!BOUNDED_AGENT_REPO_PATTERN.test(repo)) {
      errors.push(
        `boundedAgents.privateRepos entry "${repo}" is not a bare owner/repo slug ` +
        '(no scheme, host, credentials, path traversal, query, fragment, or wildcard)',
      );
      continue;
    }
    const key = normalizeRepoKey(repo);
    if (seenKeys.has(key)) {
      errors.push(`boundedAgents.privateRepos contains a duplicate entry: "${repo}"`);
    }
    seenKeys.add(key);
  }

  if (BLOCKED_ENCLAVE_RUNTIMES.has(boundedAgents.runtime)) {
    errors.push(
      `boundedAgents.runtime "${boundedAgents.runtime}" is not yet implemented. AWF has no audited ` +
      'single-use, API-proxy-only enclave launcher for it, and bounded agents never downgrade to a ' +
      'weaker runtime. Use "docker" or "gvisor".',
    );
  } else if (!IMPLEMENTED_ENCLAVE_RUNTIMES.has(boundedAgents.runtime)) {
    errors.push(
      `boundedAgents.runtime "${boundedAgents.runtime}" is not supported. Use "docker" or "gvisor".`,
    );
  }

  if (!config.enableApiProxy) {
    errors.push(
      'bounded agents require the AWF API proxy to be enabled: the enclave holds no credentials and ' +
      'the API proxy is its only permitted upstream egress',
    );
  }

  if (!boundedAgents.model || boundedAgents.model.length === 0) {
    errors.push('boundedAgents.model is required when boundedAgents.enabled is true');
  }

  const route = resolveApiProxyRoute(config, boundedAgents.profile);
  if (!route.routed) {
    errors.push(
      `bounded agents require a supported configured API target for profile "${boundedAgents.profile}": ` +
      `${route.detail}`,
    );
  }

  // Reserve the final minute of the 10-minute response bucket for Docker
  // termination, result validation, container removal, and workspace cleanup.
  if (!Number.isInteger(boundedAgents.timeout) || boundedAgents.timeout < 1) {
    errors.push('boundedAgents.timeout must be a positive integer number of seconds');
  } else if (boundedAgents.timeout > MAX_BOUNDED_AGENT_TIMEOUT_SECONDS) {
    errors.push(
      `boundedAgents.timeout must be at most ${MAX_BOUNDED_AGENT_TIMEOUT_SECONDS} seconds ` +
      '(the 10-minute response bucket reserves its final minute for termination, validation, and cleanup)',
    );
  }

  if (!Number.isInteger(boundedAgents.maxInvocations) || boundedAgents.maxInvocations < 1) {
    errors.push('boundedAgents.maxInvocations must be a positive integer');
  }
  if (!Number.isInteger(boundedAgents.maxModelRequests) || boundedAgents.maxModelRequests < 1) {
    errors.push('boundedAgents.maxModelRequests must be a positive integer');
  }
  if (!Number.isInteger(boundedAgents.maxModelTokens) || boundedAgents.maxModelTokens < 1) {
    errors.push('boundedAgents.maxModelTokens must be a positive integer');
  }
  if (!Number.isInteger(boundedAgents.pidsLimit) || boundedAgents.pidsLimit < 1) {
    errors.push('boundedAgents.pidsLimit must be a positive integer');
  }
  if (
    !Number.isInteger(boundedAgents.maxOutputBytes)
    || boundedAgents.maxOutputBytes < 1
    || boundedAgents.maxOutputBytes > MAX_RESULT_BYTES
  ) {
    errors.push(`boundedAgents.maxOutputBytes must be between 1 and ${MAX_RESULT_BYTES}`);
  }
  if (
    !Number.isInteger(boundedAgents.maxTaskBytes)
    || boundedAgents.maxTaskBytes < 1
    || boundedAgents.maxTaskBytes > MAX_TASK_BYTES
  ) {
    errors.push(`boundedAgents.maxTaskBytes must be between 1 and ${MAX_TASK_BYTES}`);
  }

  if (!isDockerSize(boundedAgents.memoryLimit)) {
    errors.push(`boundedAgents.memoryLimit "${boundedAgents.memoryLimit}" is not a Docker memory limit`);
  }
  if (!isDockerSize(boundedAgents.tmpfsLimit)) {
    errors.push(`boundedAgents.tmpfsLimit "${boundedAgents.tmpfsLimit}" is not a Docker size limit`);
  }
  if (!/^(?:[0-9]{1,2})(?:\.[0-9]{1,3})?$/.test(boundedAgents.cpuLimit) || Number(boundedAgents.cpuLimit) <= 0) {
    errors.push(`boundedAgents.cpuLimit "${boundedAgents.cpuLimit}" is not a positive Docker --cpus value`);
  }

  const dockerHost = config.awfDockerHost ?? env.DOCKER_HOST;
  if (dockerHost && !dockerHost.startsWith('unix://')) {
    errors.push(
      `bounded agents require a Unix-socket Docker host, but the resolved host is "${dockerHost}". ` +
      'The broker has no route to a TCP daemon and AWF will not weaken that isolation.',
    );
  }

  if (!resolveStagingToken(env)) {
    errors.push(
      'bounded agents require a staging credential in GH_TOKEN or GITHUB_TOKEN on the AWF host ' +
      '(it is used only by the trusted staging phase and never reaches the agent, broker, or enclave)',
    );
  }

  return errors;
}

/**
 * Verifies that the requested enclave runtime is actually available.
 *
 * Only reached after {@link validateBoundedAgentConfig} accepted the runtime
 * name, so the only remaining question is daemon support. gVisor requires an
 * exact `runsc` registration and is never downgraded.
 */
export async function assertEnclaveRuntimeAvailable(
  boundedAgents: BoundedAgentsConfig,
  queryDockerRuntime: DockerRuntimeQuery = defaultDockerRuntimeQuery,
  queryDockerAvailable: DockerAvailabilityQuery = defaultDockerAvailabilityQuery,
): Promise<void> {
  if (boundedAgents.runtime === 'gvisor') {
    if (!(await queryDockerRuntime(GVISOR_DOCKER_RUNTIME))) {
      throw new Error(
        `boundedAgents.runtime "gvisor" requires the "${GVISOR_DOCKER_RUNTIME}" OCI runtime to be ` +
        'registered with the Docker daemon. It is not available, and bounded agents never fall back ' +
        'to a weaker runtime.',
      );
    }
    return;
  }

  if (boundedAgents.runtime === 'docker') {
    if (!(await queryDockerAvailable())) {
      throw new Error(
        'boundedAgents.runtime "docker" requires a reachable Docker daemon. It is not available, ' +
        'and bounded agents never fall back to another runtime.',
      );
    }
    return;
  }

  throw new Error(
    `boundedAgents.runtime "${boundedAgents.runtime}" has no implemented enclave launcher. ` +
    'Bounded agents fail closed rather than downgrading to Docker or gVisor.',
  );
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const boundedAgentPreflightTestHelpers = {
  IMPLEMENTED_ENCLAVE_RUNTIMES,
  BLOCKED_ENCLAVE_RUNTIMES,
  GVISOR_DOCKER_RUNTIME,
  defaultDockerRuntimeQuery,
  defaultDockerAvailabilityQuery,
  isDockerSize,
};
