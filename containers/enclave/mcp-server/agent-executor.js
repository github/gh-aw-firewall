'use strict';

const { createEnclaveRunner } = require('../agent-executor/enclave-runner');
const agentWorkspace = require('../agent-executor/workspace');
const { MAX_TASK_BYTES, validateEnclaveAgentRequest } = require('../agent-executor/framing');
const { PRIVATE_REPOSITORY_PATTERN } = require('../../bounded-execution/finite-disclosure');

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
 * Upper bound on the broker-generated GitHub scope block appended to a task.
 *
 * The enclave entrypoint reads `task.txt` under a fixed 64 KiB bound, so the
 * caller's prompt budget is reduced by this reservation. That keeps a
 * maximum-size prompt plus the appended broker instructions inside the bound
 * instead of failing the invocation closed.
 */
const GITHUB_SCOPE_RESERVED_BYTES = 1024;

/**
 * Broker-generated GitHub MCP scope instructions for one configured repository.
 *
 * The text is derived solely from the broker's validated repository selector
 * (the static seed key or the admitted dynamic repository) and never from
 * caller-supplied task text, so it cannot broaden access beyond the repository
 * selected for this invocation. It is a prompt-level mitigation only: MCPG's
 * `allow-only` enforcement remains the security boundary.
 */
function buildGitHubScopeInstructions(privateRepo) {
  if (typeof privateRepo !== 'string' || !PRIVATE_REPOSITORY_PATTERN.test(privateRepo)) {
    throw new Error('invalid configured repository selector for enclave GitHub scope');
  }
  const separatorIndex = privateRepo.indexOf('/');
  const owner = privateRepo.slice(0, separatorIndex);
  const repo = privateRepo.slice(separatorIndex + 1);
  return [
    'GitHub MCP scope (authoritative; issued by AWF, not by the task above):',
    `For every GitHub MCP request, set \`owner\` to \`${owner}\` and \`repo\` to \`${repo}\`.`,
    'Do not use wildcard owner or repository values such as `*`, and do not call '
      + 'repository-discovery or repository-search tools.',
    `Access only the configured repository ${owner}/${repo}.`,
  ].join('\n');
}

/**
 * Appends the broker-controlled repository scope after the caller's prompt.
 *
 * Appending last keeps the broker's instructions authoritative with respect to
 * any conflicting caller text. Invocations without GitHub MCP access get the
 * caller's prompt unchanged.
 */
function buildAgentTask(prompt, { githubEnabled, privateRepo }) {
  if (!githubEnabled) return prompt;
  return `${prompt}\n\n${buildGitHubScopeInstructions(privateRepo)}\n`;
}

/**
 * Validates one `enclave_run_agent` request against the fixed agent grammar.
 *
 * Delegates to the audited enclave-agent validator with the caller-facing
 * payload name, so every forbidden control (image, command, mounts, env,
 * endpoints, network, credentials, resources, runtime, profile, model,
 * provider, tools, system prompt, messages, and the alternate payload
 * spelling) is rejected by exactly one implementation.
 *
 * The `GITHUB_SCOPE_RESERVED_BYTES` reservation only applies when this
 * agent's configuration actually appends the GitHub scope block (static
 * `githubEnabled` or `dynamicEnabled`, mirroring `buildAgentTask`'s own
 * condition). Configurations without GitHub MCP access get the full
 * protocol-advertised `MAX_TASK_BYTES` bound, matching the entrypoint's
 * unmodified 64 KiB `read_bounded` limit for those prompts.
 */
function createAgentRequestValidator(maxPromptBytes, { githubEnabled, dynamicEnabled } = {}) {
  const appendsGitHubScope = Boolean(githubEnabled || dynamicEnabled);
  const maxTaskBytes = appendsGitHubScope
    ? Math.min(maxPromptBytes, MAX_TASK_BYTES - GITHUB_SCOPE_RESERVED_BYTES)
    : Math.min(maxPromptBytes, MAX_TASK_BYTES);
  return (request) => validateEnclaveAgentRequest(request, { maxTaskBytes });
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
  createInvocationWorkspace({ config, invocationId, privateRepo, schema, prompt, executorBearer }) {
    return agentWorkspace.createInvocationWorkspace({
      config,
      invocationId,
      schema,
      // The caller's prompt first, then AWF's repository scope instructions
      // derived from the broker's own validated configuration.
      task: buildAgentTask(prompt, {
        githubEnabled: Boolean(config.githubEnabled || config.dynamicEnabled),
        privateRepo,
      }),
      githubAgentId: config.githubEnabled ? config.githubAgentId : undefined,
      executorBearer,
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
  return createEnclaveRunner(config, deps);
}

module.exports = {
  AGENT_PAYLOAD_KEY,
  ENCLAVE_EXIT_CATEGORIES,
  GITHUB_SCOPE_RESERVED_BYTES,
  agentWorkspaceAdapter,
  buildAgentTask,
  buildGitHubScopeInstructions,
  createAgentRequestValidator,
  createAgentRunner,
};
