'use strict';

/**
 * Fixed enclave container specification.
 *
 * Every daemon-facing setting is derived from trusted broker configuration and
 * broker-generated identifiers. No request object is accepted by this API, and
 * the resulting argument vector is frozen: an invocation can never add, remove,
 * or reorder a flag.
 *
 * Isolation properties encoded here:
 *
 *  - `--network <enclave-agent network>`: the enclave joins *only* the
 *    dedicated `internal` enclave-agent network. Its sole reachable peer is
 *    the AWF API proxy; there is no `awf-net`, no `awf-ext`, no Squid, no
 *    general proxy, no primary agent, no broker, no safe-outputs collector, no
 *    MCP gateway, and no CLI proxy.
 *  - `--read-only` with the repository seed bind-mounted `ro`: the enclave can
 *    never mutate private source.
 *  - bounded `--tmpfs` mounts for `/tmp` and the `/agent` work/result root.
 *  - fixed non-root uid/gid, `--cap-drop ALL`, `no-new-privileges`, a seccomp
 *    profile, and memory/CPU/PID/file-size/timeout bounds.
 */

/** Extra grace beyond the enclave's wall-clock budget for docker CLI overhead. */
const CLI_GRACE_MS = 5_000;

/** Maximum file size the enclave may create, in bytes (per-file RLIMIT_FSIZE). */
const ENCLAVE_MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Labels shared by both enclave executors for unified orphan reconciliation. */
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

function assertTrustedSeedId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{16,64}$/.test(value)) {
    throw new Error('seedId is not an AWF-generated seed identifier');
  }
}

function freezeArray(values) {
  return Object.freeze(values);
}

/**
 * Derives every daemon-facing enclave setting from trusted config and
 * broker-generated identifiers.
 */
function deriveEnclaveContainerSpec({ config, runId, invocationId, seedId, runtimeName }) {
  assertTrustedId('runId', runId);
  assertTrustedId('invocationId', invocationId);
  assertTrustedSeedId(seedId);
  if (runtimeName !== undefined && runtimeName !== 'runsc') {
    throw new Error(`Unsupported OCI runtime in enclave runner: ${runtimeName}`);
  }

  // Label keys and the container prefix are trusted server configuration.
  const runLabelKey = config.runLabelKey || ENCLAVE_RUN_LABEL;
  const invocationLabelKey = config.invocationLabelKey || ENCLAVE_INVOCATION_LABEL;
  const containerPrefix = config.containerPrefix || 'awf-enclave-agent';
  const containerName = `${containerPrefix}-${runId.slice(0, 12)}-${invocationId}`;
  const hostInvocationDir = `${config.hostWorkDir}/${invocationId}`;
  const hostSeedDir = `${config.hostSeedsDir}/${seedId}`;
  const runLabel = `${runLabelKey}=${runId}`;
  const invocationLabel = `${invocationLabelKey}=${invocationId}`;
  const launchArgs = [
    'run',
    '--pull', 'never',
    '--name', containerName,
    '--label', runLabel,
    '--label', invocationLabel,
    '--network', config.network,
    '--read-only',
    '--user', `${config.enclaveUid}:${config.enclaveGid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--security-opt', `seccomp=${config.enclaveSeccompPath}`,
    '--memory', config.memoryLimit,
    '--memory-swap', config.memoryLimit,
    '--cpus', String(config.cpuLimit),
    '--pids-limit', String(config.pidsLimit),
    '--ulimit', `fsize=${ENCLAVE_MAX_FILE_BYTES}`,
    '--ulimit', 'nofile=1024:1024',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${config.tmpfsLimit}`,
    '--tmpfs',
    `${config.enclaveMountDir}:rw,nosuid,nodev,size=${config.tmpfsLimit},` +
      `uid=${config.enclaveUid},gid=${config.enclaveGid},mode=0700`,
    '--hostname', config.enclaveHostname || 'enclave-agent',
    '--workdir', config.enclaveSeedPath,
    '--env', `AWF_ENCLAVE_AGENT_ENGINE=${config.engine}`,
    '--env', `HOME=${config.enclaveMountDir}/home`,
    '--env', `COPILOT_HOME=${config.enclaveMountDir}/copilot`,
    '--env', 'COPILOT_OFFLINE=true',
    '--env', 'COPILOT_GITHUB_TOKEN=******',
    '--env', 'COPILOT_TOKEN=******',
    '--env', `COPILOT_API_URL=${config.apiEndpoint}`,
    '--env', `COPILOT_PROVIDER_BASE_URL=${config.apiEndpoint}`,
    '--env', `COPILOT_MODEL=${config.model}`,
    '--env', 'PYTHONDONTWRITEBYTECODE=1',
    '--env', 'PYTHONUNBUFFERED=1',
    '--env', `AWF_ENCLAVE_AGENT_API_ENDPOINT=${config.apiEndpoint}`,
    '--env', `AWF_ENCLAVE_AGENT_PROFILE=${config.profile}`,
    '--env', `AWF_ENCLAVE_AGENT_MODEL=${config.model}`,
    '--env', `AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES=${config.maxOutputBytes}`,
    '--env', `AWF_ENCLAVE_AGENT_DEADLINE_SECONDS=${config.timeoutSeconds}`,
    '-v', `${hostSeedDir}:${config.enclaveSeedPath}:ro`,
    '-v', `${hostInvocationDir}/task.txt:${config.enclaveTaskPath}:ro`,
    '-v', `${hostInvocationDir}/schema.json:${config.enclaveSchemaPath}:ro`,
    '-v', `${hostInvocationDir}/out:/awf/out:rw`,
    '-v', `${hostInvocationDir}/session.jsonl:/awf/session.jsonl:rw`,
  ];

  if (runtimeName !== undefined) {
    launchArgs.push('--runtime', runtimeName);
  }
  launchArgs.push('--entrypoint', '/usr/local/bin/run-enclave-agent', config.enclaveImage);

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
  ENCLAVE_MAX_FILE_BYTES,
  ENCLAVE_RUN_LABEL,
  buildRemoveArgs,
  deriveEnclaveContainerSpec,
  normalizeTimeoutMs,
};
