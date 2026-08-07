import execa from 'execa';
import type { BoundedQueriesConfig, WrapperConfig } from '../types';
import {
  defaultDockerAvailabilityQuery,
  defaultDockerRuntimeQuery,
  defaultSbxAvailabilityQuery,
  type DockerAvailabilityQuery,
  type DockerRuntimeQuery,
  type SbxAvailabilityQuery,
} from '../bounded-execution/runtime-probes';
import { normalizeRepoKey } from './paths';
import { MAX_QUERY_TIMEOUT_SECONDS, BOUNDED_QUERY_REPO_PATTERN } from './protocol';
import { resolveStagingToken } from './staging';

/**
 * Fail-closed preflight for bounded queries.
 *
 * JSON Schema already constrains the *shape* of `boundedQueries`. This module
 * covers everything the schema cannot: credential availability, sandbox
 * runtime availability, and combinations of AWF settings under which bounded
 * queries cannot be exposed securely.
 *
 * Every check here is fatal — a bounded-query run that cannot satisfy its
 * isolation guarantees must abort before the primary agent starts rather than
 * silently downgrading.
 */

/** Query sandbox runtimes with a safe, implemented no-network launcher. */
const SUPPORTED_QUERY_RUNTIMES = new Set(['docker', 'gvisor', 'sbx']);

/** Docker OCI runtime name required for the `gvisor` query runtime. */
const GVISOR_DOCKER_RUNTIME = 'runsc';

export type {
  DockerAvailabilityQuery,
  DockerRuntimeQuery,
  SbxAvailabilityQuery,
} from '../bounded-execution/runtime-probes';

export interface SbxCapabilityReport {
  supported: boolean;
  version?: string;
  missing: string[];
}

/** Executes the minimum host-side capability proof for the sbx query backend. */
export type SbxCapabilityQuery = () => Promise<SbxCapabilityReport>;

type RuntimeAvailabilityCase = 'sbx' | 'docker' | 'gvisor' | 'custom' | 'default-docker';

function classifyRuntimeAvailability(runtime: string | undefined): RuntimeAvailabilityCase {
  if (runtime === 'sbx') return 'sbx';
  if (runtime === 'docker') return 'docker';
  if (runtime === 'gvisor' || runtime === 'runsc') return 'gvisor';
  if (runtime) return 'custom';
  return 'default-docker';
}

interface RuntimeAvailabilityChecks {
  sbx: () => Promise<void>;
  docker: () => Promise<void>;
  gvisor: (runtime: string) => Promise<void>;
  custom: (runtime: string) => Promise<void>;
  defaultDocker: () => Promise<void>;
}

async function assertRuntimeAvailability(
  runtime: string | undefined,
  checks: RuntimeAvailabilityChecks,
): Promise<void> {
  const runtimeCase = classifyRuntimeAvailability(runtime);
  switch (runtimeCase) {
    case 'sbx':
      return checks.sbx();
    case 'docker':
      return checks.docker();
    case 'gvisor':
      return checks.gvisor(runtime!);
    case 'custom':
      return checks.custom(runtime!);
    case 'default-docker':
      return checks.defaultDocker();
    default:
      throw new Error(`Unreachable runtime case: ${runtimeCase satisfies never}`);
  }
}

const SBX_AUDITED_VERSION = '0.37.1';
const SBX_REQUIRED_CREATE_FLAGS = [
  '--cpus',
  '--memory',
  '--name',
  '--template',
  '--network=none',
  '--pids-limit',
  '--disk-limit',
  '--ulimit-fsize',
  '--mount-target',
] as const;
const SBX_REQUIRED_EXEC_FLAGS = ['--user', '--workdir'] as const;

function helpIncludesFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${escaped}(?=([=\\s,]|$))`, 'm').test(help);
}

const defaultSbxCapabilityQuery: SbxCapabilityQuery = async () => {
  const managementEnv = { ...process.env };
  delete managementEnv.DOCKER_SANDBOXES_PROXY;
  delete managementEnv.XDG_CONFIG_HOME;

  const run = async (args: string[]): Promise<{ exitCode: number; stdout: string }> => {
    const result = await execa('sbx', args, {
      reject: false,
      timeout: 10_000,
      env: managementEnv,
    });
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
  };

  let versionResult: { exitCode: number; stdout: string };
  let daemonResult: { exitCode: number; stdout: string };
  let createHelp: { exitCode: number; stdout: string };
  let execHelp: { exitCode: number; stdout: string };
  try {
    [versionResult, daemonResult, createHelp, execHelp] = await Promise.all([
      run(['version']),
      // sbx has no auth-status command; listing is authenticated and non-mutating.
      run(['ls']),
      run(['create', '--help']),
      run(['exec', '--help']),
    ]);
  } catch {
    return { supported: false, missing: ['authenticated sbx CLI/daemon'] };
  }

  const version = /\bv?(\d+\.\d+\.\d+)\b/.exec(versionResult.stdout)?.[1];
  const missing: string[] = ['pinned AWF Python query template and bootstrap'];
  if (versionResult.exitCode !== 0 || !version || daemonResult.exitCode !== 0) {
    missing.push('authenticated sbx CLI/daemon');
  }
  if (version && version !== SBX_AUDITED_VERSION) {
    missing.push(`audited sbx version ${SBX_AUDITED_VERSION} (found ${version})`);
  }
  for (const flag of SBX_REQUIRED_CREATE_FLAGS) {
    if (createHelp.exitCode !== 0 || !helpIncludesFlag(createHelp.stdout, flag)) {
      missing.push(`sbx create ${flag}`);
    }
  }
  for (const flag of SBX_REQUIRED_EXEC_FLAGS) {
    if (execHelp.exitCode !== 0 || !helpIncludesFlag(execHelp.stdout, flag)) {
      missing.push(`sbx exec ${flag}`);
    }
  }
  return { supported: missing.length === 0, version, missing };
};

/**
 * Validates everything about a bounded-query configuration that can be decided
 * without touching Docker or the network.
 *
 * @returns human-readable errors; empty when the configuration is acceptable.
 */
export function validateBoundedQueryConfig(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const boundedQueries = config.boundedQueries;
  if (!boundedQueries?.enabled) return [];

  const errors: string[] = [];

  if (boundedQueries.privateRepos.length === 0) {
    errors.push('boundedQueries.enabled is true but boundedQueries.privateRepos is empty');
  }

  const seenKeys = new Set<string>();
  for (const entry of boundedQueries.privateRepos) {
    const repo = entry.repo;
    if (!BOUNDED_QUERY_REPO_PATTERN.test(repo)) {
      errors.push(
        `boundedQueries.privateRepos entry "${repo}" is not a bare owner/repo slug ` +
        '(no scheme, host, credentials, path traversal, query, fragment, or wildcard)',
      );
      continue;
    }
    const key = normalizeRepoKey(repo);
    if (seenKeys.has(key)) {
      errors.push(`boundedQueries.privateRepos contains a duplicate entry: "${repo}"`);
    }
    seenKeys.add(key);
  }

  if (!SUPPORTED_QUERY_RUNTIMES.has(boundedQueries.runtime)) {
    errors.push(
      `boundedQueries.runtime "${boundedQueries.runtime}" is not supported. ` +
      'AWF has no no-network, per-invocation bounded-query launcher for it, and bounded queries ' +
      'never downgrade to a weaker runtime. Use "docker", "gvisor", or "sbx".',
    );
  }

  if (boundedQueries.interpreter !== 'python3') {
    errors.push(`boundedQueries.interpreter "${boundedQueries.interpreter}" is not supported`);
  }

  // Reserve the final minute of the 10-minute response bucket for Docker
  // termination, result validation, container removal, and workspace cleanup.
  // The script timeout cannot consume the entire observable boundary.
  if (!Number.isInteger(boundedQueries.timeout) || boundedQueries.timeout < 1) {
    errors.push('boundedQueries.timeout must be a positive integer number of seconds');
  } else if (boundedQueries.timeout > MAX_QUERY_TIMEOUT_SECONDS) {
    errors.push(
      `boundedQueries.timeout must be at most ${MAX_QUERY_TIMEOUT_SECONDS} seconds ` +
      '(the 10-minute response bucket reserves its final minute for termination, validation, and cleanup)',
    );
  }

  if (!Number.isInteger(boundedQueries.maxInvocations) || boundedQueries.maxInvocations < 1) {
    errors.push('boundedQueries.maxInvocations must be a positive integer');
  }

  if (!/^[1-9][0-9]*[bkmgBKMG]$/.test(boundedQueries.memoryLimit)) {
    errors.push(`boundedQueries.memoryLimit "${boundedQueries.memoryLimit}" is not a Docker memory limit`);
  }

  const dockerHost = config.awfDockerHost ?? env.DOCKER_HOST;
  if (boundedQueries.runtime !== 'sbx' && dockerHost && !dockerHost.startsWith('unix://')) {
    errors.push(
      `bounded queries require a Unix-socket Docker host, but the resolved host is "${dockerHost}". ` +
      'The broker runs with network_mode: none so it can only reach the daemon over a bind-mounted ' +
      'socket, and AWF will not weaken that isolation to reach a TCP daemon.',
    );
  }

  if (!resolveStagingToken(env)) {
    errors.push(
      'bounded queries require a staging credential in GH_TOKEN or GITHUB_TOKEN on the AWF host ' +
      '(it is used only by the trusted staging phase and never reaches the agent, broker, or query)',
    );
  }

  return errors;
}

/**
 * Verifies that the requested query sandbox runtime is actually available.
 *
 * Only reached after {@link validateBoundedQueryConfig} accepted the runtime
 * name, so the only remaining question is daemon support.
 */
export async function assertQueryRuntimeAvailable(
  boundedQueries: BoundedQueriesConfig,
  queryDockerRuntime: DockerRuntimeQuery = defaultDockerRuntimeQuery,
  querySbxCapabilities: SbxCapabilityQuery = defaultSbxCapabilityQuery,
  queryDockerAvailable: DockerAvailabilityQuery = defaultDockerAvailabilityQuery,
  runtimeConfigPath = 'boundedQueries.runtime',
): Promise<void> {
  await assertRuntimeAvailability(boundedQueries.runtime, {
    sbx: async () => {
      const report = await querySbxCapabilities();
      if (!report.supported) {
        throw new Error(
          `${runtimeConfigPath} "sbx" is blocked because the installed sbx runtime cannot enforce all ` +
          `mandatory query-isolation controls: ${report.missing.join(', ')}. ` +
          'AWF will not launch the configured sandbox and will never fall back to Docker or gVisor.',
        );
      }
    },
    docker: async () => {
      if (!(await queryDockerAvailable())) {
        throw new Error(
          `${runtimeConfigPath} "docker" requires a reachable Docker daemon. It is not available, ` +
          'and the configured sandbox will never fall back to another runtime.',
        );
      }
    },
    gvisor: async () => {
      if (!(await queryDockerRuntime(GVISOR_DOCKER_RUNTIME))) {
        throw new Error(
          `${runtimeConfigPath} "gvisor" requires the "${GVISOR_DOCKER_RUNTIME}" OCI runtime to be ` +
          'registered with the Docker daemon. It is not available, and the configured sandbox will never fall back ' +
          'to a weaker runtime.',
        );
      }
    },
    custom: async () => {
      if (!(await queryDockerRuntime(GVISOR_DOCKER_RUNTIME))) {
        throw new Error(
          `${runtimeConfigPath} "gvisor" requires the "${GVISOR_DOCKER_RUNTIME}" OCI runtime to be ` +
          'registered with the Docker daemon. It is not available, and the configured sandbox will never fall back ' +
          'to a weaker runtime.',
        );
      }
    },
    defaultDocker: async () => {
      if (!(await queryDockerAvailable())) {
        throw new Error(
          `${runtimeConfigPath} "docker" requires a reachable Docker daemon. It is not available, ` +
          'and the configured sandbox will never fall back to another runtime.',
        );
      }
    },
  });
}

/** Verifies the primary-agent runtime before bounded-query repository staging. */
export async function assertPrimaryRuntimeAvailable(
  containerRuntime: string | undefined,
  queryDockerRuntime: DockerRuntimeQuery = defaultDockerRuntimeQuery,
  queryDockerAvailable: DockerAvailabilityQuery = defaultDockerAvailabilityQuery,
  querySbxAvailable: SbxAvailabilityQuery = defaultSbxAvailabilityQuery,
): Promise<void> {
  await assertRuntimeAvailability(containerRuntime, {
    sbx: async () => {
      if (!(await querySbxAvailable())) {
        throw new Error(
          'Primary-agent runtime "sbx" is unavailable. Bounded queries abort before staging and never ' +
          'fall back to a Docker or gVisor primary agent.',
        );
      }
    },
    docker: async () => {
      if (!(await queryDockerRuntime('docker'))) {
        throw new Error(
          'Primary-agent OCI runtime "docker" is not registered with Docker. ' +
          'Bounded queries abort before staging and never fall back.',
        );
      }
    },
    gvisor: async (runtime) => {
      if (!(await queryDockerRuntime(GVISOR_DOCKER_RUNTIME))) {
        throw new Error(
          `Primary-agent runtime "${runtime}" requires the "${GVISOR_DOCKER_RUNTIME}" OCI runtime. ` +
          'It is not available, so bounded queries abort before staging and never fall back.',
        );
      }
    },
    custom: async (runtime) => {
      if (!(await queryDockerRuntime(runtime))) {
        throw new Error(
          `Primary-agent OCI runtime "${runtime}" is not registered with Docker. ` +
          'Bounded queries abort before staging and never fall back.',
        );
      }
    },
    defaultDocker: async () => {
      if (!(await queryDockerAvailable())) {
        throw new Error(
          'The Docker primary-agent runtime is unavailable. Bounded queries abort before staging and never fall back.',
        );
      }
    },
  });
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const preflightTestHelpers = {
  SUPPORTED_QUERY_RUNTIMES,
  GVISOR_DOCKER_RUNTIME,
  defaultDockerRuntimeQuery,
  defaultDockerAvailabilityQuery,
  defaultSbxAvailabilityQuery,
  defaultSbxCapabilityQuery,
  SBX_AUDITED_VERSION,
  SBX_REQUIRED_CREATE_FLAGS,
  SBX_REQUIRED_EXEC_FLAGS,
};
