#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

const BACKENDS = ['docker', 'gvisor', 'sbx'];

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout || '',
  };
}

function collectCapabilities(commandRunner = run) {
  const docker = commandRunner('docker', ['info', '--format', '{{json .Runtimes}}']);
  let runtimes = {};
  if (docker.ok) {
    try {
      runtimes = JSON.parse(docker.stdout);
    } catch {
      runtimes = {};
    }
  }
  const gvisor = Object.prototype.hasOwnProperty.call(runtimes, 'runsc');
  // `sbx version` only proves that the binary exists. Listing is authenticated
  // and non-mutating, so it also proves daemon and credential availability.
  const sbxPrimary = commandRunner('sbx', ['ls']).ok;
  const sbxQuery = commandRunner(
    process.execPath,
    ['containers/bounded-query/broker/sbx-capability-probe.js'],
  );
  let sbxQuerySupported = false;
  if (sbxQuery.stdout) {
    try {
      sbxQuerySupported = JSON.parse(sbxQuery.stdout).supported === true;
    } catch {
      sbxQuerySupported = false;
    }
  }
  return {
    primary: {
      docker: docker.ok ? 'supported' : 'unavailable',
      gvisor: gvisor ? 'supported' : 'unavailable',
      sbx: sbxPrimary ? 'supported' : 'unavailable',
    },
    query: {
      docker: docker.ok ? 'supported' : 'unavailable',
      gvisor: gvisor ? 'supported' : 'unavailable',
      sbx: sbxQuerySupported ? 'supported' : 'blocked',
    },
  };
}

function evaluate(primary, query, capabilities) {
  if (capabilities.primary[primary] !== 'supported') {
    return {
      status: 'BLOCKED',
      capability: capabilities.primary[primary],
      phase: 'primary-preflight',
    };
  }
  if (capabilities.query[query] !== 'supported') {
    return {
      status: 'BLOCKED',
      capability: capabilities.query[query],
      phase: 'query-preflight',
    };
  }
  return { status: 'SUPPORTED', capability: 'supported', phase: 'ready' };
}

function renderMatrix(capabilities) {
  const lines = [
    '## Bounded-query runtime capability matrix',
    '',
    '| Primary agent | Query sandbox | Result | Primary capability | Query capability | Gate |',
    '|---|---|---|---|---|---|',
  ];
  for (const primary of BACKENDS) {
    for (const query of BACKENDS) {
      const result = evaluate(primary, query, capabilities);
      lines.push(
        `| ${primary} | ${query} | ${result.status} | ${capabilities.primary[primary]} | ` +
        `${capabilities.query[query]} | ${result.phase} |`,
      );
    }
  }
  lines.push(
    '',
    '> BLOCKED is an expected fail-closed security result, not runtime success. No fallback is attempted.',
  );
  return `${lines.join('\n')}\n`;
}

function main() {
  const capabilities = collectCapabilities();
  const report = renderMatrix(capabilities);
  process.stdout.write(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  }

  const requiredIndex = process.argv.indexOf('--require');
  if (requiredIndex !== -1) {
    const requirement = process.argv[requiredIndex + 1] || '';
    const [primary, query] = requirement.split('/');
    if (!BACKENDS.includes(primary) || !BACKENDS.includes(query)) {
      throw new Error(`Invalid --require combination: ${requirement}`);
    }
    const result = evaluate(primary, query, capabilities);
    if (result.status !== 'SUPPORTED') {
      throw new Error(`Required runtime combination ${requirement} is ${result.status} at ${result.phase}`);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { collectCapabilities, evaluate, renderMatrix };
