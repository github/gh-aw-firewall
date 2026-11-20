'use strict';

const { isAgentExecutorEnabled, isScriptExecutorEnabled } = require('./config');

function createStartupPlan() {
  const scriptEnabled = isScriptExecutorEnabled();
  const agentEnabled = isAgentExecutorEnabled();
  const configuredBackends = new Set([
    scriptEnabled ? process.env.AWF_ENCLAVE_BACKEND : undefined,
    agentEnabled ? process.env.AWF_ENCLAVE_AGENT_BACKEND : undefined,
  ].filter(Boolean));
  return {
    scriptEnabled,
    agentEnabled,
    context: {
      primaryBackend: process.env.AWF_ENCLAVE_PRIMARY_BACKEND,
      executorBackend: configuredBackends.size > 1 ? 'mixed' : [...configuredBackends][0],
      executorKind: scriptEnabled && agentEnabled ? 'both'
        : scriptEnabled ? 'script' : agentEnabled ? 'agent' : 'none',
    },
    stages: [
      'server-config', 'audit', 'seed-map', 'executors', 'executor-state',
      ...(scriptEnabled ? [
        'script-config', 'script-selection', 'script-available', 'script-reconcile', 'script-handler',
      ] : []),
      ...(agentEnabled ? [
        'agent-config', 'agent-selection', 'agent-available', 'agent-reconcile', 'agent-handler',
      ] : []),
      'backend-consistency', 'tool-budget', 'listener-binding', 'ready-file',
    ],
  };
}

function getExecutorBackend(runners) {
  const backends = new Set(runners.map(({ config }) => config.executorBackend));
  return backends.size === 1 ? runners[0].config.executorBackend : 'mixed';
}

module.exports = { createStartupPlan, getExecutorBackend };
