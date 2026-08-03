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
  // `sbx ls` only proves the CLI/daemon is installed, authenticated, and
  // reachable. It is deliberately NOT reported as `supported`: this static CI
  // report never starts a sandbox, mounts the broker's Unix socket, or drives
  // the authenticated HTTP capability exchange, so it cannot execute the
  // ingress proof (`assertSbxBoundedAgentIngress` in `main-action.ts`) that
  // this PR's "supported after ingress proof" condition requires. Promoting
  // primary sbx to `supported` from this alone would be a false positive.
  // It is reported as `available`: CLI/daemon reachability confirmed, ingress
  // unproven.
  const sbxPrimary = commandRunner('sbx', ['ls']).ok;
  const sbxBoundedAgent = commandRunner(
    process.execPath,
    ['containers/bounded-agent/broker/sbx-capability-probe.js'],
  );
  let sbxBoundedAgentSupported = false;
  if (sbxBoundedAgent.stdout) {
    try {
      sbxBoundedAgentSupported = JSON.parse(sbxBoundedAgent.stdout).supported === true;
    } catch {
      sbxBoundedAgentSupported = false;
    }
  }
  return {
    primary: {
      docker: docker.ok ? 'supported' : 'unavailable',
      gvisor: gvisor ? 'supported' : 'unavailable',
      sbx: sbxPrimary ? 'available' : 'unavailable',
    },
    boundedAgent: {
      docker: docker.ok ? 'supported' : 'unavailable',
      gvisor: gvisor ? 'supported' : 'unavailable',
      sbx: sbxBoundedAgentSupported ? 'supported' : 'blocked',
    },
  };
}

/**
 * Evaluates one primary/bounded-agent combination without ever promoting a
 * primary sbx CLI/daemon reachability check (`available`) to `SUPPORTED`.
 *
 * A primary sbx combination can only reach `SUPPORTED` once its capability is
 * literally `supported` — a value this static reporter never assigns to
 * primary sbx (see {@link collectCapabilities}) because it cannot execute the
 * pre-agent ingress proof. `available` is therefore always reported as
 * `BLOCKED` at a distinct `primary-sbx-ingress-unproven` phase so it is never
 * confused with an outright-unavailable CLI/daemon.
 */
function evaluate(primary, boundedAgent, capabilities) {
  const primaryState = capabilities.primary[primary];
  if (primaryState === 'available') {
    return {
      status: 'BLOCKED',
      capability: primaryState,
      phase: 'primary-sbx-ingress-unproven',
    };
  }
  if (primaryState !== 'supported') {
    return {
      status: 'BLOCKED',
      capability: primaryState,
      phase: 'primary-preflight',
    };
  }
  if (capabilities.boundedAgent[boundedAgent] !== 'supported') {
    return {
      status: 'BLOCKED',
      capability: capabilities.boundedAgent[boundedAgent],
      phase: 'bounded-agent-preflight',
    };
  }
  return { status: 'SUPPORTED', capability: 'supported', phase: 'ready' };
}

function renderMatrix(capabilities) {
  const lines = [
    '## Bounded-agent runtime capability matrix',
    '',
    '| Primary agent | Bounded-agent enclave | Result | Primary capability | ' +
    'Bounded-agent capability | Gate |',
    '|---|---|---|---|---|---|',
  ];
  for (const primary of BACKENDS) {
    for (const boundedAgent of BACKENDS) {
      const result = evaluate(primary, boundedAgent, capabilities);
      lines.push(
        `| ${primary} | ${boundedAgent} | ${result.status} | ${capabilities.primary[primary]} | ` +
        `${capabilities.boundedAgent[boundedAgent]} | ${result.phase} |`,
      );
    }
  }
  lines.push(
    '',
    '> BLOCKED is an expected fail-closed security result, not runtime success. No fallback is attempted.',
    '> The bounded-agent sbx enclave is BLOCKED unconditionally today: the audited sbx CLI cannot yet ' +
    'prove the mandatory API-proxy-only network, RO-targeted-mount, pids/disk/fsize, or lifecycle ' +
    'isolation primitives this enclave requires.',
    '> Primary capability `available` (sbx only) means the CLI/daemon is installed, authenticated, and ' +
    'reachable, but the pre-agent ingress proof this static report cannot execute has not run — it is ' +
    'never promoted to SUPPORTED here. Primary sbx becomes SUPPORTED only after ' +
    '`assertSbxBoundedAgentIngress` proves the selected ingress during an actual run.',
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
    const [primary, boundedAgent] = requirement.split('/');
    if (!BACKENDS.includes(primary) || !BACKENDS.includes(boundedAgent)) {
      throw new Error(`Invalid --require combination: ${requirement}`);
    }
    const result = evaluate(primary, boundedAgent, capabilities);
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
