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
 * Capabilities that sbx must expose before AWF can safely launch a
 * enclave-agent enclave VM.
 *
 * Unlike enclave scripts (which run with `--network=none`), a enclave-agent
 * enclave must reach the AWF API proxy and nothing else — so instead of a
 * no-network primitive, sbx needs a *named-network attach with mandatory
 * lateral-peer denial*: the VM must be able to join a single named network
 * with exactly one reachable peer (the API proxy) and no route to any other
 * member, including other enclave VMs on the same network. sbx v0.37.1 has no
 * such primitive — its `--network` flag (if present at all) does not carry an
 * enforced peer-isolation guarantee, so this control is always reported
 * missing until AWF can name a specific, verifiable sbx flag or capability
 * token that provides it. Local Docker/iptables rules are insufficient
 * because organization sbx governance can replace them.
 */
const REQUIRED_HARD_ISOLATION_FLAGS = Object.freeze([
  '--network',
  '--pids-limit',
  '--disk-limit',
  '--ulimit-fsize',
  '--mount-target',
]);

/** Capability primitive sbx does not yet expose under any flag name. */
const LATERAL_PEER_DENIAL_PRIMITIVE =
  'sbx named-network attach with mandatory lateral-peer denial to enforce API-proxy-only egress ' +
  '(hard network-policy / capability-token ingress primitive)';

/** AWF has not published a pinned, immutable enclave-agent sbx template/bootstrap. */
const PINNED_TEMPLATE_MISSING = 'pinned AWF enclave-agent sbx template and bootstrap';

function includesFlag(help, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${escaped}(?=([=\\s,]|$))`, 'm').test(help);
}

async function inspectHelp(sbx, command) {
  const result = await sbx.runSbx([command, '--help'], 10_000);
  return result.exitCode === 0 ? result.stdout : '';
}

/**
 * Probes the installed sbx CLI for the exact version, authentication, and
 * hard-isolation flags a enclave-agent enclave requires.
 *
 * This never reports `supported: true` on flag detection alone: even when
 * every enumerated flag is present, the two capability primitives AWF cannot
 * yet verify (the pinned template/bootstrap and the lateral-peer-denial
 * network primitive) are unconditionally appended to `missing`. A future sbx
 * release that ships a concrete, checkable primitive for both must replace
 * this unconditional block with a real check — it must never be removed
 * without one.
 */
async function probeSbxCapabilities(sbx = defaultSbxClient) {
  const versionResult = await sbx.runSbx(['version'], 10_000);
  const daemonResult = await sbx.runSbx(['ls'], 10_000);
  const createHelp = await inspectHelp(sbx, 'create');
  const execHelp = await inspectHelp(sbx, 'exec');
  const versionMatch = /\bv?(\d+\.\d+\.\d+)\b/.exec(versionResult.stdout);
  const version = versionMatch ? versionMatch[1] : undefined;
  const missing = [];

  missing.push(PINNED_TEMPLATE_MISSING);
  missing.push(LATERAL_PEER_DENIAL_PRIMITIVE);

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
  LATERAL_PEER_DENIAL_PRIMITIVE,
  PINNED_TEMPLATE_MISSING,
  probeSbxCapabilities,
};
