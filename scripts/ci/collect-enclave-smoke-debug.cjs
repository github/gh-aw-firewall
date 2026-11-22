/* global require, module, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_STREAM_BYTES, MAX_FILES, MAX_PUBLISHED_FILES, MAX_PUBLISHED_BYTES, MAX_STATUS_BYTES,
  MAX_STARTUP_BYTES, MAX_DIRECTORY_ENTRIES, ROOTS, object, check,
} = require('./collect-enclave-smoke-debug/common.cjs');
const { directory, inventory, readRegular } = require('./collect-enclave-smoke-debug/safe-fs.cjs');
const { redactCredentials, isSafeCopilotAuthLogFields } = require('./collect-enclave-smoke-debug/redaction.cjs');
const {
  projectStartup, projectFinalization, FINALIZATION_REASONS, RESULT_CODES, projectStartupChecklist,
  projectProxyUsage, projectProxyResponse, projectProxyEvents, projectProxyContainerLog, projectDiagnostics,
} = require('./collect-enclave-smoke-debug/projections.cjs');
const {
  prepare, collect, retainStartup, retainFinalization, publishCollectionFailure,
  assertPublicationBounds, snapshot, classifyFailure,
} = require('./collect-enclave-smoke-debug/publication.cjs');

function cliRoots(backend, runnerUid) {
  if (backend === 'cloud-hypervisor') return { ...ROOTS, backend, sourceUid: 0 };
  const base = `/var/lib/awf/enclave-storage/${runnerUid}/host-state`;
  return { backend, sourceUid: runnerUid, journal: path.join(base, 'host-executor-journal'),
    debug: path.join(base, 'debug-artifacts', 'docker') };
}

function cliCandidates(backend, runnerUid) {
  const selected = cliRoots(backend, runnerUid);
  return backend === 'docker' ? [selected, {
    backend, sourceUid: 0, journal: ROOTS.journal,
    debug: '/var/lib/awf-cloud-hypervisor/debug-artifacts/docker',
  }] : [selected];
}

function parseArguments(args) {
  let [operation, backend, key, uidText, gidText] = args;
  const legacy = (args.length === 2 && operation === 'prepare')
    || (args.length === 4 && operation === 'collect');
  if (legacy) {
    [operation, key, uidText = '0', gidText = '0'] = args;
    backend = 'cloud-hypervisor';
  }
  const validId = value => /^(?:0|[1-9][0-9]{0,9})$/.test(value ?? '')
    && Number(value) <= 0xfffffffe;
  check((args.length === 5 || legacy)
    && ['prepare', 'collect'].includes(operation) && ['docker', 'cloud-hypervisor'].includes(backend)
    && /^[0-9]{1,20}-[0-9]{1,10}$/.test(key ?? '') && validId(uidText) && validId(gidText), 'cli-arguments');
  const runnerUid = Number(uidText);
  const runnerGid = Number(gidText);
  // Historical CH prepare callers did not supply the runner identity. They
  // remain root-only and CH-only; never reinterpret their scope as Docker.
  const binding = legacy ? { backend, legacy: true } : { backend, runnerUid, runnerGid };
  return { operation, backend, key, runnerUid, runnerGid, binding };
}

function main(args = process.argv.slice(2), options = {}) {
  const privilegedUid = options.privilegedUid ?? 0;
  const exportRoot = options.exportRoot ?? '/var/lib/awf-enclave-smoke-export';
  const exportTrustedRoot = options.exportTrustedRoot ?? '/';
  const candidatesForBackend = options.candidatesForBackend ?? cliCandidates;
  check(process.getuid() === privilegedUid, 'cli-arguments');
  const { operation, backend, key, runnerUid, runnerGid, binding } = parseArguments(args);
  const candidates = candidatesForBackend(backend, runnerUid);
  const runDirectory = path.join(exportRoot, key);
  if (operation === 'prepare') {
    // Source ownership may be the unprivileged Docker runner, but staging is root-only.
    directory(path.dirname(runDirectory), privilegedUid, exportTrustedRoot);
    fs.mkdirSync(runDirectory, { mode: 0o700 });
    const baseline = { binding, sourceScopes: candidates.map(snapshot) };
    fs.writeFileSync(path.join(runDirectory, 'baseline.json'), JSON.stringify(baseline), { mode: 0o600, flag: 'wx' });
    return 0;
  }
  try {
    directory(runDirectory, privilegedUid, exportTrustedRoot);
    check(!fs.existsSync(path.join(runDirectory, 'collected')), 'prepared-scope', 'scope-already-collected');
    const prepared = JSON.parse(readRegular(path.join(runDirectory, 'baseline.json'), MAX_STREAM_BYTES, privilegedUid));
    check(object(prepared) && JSON.stringify(prepared.binding) === JSON.stringify(binding)
      && Array.isArray(prepared.sourceScopes) && prepared.sourceScopes.length === candidates.length, 'prepared-scope');
    const active = candidates.filter((candidate, index) => {
      const before = prepared.sourceScopes[index];
      check(object(before) && before.journal === candidate.journal
        && ['journals', 'debug', 'proxyDebug'].every(key => Array.isArray(before[key])
          && before[key].length <= MAX_DIRECTORY_ENTRIES && before[key].every(name => typeof name === 'string')),
      'prepared-scope');
      const after = snapshot(candidate);
      return ['journals', 'debug', 'proxyDebug'].some(key => after[key].some(name => !before[key].includes(name)));
    });
    if (active.length > 1) {
      fs.writeFileSync(path.join(runDirectory, 'collected'), '', { mode: 0o600, flag: 'wx' });
      check(false, 'run-budget', 'concurrent-runs');
    }
    const roots = active[0] ?? candidates[0];
    collect(runDirectory, runnerUid, runnerGid, roots, roots.sourceUid, roots.trustedRoot ?? '/',
      binding, privilegedUid, exportTrustedRoot);
    return 0;
  } catch (error) {
    const failure = classifyFailure(error);
    publishCollectionFailure(runDirectory, runnerUid, runnerGid, error, privilegedUid, exportTrustedRoot, binding);
    process.stderr.write(`Collection failed: failedCheck=${failure.failedCheck} category=${failure.category}\n`);
    return 1;
  }
}

module.exports = {
  prepare, collect, retainStartup, projectStartup, retainFinalization, projectFinalization, FINALIZATION_REASONS,
  RESULT_CODES,
  projectStartupChecklist,
  MAX_STREAM_BYTES, MAX_FILES, MAX_PUBLISHED_FILES, MAX_PUBLISHED_BYTES, MAX_STATUS_BYTES, MAX_STARTUP_BYTES,
  directory, inventory, readRegular, projectProxyUsage, projectProxyResponse,
  projectProxyEvents, projectProxyContainerLog, isSafeCopilotAuthLogFields,
  projectDiagnostics, cliRoots, cliCandidates, parseArguments, main, publishCollectionFailure,
  assertPublicationBounds, redactCredentials,
};

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) {
    const failure = classifyFailure(error);
    process.stderr.write(`Collection failed: failedCheck=${failure.failedCheck} category=${failure.category}\n`);
    process.exitCode = 1;
  }
}
