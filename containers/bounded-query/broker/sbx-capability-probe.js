#!/usr/bin/env node
'use strict';

const defaultSbxClient = require('./sbx-client');

const AUDITED_SBX_VERSION = '0.37.1';
const REQUIRED_CREATE_FLAGS = Object.freeze([
  '--cpus',
  '--memory',
  '--name',
  '--template',
]);
const REQUIRED_EXEC_FLAGS = Object.freeze([
  '--user',
  '--workdir',
]);

/**
 * Capabilities that sbx must expose before AWF can safely launch a query VM.
 *
 * sbx v0.37.1 lacks the final five controls. Local or kit network rules are
 * insufficient because organization governance can replace them.
 */
const REQUIRED_HARD_ISOLATION_FLAGS = Object.freeze([
  '--network=none',
  '--pids-limit',
  '--disk-limit',
  '--ulimit-fsize',
  '--mount-target',
]);

function includesFlag(help, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${escaped}(?=([=\\s,]|$))`, 'm').test(help);
}

async function inspectHelp(sbx, command) {
  const result = await sbx.runSbx([command, '--help'], 10_000);
  return result.exitCode === 0 ? result.stdout : '';
}

async function probeSbxCapabilities(sbx = defaultSbxClient) {
  const versionResult = await sbx.runSbx(['version'], 10_000);
  const daemonResult = await sbx.runSbx(['ls'], 10_000);
  const createHelp = await inspectHelp(sbx, 'create');
  const execHelp = await inspectHelp(sbx, 'exec');
  const versionMatch = /\bv?(\d+\.\d+\.\d+)\b/.exec(versionResult.stdout);
  const version = versionMatch ? versionMatch[1] : undefined;
  const missing = [];

  // AWF has not published the immutable Python-only sbx template/bootstrap
  // because current sbx cannot yet enforce the controls below.
  missing.push('pinned AWF Python query template and bootstrap');

  if (versionResult.exitCode !== 0 || !version || daemonResult.exitCode !== 0) {
    missing.push('authenticated sbx CLI/daemon');
  }
  if (version && version !== AUDITED_SBX_VERSION) {
    missing.push(`audited sbx version ${AUDITED_SBX_VERSION} (found ${version})`);
  }
  for (const flag of REQUIRED_CREATE_FLAGS) {
    if (!includesFlag(createHelp, flag)) missing.push(`sbx create ${flag}`);
  }
  for (const flag of REQUIRED_EXEC_FLAGS) {
    if (!includesFlag(execHelp, flag)) missing.push(`sbx exec ${flag}`);
  }
  for (const flag of REQUIRED_HARD_ISOLATION_FLAGS) {
    if (!includesFlag(createHelp, flag)) missing.push(`sbx create ${flag}`);
  }

  return Object.freeze({
    supported: missing.length === 0,
    version,
    auditedVersion: AUDITED_SBX_VERSION,
    missing: Object.freeze(missing),
  });
}

async function main() {
  const report = await probeSbxCapabilities();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.supported ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      supported: false,
      auditedVersion: AUDITED_SBX_VERSION,
      missing: ['capability probe failed'],
      error: error.message,
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  AUDITED_SBX_VERSION,
  REQUIRED_CREATE_FLAGS,
  REQUIRED_EXEC_FLAGS,
  REQUIRED_HARD_ISOLATION_FLAGS,
  probeSbxCapabilities,
};
