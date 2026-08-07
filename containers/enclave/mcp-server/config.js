'use strict';

const fs = require('fs');
const path = require('path');
const {
  MAX_ENCLAVE_TIMEOUT_SECONDS,
  MAX_RESULT_BYTES,
  MAX_SCRIPT_BYTES,
} = require('../../bounded-execution/finite-disclosure');
const { ENCLAVE_SENSITIVITY_RUN_BITS } = require('../../bounded-execution/sensitivity-policy');
const { parsePrivateRepositorySeedMap } = require('../../bounded-execution/repository-staging');
const {
  ENCLAVE_INVOCATION_LABEL,
  ENCLAVE_RUN_LABEL,
} = require('../script-executor/script-runner-spec');
const { MAX_TASK_BYTES } = require('../agent-executor/framing');

const SEEDS_DIR = '/srv/awf/seeds';
const WORK_DIR = '/srv/awf/work';
const SEED_MAP_PATH = '/srv/awf/seed-map.json';
const CAPABILITY_DIR = '/run/awf-enclave-mcp';
const CAPABILITY_PATH = path.join(CAPABILITY_DIR, 'auth-token');
const CONTROL_DIR = '/run/awf-enclave-mcp-control';
const AUDIT_DIR = '/var/log/awf-enclave';
const READY_PATH = path.join(CONTROL_DIR, 'server.ready');
const MCP_PORT = 8080;

/**
 * Fixed agent-enclave mount points and identity. Never caller-supplied.
 *
 * The seccomp profile is the audited no-network sandbox profile the script
 * executor already uses, shipped into the server image a second time under an
 * enclave-specific name so both executors stay pinned to one reviewed policy.
 */
