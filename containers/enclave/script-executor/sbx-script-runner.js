'use strict';

const fs = require('fs');
const path = require('path');
const defaultSbxClient = require('./sbx-client');
const { probeSbxCapabilities } = require('./sbx-capability-probe');
const {
  SBX_CLI_GRACE_MS,
  deriveSbxQuerySpec,
  normalizeTimeoutMs,
} = require('./sbx-script-runner-spec');

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

class SbxScriptRunner {
  constructor(config, deps = {}) {
    this.config = config;
    this.sbx = deps.sbx || defaultSbxClient;
    this.probe = deps.probe || probeSbxCapabilities;
    this.files = deps.files || fs;
    this.nowMs = deps.nowMs || Date.now;
    this.cleanupTail = Promise.resolve();
  }

  spec(runId, invocationId) {
    return deriveSbxQuerySpec({ config: this.config, runId, invocationId });
  }

  async assertAvailable() {
    const report = await this.probe(this.sbx);
    if (!report.supported) {
      throw new Error(
        'sbx enclave-script backend is blocked: the installed sbx runtime cannot enforce all mandatory ' +
        `isolation controls (${report.missing.join(', ')}). No fallback is permitted.`,
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
    const spec = this.spec(runId, '000000000000000000000000');
    const listed = await this.sbx.runSbx(spec.listArgs, 30_000);
    if (listed.exitCode !== 0) throw new Error('Failed to reconcile enclave-script sbx VMs');
    return parseSandboxNames(listed.stdout).filter((name) => name.startsWith(spec.runPrefix));
  }

  async removeSandbox(name) {
    const stopped = await this.sbx.runSbx(['stop', name], 30_000);
    if (stopped.exitCode !== 0) {
      const inventory = await this.sbx.runSbx(['ls', '--quiet'], 30_000);
      if (inventory.exitCode !== 0 || inventory.stdout.split('\n').includes(name)) {
        throw new Error('Failed to stop enclave-script sbx VM');
      }
    }
    const removed = await this.sbx.runSbx(['rm', '--force', name], 30_000);
    if (removed.exitCode !== 0) throw new Error('Failed to remove enclave-script sbx VM');
  }

  async reconcileRun(runId) {
    await this.serializeCleanup(async () => {
      for (const name of await this.listRunSandboxes(runId)) {
        await this.removeSandbox(name);
      }
    });
  }

  async cleanupInvocation(runId, invocationId) {
    const { sandboxName } = this.spec(runId, invocationId);
    await this.serializeCleanup(() => this.removeSandbox(sandboxName));
  }

  async runScriptContainer(params) {
    const spec = this.spec(params.runId, params.invocationId);
    const totalTimeoutMs = normalizeTimeoutMs(
      (params.timeoutMs ?? this.config.timeoutSeconds * 1000) + SBX_CLI_GRACE_MS,
    );
    const deadlineMs = this.nowMs() + totalTimeoutMs;
    const remainingMs = () => normalizeTimeoutMs(deadlineMs - this.nowMs());
    let result;
    let runError;
    try {
      this.files.mkdirSync(path.join(this.config.workDir, params.invocationId, 'sbx-workspace'), {
        mode: 0o700,
      });
      const created = await this.sbx.runSbx(spec.createArgs, Math.min(120_000, remainingMs()));
      if (created.timedOut) {
        result = created;
      } else if (created.exitCode !== 0) {
        throw new Error('Failed to create enclave-script sbx VM');
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
    return result;
  }
}

module.exports = { SbxScriptRunner, parseSandboxNames };
