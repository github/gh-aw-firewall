'use strict';

const fs = require('fs');
const path = require('path');
const {
  MAX_QUERY_TIMEOUT_SECONDS,
  MAX_RESULT_BYTES,
  MAX_SCRIPT_BYTES,
} = require('../bounded-execution/finite-disclosure');
const { ENCLAVE_SENSITIVITY_RUN_BITS } = require('../bounded-execution/sensitivity-policy');
const { parsePrivateRepositorySeedMap } = require('../bounded-execution/repository-staging');
const {
  ENCLAVE_INVOCATION_LABEL,
  ENCLAVE_RUN_LABEL,
} = require('../broker/query-runner-spec');

const SEEDS_DIR = '/srv/awf/seeds';
const WORK_DIR = '/srv/awf/work';
const SEED_MAP_PATH = '/srv/awf/seed-map.json';
const SOCKET_DIR = '/run/awf-enclave-mcp';
const CAPABILITY_PATH = path.join(SOCKET_DIR, 'auth-token');
const CONTROL_DIR = '/run/awf-enclave-mcp-control';
const AUDIT_DIR = '/var/log/awf-enclave';
const READY_PATH = path.join(CONTROL_DIR, 'server.ready');

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

function nonnegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
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
  const queryBackend = requireEnv('AWF_ENCLAVE_BACKEND');
  if (queryBackend !== 'docker' && queryBackend !== 'gvisor') {
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
    MAX_QUERY_TIMEOUT_SECONDS,
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
    socketDir: SOCKET_DIR,
    socketPath: path.join(SOCKET_DIR, 'server.sock'),
    controlDir: CONTROL_DIR,
    readyPath: READY_PATH,
    auditDir: AUDIT_DIR,
    querySeccompPath: '/opt/awf/query-seccomp.json',
    queryMountDir: '/query',
    queryScriptPath: '/awf/query-script.py',
    queryUid: 65534,
    queryGid: 65534,
    queryImage: requireEnv('AWF_ENCLAVE_IMAGE'),
    queryBackend,
    primaryBackend,
    timeoutSeconds,
    maxInvocations: positiveInt('AWF_ENCLAVE_MAX_INVOCATIONS', 32),
    memoryLimit: dockerSize('AWF_ENCLAVE_MEMORY', '512m'),
    cpuLimit,
    pidsLimit: positiveInt('AWF_ENCLAVE_PIDS', 128),
    tmpfsLimit: dockerSize('AWF_ENCLAVE_TMPFS', '64m'),
    maxOutputBytes: positiveInt('AWF_ENCLAVE_MAX_OUTPUT_BYTES', MAX_RESULT_BYTES, MAX_RESULT_BYTES),
    maxScriptBytes: positiveInt('AWF_ENCLAVE_MAX_SCRIPT_BYTES', MAX_SCRIPT_BYTES, MAX_SCRIPT_BYTES),
    socketUid: nonnegativeInt('AWF_ENCLAVE_SOCKET_UID', 0),
    socketGid: nonnegativeInt('AWF_ENCLAVE_SOCKET_GID', 0),
    capability,
    runLabelKey: ENCLAVE_RUN_LABEL,
    invocationLabelKey: ENCLAVE_INVOCATION_LABEL,
    containerPrefix: 'awf-enclave-script',
  };
}

function loadSeedMap(seedMapPath) {
  return parsePrivateRepositorySeedMap(
    fs.readFileSync(seedMapPath, 'utf8'),
    ENCLAVE_SENSITIVITY_RUN_BITS,
  );
}

module.exports = {
  AUDIT_DIR,
  CAPABILITY_PATH,
  CONTROL_DIR,
  READY_PATH,
  SEED_MAP_PATH,
  SEEDS_DIR,
  SOCKET_DIR,
  WORK_DIR,
  loadConfig,
  loadSeedMap,
};
