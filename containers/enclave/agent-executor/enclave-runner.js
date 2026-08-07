'use strict';

const { DockerEnclaveRunner } = require('./docker-enclave-runner');
const { GvisorEnclaveRunner } = require('./gvisor-enclave-runner');
const { SbxEnclaveRunner } = require('./sbx-enclave-runner');
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
 *   timeoutMs?: number
 * }) => Promise<{exitCode: number, timedOut: boolean}>} runEnclaveContainer
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
  if (config.backend === 'docker') {
    return new DockerEnclaveRunner(config, deps);
  }
  if (config.backend === 'gvisor') {
    return new GvisorEnclaveRunner(config, deps);
  }
  if (config.backend === 'sbx') {
    return new SbxEnclaveRunner(config, deps);
  }
  throw new Error(`Unsupported enclave-agent backend: ${config.backend}`);
}

module.exports = {
  ENCLAVE_INVOCATION_LABEL,
  ENCLAVE_MAX_FILE_BYTES,
  ENCLAVE_RUN_LABEL,
  createEnclaveRunner,
  deriveEnclaveContainerSpec,
  normalizeTimeoutMs,
};
