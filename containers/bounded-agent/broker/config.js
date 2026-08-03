'use strict';

const fs = require('fs');
const path = require('path');
const { MAX_QUERY_TIMEOUT_SECONDS, MAX_RESULT_BYTES } = require('./protocol');
const { BOUNDED_QUERY_SENSITIVITY_RUN_BITS } = require('./sensitivity');
const { parsePrivateRepositorySeedMap } = require('../bounded-execution/repository-staging');

/**
 * Bounded-agent broker configuration.
 *
 * Everything here is supplied by AWF through the container environment and
 * fixed mount points. Nothing in this file is influenced by a request: the
 * caller cannot choose an image, a runtime, a network, an endpoint, a model, a
 * profile, a path, a mount, a limit, or a timeout.
 */

const SEEDS_DIR = '/srv/awf/seeds';
const WORK_DIR = '/srv/awf/work';
const SEED_MAP_PATH = '/srv/awf/seed-map.json';
const SOCKET_DIR = '/run/awf-bounded-agent';
const SOCKET_PATH = path.join(SOCKET_DIR, 'broker.sock');
const CONTROL_DIR = '/run/awf-bounded-agent-control';
const AUDIT_DIR = '/var/log/awf-bounded-agent';
/** Broker-private readiness marker; the control directory is never agent-mounted. */
const READY_PATH = path.join(CONTROL_DIR, 'broker.ready');
const ENCLAVE_SECCOMP_PATH = '/opt/awf/enclave-seccomp.json';

/** Mount points inside the enclave container. Fixed, never caller-supplied. */
const ENCLAVE_MOUNT_DIR = '/agent';
const ENCLAVE_SEED_PATH = '/awf/seed';
const ENCLAVE_TASK_PATH = '/awf/task.txt';
const ENCLAVE_SCHEMA_PATH = '/awf/schema.json';

/** Unprivileged uid/gid the enclave process runs as. */
const ENCLAVE_UID = 65534;
const ENCLAVE_GID = 65534;

/** Hard ceiling on the caller-supplied task text, mirrored from the TS protocol. */
const MAX_TASK_BYTES = 64 * 1024;

const SUPPORTED_BACKENDS = new Set(['docker', 'gvisor', 'sbx']);
const SUPPORTED_PROFILES = new Set(['openai', 'anthropic']);
const PRIMARY_BACKENDS = new Set(['docker', 'gvisor', 'sbx']);
const SBX_CAPABILITY_PATH = path.join(CONTROL_DIR, 'sbx-ingress.json');

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoundedInt(name, fallback, maximum) {
  const parsed = parsePositiveInt(name, fallback);
  if (parsed > maximum) {
    throw new Error(`Environment variable ${name} must be at most ${maximum}`);
  }
  return parsed;
}

/**
 * Parses the per-invocation timeout, additionally re-enforcing (defense in
 * depth; AWF's host-side preflight already rejects an out-of-range value
 * before this container ever starts) that it preserves the final response
 * bucket's post-processing margin.
 */
function parseTimeoutSeconds() {
  const parsed = parsePositiveInt('AWF_BOUNDED_AGENT_TIMEOUT', 120);
  if (parsed > MAX_QUERY_TIMEOUT_SECONDS) {
    throw new Error(
      `Environment variable AWF_BOUNDED_AGENT_TIMEOUT must be at most ${MAX_QUERY_TIMEOUT_SECONDS} seconds ` +
      '(the final response bucket reserves one minute for termination, validation, and cleanup)',
    );
  }
  return parsed;
}

function parseDockerSize(name, fallback) {
  const value = process.env[name] || fallback;
  if (!/^[1-9][0-9]*[bkmgBKMG]$/.test(value)) {
    throw new Error(`${name} must be a Docker size limit (e.g. "512m")`);
  }
  return value;
}

/**
 * Loads the two capability tokens the broker's TCP listener requires on
 * every request when reachability is via authenticated primary-sbx ingress
 * (never used for the Unix-socket transport). Generated fresh per run on the
 * trusted host only after runtime proofs succeed; never logged, telemetered,
 * or written to any audit/skill surface.
 */
function loadSbxIngressCapabilities(capabilityPath) {
  const parsed = JSON.parse(fs.readFileSync(capabilityPath, 'utf8'));
  const pattern = /^[0-9a-f]{64}$/;
  if (
    !parsed
    || parsed.version !== 1
    || typeof parsed.query !== 'string'
    || typeof parsed.probe !== 'string'
    || !pattern.test(parsed.query)
    || !pattern.test(parsed.probe)
    || parsed.query === parsed.probe
  ) {
    throw new Error('SBX ingress capability file is malformed');
  }
  return { query: parsed.query, probe: parsed.probe };
}

