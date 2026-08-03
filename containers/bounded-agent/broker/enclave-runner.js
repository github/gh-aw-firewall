'use strict';

const { DockerEnclaveRunner } = require('./docker-enclave-runner');
const { GvisorEnclaveRunner } = require('./gvisor-enclave-runner');
const {
  ENCLAVE_MAX_FILE_BYTES,
  buildEnclaveArgs,
  deriveEnclaveContainerSpec,
  normalizeTimeoutMs,
} = require('./enclave-runner-spec');

/**
 * Trusted broker interface for one-enclave-per-invocation execution.
 *
 * @typedef {object} EnclaveRunner
 * @property {() => Promise<void>} assertAvailable
 * @property {(runId: string) => Promise<void>} reconcileRun
 * @property {(params: {
 *   runId: string,
 *   invocationId: string,
 *   seedId: string,
 *   timeoutMs?: number
 * }) => Promise<{exitCode: number, timedOut: boolean}>} runEnclaveContainer
 */

/**
 * Selects a runner only from AWF's normalized broker configuration.
 *
 * Unknown values fail closed. In particular, gVisor never falls back to the
 * daemon's default OCI runtime when runsc is unavailable, and the `sbx`
 * backend has no launcher at all — it is rejected by host-side preflight long
 * before this code runs, and rejected again here.
 *
 * @returns {EnclaveRunner}
 */
function createEnclaveRunner(config, deps = {}) {
  if (config.backend === 'docker') {
    return new DockerEnclaveRunner(config, deps);
  }
  if (config.backend === 'gvisor') {
    return new GvisorEnclaveRunner(config, deps);
  }
  throw new Error(`Unsupported bounded-agent backend: ${config.backend}`);
}

module.exports = {
  ENCLAVE_MAX_FILE_BYTES,
  buildEnclaveArgs,
  createEnclaveRunner,
  deriveEnclaveContainerSpec,
  normalizeTimeoutMs,
};
