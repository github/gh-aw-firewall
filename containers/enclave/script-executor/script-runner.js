'use strict';

const { DockerScriptRunner } = require('./docker-script-runner');
const { GvisorScriptRunner } = require('./gvisor-script-runner');
const { SbxScriptRunner } = require('./sbx-script-runner');
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
 *   timeoutMs?: number
 * }) => Promise<{exitCode: number, timedOut: boolean, stdout: string, stderr: string}>} runScriptContainer
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
  if (config.executorBackend === 'docker') {
    return new DockerScriptRunner(config, deps);
  }
  if (config.executorBackend === 'gvisor') {
    return new GvisorScriptRunner(config, deps);
  }
  if (config.executorBackend === 'sbx') {
    return new SbxScriptRunner(config, deps);
  }
  throw new Error(`Unsupported enclave-script backend: ${config.executorBackend}`);
}

module.exports = {
  QUERY_MAX_FILE_BYTES,
  QUERY_WORKSPACE_TMPFS_BYTES,
  createScriptRunner,
  deriveQueryContainerSpec,
  normalizeTimeoutMs,
};
