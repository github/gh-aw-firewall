'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');
const { isIPv4 } = require('node:net');
const { run } = require('./commands');
const { inspectDiagnosticFile, failedSpawns } = require('./startup-evidence');
const { readDiagnosticFile } = require('./diagnostic-files');

function captureVmResidue(deadline = Date.now() + 10_000) {
  const options = () => ({
    encoding: 'utf8', maxBuffer: 1024 * 1024,
    timeout: Math.max(1, Math.min(5000, deadline - Date.now())), killSignal: 'SIGKILL',
  });
  const namespaces = run('ip', ['netns', 'list'], options());
  const namespaceNames = namespaces.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter((name) => name?.startsWith('awfvm-'))
    .sort();
  const processes = spawnSync('pgrep', [
    '-f', '[c]loud-hypervisor --api-socket',
  ], options());
  if (processes.error || ![0, 1].includes(processes.status)) {
    throw new Error('Could not inspect Cloud Hypervisor process state');
  }
  const processIdentities = (processes.stdout || '').trim().split(/\r?\n/)
    .filter(Boolean)
    .map((pid) => {
      if (!/^\d+$/.test(pid)) throw new Error('Could not inspect Cloud Hypervisor process state');
      let stat;
      try {
        stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      } catch {
        throw new Error('Cloud Hypervisor VM residue remains');
      }
      const commandEnd = stat.lastIndexOf(')');
      const startTime = stat.slice(commandEnd + 2).split(/\s+/)[19];
      if (commandEnd < 0 || !/^\d+$/.test(startTime || '')) {
        throw new Error('Could not inspect Cloud Hypervisor process state');
      }
      return { pid, startTime };
    })
    .sort((left, right) => Number(left.pid) - Number(right.pid));
  const cgroupRoot = '/sys/fs/cgroup/awf-cloud-hypervisor';
  const cgroups = fs.existsSync(cgroupRoot)
    ? fs.readdirSync(cgroupRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const stat = fs.statSync(path.join(cgroupRoot, entry.name));
        return { name: entry.name, device: stat.dev, inode: stat.ino };
      })
      .sort((left, right) => left.name.localeCompare(right.name))
    : [];
  return { namespaces: namespaceNames, processes: processIdentities, cgroups };
}

function assertNoVmResidue(expectedPrimary, observed = captureVmResidue()) {
  const empty = { namespaces: [], processes: [], cgroups: [] };
  if (expectedPrimary === undefined) {
    if (!isDeepStrictEqual(observed, empty)) {
      throw new Error('Cloud Hypervisor VM residue remains');
    }
    return;
  }
  if (!Array.isArray(expectedPrimary.namespaces)
      || !Array.isArray(expectedPrimary.processes)
      || !Array.isArray(expectedPrimary.cgroups)
      || expectedPrimary.namespaces.length !== 1
      || expectedPrimary.processes.length !== 1
      || expectedPrimary.cgroups.length !== 1) {
    throw new Error('Could not verify the live Cloud Hypervisor primary VM');
  }
  if (!isDeepStrictEqual(observed, expectedPrimary)) {
    throw new Error('Cloud Hypervisor enclave resource residue remains');
  }
}

function readPrimaryVmProgress(file, child) {
  const { PRIMARY_BOOT_STAGES } = require('../../../dist/cloud-hypervisor/primary-readiness');
  const { CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS } = require('../../../dist/cloud-hypervisor/preflight');
  const inspected = inspectDiagnosticFile(file, 4096, { attempts: 1, ownerOnly: true });
  if (['missing', 'unstable'].includes(inspected.outcome)) return undefined;
  if (inspected.outcome !== 'ok') throw new Error('Primary VM progress inspection failed');
  let value;
  try {
    value = JSON.parse(inspected.buffer.toString('utf8'));
  } catch {
    return undefined; // A truncated publication is never readiness.
  }
  const keys = JSON.stringify(Object.keys(value || {}).sort());
  if (![
    '["bootAttempt","ownerPid","runId","schemaVersion","stage","state"]',
    '["bootAttempt","guestIp","ownerPid","runId","schemaVersion","stage","state"]',
  ].includes(keys)
      || value.schemaVersion !== 1 || value.ownerPid !== child.pid
      || !PRIMARY_BOOT_STAGES.includes(value.stage)
      || !['starting', 'ready', 'failed'].includes(value.state)
      || (value.guestIp !== undefined
        && (typeof value.guestIp !== 'string' || !isIPv4(value.guestIp)))
      || (value.state === 'ready'
        && (typeof value.guestIp !== 'string' || !isIPv4(value.guestIp)))
      || !Number.isInteger(value.bootAttempt) || value.bootAttempt < 0
      || value.bootAttempt > CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS
      || !(value.runId === null || (typeof value.runId === 'string'
        && /^[A-Za-z0-9_.-]{1,128}$/.test(value.runId)))
      || (value.state === 'ready'
        && (value.stage !== 'ready' || !value.runId || value.bootAttempt === 0))) return undefined;
  return value;
}

