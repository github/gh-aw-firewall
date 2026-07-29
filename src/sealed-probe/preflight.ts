import execa from 'execa';
import { getLocalDockerEnv } from '../host-env';
import { runtimeUsesComposeAgent } from '../container-runtime';
import type { SealedProbesConfig, WrapperConfig } from '../types';
import { normalizeRepoKey } from './paths';
import { SEALED_PROBE_REPO_PATTERN, TIMING_BUCKETS_MS } from './protocol';
import { resolveStagingToken } from './staging';

/**
 * Fail-closed preflight for sealed probes.
 *
 * JSON Schema already constrains the *shape* of `sealedProbes`. This module
 * covers everything the schema cannot: credential availability, sandbox
 * runtime availability, and combinations of AWF settings under which sealed
 * probes cannot be exposed securely.
 *
 * Every check here is fatal — a sealed-probe run that cannot satisfy its
 * isolation guarantees must abort before the primary agent starts rather than
 * silently downgrading.
 */

/** Probe sandbox runtimes with a safe, implemented no-network launcher. */
const SUPPORTED_PROBE_RUNTIMES = new Set(['docker', 'gvisor']);

/** Docker OCI runtime name required for the `gvisor` probe runtime. */
const GVISOR_DOCKER_RUNTIME = 'runsc';

/** Detects whether the Docker daemon exposes a named OCI runtime. */
export type DockerRuntimeProbe = (runtimeName: string) => Promise<boolean>;

const defaultDockerRuntimeProbe: DockerRuntimeProbe = async (runtimeName) => {
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

/**
 * Validates everything about a sealed-probe configuration that can be decided
 * without touching Docker or the network.
 *
 * @returns human-readable errors; empty when the configuration is acceptable.
 */
export function validateSealedProbeConfig(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const sealedProbes = config.sealedProbes;
  if (!sealedProbes?.enabled) return [];

  const errors: string[] = [];

  if (sealedProbes.privateRepos.length === 0) {
    errors.push('sealedProbes.enabled is true but sealedProbes.privateRepos is empty');
  }

  const seenKeys = new Set<string>();
  for (const entry of sealedProbes.privateRepos) {
    const repo = entry.repo;
    if (!SEALED_PROBE_REPO_PATTERN.test(repo)) {
      errors.push(
        `sealedProbes.privateRepos entry "${repo}" is not a bare owner/repo slug ` +
        '(no scheme, host, credentials, path traversal, query, fragment, or wildcard)',
      );
      continue;
    }
    const key = normalizeRepoKey(repo);
    if (seenKeys.has(key)) {
      errors.push(`sealedProbes.privateRepos contains a duplicate entry: "${repo}"`);
    }
    seenKeys.add(key);
  }

  if (!SUPPORTED_PROBE_RUNTIMES.has(sealedProbes.runtime)) {
    errors.push(
      `sealedProbes.runtime "${sealedProbes.runtime}" is not supported. ` +
      'AWF has no no-network, per-invocation sealed-probe launcher for it, and sealed probes ' +
      'never downgrade to a weaker runtime. Use "docker" or "gvisor".',
    );
  }

  if (sealedProbes.interpreter !== 'python3') {
    errors.push(`sealedProbes.interpreter "${sealedProbes.interpreter}" is not supported`);
  }

  // The largest observable timing bucket bounds how long the broker can ever
  // wait before answering (see `TIMING_BUCKETS_MS` in ./protocol). Capping the
  // configured timeout at that same ceiling guarantees every completed
  // invocation — success, failure, or timeout — always lands inside a
  // bucket, so response latency alone can never distinguish a timeout from a
  // merely slow-but-successful script.
  const maxTimeoutSeconds = TIMING_BUCKETS_MS[TIMING_BUCKETS_MS.length - 1] / 1000;
  if (!Number.isInteger(sealedProbes.timeout) || sealedProbes.timeout < 1) {
    errors.push('sealedProbes.timeout must be a positive integer number of seconds');
  } else if (sealedProbes.timeout > maxTimeoutSeconds) {
    errors.push(
      `sealedProbes.timeout must be at most ${maxTimeoutSeconds} seconds ` +
      `(the largest response-timing bucket); a longer timeout could let an invocation's ` +
      'completion time itself leak unbucketed secret-dependent information',
    );
  }

  if (!Number.isInteger(sealedProbes.maxInvocations) || sealedProbes.maxInvocations < 1) {
    errors.push('sealedProbes.maxInvocations must be a positive integer');
  }

  if (!/^[1-9][0-9]*[bkmgBKMG]$/.test(sealedProbes.memoryLimit)) {
    errors.push(`sealedProbes.memoryLimit "${sealedProbes.memoryLimit}" is not a Docker memory limit`);
  }

  if (!runtimeUsesComposeAgent(config.containerRuntime)) {
    errors.push(
      `sealed probes cannot be exposed to a "${config.containerRuntime}" primary agent: ` +
      'the broker socket is shared through a Docker Compose bind mount, which a microVM agent ' +
      'does not receive. Disable sealedProbes or use a Compose-based container runtime.',
    );
  }

  const dockerHost = config.awfDockerHost ?? env.DOCKER_HOST;
  if (dockerHost && !dockerHost.startsWith('unix://')) {
    errors.push(
      `sealed probes require a Unix-socket Docker host, but the resolved host is "${dockerHost}". ` +
      'The broker runs with network_mode: none so it can only reach the daemon over a bind-mounted ' +
      'socket, and AWF will not weaken that isolation to reach a TCP daemon.',
    );
  }

  if (!resolveStagingToken(env)) {
    errors.push(
      'sealed probes require a staging credential in GH_TOKEN or GITHUB_TOKEN on the AWF host ' +
      '(it is used only by the trusted staging phase and never reaches the agent, broker, or probe)',
    );
  }

  return errors;
}

/**
 * Verifies that the requested probe sandbox runtime is actually available.
 *
 * Only reached after {@link validateSealedProbeConfig} accepted the runtime
 * name, so the only remaining question is daemon support.
 */
export async function assertProbeRuntimeAvailable(
  sealedProbes: SealedProbesConfig,
  probeDockerRuntime: DockerRuntimeProbe = defaultDockerRuntimeProbe,
): Promise<void> {
  if (sealedProbes.runtime !== 'gvisor') return;

  if (!(await probeDockerRuntime(GVISOR_DOCKER_RUNTIME))) {
    throw new Error(
      `sealedProbes.runtime "gvisor" requires the "${GVISOR_DOCKER_RUNTIME}" OCI runtime to be ` +
      'registered with the Docker daemon. It is not available, and sealed probes never fall back ' +
      'to a weaker runtime.',
    );
  }
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const preflightTestHelpers = {
  SUPPORTED_PROBE_RUNTIMES,
  GVISOR_DOCKER_RUNTIME,
  defaultDockerRuntimeProbe,
};
