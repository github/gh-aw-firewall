'use strict';

/** Extra grace beyond the query's wall-clock budget for docker CLI overhead. */
const CLI_GRACE_MS = 5_000;

/** Maximum file size a query may create, in bytes (per-file RLIMIT_FSIZE). */
const QUERY_MAX_FILE_BYTES = 512 * 1024 * 1024;

/** Aggregate size limit for the query's writable tmpfs workspace in bytes. */
const QUERY_WORKSPACE_TMPFS_BYTES = 1024 * 1024 * 1024;

const ENCLAVE_RUN_LABEL = 'awf.enclave.run';
const ENCLAVE_INVOCATION_LABEL = 'awf.enclave.invocation';
const TRUSTED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Converts a monotonic-clock duration to the integer milliseconds Node requires. */
function normalizeTimeoutMs(timeoutMs) {
  return Math.max(1, Math.ceil(timeoutMs));
}

function assertTrustedId(name, value) {
  if (typeof value !== 'string' || !TRUSTED_ID_PATTERN.test(value)) {
    throw new Error(`${name} is not a broker-generated identifier`);
  }
}

function freezeArray(values) {
  return Object.freeze(values);
}

/**
 * Derives every daemon-facing query setting from trusted config and
 * broker-generated identifiers. No request object is accepted by this API.
 */
function deriveQueryContainerSpec({ config, runId, invocationId, runtimeName }) {
  assertTrustedId('runId', runId);
  assertTrustedId('invocationId', invocationId);
  if (runtimeName !== undefined && runtimeName !== 'runsc') {
    throw new Error(`Unsupported OCI runtime in query runner: ${runtimeName}`);
  }

  const runLabelKey = config.runLabelKey || ENCLAVE_RUN_LABEL;
  const invocationLabelKey = config.invocationLabelKey || ENCLAVE_INVOCATION_LABEL;
  const containerPrefix = config.containerPrefix || 'awf-enclave-script';
  const containerName = `${containerPrefix}-${runId.slice(0, 12)}-${invocationId}`;
  const hostInvocationDir = `${config.hostWorkDir}/${invocationId}`;
  const runLabel = `${runLabelKey}=${runId}`;
  const invocationLabel = `${invocationLabelKey}=${invocationId}`;
  const cpuLimit = config.cpuLimit || '1';
  const pidsLimit = config.pidsLimit || 128;
  const tmpfsLimit = config.tmpfsLimit;
  const launchArgs = [
    'run',
    '--pull', 'never',
    '--name', containerName,
    '--label', runLabel,
    '--label', invocationLabel,
    '--network', 'none',
    '--read-only',
    '--user', `${config.queryUid}:${config.queryGid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--security-opt', `seccomp=${config.querySeccompPath}`,
    '--memory', config.memoryLimit,
    '--memory-swap', config.memoryLimit,
    '--cpus', cpuLimit,
    '--pids-limit', String(pidsLimit),
    '--ulimit', `fsize=${QUERY_MAX_FILE_BYTES}`,
    '--ulimit', 'nofile=1024:1024',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${tmpfsLimit || '16m'}`,
    '--tmpfs', `/query:rw,nosuid,nodev,size=${tmpfsLimit || QUERY_WORKSPACE_TMPFS_BYTES},uid=${config.queryUid},gid=${config.queryGid},mode=0700`,
    '--hostname', 'query',
    '--workdir', config.queryMountDir,
    '--env', 'HOME=/tmp',
    '--env', 'PYTHONDONTWRITEBYTECODE=1',
    '--env', 'PYTHONUNBUFFERED=1',
    '-v', `${hostInvocationDir}/repo:/awf/seed:ro`,
    '-v', `${hostInvocationDir}/out:/awf/out:rw`,
    '-v', `${hostInvocationDir}/script.py:${config.queryScriptPath}:ro`,
  ];

  if (runtimeName !== undefined) {
    launchArgs.push('--runtime', runtimeName);
  }
  launchArgs.push('--entrypoint', '/usr/local/bin/run-enclave-script', config.queryImage);

  return Object.freeze({
    containerName,
    runtimeName,
    launchArgs: freezeArray(launchArgs),
    invocationListArgs: freezeArray([
      'ps', '-aq',
      '--filter', `label=${runLabel}`,
      '--filter', `label=${invocationLabel}`,
    ]),
    runListArgs: freezeArray(['ps', '-aq', '--filter', `label=${runLabel}`]),
  });
}

function buildRemoveArgs(containerIds) {
  return freezeArray(['rm', '-f', ...containerIds]);
}

module.exports = {
  CLI_GRACE_MS,
  ENCLAVE_INVOCATION_LABEL,
  ENCLAVE_RUN_LABEL,
  QUERY_MAX_FILE_BYTES,
  QUERY_WORKSPACE_TMPFS_BYTES,
  buildRemoveArgs,
  deriveQueryContainerSpec,
  normalizeTimeoutMs,
};