async function verifyPrimaryVmIdentity(progress, child, observed) {
  const { validateRecord } = require('../../../dist/cloud-hypervisor/cleanup-identity');
  const { processMatches } = require('../../../dist/cloud-hypervisor/cleanup-process');
  const registry = '/run/awf-cloud-hypervisor/pending-cleanup';
  const file = path.join(registry, `${progress.runId}.json`);
  const inspected = inspectDiagnosticFile(file, 1024 * 1024, { attempts: 1, ownerOnly: true });
  if (['missing', 'unstable'].includes(inspected.outcome)) return 'pending';
  if (inspected.outcome !== 'ok') throw new Error('Primary VM journal inspection failed');
  let record;
  try {
    record = JSON.parse(inspected.buffer.toString('utf8'));
  } catch {
    return 'pending';
  }
  try {
    validateRecord(record, file, registry);
  } catch {
    return 'mismatch';
  }
  const vmm = record.processes.vmm;
  if (record.runId !== progress.runId || record.owner.pid !== child.pid
      || record.workload?.kind !== 'primary-agent'
      || record.workload.ownerId !== 'primary-agent' || record.network?.mode !== 'primary'
      || vmm?.state !== 'live' || !vmm.identity || !record.identities.cgroup
      || !record.identities.netns) return 'mismatch';
  const expected = {
    namespaces: [record.network.namespaceName],
    processes: [{ pid: String(vmm.identity.pid), startTime: vmm.identity.startTime }],
    cgroups: [{
      name: progress.runId,
      device: Number(record.identities.cgroup.device),
      inode: Number(record.identities.cgroup.inode),
    }],
  };
  if (!isDeepStrictEqual(observed, expected)) return 'mismatch';
  // Reuse the cleanup verifier: PID/start time alone cannot establish ownership.
  const dependencies = fs.promises;
  if (!await processMatches(dependencies, record.owner)
      || !await processMatches(dependencies, vmm.identity, vmm)) return 'mismatch';
  const namespace = fs.statSync(record.network.netnsPath);
  const membership = fs.readFileSync(`/proc/${vmm.identity.pid}/cgroup`, 'utf8');
  if (String(namespace.dev) !== record.identities.netns.device
      || String(namespace.ino) !== record.identities.netns.inode
      || vmm.identity.networkNamespace !== `net:[${namespace.ino}]`
      || !membership.split('\n').includes(`0::/awf-cloud-hypervisor/${progress.runId}`)) {
    return 'mismatch';
  }
  return 'verified';
}

