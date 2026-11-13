'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { GATEWAY_CONTAINER } = require('./constants');

function run(command, args, options = {}) {
  const { captureStderr = false, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...spawnOptions,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Required live enclave command failed: ${path.basename(command)}`);
  }
  return captureStderr ? `${result.stdout}\n${result.stderr}` : result.stdout;
}

function captureContainerLogs(profile = 'combined', dockerPrimary = false) {
  return [
    GATEWAY_CONTAINER,
    'awf-enclave-mcp-server',
    'awf-api-proxy',
    ...(dockerPrimary ? ['awf-agent'] : []),
    ...(profile === 'script-only' ? [] : ['awf-enclave-agent-api-proxy']),
    'awf-squid',
  ].map((container) => run('docker', ['logs', container], {
    maxBuffer: 1024 * 1024,
    captureStderr: true,
  }));
}

module.exports = {
  run,
  captureContainerLogs,
};
