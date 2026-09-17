'use strict';

const { DockerScriptRunner } = require('./docker-script-runner');
const { GvisorScriptRunner } = require('./gvisor-script-runner');
const { SbxScriptRunner } = require('./sbx-script-runner');
const { createRunnerLifecycle } = require('./runner-lifecycle');
const {
  QUERY_MAX_FILE_BYTES,
  QUERY_WORKSPACE_TMPFS_BYTES,
  deriveQueryContainerSpec,
  normalizeTimeoutMs,
} = require('./script-runner-spec');

/**
 * Trusted server interface for one-script-per-sandbox execution.
 *
 * @typedef {object} ScriptRunner
 * @property {() => Promise<void>} assertAvailable
 * @property {(runId: string) => Promise<void>} reconcileRun
 * @property {(params: {
 *   runId: string,
 *   invocationId: string,
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
 * daemon's default OCI runtime when runsc is unavailable.
 *
 * @returns {ScriptRunner}
 */
function createScriptRunner(config, deps = {}) {
  let adapter;
  if (config.executorBackend === 'docker') {
    adapter = new DockerScriptRunner(config, deps);
  } else if (config.executorBackend === 'gvisor') {
    adapter = new GvisorScriptRunner(config, deps);
  } else if (config.executorBackend === 'sbx') {
    // The audited sbx capability probe remains fail-closed and independent of
    // the Docker/gVisor lifecycle integration in this change.
    return new SbxScriptRunner(config, deps);
  } else {
    throw new Error(`Unsupported enclave-script backend: ${config.executorBackend}`);
  }
  return createRunnerLifecycle(adapter, deps);
}

module.exports = {
  QUERY_MAX_FILE_BYTES,
  QUERY_WORKSPACE_TMPFS_BYTES,
  createScriptRunner,
  deriveQueryContainerSpec,
  normalizeTimeoutMs,
};