function loadConfig() {
  const backend = requireEnv('AWF_BOUNDED_AGENT_BACKEND');
  if (!SUPPORTED_BACKENDS.has(backend)) {
    throw new Error(`Unsupported AWF_BOUNDED_AGENT_BACKEND: ${backend}`);
  }

  const profile = requireEnv('AWF_BOUNDED_AGENT_PROFILE');
  if (!SUPPORTED_PROFILES.has(profile)) {
    throw new Error(`Unsupported AWF_BOUNDED_AGENT_PROFILE: ${profile}`);
  }

  const apiEndpoint = requireEnv('AWF_BOUNDED_AGENT_API_ENDPOINT');
  if (!/^http:\/\/[0-9a-zA-Z.:-]+$/.test(apiEndpoint)) {
    throw new Error('AWF_BOUNDED_AGENT_API_ENDPOINT must be a bare http origin');
  }

  const network = requireEnv('AWF_BOUNDED_AGENT_NETWORK');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network)) {
    throw new Error('AWF_BOUNDED_AGENT_NETWORK is not a Docker network name');
  }

  const primaryBackend = requireEnv('AWF_BOUNDED_AGENT_PRIMARY_BACKEND');
  if (!PRIMARY_BACKENDS.has(primaryBackend)) {
    throw new Error(`Unsupported AWF_BOUNDED_AGENT_PRIMARY_BACKEND: ${primaryBackend}`);
  }

  const tcpPortRaw = process.env.AWF_BOUNDED_AGENT_TCP_PORT;
  const tcpPort = tcpPortRaw === undefined ? undefined : parsePositiveInt('AWF_BOUNDED_AGENT_TCP_PORT');
  if (tcpPort !== undefined && tcpPort > 65535) {
    throw new Error('AWF_BOUNDED_AGENT_TCP_PORT must be a valid TCP port');
  }

  // sbx and Docker daemons can have different filesystem namespaces
  // (ARC/DinD); never reuse the Docker-daemon-visible paths for sbx mounts.
  const sbxWorkDir = backend === 'sbx' ? requireEnv('AWF_BOUNDED_AGENT_SBX_WORK_DIR') : undefined;
  const sbxSeedsDir = backend === 'sbx' ? requireEnv('AWF_BOUNDED_AGENT_SBX_SEEDS_DIR') : undefined;

  return {
    seedsDir: SEEDS_DIR,
    workDir: WORK_DIR,
    seedMapPath: SEED_MAP_PATH,
    socketDir: SOCKET_DIR,
    socketPath: SOCKET_PATH,
    controlDir: CONTROL_DIR,
    readyPath: READY_PATH,
    auditDir: AUDIT_DIR,
    enclaveSeccompPath: ENCLAVE_SECCOMP_PATH,
    enclaveMountDir: ENCLAVE_MOUNT_DIR,
    enclaveSeedPath: ENCLAVE_SEED_PATH,
    enclaveTaskPath: ENCLAVE_TASK_PATH,
    enclaveSchemaPath: ENCLAVE_SCHEMA_PATH,
    enclaveUid: ENCLAVE_UID,
    enclaveGid: ENCLAVE_GID,
    enclaveImage: requireEnv('AWF_BOUNDED_AGENT_IMAGE'),
    backend,
    profile,
    model: requireEnv('AWF_BOUNDED_AGENT_MODEL'),
    apiEndpoint,
    network,
    // The daemon resolves enclave bind-mount sources in *its* filesystem view,
    // which is not necessarily the broker's (ARC/DinD split filesystems).
    hostWorkDir: requireEnv('AWF_BOUNDED_AGENT_HOST_WORK_DIR'),
    hostSeedsDir: requireEnv('AWF_BOUNDED_AGENT_HOST_SEEDS_DIR'),
    sbxWorkDir,
    sbxSeedsDir,
    primaryBackend,
    tcpPort,
    sbxIngressCapabilities: tcpPort === undefined
      ? undefined
      : loadSbxIngressCapabilities(SBX_CAPABILITY_PATH),
    timeoutSeconds: parseTimeoutSeconds(),
    memoryLimit: parseDockerSize('AWF_BOUNDED_AGENT_MEMORY', '512m'),
    tmpfsLimit: parseDockerSize('AWF_BOUNDED_AGENT_TMPFS', '64m'),
    cpuLimit: process.env.AWF_BOUNDED_AGENT_CPUS || '1',
    pidsLimit: parseBoundedInt('AWF_BOUNDED_AGENT_PIDS', 128, 4096),
    maxOutputBytes: parseBoundedInt('AWF_BOUNDED_AGENT_MAX_OUTPUT_BYTES', MAX_RESULT_BYTES, MAX_RESULT_BYTES),
    maxTaskBytes: parseBoundedInt('AWF_BOUNDED_AGENT_MAX_TASK_BYTES', 4096, MAX_TASK_BYTES),
    maxInvocations: parsePositiveInt('AWF_BOUNDED_AGENT_MAX_INVOCATIONS', 8),
    maxModelRequests: parseBoundedInt('AWF_BOUNDED_AGENT_MAX_MODEL_REQUESTS', 8, 64),
    maxModelTokens: parseBoundedInt('AWF_BOUNDED_AGENT_MAX_MODEL_TOKENS', 1024, 32768),
    socketUid: parsePositiveInt('AWF_BOUNDED_AGENT_SOCKET_UID', 0),
    socketGid: parsePositiveInt('AWF_BOUNDED_AGENT_SOCKET_GID', 0),
  };
}

/**
 * Loads the AWF-generated repo → { opaque seed id, sensitivity } map.
 *
 * The map is the *only* way a repository can be selected: a request supplies a
 * normalized `owner/repo` id, which is looked up here. Callers never supply a
 * path, and an unknown id is simply absent from the map. Sensitivity is
 * carried in the (AWF-trusted, host-written) map itself, never accepted from a
 * request. The bounded-agent broker loads its *own* map from its own private
 * root, so its ledger is disjoint from the bounded-query ledger.
 */
function loadSeedMap(seedMapPath) {
  return parsePrivateRepositorySeedMap(
    fs.readFileSync(seedMapPath, 'utf8'),
    BOUNDED_QUERY_SENSITIVITY_RUN_BITS,
  );
}

module.exports = {
  READY_PATH,
  SBX_CAPABILITY_PATH,
  MAX_TASK_BYTES,
  SUPPORTED_BACKENDS,
  SUPPORTED_PROFILES,
  PRIMARY_BACKENDS,
  loadConfig,
  loadSeedMap,
  loadSbxIngressCapabilities,
};
