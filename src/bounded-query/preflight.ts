import execa from 'execa';
import { getLocalDockerEnv } from '../host-env';
import type { BoundedQueriesConfig, WrapperConfig } from '../types';
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

/** Detects whether the Docker daemon exposes a named OCI runtime. */
export type DockerRuntimeQuery = (runtimeName: string) => Promise<boolean>;

export interface SbxCapabilityReport {
  supported: boolean;
  version?: string;
  missing: string[];
}

/** Executes the minimum host-side capability proof for the sbx query backend. */
export type SbxCapabilityQuery = () => Promise<SbxCapabilityReport>;

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
  const run = async (args: string[]): Promise<{ exitCode: number; stdout: string }> => {
    const result = await execa('sbx', args, {
      reject: false,
      timeout: 10_000,
      env: { PATH: process.env.PATH },
    });
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
  };

  let versionResult: { exitCode: number; stdout: string };
  let createHelp: { exitCode: number; stdout: string };
  let execHelp: { exitCode: number; stdout: string };
  try {
    [versionResult, createHelp, execHelp] = await Promise.all([
      run(['version']),
      run(['create', '--help']),
      run(['exec', '--help']),
    ]);
  } catch {
    return { supported: false, missing: ['authenticated sbx CLI/daemon'] };
  }

  const version = /\bv?(\d+\.\d+\.\d+)\b/.exec(versionResult.stdout)?.[1];
  const missing: string[] = ['pinned AWF Python query template and bootstrap'];
  if (versionResult.exitCode !== 0 || !version) missing.push('authenticated sbx CLI/daemon');
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
): Promise<void> {
  if (boundedQueries.runtime === 'sbx') {
    const report = await querySbxCapabilities();
    if (!report.supported) {
      throw new Error(
        'boundedQueries.runtime "sbx" is blocked because the installed sbx runtime cannot enforce all ' +
        `mandatory query-isolation controls: ${report.missing.join(', ')}. ` +
        'AWF will not launch a query VM and will never fall back to Docker or gVisor.',
      );
    }
    return;
  }

  if (boundedQueries.runtime !== 'gvisor') return;

  if (!(await queryDockerRuntime(GVISOR_DOCKER_RUNTIME))) {
    throw new Error(
      `boundedQueries.runtime "gvisor" requires the "${GVISOR_DOCKER_RUNTIME}" OCI runtime to be ` +
      'registered with the Docker daemon. It is not available, and bounded queries never fall back ' +
      'to a weaker runtime.',
    );
  }
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const preflightTestHelpers = {
  SUPPORTED_QUERY_RUNTIMES,
  GVISOR_DOCKER_RUNTIME,
  defaultDockerRuntimeQuery,
  defaultSbxCapabilityQuery,
  SBX_AUDITED_VERSION,
  SBX_REQUIRED_CREATE_FLAGS,
  SBX_REQUIRED_EXEC_FLAGS,
};
