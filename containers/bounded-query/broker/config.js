'use strict';

const fs = require('fs');
const path = require('path');
const { MAX_QUERY_TIMEOUT_SECONDS } = require('./protocol');
const { BOUNDED_QUERY_SENSITIVITY_RUN_BITS } = require('./sensitivity');

/**
 * Broker configuration.
 *
 * Everything here is supplied by AWF through the container environment and
 * fixed mount points. Nothing in this file is influenced by a query request:
 * the caller cannot choose an image, a runtime, a path, a mount, a limit, or
 * a timeout.
 */

const SEEDS_DIR = '/srv/awf/seeds';
const WORK_DIR = '/srv/awf/work';
const SEED_MAP_PATH = '/srv/awf/seed-map.json';
const SOCKET_DIR = '/run/awf-bounded-query';
const SOCKET_PATH = path.join(SOCKET_DIR, 'broker.sock');
const CONTROL_DIR = '/run/awf-bounded-query-control';
const AUDIT_DIR = '/var/log/awf-bounded-query';
/** Broker-private readiness marker; the control directory is never agent-mounted. */
const READY_PATH = path.join(CONTROL_DIR, 'broker.ready');
const SBX_CAPABILITY_PATH = path.join(CONTROL_DIR, 'sbx-ingress.json');
const QUERY_SECCOMP_PATH = '/opt/awf/query-seccomp.json';

/** Mount points inside the query container. Fixed, never caller-supplied. */
const QUERY_MOUNT_DIR = '/query';
const QUERY_SCRIPT_PATH = '/awf/query-script.py';

/** Unprivileged uid/gid the query process runs as. */
const QUERY_UID = 65534;
const QUERY_GID = 65534;

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

/**
 * Parses the per-invocation timeout, additionally re-enforcing (defense in
 * depth; AWF's host-side preflight already rejects an out-of-range value
 * before this container ever starts) that it preserves the final response
 * bucket's post-processing margin.
 */
function parseTimeoutSeconds() {
  const parsed = parsePositiveInt('AWF_BOUNDED_QUERY_TIMEOUT', 30);
  if (parsed > MAX_QUERY_TIMEOUT_SECONDS) {
    throw new Error(
      `Environment variable AWF_BOUNDED_QUERY_TIMEOUT must be at most ${MAX_QUERY_TIMEOUT_SECONDS} seconds ` +
      '(the final response bucket reserves one minute for termination, validation, and cleanup)',
    );
  }
  return parsed;
}

function loadConfig() {
  const memoryLimit = process.env.AWF_BOUNDED_QUERY_MEMORY || '512m';
  if (!/^[1-9][0-9]*[bkmgBKMG]$/.test(memoryLimit)) {
    throw new Error('AWF_BOUNDED_QUERY_MEMORY must be a Docker memory limit (e.g. "512m")');
  }

  const queryBackend = requireEnv('AWF_BOUNDED_QUERY_BACKEND');
  if (queryBackend !== 'docker' && queryBackend !== 'gvisor' && queryBackend !== 'sbx') {
    throw new Error(`Unsupported AWF_BOUNDED_QUERY_BACKEND: ${queryBackend}`);
  }
  const primaryBackend = requireEnv('AWF_BOUNDED_QUERY_PRIMARY_BACKEND');
  if (primaryBackend !== 'docker' && primaryBackend !== 'gvisor' && primaryBackend !== 'sbx') {
    throw new Error(`Unsupported AWF_BOUNDED_QUERY_PRIMARY_BACKEND: ${primaryBackend}`);
  }

  const tcpPortRaw = process.env.AWF_BOUNDED_QUERY_TCP_PORT;
  const tcpPort = tcpPortRaw === undefined ? undefined : parsePositiveInt('AWF_BOUNDED_QUERY_TCP_PORT');
  if (tcpPort !== undefined && tcpPort > 65535) {
    throw new Error('AWF_BOUNDED_QUERY_TCP_PORT must be a valid TCP port');
  }

  return {
    seedsDir: SEEDS_DIR,
    workDir: WORK_DIR,
    seedMapPath: SEED_MAP_PATH,
    socketDir: SOCKET_DIR,
    socketPath: SOCKET_PATH,
    controlDir: CONTROL_DIR,
    readyPath: READY_PATH,
    auditDir: AUDIT_DIR,
    querySeccompPath: QUERY_SECCOMP_PATH,
    queryMountDir: QUERY_MOUNT_DIR,
    queryScriptPath: QUERY_SCRIPT_PATH,
    queryUid: QUERY_UID,
    queryGid: QUERY_GID,
    queryImage: requireEnv('AWF_BOUNDED_QUERY_IMAGE'),
    // The daemon resolves query bind-mount sources in *its* filesystem view,
    // which is not necessarily the broker's (ARC/DinD split filesystems).
    hostWorkDir: requireEnv('AWF_BOUNDED_QUERY_HOST_WORK_DIR'),
    queryBackend,
    primaryBackend,
    timeoutSeconds: parseTimeoutSeconds(),
    maxInvocations: parsePositiveInt('AWF_BOUNDED_QUERY_MAX_INVOCATIONS', 32),
    memoryLimit,
    socketUid: parsePositiveInt('AWF_BOUNDED_QUERY_SOCKET_UID', 0),
    socketGid: parsePositiveInt('AWF_BOUNDED_QUERY_SOCKET_GID', 0),
    tcpPort,
    sbxIngressCapabilities: tcpPort === undefined
      ? undefined
      : loadSbxIngressCapabilities(SBX_CAPABILITY_PATH),
  };
}

/**
 * Loads the AWF-generated repo → { opaque seed id, sensitivity } map.
 *
 * The map is the *only* way a repository can be selected: a request supplies
 * a normalized `owner/repo` id, which is looked up here. Callers never supply
 * a path, and an unknown id is simply absent from the map. Sensitivity is
 * carried in the (AWF-trusted, host-written) map itself, never accepted from
 * a request — a request cannot choose or override its repository's budget.
 */
function loadSeedMap(seedMapPath) {
  const parsed = JSON.parse(fs.readFileSync(seedMapPath, 'utf8'));
  if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.seeds)) {
    throw new Error('Seed map is malformed or is an unsupported version');
  }
  if (typeof parsed.runId !== 'string' || !/^[0-9a-f]{8,}$/.test(parsed.runId)) {
    throw new Error('Seed map has no usable runId');
  }

  const seeds = new Map();
  for (const entry of parsed.seeds) {
    if (
      !entry
      || typeof entry.repo !== 'string'
      || typeof entry.seedId !== 'string'
      || !Object.prototype.hasOwnProperty.call(BOUNDED_QUERY_SENSITIVITY_RUN_BITS, entry.sensitivity)
    ) {
      throw new Error('Seed map entry is malformed');
    }
    // Seed ids are AWF-generated opaque hex names. Re-validating here means a
    // corrupted map can never turn into a path traversal.
    if (!/^[0-9a-f]{16,64}$/.test(entry.seedId)) {
      throw new Error('Seed map entry has an unexpected seed id');
    }
    seeds.set(entry.repo.toLowerCase(), { seedId: entry.seedId, sensitivity: entry.sensitivity });
  }

  return { runId: parsed.runId, seeds };
}

module.exports = { READY_PATH, SBX_CAPABILITY_PATH, loadConfig, loadSeedMap, loadSbxIngressCapabilities };
