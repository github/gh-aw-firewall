'use strict';

const STAGES = [
  'server-config', 'audit', 'seed-map', 'executors', 'script-config',
  'script-available', 'script-reconcile', 'agent-config', 'agent-available',
  'agent-reconcile', 'tool-budget', 'listen', 'ready-file',
];
const ERROR_TYPES = ['Error', 'TypeError', 'SyntaxError', 'RangeError'];
const ERROR_CODES = [
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EROFS', 'EADDRINUSE',
  'EADDRNOTAVAIL', 'ECONNREFUSED', 'ETIMEDOUT', 'MODULE_NOT_FOUND',
];
const MODULES = [
  'mcp-server/server.js', 'mcp-server/config.js', 'mcp-server/host-executor-runner.js',
  'mcp-server/tool-call-budget.js', 'script-executor/script-runner.js',
  'bounded-execution/protected-audit.js',
];

function startupDiagnostic(error, stage) {
  const frames = [];
  const stack = typeof error?.stack === 'string' ? error.stack.slice(0, 16384) : '';
  for (const line of stack.split('\n').slice(1, 50)) {
    const match = line.match(/^\s+at .*?(\/opt\/awf\/[^ ()]+):(\d{1,6}):(\d{1,6})\)?$/);
    if (!match) continue;
    const module = MODULES.find(name => match[1] === `/opt/awf/enclave/${name}`
      || match[1] === `/opt/awf/${name}`);
    if (module) frames.push({ module, line: Number(match[2]), column: Number(match[3]) });
    if (frames.length === 8) break;
  }
  return {
    schemaVersion: 1,
    component: 'enclave-mcp-server',
    kind: 'startup-error',
    stage: STAGES.includes(stage) ? stage : 'unknown',
    errorType: ERROR_TYPES.includes(error?.name) ? error.name : 'unknown',
    code: ERROR_CODES.includes(error?.code) ? error.code : 'unknown',
    frames,
  };
}

module.exports = { startupDiagnostic };
