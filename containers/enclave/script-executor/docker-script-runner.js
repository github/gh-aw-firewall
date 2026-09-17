'use strict';

const defaultDockerClient = require('./docker-client');
const {
  CLI_GRACE_MS,
  buildRemoveArgs,
  deriveQueryContainerSpec,
  normalizeTimeoutMs,
} = require('./script-runner-spec');

/**
 * ScriptRunner using the Docker daemon's default OCI runtime.
 *
 * The optional runtimeName is constructor-controlled so subclasses can select
 * a fixed trusted runtime without accepting runtime data per invocation.
 */
class DockerScriptRunner {
  constructor(config, deps = {}, runtimeName = undefined) {
    this.config = config;
    this.runtimeName = runtimeName;
    this.docker = deps.docker || defaultDockerClient;
    this.nowMs = deps.nowMs || Date.now;
    this.cleanupTail = Promise.resolve();
  }

  async assertAvailable() {
    const image = await this.docker.runDocker(['image', 'inspect', this.config.queryImage], 60_000);
    if (image.exitCode !== 0) {
      throw new Error(`Query image is not available locally: ${this.config.queryImage}`);
    }
  }

  spec(runId, invocationId) {
    return deriveQueryContainerSpec({
      config: this.config,
      runId,
      invocationId,
      runtimeName: this.runtimeName,
    });
  }

  async listContainerIds(args) {
    const listed = await this.docker.runDocker(args, 30_000);
    if (listed.exitCode !== 0) {
      throw new Error('Failed to reconcile enclave-script containers');
    }
    const ids = listed.stdout.split('\n').map((id) => id.trim()).filter(Boolean);
    if (ids.some((id) => !/^[0-9a-f]{12,64}$/.test(id))) {
      throw new Error('Docker returned an invalid enclave-script container id');
    }
    return ids;
  }

  async removeListed(args) {
    const ids = await this.listContainerIds(args);
    if (ids.length === 0) return;
    const removed = await this.docker.runDocker(buildRemoveArgs(ids), 30_000);
    if (removed.exitCode !== 0) {
      throw new Error('Failed to remove enclave-script containers');
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

  async reconcileRun(runId) {
    const spec = this.spec(runId, 'reconcile');
    await this.serializeCleanup(() => this.removeListed(spec.runListArgs));
  }

  async cleanupInvocation(handle) {
    const spec = this.spec(handle.runId, handle.invocationId);
    try {
      await this.serializeCleanup(() => this.removeListed(spec.invocationListArgs));
    } catch (error) {
      // Preserve the existing Docker script behavior: after a successful
      // `docker run`, the container is already stopped and its bounded result
      // remains valid even if removing the stopped record fails. Timeout,
      // cancellation, non-zero exit, and partial-launch paths still fail closed.
      if (!handle.resultValue || handle.resultValue.timedOut || handle.resultValue.exitCode !== 0) {
        throw error;
      }
    }
  }

  async launchInvocation(params) {
    const spec = this.spec(params.runId, params.invocationId);
    const remainingMs = params.deadlineMs - this.nowMs();
    if (remainingMs <= 0) throw new Error('Enclave script deadline elapsed before launch');
    const timeoutMs = normalizeTimeoutMs(
      remainingMs + CLI_GRACE_MS,
    );
    const cancellation = new AbortController();
    return {
      runId: params.runId,
      invocationId: params.invocationId,
      cancellation,
      result: this.docker.runDocker(spec.launchArgs, timeoutMs, cancellation.signal),
    };
  }

  async collectResult(handle) {
    handle.resultValue = await handle.result;
    return handle.resultValue;
  }

  cancelInvocation(handle) {
    handle.cancellation.abort();
    return this.cleanupInvocation(handle);
  }
}

module.exports = { DockerScriptRunner };
