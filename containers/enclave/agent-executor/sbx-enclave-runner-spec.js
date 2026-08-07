'use strict';

const {
  ENCLAVE_MAX_FILE_BYTES,
  normalizeTimeoutMs,
} = require('./enclave-runner-spec');
const { REQUIRED_HARD_ISOLATION_FLAGS } = require('./sbx-capability-probe');

const SBX_CLI_GRACE_MS = 15_000;

/**
 * Pinned placeholder template/bootstrap reference.
 *
 * This is intentionally not a real, resolvable template: AWF has not
 * published a enclave-agent sbx template because current sbx cannot enforce
 * the mandatory isolation controls a real template would depend on (see
 * `./sbx-capability-probe.js`). The value documents the exact shape a future
 * pinned reference must take (a content-addressed tag), and is never used to
 * launch a real enclave while the capability probe reports it missing.
 */
const SBX_ENCLAVE_TEMPLATE = 'awf/enclave-agent-sandbox-templates:sbx-enclave@sha256:unsupported-until-pinned';

const TRUSTED_RUN_ID_PATTERN = /^[0-9a-f]{32}$/;
const TRUSTED_INVOCATION_ID_PATTERN = /^[0-9a-f]{24}$/;
const TRUSTED_SEED_ID_PATTERN = /^[0-9a-f]{16,64}$/;

function assertTrustedId(name, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${name} is not a broker-generated identifier`);
  }
}

function freeze(values) {
  return Object.freeze(values);
}

/**
 * Derives the entire sbx CLI surface for one enclave-agent enclave invocation
 * from trusted broker state.
 *
 * This specification is intentionally not launchable while the capability
 * probe reports missing hard-isolation controls (see
 * `SbxEnclaveRunner.assertAvailable`, which always throws for the currently
 * audited sbx CLI). It records the exact sbx API a future, capability-proven
 * sbx CLI would be driven with — a fixed uid/workdir, mandatory resource
 * limits, and mount targets for the seed/task/schema/out channels — without
 * ever accepting request-owned launch data.
 */
function deriveSbxEnclaveSpec({ config, runId, invocationId, seedId }) {
  assertTrustedId('runId', runId, TRUSTED_RUN_ID_PATTERN);
  assertTrustedId('invocationId', invocationId, TRUSTED_INVOCATION_ID_PATTERN);
  assertTrustedId('seedId', seedId, TRUSTED_SEED_ID_PATTERN);

  const runPrefix = `awf-enclave-agent-sbx-${runId}-`;
  const sandboxName = `${runPrefix}${invocationId}`;
  const hostInvocationDir = `${config.sbxWorkDir}/${invocationId}`;
  const hostSeedDir = `${config.sbxSeedsDir}/${seedId}`;
  const workspaceDir = `${hostInvocationDir}/sbx-workspace`;
  const taskPath = `${hostInvocationDir}/task.txt`;
  const schemaPath = `${hostInvocationDir}/schema.json`;
  const outPath = `${hostInvocationDir}/out`;

  return Object.freeze({
    sandboxName,
    runPrefix,
    createArgs: freeze([
      'create',
      '--name', sandboxName,
      '--cpus', String(config.cpuLimit),
      '--memory', config.memoryLimit,
      '--template', SBX_ENCLAVE_TEMPLATE,
      // Distinct from enclave scripts' `--network=none`: a enclave-agent
      // enclave must reach the API proxy and *only* the API proxy. sbx has
      // no verified lateral-peer-denial primitive today (see
      // REQUIRED_HARD_ISOLATION_FLAGS), so this argument is never issued
      // against a real launch while the capability probe reports it missing.
      '--network', config.network,
      '--pids-limit', String(config.pidsLimit),
      '--disk-limit', config.tmpfsLimit,
      '--ulimit-fsize', String(ENCLAVE_MAX_FILE_BYTES),
      '--mount-target', `${hostSeedDir}:${config.enclaveSeedPath}:ro`,
      '--mount-target', `${taskPath}:${config.enclaveTaskPath}:ro`,
      '--mount-target', `${schemaPath}:${config.enclaveSchemaPath}:ro`,
      '--mount-target', `${outPath}:/awf/out:rw`,
      '--mount-target', `${hostInvocationDir}/session.jsonl:/awf/session.jsonl:rw`,
      'shell',
      workspaceDir,
    ]),
    execArgs: freeze([
      'exec',
      '--user', `${config.enclaveUid}:${config.enclaveGid}`,
      '--workdir', config.enclaveMountDir,
      sandboxName,
      '/usr/local/bin/run-enclave-agent',
    ]),
    stopArgs: freeze(['stop', sandboxName]),
    removeArgs: freeze(['rm', '--force', sandboxName]),
    listArgs: freeze(['ls', '--json']),
  });
}

module.exports = {
  SBX_CLI_GRACE_MS,
  SBX_ENCLAVE_TEMPLATE,
  REQUIRED_HARD_ISOLATION_FLAGS,
  deriveSbxEnclaveSpec,
  normalizeTimeoutMs,
};
