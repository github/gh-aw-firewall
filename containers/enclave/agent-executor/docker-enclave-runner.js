'use strict';

const defaultDockerClient = require('./docker-client');

const EXPECTED_NETWORK_TOPOLOGY =
  'true|bridge|172.31.0.0/24,|awf-enclave-agent-api-proxy@172.31.0.30/24,';
const {
  CLI_GRACE_MS,
  buildRemoveArgs,
  deriveEnclaveContainerSpec,
  normalizeTimeoutMs,
} = require('./enclave-runner-spec');

/**
 * EnclaveRunner using the Docker daemon's default OCI runtime.
 *
 * The optional runtimeName is constructor-controlled so subclasses can select a
 * fixed trusted runtime without accepting runtime data per invocation.
 */
class DockerEnclaveRunner {
  constructor(config, deps = {}, runtimeName = undefined) {
    this.config = config;
    this.runtimeName = runtimeName;
    this.docker = deps.docker || defaultDockerClient;
    this.cleanupTail = Promise.resolve();
  }

  async assertNetworkIsolated() {
    const network = await this.docker.runDocker([
      'network',
      'inspect',
      '--format',
      '{{.Internal}}|{{.Driver}}|{{range .IPAM.Config}}{{.Subnet}},{{end}}|' +
        '{{range .Containers}}{{.Name}}@{{.IPv4Address}},{{end}}',
      this.config.network,
    ], 30_000);
    if (network.exitCode !== 0 || network.stdout.trim() !== EXPECTED_NETWORK_TOPOLOGY) {
      throw new Error(
        'The dedicated enclave-agent network is unavailable or not isolated; enclave agents ' +
        'never fall back to another network',
      );
    }
  }

  async assertAvailable() {
    const image = await this.docker.runDocker(['image', 'inspect', this.config.enclaveImage], 60_000);
    if (image.exitCode !== 0) {
      throw new Error('Enclave image is not available locally');
    }
    await this.assertNetworkIsolated();
  }

  spec(runId, invocationId, seedId) {
    return deriveEnclaveContainerSpec({
      config: this.config,
      runId,
      invocationId,
      seedId,
      runtimeName: this.runtimeName,
    });
  }

  async listContainerIds(args) {
    const listed = await this.docker.runDocker(args, 30_000);
    if (listed.exitCode !== 0) {
      throw new Error('Failed to reconcile enclave-agent containers');
    }
    const ids = listed.stdout.split('\n').map((id) => id.trim()).filter(Boolean);
    if (ids.some((id) => !/^[0-9a-f]{12,64}$/.test(id))) {
      throw new Error('Docker returned an invalid enclave-agent container id');
    }
    return ids;
  }

  async removeListed(args) {
    const ids = await this.listContainerIds(args);
    if (ids.length === 0) return;
    const removed = await this.docker.runDocker(buildRemoveArgs(ids), 30_000);
    if (removed.exitCode !== 0) {
      throw new Error('Failed to remove enclave-agent containers');
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

  /** Deterministic orphan cleanup for every container labelled with this run. */
  async reconcileRun(runId) {
    const spec = this.spec(runId, 'reconcile', '0'.repeat(32));
    await this.serializeCleanup(() => this.removeListed(spec.runListArgs));
  }

  async cleanupInvocation(runId, invocationId) {
    const spec = this.spec(runId, invocationId, '0'.repeat(32));
    await this.serializeCleanup(() => this.removeListed(spec.invocationListArgs));
  }

  /**
   * Runs one enclave to completion and always removes it before returning.
   *
   * Cleanup failures fail closed on the timeout/error paths, where a live
   * sandbox may still hold a mount of private repository content.
   */
  async runEnclaveContainer(params) {
    const spec = this.spec(params.runId, params.invocationId, params.seedId);
    const timeoutMs = normalizeTimeoutMs(
      (params.timeoutMs ?? this.config.timeoutSeconds * 1000) + CLI_GRACE_MS,
    );

    let result;
    let runError;
    try {
      await this.assertNetworkIsolated();
      result = await this.docker.runDocker(spec.launchArgs, timeoutMs);
    } catch (error) {
      runError = error;
    }

    try {
      await this.cleanupInvocation(params.runId, params.invocationId);
    } catch (cleanupError) {
      throw cleanupError;
    }

    if (runError) throw runError;
    // stdout/stderr are intentionally dropped here: the broker never reads,
    // logs, or forwards enclave output. Only the exit status and the dedicated
    // bounded result file are consulted.
    return { exitCode: result.exitCode, timedOut: result.timedOut };
  }
}

module.exports = { DockerEnclaveRunner };