const AGENT_SECCOMP_PATH = '/opt/awf/enclave-seccomp.json';
const AGENT_MOUNT_DIR = '/agent';
const AGENT_SEED_PATH = '/awf/seed';
const AGENT_TASK_PATH = '/awf/task.txt';
const AGENT_SCHEMA_PATH = '/awf/schema.json';
const AGENT_UID = 65534;
const AGENT_GID = 65534;
const AGENT_SUPPORTED_BACKENDS = new Set(['docker', 'gvisor']);
const AGENT_SUPPORTED_ENGINES = new Set(['copilot']);
const AGENT_SUPPORTED_PROFILES = new Set(['openai', 'anthropic']);
const AGENT_CONTAINER_PREFIX = 'awf-enclave-agent';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInt(name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function dockerSize(name, fallback) {
  const value = process.env[name] || fallback;
  if (!/^[1-9][0-9]*[bkmgBKMG]$/.test(value)) {
    throw new Error(`${name} must be a Docker size such as 64m`);
  }
  return value.toLowerCase();
}

function loadConfig(files = fs) {
  const executorBackend = requireEnv('AWF_ENCLAVE_BACKEND');
  if (executorBackend !== 'docker' && executorBackend !== 'gvisor') {
    throw new Error('AWF_ENCLAVE_BACKEND must be docker or gvisor');
  }
  const primaryBackend = requireEnv('AWF_ENCLAVE_PRIMARY_BACKEND');
  if (primaryBackend !== 'docker' && primaryBackend !== 'gvisor' && primaryBackend !== 'sbx') {
    throw new Error('AWF_ENCLAVE_PRIMARY_BACKEND is unsupported');
  }
  const cpuLimit = process.env.AWF_ENCLAVE_CPU || '1';
  if (!/^(?:[0-9]{1,2})(?:\.[0-9]{1,3})?$/.test(cpuLimit) || Number(cpuLimit) <= 0) {
    throw new Error('AWF_ENCLAVE_CPU must be a positive decimal');
  }
  const timeoutSeconds = positiveInt(
    'AWF_ENCLAVE_TIMEOUT',
    30,
    MAX_ENCLAVE_TIMEOUT_SECONDS,
  );
  const capability = files.readFileSync(CAPABILITY_PATH, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(capability)) {
    throw new Error('Enclave capability file does not contain an AWF capability');
  }

  return {
    seedsDir: SEEDS_DIR,
    workDir: WORK_DIR,
    seedMapPath: SEED_MAP_PATH,
    hostWorkDir: requireEnv('AWF_ENCLAVE_HOST_WORK_DIR'),
    listenHost: process.env.AWF_ENCLAVE_LISTEN_HOST || '0.0.0.0',
    listenPort: MCP_PORT,
    controlDir: CONTROL_DIR,
    readyPath: READY_PATH,
    auditDir: AUDIT_DIR,
    querySeccompPath: '/opt/awf/script-seccomp.json',
    queryMountDir: '/query',
    queryScriptPath: '/awf/query-script.py',
    queryUid: 65534,
    queryGid: 65534,
    queryImage: requireEnv('AWF_ENCLAVE_IMAGE'),
    executorBackend,
    primaryBackend,
    timeoutSeconds,
    maxInvocations: positiveInt('AWF_ENCLAVE_MAX_INVOCATIONS', 32),
    memoryLimit: dockerSize('AWF_ENCLAVE_MEMORY', '512m'),
    cpuLimit,
    pidsLimit: positiveInt('AWF_ENCLAVE_PIDS', 128),
    tmpfsLimit: dockerSize('AWF_ENCLAVE_TMPFS', '64m'),
    maxOutputBytes: positiveInt('AWF_ENCLAVE_MAX_OUTPUT_BYTES', MAX_RESULT_BYTES, MAX_RESULT_BYTES),
    maxScriptBytes: positiveInt('AWF_ENCLAVE_MAX_SCRIPT_BYTES', MAX_SCRIPT_BYTES, MAX_SCRIPT_BYTES),
    capability,
    runLabelKey: ENCLAVE_RUN_LABEL,
    invocationLabelKey: ENCLAVE_INVOCATION_LABEL,
    containerPrefix: 'awf-enclave-script',
  };
}

/** True when this run exposes the bounded-script executor. */
function isScriptExecutorEnabled() {
  return process.env.AWF_ENCLAVE_SCRIPT_ENABLED === 'true';
}

/** True when this run exposes the enclave-agent executor. */
function isAgentExecutorEnabled() {
  return process.env.AWF_ENCLAVE_AGENT_ENABLED === 'true';
}

/**
 * Loads the shared, executor-independent server settings.
 *
 * Used on every start, including agent-only runs where no script-executor
 * environment is present at all.
 */
function loadServerConfig(files = fs) {
  const primaryBackend = requireEnv('AWF_ENCLAVE_PRIMARY_BACKEND');
  if (primaryBackend !== 'docker' && primaryBackend !== 'gvisor' && primaryBackend !== 'sbx') {
    throw new Error('AWF_ENCLAVE_PRIMARY_BACKEND is unsupported');
  }
  const capability = files.readFileSync(CAPABILITY_PATH, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(capability)) {
    throw new Error('Enclave capability file does not contain an AWF capability');
  }
  return {
    seedMapPath: SEED_MAP_PATH,
    listenHost: process.env.AWF_ENCLAVE_LISTEN_HOST || '0.0.0.0',
    listenPort: MCP_PORT,
    controlDir: CONTROL_DIR,
    readyPath: READY_PATH,
    auditDir: AUDIT_DIR,
    primaryBackend,
    capability,
  };
}

/**
 * Loads the trusted enclave-agent executor configuration.
 *
 * Every value here is AWF configuration delivered through the server's own
 * environment: image, runtime backend, engine, profile, model, API-proxy
 * endpoint, dedicated network, mount points, identity, resource bounds, and
 * disclosure bounds. A request can express none of them.
 */
function loadAgentConfig(server) {
  const backend = requireEnv('AWF_ENCLAVE_AGENT_BACKEND');
  if (!AGENT_SUPPORTED_BACKENDS.has(backend)) {
    throw new Error(`Unsupported AWF_ENCLAVE_AGENT_BACKEND: ${backend}`);
  }
  const engine = requireEnv('AWF_ENCLAVE_AGENT_ENGINE');
  if (!AGENT_SUPPORTED_ENGINES.has(engine)) {
    throw new Error(`Unsupported AWF_ENCLAVE_AGENT_ENGINE: ${engine}`);
  }
  const profile = requireEnv('AWF_ENCLAVE_AGENT_PROFILE');
  if (!AGENT_SUPPORTED_PROFILES.has(profile)) {
    throw new Error(`Unsupported AWF_ENCLAVE_AGENT_PROFILE: ${profile}`);
  }
  const apiEndpoint = requireEnv('AWF_ENCLAVE_AGENT_API_ENDPOINT');
  if (!/^http:\/\/[0-9a-zA-Z.:-]+$/.test(apiEndpoint)) {
    throw new Error('AWF_ENCLAVE_AGENT_API_ENDPOINT must be a bare http origin');
  }
  const network = requireEnv('AWF_ENCLAVE_AGENT_NETWORK');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network)) {
    throw new Error('AWF_ENCLAVE_AGENT_NETWORK is not a Docker network name');
  }
  const cpuLimit = process.env.AWF_ENCLAVE_AGENT_CPU || '1';
  if (!/^(?:[0-9]{1,2})(?:\.[0-9]{1,3})?$/.test(cpuLimit) || Number(cpuLimit) <= 0) {
    throw new Error('AWF_ENCLAVE_AGENT_CPU must be a positive decimal');
  }

  return {
    seedsDir: SEEDS_DIR,
    workDir: WORK_DIR,
    auditDir: server.auditDir,
    hostWorkDir: requireEnv('AWF_ENCLAVE_AGENT_HOST_WORK_DIR'),
    hostSeedsDir: requireEnv('AWF_ENCLAVE_AGENT_HOST_SEEDS_DIR'),
    enclaveSeccompPath: AGENT_SECCOMP_PATH,
    enclaveMountDir: AGENT_MOUNT_DIR,
    enclaveSeedPath: AGENT_SEED_PATH,
    enclaveTaskPath: AGENT_TASK_PATH,
    enclaveSchemaPath: AGENT_SCHEMA_PATH,
    enclaveUid: AGENT_UID,
    enclaveGid: AGENT_GID,
    enclaveHostname: 'enclave-agent',
    enclaveImage: requireEnv('AWF_ENCLAVE_AGENT_IMAGE'),
    backend,
    executorBackend: backend,
    primaryBackend: server.primaryBackend,
    engine,
    profile,
    model: requireEnv('AWF_ENCLAVE_AGENT_MODEL'),
    apiEndpoint,
    network,
    timeoutSeconds: positiveInt('AWF_ENCLAVE_AGENT_TIMEOUT', 120, MAX_ENCLAVE_TIMEOUT_SECONDS),
    memoryLimit: dockerSize('AWF_ENCLAVE_AGENT_MEMORY', '512m'),
    cpuLimit,
    pidsLimit: positiveInt('AWF_ENCLAVE_AGENT_PIDS', 128),
    tmpfsLimit: dockerSize('AWF_ENCLAVE_AGENT_TMPFS', '64m'),
    maxOutputBytes: positiveInt('AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES', MAX_RESULT_BYTES, MAX_RESULT_BYTES),
    maxPromptBytes: positiveInt('AWF_ENCLAVE_AGENT_MAX_PROMPT_BYTES', 4096, MAX_TASK_BYTES),
    maxInvocations: positiveInt('AWF_ENCLAVE_AGENT_MAX_INVOCATIONS', 8),
    runLabelKey: ENCLAVE_RUN_LABEL,
    invocationLabelKey: ENCLAVE_INVOCATION_LABEL,
    containerPrefix: AGENT_CONTAINER_PREFIX,
  };
}

function loadSeedMap(seedMapPath) {
  return parsePrivateRepositorySeedMap(
    fs.readFileSync(seedMapPath, 'utf8'),
    ENCLAVE_SENSITIVITY_RUN_BITS,
  );
}

module.exports = {
  AGENT_CONTAINER_PREFIX,
  AGENT_SECCOMP_PATH,
  AGENT_SUPPORTED_BACKENDS,
  AGENT_SUPPORTED_ENGINES,
  AGENT_SUPPORTED_PROFILES,
  AUDIT_DIR,
  CAPABILITY_PATH,
  CONTROL_DIR,
  READY_PATH,
  SEED_MAP_PATH,
  SEEDS_DIR,
  CAPABILITY_DIR,
  WORK_DIR,
  isAgentExecutorEnabled,
  isScriptExecutorEnabled,
  loadAgentConfig,
  loadConfig,
  loadSeedMap,
  loadServerConfig,
};
