'use strict';

const {
  QUERY_MAX_FILE_BYTES,
  QUERY_WORKSPACE_TMPFS_BYTES,
  normalizeTimeoutMs,
} = require('./script-runner-spec');
const { REQUIRED_HARD_ISOLATION_FLAGS } = require('./sbx-capability-probe');

const SBX_CLI_GRACE_MS = 15_000;
const SBX_QUERY_TEMPLATE = 'docker/sandbox-templates:shell-docker@sha256:unsupported-until-pinned';
const TRUSTED_RUN_ID_PATTERN = /^[0-9a-f]{32}$/;
const TRUSTED_INVOCATION_ID_PATTERN = /^[0-9a-f]{24}$/;

function assertTrustedId(name, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${name} is not a broker-generated identifier`);
  }
}

function freeze(values) {
  return Object.freeze(values);
}

/**
 * Derives the entire sbx CLI surface from trusted broker state.
 *
 * This specification is intentionally not launchable while the capability
 * probe reports missing hard-isolation controls. It records the current sbx
 * API needed by the runner without accepting any request-owned launch data.
 */
function deriveSbxQuerySpec({ config, runId, invocationId }) {
  assertTrustedId('runId', runId, TRUSTED_RUN_ID_PATTERN);
  assertTrustedId('invocationId', invocationId, TRUSTED_INVOCATION_ID_PATTERN);

  const runPrefix = `awf-query-sbx-${runId}-`;
  const sandboxName = `${runPrefix}${invocationId}`;
  const hostInvocationDir = `${config.sbxWorkDir}/${invocationId}`;
  const workspaceDir = `${hostInvocationDir}/sbx-workspace`;
  const outPath = `${hostInvocationDir}/out`;
  const repoDir = `${hostInvocationDir}/repo`;
  const scriptPath = `${hostInvocationDir}/script.py`;

  return Object.freeze({
    sandboxName,
    runPrefix,
    createArgs: freeze([
      'create',
      '--name', sandboxName,
      '--cpus', '1',
      '--memory', config.memoryLimit,
      '--template', SBX_QUERY_TEMPLATE,
      '--network=none',
      '--pids-limit', '128',
      '--disk-limit', String(QUERY_WORKSPACE_TMPFS_BYTES),
      '--ulimit-fsize', String(QUERY_MAX_FILE_BYTES),
      '--mount-target', `${repoDir}:/awf/seed:ro`,
      '--mount-target', `${scriptPath}:${config.queryScriptPath}:ro`,
      '--mount-target', `${outPath}:/awf/out:rw`,
      'shell',
      workspaceDir,
    ]),
    execArgs: freeze([
      'exec',
      '--user', `${config.queryUid}:${config.queryGid}`,
      '--workdir', config.queryMountDir,
      sandboxName,
      '/usr/local/bin/awf-run-enclave-script',
    ]),
    stopArgs: freeze(['stop', sandboxName]),
    removeArgs: freeze(['rm', '--force', sandboxName]),
    listArgs: freeze(['ls', '--json']),
  });
}

module.exports = {
  SBX_CLI_GRACE_MS,
  SBX_QUERY_TEMPLATE,
  REQUIRED_HARD_ISOLATION_FLAGS,
  deriveSbxQuerySpec,
  normalizeTimeoutMs,
};
