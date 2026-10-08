import * as path from 'path';
import { MAX_ENV_VALUE_SIZE } from '../../constants';
import { copyEnvEntries } from '../../env-utils';
import { getRealUserHome } from '../../host-identity';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';
import { mountedChrootRoots } from '../agent-path-policy';

interface EnvPassthroughParams {
  config: WrapperConfig;
  environment: Record<string, string>;
  excludedEnvVars: Set<string>;
}

export function passthroughHostEnvironment(params: EnvPassthroughParams): void {
  const { config, environment, excludedEnvVars } = params;

  if (config.envAll) {
    const skippedLargeVars: string[] = [];
    const preexistingKeys = new Set(Object.keys(environment));
    copyEnvEntries(process.env, environment, {
      excludedKeys: excludedEnvVars,
      noOverwrite: true,
      maxValueSizeBytes: MAX_ENV_VALUE_SIZE,
      onSkippedOversized: (key, sizeBytes) => {
        skippedLargeVars.push(`${key} (${(sizeBytes / 1024).toFixed(0)} KB)`);
      },
    });

    if (skippedLargeVars.length > 0) {
      logger.warn(`Skipped ${skippedLargeVars.length} oversized env var(s) from --env-all passthrough (>${(MAX_ENV_VALUE_SIZE / 1024).toFixed(0)} KB each):`);
      for (const entry of skippedLargeVars) {
        logger.warn(`  - ${entry}`);
      }
      logger.warn('Use --env VAR="$VAR" to explicitly pass large values if needed.');
    }

    dropUnmountedRunnerTempPaths(config, environment, preexistingKeys);
    return;
  }

  const alwaysForwardVars = [
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_PERSONAL_ACCESS_TOKEN',
    'USER',
    'XDG_CONFIG_HOME',
    'GITHUB_SERVER_URL',
    'GITHUB_API_URL',
    'AZURE_CONFIG_DIR',
    'ADO_MCP_AUTH_TOKEN',
    'DOCKER_HOST',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_API_VERSION',
    'DOCKER_DEFAULT_PLATFORM',
    'COPILOT_OTEL_FILE_EXPORTER_PATH',
    'GITHUB_AW_OTEL_TRACE_ID',
    'GITHUB_AW_OTEL_PARENT_SPAN_ID',
  ] as const;

  for (const v of alwaysForwardVars) {
    if (process.env[v] && !excludedEnvVars.has(v)) {
      environment[v] = process.env[v]!;
    }
  }

  if (!config.enableApiProxy) {
    for (const v of [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'ANTHROPIC_API_KEY',
      'COPILOT_GITHUB_TOKEN',
      'COPILOT_PROVIDER_API_KEY',
    ] as const) {
      if (process.env[v] && !excludedEnvVars.has(v)) {
        environment[v] = process.env[v]!;
      }
    }
  }

  if (process.env.TERM && !config.tty) {
    environment.TERM = process.env.TERM;
  }

  if (config.enableDind && !environment.DOCKER_HOST && config.awfDockerHost?.startsWith('unix://')) {
    environment.DOCKER_HOST = config.awfDockerHost;
  }
}

function isAtOrBelow(candidate: string, root: string): boolean {
  if (root === '/') {
    return true;
  }
  const relative = path.posix.relative(root, candidate);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}

/**
 * Removes `--env-all` forwarded variables whose value is an absolute path
 * strictly inside `${RUNNER_TEMP}` but not covered by any agent mount.
 *
 * Only `${RUNNER_TEMP}/gh-aw` is normally mounted into the sandbox, so host-only
 * tool paths such as setup-uv's `UV_CACHE_DIR=${RUNNER_TEMP}/setup-uv-cache`
 * and `UV_PYTHON_INSTALL_DIR=${RUNNER_TEMP}/uv-python-dir` would point at
 * locations the agent cannot create or write. Dropping them lets tools fall
 * back to their defaults under the allowlisted `$HOME` directories. The
 * unmounted directories are deliberately not made writable: setup-uv's post
 * step would otherwise save agent-written files into the Actions cache.
 * Explicit `--env` values are applied later and are not affected.
 */
function dropUnmountedRunnerTempPaths(
  config: WrapperConfig,
  environment: Record<string, string>,
  preexistingKeys: Set<string>,
): void {
  const runnerTempValue = process.env.RUNNER_TEMP;
  if (!runnerTempValue || !path.posix.isAbsolute(runnerTempValue)) {
    return;
  }
  const runnerTemp = path.posix.normalize(runnerTempValue).replace(/\/+$/, '') || '/';
  if (runnerTemp === '/') {
    return;
  }

  let mountedRoots: string[] | undefined;
  for (const [key, value] of Object.entries(environment)) {
    if (key === 'RUNNER_TEMP' || preexistingKeys.has(key) || !path.posix.isAbsolute(value)) {
      continue;
    }
    const candidate = path.posix.normalize(value).replace(/\/+$/, '') || '/';
    if (candidate === runnerTemp || !isAtOrBelow(candidate, runnerTemp)) {
      continue;
    }
    mountedRoots ??= mountedChrootRoots(
      config,
      process.env.GITHUB_WORKSPACE || process.cwd(),
      getRealUserHome(),
    );
    if (mountedRoots.some((root) => isAtOrBelow(candidate, root))) {
      continue;
    }
    delete environment[key];
    logger.debug(
      `Not forwarding ${key} from --env-all: ${candidate} is under RUNNER_TEMP but not mounted into the sandbox`
    );
  }
}
