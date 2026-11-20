'use strict';

const { createExecutorHandler } = require('../script-executor/executor-handler');
const { createScriptRunner } = require('../script-executor/script-runner');
const { loadAgentConfig, loadConfig } = require('./config');
const {
  ENCLAVE_EXIT_CATEGORIES,
  agentWorkspaceAdapter,
  createAgentRequestValidator,
  createAgentRunner,
} = require('./agent-executor');
const { AGENT_TOOL_NAME, TOOL_NAME } = require('./mcp-protocol');
const { createDynamicDelegationClient } = require('./delegation-channel');
const { createHostExecutorRunner, usesHostExecutor } = require('./host-executor-runner');
const { runStartupStage } = require('./startup-diagnostics');
const { getExecutorBackend } = require('./startup-plan');

async function configureExecutor({
  kind, startupReporter, serverConfig, scriptEnabled, agentEnabled,
  runId, seeds, audit, hostExecutorAudit, clock, ledger, telemetry, lane,
  handlers, runners, executors,
}) {
  if (kind !== 'script' && kind !== 'agent') throw new Error('Unknown executor kind');
  const script = kind === 'script';
  const details = { executorKind: kind };
  const config = await runStartupStage(
    startupReporter, `${kind}-config`, `${kind}-config-invalid`,
    () => script ? loadConfig() : loadAgentConfig(serverConfig), details,
  );
  const runner = await runStartupStage(
    startupReporter, `${kind}-selection`, `${kind}-runner-initialization-failed`, () => {
      if (usesHostExecutor(config)) {
        return createHostExecutorRunner(config, { nowMs: clock.nowMs, audit: hostExecutorAudit });
      }
      const createRunner = script ? createScriptRunner : createAgentRunner;
      return createRunner(config, { nowMs: clock.nowMs });
    }, details,
  );
  startupReporter.configure({
    primaryBackend: serverConfig.primaryBackend,
    executorBackend: script
      ? agentEnabled && process.env.AWF_ENCLAVE_AGENT_BACKEND !== config.executorBackend
        ? 'mixed' : config.executorBackend
      : getExecutorBackend([...runners, { config }]),
    executorKind: scriptEnabled && agentEnabled ? 'both' : kind,
  });
  await runStartupStage(startupReporter, `${kind}-available`, `${kind}-availability-failed`,
    () => runner.assertAvailable(), details);
  await runStartupStage(startupReporter, `${kind}-reconcile`, `${kind}-reconciliation-failed`,
    () => runner.reconcileRun(runId), details);
  runners.push({ runner, config });
  handlers[script ? TOOL_NAME : AGENT_TOOL_NAME] = await runStartupStage(
    startupReporter, `${kind}-handler`, `${kind}-handler-construction-failed`, () =>
      createExecutorHandler({
        config,
        seedMap: seeds,
        runId,
        audit,
        diagnosticAudit: hostExecutorAudit,
        runner,
        ledger,
        telemetry,
        lane,
        executorKind: kind,
        uniformTiming: true,
        clock,
        ...(!script ? {
          workspace: agentWorkspaceAdapter,
          validateRequest: createAgentRequestValidator(config.maxPromptBytes, {
            githubEnabled: config.githubEnabled,
            dynamicEnabled: config.dynamicEnabled,
          }),
          payloadKey: 'prompt',
          exitCategories: ENCLAVE_EXIT_CATEGORIES,
          // Dynamic entries route every selector through AWF's canonical
          // admission before any repository content is exposed. `enclave_run_script`
          // is never registered for a dynamic entry, so it is neither advertised
          // nor dispatchable.
          ...(config.dynamicEnabled && !runner.hostOwned
            ? { admission: createDynamicDelegationClient(config) }
            : {}),
        } : {}),
      }),
    details,
  );
  executors.push(kind);
  return config;
}

module.exports = { configureExecutor };
