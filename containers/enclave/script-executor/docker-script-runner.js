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

  async cleanupInvocation(runId, invocationId) {
    const spec = this.spec(runId, invocationId);
    await this.serializeCleanup(() => this.removeListed(spec.invocationListArgs));
  }

  async runScriptContainer(params) {
    const spec = this.spec(params.runId, params.invocationId);
    const timeoutMs = normalizeTimeoutMs(
      (params.timeoutMs ?? this.config.timeoutSeconds * 1000) + CLI_GRACE_MS,
    );

    let result;
    let runError;
    try {
      result = await this.docker.runDocker(spec.launchArgs, timeoutMs);
    } catch (error) {
      runError = error;
    }

    try {
      await this.cleanupInvocation(params.runId, params.invocationId);
    } catch (cleanupError) {
      // A successful `docker run` means the container has already stopped, so
      // preserve its result as before this refactor. Timeout/error paths may
      // still have a live sandbox and therefore fail closed when cleanup fails.
      if (!result || result.timedOut || result.exitCode !== 0) {
        throw cleanupError;
      }
    }

    if (runError) throw runError;
    return result;
  }
}

module.exports = { DockerScriptRunner };
