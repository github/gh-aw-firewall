'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Broker configuration.
 *
 * Everything here is supplied by AWF through the container environment and
 * fixed mount points. Nothing in this file is influenced by a probe request:
 * the caller cannot choose an image, a runtime, a path, a mount, a limit, or
 * a timeout.
 */

const SEEDS_DIR = '/srv/awf/seeds';
const WORK_DIR = '/srv/awf/work';
const SEED_MAP_PATH = '/srv/awf/seed-map.json';
const SOCKET_DIR = '/run/awf-sealed-probe';
const SOCKET_PATH = path.join(SOCKET_DIR, 'broker.sock');
const AUDIT_DIR = '/var/log/awf-sealed-probe';
/** Broker-private readiness marker; the audit directory is never agent-mounted. */
const READY_PATH = path.join(AUDIT_DIR, 'broker.ready');
const PROBE_SECCOMP_PATH = '/opt/awf/probe-seccomp.json';

/** Mount points inside the probe container. Fixed, never caller-supplied. */
const PROBE_MOUNT_DIR = '/probe';
const PROBE_SCRIPT_PATH = '/awf/probe-script.py';

/** Unprivileged uid/gid the probe process runs as. */
const PROBE_UID = 65534;
const PROBE_GID = 65534;

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

function loadConfig() {
  const memoryLimit = process.env.AWF_SEALED_PROBE_MEMORY || '512m';
  if (!/^[1-9][0-9]*[bkmgBKMG]$/.test(memoryLimit)) {
    throw new Error('AWF_SEALED_PROBE_MEMORY must be a Docker memory limit (e.g. "512m")');
  }

  const dockerRuntime = process.env.AWF_SEALED_PROBE_RUNTIME || '';
  if (dockerRuntime && !/^[A-Za-z0-9_.-]+$/.test(dockerRuntime)) {
    throw new Error('AWF_SEALED_PROBE_RUNTIME contains unexpected characters');
  }

  return {
    seedsDir: SEEDS_DIR,
    workDir: WORK_DIR,
    seedMapPath: SEED_MAP_PATH,
    socketDir: SOCKET_DIR,
    socketPath: SOCKET_PATH,
    readyPath: READY_PATH,
    auditDir: AUDIT_DIR,
    probeSeccompPath: PROBE_SECCOMP_PATH,
    probeMountDir: PROBE_MOUNT_DIR,
    probeScriptPath: PROBE_SCRIPT_PATH,
    probeUid: PROBE_UID,
    probeGid: PROBE_GID,
    probeImage: requireEnv('AWF_SEALED_PROBE_IMAGE'),
    // The daemon resolves probe bind-mount sources in *its* filesystem view,
    // which is not necessarily the broker's (ARC/DinD split filesystems).
    hostWorkDir: requireEnv('AWF_SEALED_PROBE_HOST_WORK_DIR'),
    dockerRuntime,
    timeoutSeconds: parsePositiveInt('AWF_SEALED_PROBE_TIMEOUT', 30),
    maxInvocations: parsePositiveInt('AWF_SEALED_PROBE_MAX_INVOCATIONS', 32),
    memoryLimit,
    socketUid: parsePositiveInt('AWF_SEALED_PROBE_SOCKET_UID', 0),
    socketGid: parsePositiveInt('AWF_SEALED_PROBE_SOCKET_GID', 0),
  };
}

/**
 * Loads the AWF-generated repo → opaque seed id map.
 *
 * The map is the *only* way a repository can be selected: a request supplies
 * a normalized `owner/repo` id, which is looked up here. Callers never supply
 * a path, and an unknown id is simply absent from the map.
 */
function loadSeedMap(seedMapPath) {
  const parsed = JSON.parse(fs.readFileSync(seedMapPath, 'utf8'));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.seeds)) {
    throw new Error('Seed map is malformed');
  }
  if (typeof parsed.runId !== 'string' || !/^[0-9a-f]{8,}$/.test(parsed.runId)) {
    throw new Error('Seed map has no usable runId');
  }

  const seeds = new Map();
  for (const entry of parsed.seeds) {
    if (!entry || typeof entry.repo !== 'string' || typeof entry.seedId !== 'string') {
      throw new Error('Seed map entry is malformed');
    }
    // Seed ids are AWF-generated opaque hex names. Re-validating here means a
    // corrupted map can never turn into a path traversal.
    if (!/^[0-9a-f]{16,64}$/.test(entry.seedId)) {
      throw new Error('Seed map entry has an unexpected seed id');
    }
    seeds.set(entry.repo.toLowerCase(), entry.seedId);
  }

  return { runId: parsed.runId, seeds };
}

module.exports = { READY_PATH, loadConfig, loadSeedMap };
