'use strict';

const { DockerQueryRunner } = require('./docker-query-runner');
const { GvisorQueryRunner } = require('./gvisor-query-runner');
const {
  QUERY_MAX_FILE_BYTES,
  QUERY_WORKSPACE_TMPFS_BYTES,
  buildQueryArgs,
  deriveQueryContainerSpec,
  normalizeTimeoutMs,
} = require('./query-runner-spec');

/**
 * Trusted broker interface for one-query-per-sandbox execution.
 *
 * @typedef {object} QueryRunner
 * @property {() => Promise<void>} assertAvailable
 * @property {(runId: string) => Promise<void>} reconcileRun
 * @property {(params: {
 *   runId: string,
 *   invocationId: string,
 *   timeoutMs?: number
 * }) => Promise<{exitCode: number, timedOut: boolean, stdout: string, stderr: string}>} runQueryContainer
 */

/**
 * Selects a runner only from AWF's normalized broker configuration.
 *
 * Unknown values fail closed. In particular, gVisor never falls back to the
 * daemon's default OCI runtime when runsc is unavailable.
 *
 * @returns {QueryRunner}
 */
function createQueryRunner(config, deps = {}) {
  if (config.queryBackend === 'docker') {
    return new DockerQueryRunner(config, deps);
  }
  if (config.queryBackend === 'gvisor') {
    return new GvisorQueryRunner(config, deps);
  }
  throw new Error(`Unsupported bounded-query backend: ${config.queryBackend}`);
}

module.exports = {
  QUERY_MAX_FILE_BYTES,
  QUERY_WORKSPACE_TMPFS_BYTES,
  buildQueryArgs,
  createQueryRunner,
  deriveQueryContainerSpec,
  normalizeTimeoutMs,
};
