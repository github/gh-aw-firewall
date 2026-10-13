'use strict';

const fs = require('fs');

const PROBE_TIMEOUT_MS = 250;
const PROBE_TARGETS = {
  capability: ['/run/awf-enclave-mcp/auth-token', 'file', 'read'],
  'audit-directory': ['/var/log/awf-enclave', 'directory', 'write'],
  'control-directory': ['/run/awf-enclave-mcp-control', 'directory', 'write'],
  'ready-file-parent': ['/run/awf-enclave-mcp-control', 'directory', 'write'],
  'seed-map': ['/srv/awf/seed-map.json', 'file', 'read'],
  'seed-directory': ['/srv/awf/seeds', 'directory', 'read'],
  'agent-id': ['/run/awf-enclave-mcp/github-agent-id', 'file', 'read'],
  'host-executor-socket': ['/run/awf-enclave-host-executor/executor.sock', 'socket', 'connect'],
  'host-executor-capability': ['/run/awf-enclave-host-executor/capability', 'file', 'read'],
  'delegation-channel': ['/run/awf-enclave-delegation', 'directory', 'read'],
  'docker-socket': ['/var/run/docker.sock', 'socket', 'connect'],
  'script-seccomp': ['/opt/awf/script-seccomp.json', 'file', 'read'],
  'agent-seccomp': ['/opt/awf/enclave-seccomp.json', 'file', 'read'],
  'node-executable': [process.execPath, 'file', 'execute'],
  'docker-executable': ['/usr/bin/docker', 'file', 'execute'],
};

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(value => ({ value }), error => ({ error: error?.code })),
    new Promise(resolve => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function modeBucket(mode) {
  if (!Number.isInteger(mode)) return 'unknown';
  if ((mode & 0o077) === 0) return 'owner-only';
  if ((mode & 0o007) !== 0) return 'world-accessible';
  return 'group-accessible';
}

function ownerBucket(uid, effectiveUid) {
  if (!Number.isInteger(uid) || !Number.isInteger(effectiveUid)) return 'unknown';
  if (uid === 0) return 'root';
  if (uid === effectiveUid) return 'effective-user';
  return 'other';
}

function fileType(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isSocket()) return 'socket';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
}

async function probeTarget(id, target, expectedType, access, filesystem = fs, timeoutMs = PROBE_TIMEOUT_MS) {
  const unknown = {
    id, presence: 'unknown', observedType: 'unknown', expectedType,
    owner: 'unknown', mode: 'unknown', access: 'unknown', shape: 'unknown',
  };
  const observed = await withTimeout(filesystem.promises.lstat(target), timeoutMs);
  if (observed?.timedOut) return { ...unknown, reason: 'timeout' };
  if (observed?.error === 'ENOENT' || observed?.error === 'ENOTDIR') {
    return { ...unknown, presence: 'absent', reason: 'missing', shape: 'unexpected' };
  }
  if (observed?.error === 'EACCES' || observed?.error === 'EPERM') {
    return { ...unknown, reason: 'denied' };
  }
  if (observed?.error) return { ...unknown, reason: 'unavailable' };
  const stat = observed.value;
  const observedType = fileType(stat);
  const accessCheck = observedType === 'symlink'
    ? Promise.resolve({ value: 'unknown' })
    : access === 'connect'
    ? Promise.resolve({ value: 'not-applicable' })
    : withTimeout(filesystem.promises.access(
      target,
      (access === 'write' ? filesystem.constants.W_OK
        : access === 'execute' ? filesystem.constants.X_OK : filesystem.constants.R_OK),
    ).then(() => 'allowed', error => error?.code === 'ENOENT' ? 'missing' : 'denied'), timeoutMs);
  const result = await accessCheck;
  return {
    id,
    presence: 'present',
    observedType,
    expectedType,
    owner: ownerBucket(stat.uid, typeof process.getuid === 'function' ? process.getuid() : undefined),
    mode: modeBucket(stat.mode),
    access: result?.timedOut ? 'unknown' : result?.value ?? 'unknown',
    shape: observedType === expectedType ? 'expected' : 'unexpected',
    ...(observedType === 'symlink' ? { reason: 'symlink' }
      : result?.timedOut ? { reason: 'timeout' } : result?.error ? { reason: 'unavailable' } : {}),
  };
}

function selectedProbeIds(environment) {
  const ids = ['capability', 'audit-directory', 'control-directory', 'ready-file-parent', 'node-executable'];
  const scriptEnabled = environment.AWF_ENCLAVE_SCRIPT_ENABLED === 'true';
  const agentEnabled = environment.AWF_ENCLAVE_AGENT_ENABLED === 'true';
  const scriptBackend = scriptEnabled ? environment.AWF_ENCLAVE_BACKEND : undefined;
  const agentBackend = agentEnabled ? environment.AWF_ENCLAVE_AGENT_BACKEND : undefined;
  const usesContainerExecutor = [scriptBackend, agentBackend].some(
    backend => backend !== undefined && backend !== 'cloud-hypervisor',
  );
  if (environment.AWF_ENCLAVE_SEED_MAP_ENABLED !== 'false') ids.push('seed-map');
  if (usesContainerExecutor) {
    ids.push('docker-socket', 'docker-executable');
    if (environment.AWF_ENCLAVE_SEED_MAP_ENABLED !== 'false') ids.push('seed-directory');
    if (scriptBackend && scriptBackend !== 'cloud-hypervisor') ids.push('script-seccomp');
    if (agentBackend && agentBackend !== 'cloud-hypervisor') ids.push('agent-seccomp');
  }
  if (environment.AWF_ENCLAVE_AGENT_GITHUB_ENABLED === 'true') ids.push('agent-id');
  if (environment.AWF_ENCLAVE_BACKEND === 'cloud-hypervisor'
      || environment.AWF_ENCLAVE_AGENT_BACKEND === 'cloud-hypervisor') {
    ids.push('host-executor-socket', 'host-executor-capability');
  }
  if (environment.AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED === 'true') ids.push('delegation-channel');
  return ids;
}

async function probeStartupEnvironment(environment = process.env, filesystem = fs, timeoutMs = PROBE_TIMEOUT_MS) {
  const observations = await Promise.all(selectedProbeIds(environment).map(async id => {
    const [target, expectedType, access] = PROBE_TARGETS[id];
    try {
      return await probeTarget(id, target, expectedType, access, filesystem, timeoutMs);
    } catch {
      return {
        id, presence: 'unknown', observedType: 'unknown', expectedType,
        owner: 'unknown', mode: 'unknown', access: 'unknown', shape: 'unknown', reason: 'unavailable',
      };
    }
  }));
  return {
    effectiveUid: typeof process.getuid === 'function' ? process.getuid() : null,
    effectiveGid: typeof process.getgid === 'function' ? process.getgid() : null,
    probes: observations,
  };
}

module.exports = {
  PROBE_TIMEOUT_MS,
  probeStartupEnvironment,
  probeTarget,
  selectedProbeIds,
};
