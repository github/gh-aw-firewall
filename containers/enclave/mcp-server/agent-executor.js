'use strict';

const { createEnclaveRunner } = require('../agent-executor/enclave-runner');
const agentWorkspace = require('../agent-executor/workspace');
const { validateEnclaveAgentRequest } = require('../agent-executor/framing');

/**
 * Adapters that let the unified enclave MCP server drive the audited
 * enclave-agent enclave through the shared executor pipeline.
 *
 * Nothing here re-implements isolation. The runner, the container
 * specification (single-use enclave, immutable seed mounted `ro`, `--read-only`
 * root, bounded tmpfs, fixed non-root uid/gid, `--cap-drop ALL`,
 * `no-new-privileges`, seccomp, memory/CPU/PID/file-size/timeout bounds, the
 * dedicated API-proxy-only network), the native entrypoint, the bounded result
 * file contract, the runtime availability proofs, the run/invocation labels,
 * and the orphan reconciliation all come from the audited enclave-agent
 * modules verbatim. This file only maps the shared handler's script-shaped
 * calls onto them and fixes the caller-facing payload name to `prompt`.
 */

/** Trusted enclave exit status → protected audit category. Never sent to a caller. */
const ENCLAVE_EXIT_CATEGORIES = Object.freeze({
  10: 'enclave-configuration-invalid',
  11: 'enclave-input-invalid',
  20: 'enclave-deadline-exceeded',
  21: 'enclave-provider-http-error',
  22: 'enclave-provider-transport-error',
  23: 'enclave-provider-response-invalid',
  24: 'enclave-engine-failed',
  30: 'enclave-result-write-failed',
  31: 'enclave-model-loop-exhausted',
});

/** The only free-form field the agent tool accepts from a caller. */
const AGENT_PAYLOAD_KEY = 'prompt';

/**
 * Validates one `enclave_run_agent` request against the fixed agent grammar.
 *
 * Delegates to the audited enclave-agent validator with the caller-facing
 * payload name, so every forbidden control (image, command, mounts, env,
 * endpoints, network, credentials, resources, runtime, profile, model,
 * provider, tools, system prompt, messages, and the alternate payload
 * spelling) is rejected by exactly one implementation.
 */
function createAgentRequestValidator(maxPromptBytes) {
  return (request) => validateEnclaveAgentRequest(request, { maxTaskBytes: maxPromptBytes });
}

/**
 * Workspace adapter.
 *
 * The shared handler speaks `createInvocationWorkspace`/`readQueryOutput`/
 * `destroyInvocationWorkspace`; the enclave-agent workspace speaks the same
 * operations with an enclave-specific result reader and a protected session
 * transcript. `preserveInvocationArtifacts` is the handler's optional hook,
 * invoked inside the charged timing bucket and before teardown.
 */
const agentWorkspaceAdapter = {
  createInvocationWorkspace({ config, invocationId, schema, prompt }) {
    return agentWorkspace.createInvocationWorkspace({
      config,
      invocationId,
      schema,
      task: prompt,
    });
  },
  readQueryOutput(outPath, maxOutputBytes) {
    return agentWorkspace.readEnclaveOutput(outPath, maxOutputBytes);
  },
  preserveInvocationArtifacts({ layout, config, invocationId }) {
    const preserved = agentWorkspace.preserveInvocationSession(
      layout.sessionLogPath,
      config.auditDir,
      invocationId,
    );
    if (!preserved) {
      throw new Error('failed to preserve protected enclave session transcript');
    }
  },
  destroyInvocationWorkspace(workDir, invocationId) {
    agentWorkspace.destroyInvocationWorkspace(workDir, invocationId);
  },
};

/**
 * Runner adapter around the audited enclave-agent EnclaveRunner.
 *
 * The backend is selected only from normalized trusted configuration; unknown
 * values fail closed and gVisor never downgrades to the daemon's default OCI
 * runtime.
 */
function createAgentRunner(config, deps = {}) {
  const runner = createEnclaveRunner(config, deps);
  return {
    assertAvailable: () => runner.assertAvailable(),
    reconcileRun: (runId) => runner.reconcileRun(runId),
    runScriptContainer: ({ runId, invocationId, seedId, timeoutMs }) => runner.runEnclaveContainer({
      config,
      runId,
      invocationId,
      seedId,
      timeoutMs,
    }),
  };
}

module.exports = {
  AGENT_PAYLOAD_KEY,
  ENCLAVE_EXIT_CATEGORIES,
  agentWorkspaceAdapter,
  createAgentRequestValidator,
  createAgentRunner,
};
