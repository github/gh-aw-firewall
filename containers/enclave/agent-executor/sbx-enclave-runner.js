'use strict';

const fs = require('fs');
const path = require('path');
const defaultSbxClient = require('./sbx-client');
const { probeSbxCapabilities } = require('./sbx-capability-probe');
const {
  SBX_CLI_GRACE_MS,
  deriveSbxEnclaveSpec,
  normalizeTimeoutMs,
} = require('./sbx-enclave-runner-spec');

function parseSandboxNames(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('sbx returned malformed sandbox inventory');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('sbx returned malformed sandbox inventory');
  }
  const names = parsed.map((entry) => entry && entry.name);
  if (names.some((name) => typeof name !== 'string' || !/^[a-z0-9][a-z0-9+.-]{0,127}$/.test(name))) {
    throw new Error('sbx returned an invalid sandbox name');
  }
  return names;
}

/**
 * EnclaveRunner backed by the sbx microVM CLI.
 *
 * Deliberately mirrors DockerEnclaveRunner's lifecycle contract exactly
 * (assertAvailable / reconcileRun / cleanupInvocation / runEnclaveContainer)
 * so the dispatcher in `./enclave-runner.js` can select it without any
 * special-casing, and so its cleanup ordering (serialize, always run, throw
 * last) is provably the same. `assertAvailable` always throws today: the
 * audited sbx CLI cannot yet prove the mandatory isolation and
 * API-proxy-only network controls (see `./sbx-capability-probe.js`), and
 * this runner never falls back to Docker or gVisor.
 */
class SbxEnclaveRunner {
  constructor(config, deps = {}) {
    this.config = config;
    this.sbx = deps.sbx || defaultSbxClient;
    this.probe = deps.probe || probeSbxCapabilities;
    this.files = deps.files || fs;
    this.nowMs = deps.nowMs || Date.now;
    this.cleanupTail = Promise.resolve();
  }

  spec(runId, invocationId, seedId) {
    return deriveSbxEnclaveSpec({ config: this.config, runId, invocationId, seedId });
  }

  async assertAvailable() {
    const report = await this.probe(this.sbx);
    if (!report.supported) {
      throw new Error(
        'sbx enclave-agent enclave backend is blocked: the installed sbx runtime cannot enforce all ' +
        `mandatory isolation controls (${report.missing.join(', ')}). No fallback is permitted.`,
      );
    }
  }

  serializeCleanup(operation) {
    const queued = this.cleanupTail.then(operation, operation);
    this.cleanupTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async listRunSandboxes(runId) {
    const spec = this.spec(runId, '0'.repeat(24), '0'.repeat(32));
    const listed = await this.sbx.runSbx(spec.listArgs, 30_000);
    if (listed.exitCode !== 0) throw new Error('Failed to reconcile enclave-agent sbx VMs');
    return parseSandboxNames(listed.stdout).filter((name) => name.startsWith(spec.runPrefix));
  }

  async removeSandbox(name) {
    const stopped = await this.sbx.runSbx(['stop', name], 30_000);
    if (stopped.exitCode !== 0) {
      const inventory = await this.sbx.runSbx(['ls', '--quiet'], 30_000);
      if (inventory.exitCode !== 0 || inventory.stdout.split('\n').includes(name)) {
        throw new Error('Failed to stop enclave-agent sbx VM');
      }
    }
    const removed = await this.sbx.runSbx(['rm', '--force', name], 30_000);
    if (removed.exitCode !== 0) throw new Error('Failed to remove enclave-agent sbx VM');
  }

  /** Deterministic orphan cleanup for every VM name-prefixed with this run. */
  async reconcileRun(runId) {
    await this.serializeCleanup(async () => {
      for (const name of await this.listRunSandboxes(runId)) {
        await this.removeSandbox(name);
      }
    });
  }

  async cleanupInvocation(runId, invocationId) {
    const { sandboxName } = this.spec(runId, invocationId, '0'.repeat(32));
    await this.serializeCleanup(() => this.removeSandbox(sandboxName));
  }

  /**
   * Runs one enclave to completion and always removes the VM before
   * returning — including on timeout or a create/exec failure.
   *
   * stdout/stderr are intentionally dropped: the broker never reads, logs, or
   * forwards enclave output, matching DockerEnclaveRunner.
   */
  async runEnclaveContainer(params) {
    const spec = this.spec(params.runId, params.invocationId, params.seedId);
    const totalTimeoutMs = normalizeTimeoutMs(
      (params.timeoutMs ?? this.config.timeoutSeconds * 1000) + SBX_CLI_GRACE_MS,
    );
    const deadlineMs = this.nowMs() + totalTimeoutMs;
    const remainingMs = () => normalizeTimeoutMs(deadlineMs - this.nowMs());
    let result;
    let runError;
    try {
      this.files.mkdirSync(path.join(this.config.sbxWorkDir, params.invocationId, 'sbx-workspace'), {
        mode: 0o700,
      });
      const created = await this.sbx.runSbx(spec.createArgs, Math.min(120_000, remainingMs()));
      if (created.timedOut) {
        result = created;
      } else if (created.exitCode !== 0) {
        throw new Error('Failed to create enclave-agent sbx VM');
      } else if (this.nowMs() >= deadlineMs) {
        result = { exitCode: 124, timedOut: true, stdout: '', stderr: '' };
      } else {
        result = await this.sbx.runSbx(spec.execArgs, remainingMs());
      }
    } catch (error) {
      runError = error;
    }

    try {
      await this.cleanupInvocation(params.runId, params.invocationId);
    } catch (cleanupError) {
      throw cleanupError;
    }
    if (runError) throw runError;
    return { exitCode: result.exitCode, timedOut: result.timedOut };
  }
}

module.exports = { SbxEnclaveRunner, parseSandboxNames };