// Shared by the public script probe and every combined/recovery/profile launch.
// A gateway handshake and even exactly one VMM do not prove guest readiness.
async function waitForPrimaryVmReadiness(child, deadline, diagnostics, dependencies = {}) {
  const {
    PRIMARY_READINESS_FILENAME,
    PRIMARY_READINESS_DIRECTORY,
  } = require('../../../dist/cloud-hypervisor/primary-readiness');
  const readProgress = dependencies.readProgress || readPrimaryVmProgress;
  const capture = dependencies.capture || captureVmResidue;
  const verify = dependencies.verify || verifyPrimaryVmIdentity;
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const file = path.join(path.dirname(diagnostics.startupErrorFile),
    PRIMARY_READINESS_DIRECTORY, PRIMARY_READINESS_FILENAME);
  let progress;
  let observed;
  let inspection = 'not-attempted';
  let identity = 'not-attempted';
  const fail = (reason) => {
    try {
      progress = readProgress(file, child) || progress;
    } catch {
      // Child status remains authoritative if its final progress is unavailable.
    }
    if (inspection === 'not-attempted') {
      try {
        observed = capture(now() + 10_000);
        inspection = 'complete';
      } catch {
        inspection = 'failed';
      }
    }
    const count = (key) => observed ? Math.min(1000, observed[key].length) : null;
    console.error(`AWF_PRIMARY_VM_READINESS ${JSON.stringify({
      schemaVersion: 1, stage: 'primary-vm-readiness', reason,
      primary: progress ? {
        stage: progress.stage, state: progress.state, bootAttempt: progress.bootAttempt,
      } : { stage: 'unknown', state: 'not-observed', bootAttempt: null },
      resources: {
        inspection, namespaces: count('namespaces'), processes: count('processes'),
        cgroups: count('cgroups'), identity,
      },
      child: {
        status: failedSpawns.has(child) ? 'spawn-failed'
          : child.signalCode !== null ? 'signalled'
            : child.exitCode !== null ? 'exited' : 'running',
        exitCode: Number.isInteger(child.exitCode) && child.exitCode >= 0 && child.exitCode <= 255
          ? child.exitCode : null,
        signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGBUS']
          .includes(child.signalCode) ? child.signalCode : null,
      },
    })}`);
    throw new Error(`Primary VM readiness failed: ${reason}`);
  };
  const checkChild = () => {
    if (failedSpawns.has(child)) fail('spawn-failure');
    if (child.signalCode !== null) fail('signal');
    if (child.exitCode !== null) fail('exit');
  };
  while (now() < deadline) {
    checkChild();
    let current;
    try {
      current = readProgress(file, child);
      progress = current || progress;
    } catch {
      fail('inspection-failure');
    }
    if (progress?.state === 'failed') fail('startup-failure');
    // Never use a cached ready record if its current publication is incomplete.
    if (current?.state === 'ready') {
      try {
        observed = capture(deadline);
        inspection = 'complete';
      } catch {
        observed = undefined;
        inspection = 'failed';
        fail('inspection-failure');
      }
      if (Object.values(observed).some((items) => items.length > 1)) {
        identity = 'mismatch';
        fail('unexpected-resources');
      }
      if (Object.values(observed).every((items) => items.length === 1)) {
        try {
          identity = await verify(current, child, observed);
        } catch {
          identity = 'inspection-failed';
          checkChild();
          fail('inspection-failure');
        }
        checkChild();
        if (identity === 'mismatch') fail('unexpected-resources');
        if (identity === 'verified' && now() < deadline) {
          dependencies.onReady?.(current.guestIp);
          return observed;
        }
      }
    }
    await sleep(Math.max(0, Math.min(250, deadline - now())));
  }
  checkChild();
  fail('timeout');
}

async function waitForVmCleanup(timeoutMs, expectedPrimary) {
  const deadline = Date.now() + timeoutMs;
  let residueError;
  while (Date.now() < deadline) {
    try {
      assertNoVmResidue(expectedPrimary);
      return;
    } catch (error) {
      if (!/residue remains/.test(error.message)) throw error;
      residueError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw residueError || new Error('Cloud Hypervisor VM cleanup did not complete');
}

async function waitForDockerPrimaryReadiness(child, deadline, stdoutFile, readyToken, expectedPrimaryVm) {
  if (!/^AWF_DOCKER_PRIMARY_READY_[a-f0-9]{48}$/.test(readyToken || '')) {
    throw new Error('Invalid live Docker primary readiness token');
  }
  while (Date.now() < deadline) {
    if (failedSpawns.has(child) || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('AWF exited before live Docker primary command readiness');
    }
    // This fresh per-launch token is printed by the actual primary command,
    // after Docker entrypoint/chroot setup, not by a container healthcheck.
    if (readDiagnosticFile(stdoutFile).includes(Buffer.from(`${readyToken}\n`))) {
      assertNoVmResidue(expectedPrimaryVm);
      return expectedPrimaryVm;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for actual live Docker primary command readiness');
}

module.exports = {
  captureVmResidue,
  assertNoVmResidue,
  readPrimaryVmProgress,
  verifyPrimaryVmIdentity,
  waitForPrimaryVmReadiness,
  waitForVmCleanup,
  waitForDockerPrimaryReadiness,
};
