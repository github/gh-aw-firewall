'use strict';

const { DockerEnclaveRunner } = require('./docker-enclave-runner');
const { GvisorEnclaveRunner } = require('./gvisor-enclave-runner');
const { SbxEnclaveRunner } = require('./sbx-enclave-runner');
const { createRunnerLifecycle } = require('../script-executor/runner-lifecycle');
const {
  ENCLAVE_INVOCATION_LABEL,
  ENCLAVE_MAX_FILE_BYTES,
  ENCLAVE_RUN_LABEL,
  deriveEnclaveContainerSpec,
  normalizeTimeoutMs,
} = require('./enclave-runner-spec');

/**
 * Trusted server interface for one-enclave-per-invocation execution.
 *
 * @typedef {object} EnclaveRunner
 * @property {() => Promise<void>} assertAvailable
 * @property {(runId: string) => Promise<void>} reconcileRun
 * @property {(params: {
 *   runId: string,
 *   invocationId: string,
 *   seedId: string,
 *   deadlineMs: number,
 *   signal?: AbortSignal
 * }) => Promise<{status: string, exitCode: number, timedOut: boolean}>} runInvocation
 * @property {(handle: object) => Promise<void>} cancelInvocation
 * @property {(handle: object) => Promise<void>} cleanupInvocation
 */

/**
 * Selects a runner only from AWF's normalized server configuration.
 *
 * Unknown values fail closed. In particular, gVisor never falls back to the
 * daemon's default OCI runtime when runsc is unavailable, and the `sbx`
 * backend's `assertAvailable` always throws for the currently audited sbx CLI
 * (see `./sbx-capability-probe.js`) — host-side preflight already blocks sbx
 * long before this code runs, so reaching this branch at all would mean the
 * defense-in-depth check inside the runner is the only thing standing between
 * the request and an unproven enclave, and it fails closed too.
 *
 * @returns {EnclaveRunner}
 */
function createEnclaveRunner(config, deps = {}) {
  let adapter;
  if (config.backend === 'docker') {
    adapter = new DockerEnclaveRunner(config, deps);
  } else if (config.backend === 'gvisor') {
    adapter = new GvisorEnclaveRunner(config, deps);
  } else if (config.backend === 'sbx') {
    // The audited sbx capability probe remains fail-closed and independent of
    // the Docker/gVisor lifecycle integration in this change.
    return new SbxEnclaveRunner(config, deps);
  } else {
    throw new Error(`Unsupported enclave-agent backend: ${config.backend}`);
  }
  return createRunnerLifecycle(adapter, deps);
}

module.exports = {
  ENCLAVE_INVOCATION_LABEL,
  ENCLAVE_MAX_FILE_BYTES,
  ENCLAVE_RUN_LABEL,
  createEnclaveRunner,
  deriveEnclaveContainerSpec,
  normalizeTimeoutMs,
};
