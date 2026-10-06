'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');

const RELEASE_ASSETS = [
  'cloud-hypervisor-test-x86_64.tar.gz',
  'cloud-hypervisor-test-x86_64.manifest.json',
  'cloud-hypervisor-test-x86_64.manifest.sigstore.jsonl',
  'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json',
  'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
  'enclave-script-rootfs.ext4',
  'enclave-agent-rootfs.ext4',
  'enclave-script-rootfs.sbom.spdx.json',
  'enclave-agent-rootfs.sbom.spdx.json',
  'enclave-script-rootfs.provenance.sigstore.jsonl',
  'enclave-agent-rootfs.provenance.sigstore.jsonl',
];
const GATEWAY_IMAGE = 'awf-cloud-hypervisor-enclave-live-gateway:test';
const GATEWAY_CONTAINER = 'awmg-mcpg';
const SENTINEL_PREFIX = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_';

function assertReleaseAssets(required, published) {
  const available = new Set(published);
  const missing = required.filter((asset) => !available.has(asset));
  if (missing.length) {
    throw new Error(
      `Package-matched AWF release is missing required release-attested Cloud Hypervisor assets: ${missing.join(', ')}. `
      + 'Publish a release for this package version with the attested Cloud Hypervisor and enclave artifact set; '
      + 'unattested build artifacts are not accepted.',
    );
  }
}

function parsePublicToolResult(response, requestId) {
  if (!response || response.jsonrpc !== '2.0' || response.id !== requestId
      || response.error || !response.result || response.result.isError === true) {
    throw new Error('Public enclave MCP call did not return a successful JSON-RPC result');
  }
  const structured = response.result.structuredContent;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)
      || !['ok', 'error'].includes(structured.status)) {
    throw new Error('Public enclave MCP result is not canonical structured content');
  }
  const keys = Object.keys(structured).sort();
  if (JSON.stringify(keys) !== JSON.stringify(
    structured.status === 'ok' ? ['result', 'status'] : ['status'],
  )) {
    throw new Error('Public enclave MCP result contains unexpected fields');
  }
  const content = response.result.content;
  if (!Array.isArray(content) || content.length !== 1
      || content[0]?.type !== 'text'
      || content[0].text !== JSON.stringify(structured)) {
    throw new Error('Public enclave MCP text and structured results do not match canonically');
  }
  return structured;
}

function readDiagnosticFile(file, maxBytes = 16 * 1024 * 1024, requireStable = false) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY
      | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('Live enclave diagnostic is not a regular file');
    if (stat.size > maxBytes) {
      throw new Error('Live enclave diagnostic file exceeded the scan bound');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const bytes = fs.readSync(descriptor, buffer, size, buffer.length - size, null);
      if (bytes === 0) break;
      size += bytes;
    }
    if (size > maxBytes) {
      throw new Error('Live enclave diagnostic file exceeded the scan bound');
    }
    if (requireStable) {
      const after = fs.fstatSync(descriptor);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
          || after.ctimeMs !== stat.ctimeMs || size !== stat.size) {
        throw new Error('Live enclave diagnostic file changed during inspection');
      }
    }
    return buffer.subarray(0, size);
  } catch (error) {
    if (error.code) throw new Error('Could not inspect live enclave diagnostic file');
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function scanTextDirectory(directory, sentinel, found) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Could not inspect live enclave diagnostic output');
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      scanTextDirectory(file, sentinel, found);
    } else if (entry.isFile() && /\.(?:json|jsonl|log|txt)$/i.test(entry.name)) {
      if (readDiagnosticFile(file).includes(Buffer.from(sentinel, 'utf8'))) found.value = true;
    }
  }
}

function assertNoSentinelLeak(directories, logContents, sentinel) {
  if (logContents.some((content) => content.includes(sentinel))) {
    throw new Error('Synthetic enclave output sentinel escaped into a captured log');
  }
  const found = { value: false };
  for (const directory of directories) scanTextDirectory(directory, sentinel, found);
  if (found.value) {
    throw new Error('Synthetic enclave output sentinel escaped into audit or diagnostic files');
  }
}

function buildConstantObjectSchema(expected) {
  return {
    type: 'object',
    fields: Object.fromEntries(
      Object.entries(expected).map(([name, value]) => [name, { type: 'const', value }]),
    ),
  };
}

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

function captureContainerLogs() {
  return [
    GATEWAY_CONTAINER,
    'awf-enclave-mcp-server',
    'awf-api-proxy',
    'awf-enclave-agent-api-proxy',
    'awf-squid',
  ].map((container) => run('docker', ['logs', container], {
    maxBuffer: 1024 * 1024,
    captureStderr: true,
  }));
}

function requestMcp(endpoint, apiKey, requestId, method, params, signal, timeoutMs = 15 * 60_000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }));
    const request = http.request(endpoint, {
      method: 'POST',
      headers: {
        authorization: apiKey,
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 420 * 1024) request.destroy(new Error('MCP response exceeded its bound'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('Public enclave MCP response was not bounded JSON'));
        }
      });
    });
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      request.destroy();
      resolve(undefined);
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    request.on('error', () => {
      if (!cancelled) reject(new Error('Public enclave MCP request failed'));
    });
    request.on('timeout', () => request.destroy(new Error('Public enclave MCP request timed out')));
    request.on('close', () => signal?.removeEventListener('abort', cancel));
    if (!cancelled) request.end(payload);
  });
}

// Match only the first fatal header, never stdout, stack frames, or cleanup warnings.
const STARTUP_CATEGORIES = new Map([
  ['The Docker primary-agent runtime is unavailable; enclaves never fall back', 'container-runtime'],
  ['Cloud Hypervisor enclave runtime configuration is missing', 'configuration'],
  ['Cloud Hypervisor enclaves require a staged trusted run ID', 'configuration'],
  ['Preflight storage requires root-owned trusted directories', 'host-preflight'],
  ['Preflight storage requires a normalized absolute directory', 'host-preflight'],
  ['Trusted enclave artifact has invalid file metadata', 'artifact'],
  ['Trusted enclave artifact has invalid content size', 'artifact'],
  ['Enclave artifact manifest bundle must use its fixed release filename', 'artifact'],
  ['Cloud Hypervisor enclave host service could not start', 'host-service'],
  ['Unsafe Cloud Hypervisor enclave recovery directory; private state is preserved', 'recovery-state'],
  ['Trusted enclave MCP gateway container is unavailable', 'broker'],
  ['Trusted enclave MCP gateway identity could not be inspected', 'broker'],
  ['Trusted enclave MCP gateway identity did not match the compiler handoff', 'broker'],
  ['Enclave MCP control network is unavailable', 'broker'],
  ['Failed to attach the trusted enclave MCP gateway to its private control network', 'broker'],
]);
for (const tool of ['mount', 'umount', 'rsync']) {
  STARTUP_CATEGORIES.set(`Bounded enclave preflight requires trusted host tool "${tool}"`, 'host-preflight');
}
for (const role of ['script', 'agent']) {
  STARTUP_CATEGORIES.set(
    `${role} enclave rootfs does not match its trusted manifest digest and size`, 'artifact',
  );
  STARTUP_CATEGORIES.set(
    `${role} enclave rootfs SBOM does not match its trusted manifest digest`, 'artifact',
  );
}
const failedSpawns = new WeakSet();
const hostPreflightSchema = require('../../src/cloud-hypervisor/host-preflight-schema.json');

function safeHostPreflight(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== '["checks","schemaVersion","scope"]'
      || value.schemaVersion !== 1
      || typeof value.scope !== 'string'
      || !Object.prototype.hasOwnProperty.call(hostPreflightSchema.scopes, value.scope)
      || !Array.isArray(value.checks)) return undefined;
  const expected = Object.keys(hostPreflightSchema.scopes[value.scope]);
  if (value.checks.length !== expected.length) return undefined;
  const checks = [];
  for (let index = 0; index < expected.length; index += 1) {
    const check = value.checks[index];
    if (!check || JSON.stringify(Object.keys(check).sort()) !== '["id","reason","result"]'
        || check.id !== expected[index]
        || !['not-attempted', 'not-required', 'attempted', 'passed', 'failed'].includes(check.result)
        || typeof check.reason !== 'string'
        || !Object.prototype.hasOwnProperty.call(hostPreflightSchema.reasons, check.reason)
        || (check.result === 'failed' ? check.reason === 'none' : check.reason !== 'none')
        || (check.result === 'not-required'
          && !hostPreflightSchema.optionalChecks.includes(`${value.scope}/${check.id}`))) {
      return undefined;
    }
    checks.push({ id: check.id, result: check.result, reason: check.reason });
  }
  return { schemaVersion: 1, scope: value.scope, checks };
}

function safeStartupChecklist(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== '["checks","ready","schemaVersion"]'
      || value.schemaVersion !== 1 || typeof value.ready !== 'boolean'
      || !value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)) return undefined;
  const checks = {};
  const scopes = new Set();
  for (const [id, outcome] of Object.entries(value.checks)) {
    const [scope, check, extra] = id.split('/');
    if (extra !== undefined || !Object.prototype.hasOwnProperty.call(hostPreflightSchema.scopes, scope)
        || !Object.prototype.hasOwnProperty.call(hostPreflightSchema.scopes[scope], check)
        || !Array.isArray(outcome) || outcome.length !== 2
        || !['not-attempted', 'not-required', 'attempted', 'passed', 'failed'].includes(outcome[0])
        || typeof outcome[1] !== 'string'
        || !Object.prototype.hasOwnProperty.call(hostPreflightSchema.reasons, outcome[1])
        || (outcome[0] === 'failed' ? outcome[1] === 'none' : outcome[1] !== 'none')
        || (outcome[0] === 'not-required' && !hostPreflightSchema.optionalChecks.includes(id))) return undefined;
    checks[id] = [outcome[0], outcome[1]];
    scopes.add(scope);
  }
  for (const scope of scopes) {
    if (Object.keys(hostPreflightSchema.scopes[scope]).some((id) =>
      !Object.prototype.hasOwnProperty.call(checks, `${scope}/${id}`))) return undefined;
  }
  if (value.ready && (checks['startup/readiness']?.[0] !== 'passed'
    || Object.values(checks).some(([result]) => result !== 'passed' && result !== 'not-required'))) return undefined;
  return { schemaVersion: 1, ready: value.ready, checks };
}

function safeEnclaveStartup(value) {
  const keys = ['attempts', 'code', 'httpStatus', 'perspective', 'readiness', 'schemaVersion', 'stage'];
  if (value && Object.prototype.hasOwnProperty.call(value, 'hostPreflight')) keys.push('hostPreflight');
  if (value && Object.prototype.hasOwnProperty.call(value, 'startupChecks')) keys.push('startupChecks');
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
      || value.schemaVersion !== 1 || value.perspective !== 'awf-host'
      || ![
        'host-bootstrap', 'runtime-preflight', 'configuration', 'enclave-preflight',
        'host-preflight', 'artifact-preflight', 'seed-staging', 'storage-preflight',
        'recovery', 'host-service',
        'host-network', 'compose-config', 'containers', 'gateway-attach',
        'github-readiness', 'gateway-contract', 'initialize', 'initialized',
        'tools-list', 'delegation', 'primary-agent',
      ].includes(value.stage)
      || !['not-attempted', 'attempted', 'ready'].includes(value.readiness)
      || ![
        'none', 'unknown', 'dns-not-found', 'dns-temporary', 'connection-refused',
        'connection-timeout', 'request-timeout', 'network-unreachable', 'host-unreachable',
        'connection-reset', 'transport-other', 'http-auth', 'http-status',
        'backend-unavailable', 'response-too-large', 'malformed-json',
        'malformed-protocol', 'rpc-error', 'identity-mismatch', 'tools-mismatch', 'readiness-deadline', 'ready',
      ].includes(value.code)
      || !Number.isInteger(value.attempts) || value.attempts < 0 || value.attempts > 1200
      || !(value.httpStatus === null
        || (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599))
      || (value.readiness === 'not-attempted'
        && (value.attempts !== 0 || !['none', 'unknown', 'readiness-deadline'].includes(value.code)))
      || (value.readiness !== 'not-attempted' && value.attempts === 0)
      || (value.readiness === 'ready'
        && (value.code !== 'ready' || !['tools-list', 'delegation', 'primary-agent'].includes(value.stage)))) {
    return undefined;
  }
  const hostPreflight = value.hostPreflight === undefined ? undefined : safeHostPreflight(value.hostPreflight);
  if (Object.prototype.hasOwnProperty.call(value, 'hostPreflight') && !hostPreflight) return undefined;
  const startupChecks = value.startupChecks === undefined ? undefined : safeStartupChecklist(value.startupChecks);
  if (Object.prototype.hasOwnProperty.call(value, 'startupChecks') && !startupChecks) return undefined;
  return {
    schemaVersion: 1, perspective: 'awf-host', stage: value.stage,
    readiness: value.readiness, code: value.code, attempts: value.attempts,
    httpStatus: value.httpStatus,
    ...(hostPreflight ? { hostPreflight } : {}),
    ...(startupChecks ? { startupChecks } : {}),
  };
}

function gatewayCategory(code) {
  if (['dns-not-found', 'dns-temporary'].includes(code)) return 'dns';
  if ([
    'connection-refused', 'connection-timeout', 'request-timeout', 'network-unreachable',
    'host-unreachable', 'connection-reset',
  ].includes(code)) return 'connectivity';
  if (code === 'http-auth') return 'gateway-auth';
  if (code === 'backend-unavailable' || code === 'readiness-deadline') return 'gateway-readiness';
  if ([
    'http-status', 'response-too-large', 'malformed-json', 'malformed-protocol',
    'rpc-error', 'identity-mismatch', 'tools-mismatch',
  ].includes(code)) return 'gateway-protocol';
  if (code === 'transport-other') return 'other';
  return undefined;
}

function trackAwfChild(child) {
  child.on('error', () => failedSpawns.add(child));
  return child;
}

function startupDiagnostic(child, reason, stage, stderrFile, startupErrorFile) {
  let category = 'unknown';
  let logInspection = 'unavailable';
  let enclaveStartup;
  if (reason !== 'spawn-failure' && startupErrorFile) {
    try {
      const record = JSON.parse(readDiagnosticFile(startupErrorFile, 16 * 1024, true).toString('utf8'));
      if ((record?.phase === 'startup'
          || (record?.phase === 'enclave-startup-progress'
            && record.message === 'Enclave startup in progress'))
          && typeof record.message === 'string'
          && typeof record.timestamp === 'string'
          && [
            '["message","phase","timestamp"]',
            '["enclaveStartup","message","phase","timestamp"]',
          ].includes(JSON.stringify(Object.keys(record).sort()))) {
        category = STARTUP_CATEGORIES.get(record.message) || 'unknown';
        logInspection = 'structured';
        enclaveStartup = safeEnclaveStartup(record.enclaveStartup);
        if (enclaveStartup) {
          category = gatewayCategory(enclaveStartup.code)
            || (enclaveStartup.hostPreflight?.checks.some((check) => check.result === 'failed')
              ? 'host-preflight' : category);
        }
      }
    } catch {
      // Older releases or interrupted startup may not have persisted this record.
    }
  }
  if (reason !== 'spawn-failure' && logInspection !== 'structured') {
    try {
      const stderr = readDiagnosticFile(stderrFile, 64 * 1024, true).toString('utf8');
      logInspection = 'bounded';
      const header = stderr.split('\n').find((line) => line.startsWith('[ERROR] Fatal error: '));
      const prefix = '[ERROR] Fatal error: Error: ';
      if (header?.startsWith(prefix)) {
        category = STARTUP_CATEGORIES.get(header.slice(prefix.length)) || 'unknown';
      } else if (header?.startsWith('[ERROR] Fatal error: CloudHypervisorUnsupportedHostError: ')) {
        category = 'unsupported-host';
      }
    } catch {
      // Inspection failure is explicit metadata, not a reason to disclose private content.
      logInspection = 'unavailable';
    }
  }
  return {
    schemaVersion: enclaveStartup ? 2 : 1,
    phase: enclaveStartup ? 'host-startup' : 'pre-broker',
    stage: stage === 'recovery' ? 'recovery' : 'initial',
    reason: ['exit', 'signal', 'timeout', 'spawn-failure'].includes(reason) ? reason : 'unknown',
    category,
    exitCode: Number.isInteger(child?.exitCode) && child.exitCode >= 0 && child.exitCode <= 255
      ? child.exitCode : null,
    signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGBUS']
      .includes(child?.signalCode) ? child.signalCode : null,
    logInspection,
    ...(enclaveStartup ? { enclaveStartup } : {}),
  };
}

function emitStartupDiagnostic(child, reason, stage, stderrFile, startupErrorFile) {
  console.error(`AWF_HOST_STARTUP_DIAGNOSTIC ${JSON.stringify(
    startupDiagnostic(child, reason, stage, stderrFile, startupErrorFile),
  )}`);
}

async function waitForBroker(child, container, deadline, diagnostics) {
  const fail = (reason, message) => {
    if (diagnostics) emitStartupDiagnostic(
      child, reason, diagnostics.stage, diagnostics.stderrFile, diagnostics.startupErrorFile,
    );
    throw new Error(message);
  };
  while (Date.now() < deadline) {
    if (failedSpawns.has(child)) {
      fail('spawn-failure', 'Could not spawn AWF before public enclave broker readiness');
    }
    if (child.signalCode !== null) {
      fail('signal', 'AWF was signalled before the public enclave broker became ready');
    }
    if (child.exitCode !== null) {
      fail('exit', 'AWF exited before the public enclave broker became ready');
    }
    const result = spawnSync('docker', [
      'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      container,
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: Math.max(1, Math.min(10_000, deadline - Date.now())),
      killSignal: 'SIGKILL',
    });
    if (result.status === 0 && ['healthy', 'running'].includes(result.stdout.trim())) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail('timeout', 'Timed out waiting for the live enclave broker');
}

async function waitForHostGatewayReadiness(child, deadline, diagnostics) {
  const fail = (reason, message) => {
    emitStartupDiagnostic(
      child, reason, diagnostics.stage, diagnostics.stderrFile, diagnostics.startupErrorFile,
    );
    throw new Error(message);
  };
  while (Date.now() < deadline) {
    if (failedSpawns.has(child)) fail('spawn-failure', 'Could not spawn AWF before host gateway readiness');
    if (child.signalCode !== null) fail('signal', 'AWF was signalled before host gateway readiness');
    if (child.exitCode !== null) fail('exit', 'AWF exited before host gateway readiness');
    let progress;
    try {
      const record = JSON.parse(readDiagnosticFile(
        diagnostics.startupErrorFile, 16 * 1024, true,
      ).toString('utf8'));
      if (record.phase === 'enclave-startup-progress'
          && record.message === 'Enclave startup in progress') {
        progress = safeEnclaveStartup(record.enclaveStartup);
      }
    } catch {
      // Publication can be interrupted; only a complete validated record proves readiness.
    }
    if (progress?.readiness === 'ready'
        && (!progress.startupChecks || progress.startupChecks.ready)) {
      console.log(`AWF_HOST_GATEWAY_READINESS ${JSON.stringify(progress)}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  }
  fail('timeout', 'Timed out waiting for actual AWF host gateway readiness');
}

function assertNoVmResidue() {
  const namespaces = run('ip', ['netns', 'list']);
  if (/^awfvm-/m.test(namespaces)) throw new Error('Cloud Hypervisor namespace residue remains');
  const processes = spawnSync('pgrep', [
    '-f', '[c]loud-hypervisor --api-socket',
  ], { encoding: 'utf8' });
  if (processes.status === 0) throw new Error('Cloud Hypervisor process residue remains');
  if (processes.status !== 1) throw new Error('Could not inspect Cloud Hypervisor process state');
  const cgroupRoot = '/sys/fs/cgroup/awf-cloud-hypervisor';
  if (fs.existsSync(cgroupRoot)
      && fs.readdirSync(cgroupRoot, { withFileTypes: true }).some((entry) => entry.isDirectory())) {
    throw new Error('Cloud Hypervisor cgroup residue remains');
  }
}

async function waitForVmCleanup(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let residueError;
  while (Date.now() < deadline) {
    try {
      assertNoVmResidue();
      return;
    } catch (error) {
      if (!/residue remains/.test(error.message)) throw error;
      residueError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw residueError || new Error('Cloud Hypervisor VM cleanup did not complete');
}

function assertCanonicalToolError(response, requestId, label) {
  const result = parsePublicToolResult(response, requestId);
  if (result.status !== 'error') {
    throw new Error(`Live enclave ${label} did not return the canonical bounded error`);
  }
}

function assertExpectedToolResult(response, requestId, expected, label) {
  const result = parsePublicToolResult(response, requestId);
  if (result.status !== 'ok' || !isDeepStrictEqual(result.result, expected)) {
    throw new Error(`Live enclave ${label} guest assertion failed`);
  }
}

function buildAgentGuestProbe() {
  const expected = {
    uid: 65534,
    gid: 65534,
    onlyExpectedInterfaces: true,
    emptyEffectiveCapabilities: true,
    noNewPrivileges: true,
    processLimit: 47,
    fileSizeLimit: 268435456,
    openFileLimit: 1024,
    apiProxyReachable: true,
    wrongPortBlocked: true,
    wrongPeerBlocked: true,
    githubPeerBlocked: true,
    publicEgressBlocked: true,
  };
  const schema = buildConstantObjectSchema(expected);
  const python = [
    'import json, os, re, resource, socket',
    'status = open("/proc/self/status", encoding="ascii").read()',
    'effective = int(re.search(r"^CapEff:\\s+([0-9a-f]+)$", status, re.M).group(1), 16)',
    'no_new_privileges = re.search(r"^NoNewPrivs:\\s+1$", status, re.M) is not None',
    'interfaces = [name for _, name in socket.if_nameindex()]',
    'def reachable(ip, port):',
    '    try:',
    '        with socket.create_connection((ip, port), timeout=0.75):',
    '            return True',
    '    except OSError:',
    '        return False',
    'result = {',
    '    "uid": os.geteuid(), "gid": os.getegid(),',
    '    "onlyExpectedInterfaces": len(interfaces) == 2 and interfaces.count("lo") == 1,',
    '    "emptyEffectiveCapabilities": effective == 0, "noNewPrivileges": no_new_privileges,',
    '    "processLimit": resource.getrlimit(resource.RLIMIT_NPROC)[0],',
    '    "fileSizeLimit": resource.getrlimit(resource.RLIMIT_FSIZE)[0],',
    '    "openFileLimit": resource.getrlimit(resource.RLIMIT_NOFILE)[0],',
    '    "apiProxyReachable": reachable("172.31.0.30", 10002),',
    '    "wrongPortBlocked": not reachable("172.31.0.30", 10000),',
    '    "wrongPeerBlocked": not reachable("172.31.0.99", 10002),',
    '    "githubPeerBlocked": not reachable("172.31.0.40", 8080),',
    '    "publicEgressBlocked": not reachable("1.1.1.1", 443),',
    '}',
    'encoded = json.dumps(result, separators=(",", ":"))',
    'print(encoded)',
    'open("/awf/out", "w", encoding="utf8").write(encoded)',
  ].join('\n');
  return {
    expected,
    schema,
    prompt: [
      'Run this exact diagnostic with your shell tool using python3. Do not inspect repository files or make network requests other than those in the script.',
      '```bash',
      "python3 - <<'PY'",
      python,
      'PY',
      '```',
      'Return exactly the JSON object printed by the diagnostic, with no extra fields. Write that exact object to /awf/out as required by your result contract.',
    ].join('\n'),
  };
}

function buildScriptGuestProbe() {
  const expected = {
    uid: 65534,
    gid: 65534,
    seedReadOnly: true,
    noNetwork: true,
    onlyLoopback: true,
    privilegeDropDenied: true,
    noNewPrivileges: true,
    emptyEffectiveCapabilities: true,
    processLimit: 47,
    fileSizeLimit: 536870912,
    openFileLimit: 1024,
  };
  return { expected, schema: buildConstantObjectSchema(expected) };
}

function buildEnospcProbeScript(maxStorageMib = 1024) {
  if (maxStorageMib !== 512 && maxStorageMib !== 1024) {
    throw new Error('Live enclave storage probe requires a supported role ceiling');
  }
  const maximumFiles = maxStorageMib / 64;
  return [
    'import errno, json, os',
    'directory = "/output"',
    'chunk = b"x" * (8 * 1024 * 1024)',
    'created = []',
    'observed = False',
    'try:',
    `    for index in range(${maximumFiles}):`,
    '        name = os.path.join(directory, ".awf-live-enospc-" + str(index))',
    '        try:',
    '            fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)',
    '        except OSError as error:',
    '            if error.errno != errno.ENOSPC:',
    '                raise',
    '            observed = True',
    '            break',
    '        created.append(name)',
    '        try:',
    '            for _ in range(8):',
    '                remaining = memoryview(chunk)',
    '                while remaining:',
    '                    try:',
    '                        written = os.write(fd, remaining)',
    '                    except OSError as error:',
    '                        if error.errno != errno.ENOSPC:',
    '                            raise',
    '                        observed = True',
    '                        break',
    '                    if written < 1:',
    '                        raise OSError(errno.EIO, "zero-byte write during bounded storage probe")',
    '                    remaining = remaining[written:]',
    '                if observed:',
    '                    break',
    '        finally:',
    '            os.close(fd)',
    '        if observed:',
    '            break',
    '    result = {"enospcObserved": observed, "probeFilesRemoved": False}',
    'finally:',
    '    for name in created:',
    '        os.unlink(name)',
    'result["probeFilesRemoved"] = all(not os.path.exists(name) for name in created)',
    'encoded = json.dumps(result, separators=(",", ":"))',
    'print(encoded)',
    'with open("/output/out", "w", encoding="utf8") as output:',
    '    output.write(encoded)',
  ].join('\n');
}

function buildAgentEnospcProbe() {
  const expected = { enospcObserved: true, probeFilesRemoved: true };
  return {
    expected,
    schema: buildConstantObjectSchema(expected),
    prompt: [
      'Run this exact Python diagnostic in your shell. Do not inspect repository files or make network requests.',
      '```bash',
      "python3 - <<'PY'",
      buildEnospcProbeScript(512),
      'PY',
      '```',
      'Return exactly the JSON object printed by the diagnostic, with no extra fields. Write that exact object to /awf/out as required by your result contract.',
    ].join('\n'),
  };
}

function buildOomProbeScript() {
  return [
    'import json, os, subprocess, sys',
    'def oom_kills():',
    '    with open("/proc/vmstat", encoding="ascii") as status:',
    '        for line in status:',
    '            name, _, value = line.partition(" ")',
    '            if name == "oom_kill":',
    '                return int(value)',
    '    return -1',
    'before = oom_kills()',
    'child = subprocess.Popen([',
    '    sys.executable, "-c",',
    '    "blocks=[]\\nwhile True:\\n b=bytearray(32*1024*1024)\\n for i in range(0,len(b),4096): b[i]=1\\n blocks.append(b)",',
    '], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
    'signal = child.wait()',
    'after = oom_kills()',
    'result = {',
    '    "childKilledByOom": signal == -9 and before >= 0 and after > before,',
    '    "oomKillCounterIncreased": before >= 0 and after > before,',
    '}',
    'with open("/awf/out", "w", encoding="utf8") as output:',
    '    json.dump(result, output, separators=(",", ":"))',
  ].join('\n');
}

function resourceRecords(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink()
      && /^[0-9a-f]{32}-[0-9a-f]{32}\.resources\.json$/.test(entry.name))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return { file, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
    });
}

async function waitForInvocationRecord(directory, existing, ownerPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = resourceRecords(directory).find(({ file, record: value }) =>
      !existing.has(file)
      && value.state === 'pending'
      && value.owner?.pid === ownerPid
      && value.storage?.directory
      && value.directoryIdentity
      && value.snapshot);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Live enclave crash probe did not persist its pending resource identity');
}

function findProcessForSocket(apiSocketPath) {
  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let commandLine;
    try {
      commandLine = fs.readFileSync(path.join('/proc', entry.name, 'cmdline'));
    } catch {
      continue;
    }
    if (commandLine.includes(Buffer.from(apiSocketPath, 'utf8'))) return Number(entry.name);
  }
  return undefined;
}

async function waitForPath(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink()) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Live enclave guest did not reach its bounded crash-probe marker');
}

function assertNoSuccessfulResult(response) {
  if (response?.result?.structuredContent?.status === 'ok') {
    throw new Error('Interrupted live enclave invocation returned a successful result');
  }
}

function assertRecoveredInvocation(before, after, records) {
  const matches = records.filter(({ record }) =>
    record.runId === before.runId && record.invocationId === before.invocationId);
  const identityMetadata = (record) => ({
    directory: record.directory,
    directoryIdentity: record.directoryIdentity,
    ancestors: record.ancestors,
    mount: record.mount,
    snapshot: record.snapshot,
    storage: record.storage && {
      directory: record.storage.directory,
      parentIdentity: record.storage.parentIdentity,
      ancestors: record.storage.ancestors,
      directoryIdentity: record.storage.directoryIdentity,
      mountedIdentity: record.storage.mountedIdentity,
      mounts: record.storage.mounts,
    },
  });
  if (matches.length !== 1 || after.state !== 'cleaned'
      || after.runId !== before.runId
      || after.invocationId !== before.invocationId
      || !before.directoryIdentity
      || !before.storage?.directoryIdentity
      || !before.storage?.mountedIdentity
      || !before.snapshot
      || !isDeepStrictEqual(identityMetadata(after), identityMetadata(before))) {
    throw new Error('Live VMM crash recovery did not clean the exact interrupted invocation');
  }
}

function releaseTag() {
  return require('../../dist/cloud-hypervisor/artifact-manifest').CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG;
}

function prepareReleaseArtifacts(tag, directory, environment) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let published;
  try {
    published = run('gh', [
      'release', 'view', tag, '--repo', 'github/gh-aw-firewall', '--json', 'assets',
      '--jq', '.assets[].name',
    ], { env: environment });
  } catch (error) {
    throw new Error(
      `Package-matched AWF release ${tag} is unavailable; publish its signed Cloud Hypervisor and enclave artifact set before opting into live acceptance.`,
      { cause: error },
    );
  }
  const assets = published.trim().split(/\r?\n/).filter(Boolean);
  assertReleaseAssets(RELEASE_ASSETS, assets);
  run('gh', [
    'release', 'download', tag, '--repo', 'github/gh-aw-firewall', '--dir', directory,
    '--pattern', RELEASE_ASSETS[0],
    '--pattern', RELEASE_ASSETS[1],
    '--pattern', RELEASE_ASSETS[2],
  ], { env: environment });
  run('tar', [
    '--extract', '--gzip', '--file', path.join(directory, RELEASE_ASSETS[0]),
    '--directory', directory,
  ]);
  const enclaveCache = path.join(directory, 'enclave-cache');
  const setupEnvironment = { ...environment };
  delete setupEnvironment.GITHUB_ENV;
  const setup = run('bash', [
  path.join(__dirname, '../../guest/cloud-hypervisor/setup-enclave-artifacts.sh'),
  tag,
  enclaveCache,
  ], { env: setupEnvironment });
  const enclaveDirectory = path.join(enclaveCache, tag, 'x86_64');
  const enclaveArtifactEnvironment = {
  AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS: path.join(enclaveDirectory, 'enclave-script-rootfs.ext4'),
  AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS: path.join(enclaveDirectory, 'enclave-agent-rootfs.ext4'),
  AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST: path.join(enclaveDirectory, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json'),
  AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE: path.join(enclaveDirectory, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl'),
  };
  for (const [name, file] of Object.entries(enclaveArtifactEnvironment)) {
  if (!setup.includes(`${name}=${file}`)) {
    throw new Error('Release-attested enclave artifact setup did not resolve every required artifact');
  }
  }
  return {
    directory,
    enclaveArtifactEnvironment,
    enclaveDirectory,
    tag,
  };
}

function makeConfig(artifacts, workDir, workspace, handoff) {
  const enclaveRepository = { repo: 'github/gh-aw-firewall', sensitivity: 'public' };
  const main = artifacts.directory;
  return {
    network: {
      isolation: true,
      allowDomains: ['github.com', 'api.github.com', 'api.githubcopilot.com'],
      topologyAttach: [GATEWAY_CONTAINER],
    },
    cloudHypervisor: {
      previewEnabled: true,
      mountPolicy: 'workspace-only',
      artifactReleaseTag: artifacts.tag,
      cloudHypervisorBinary: path.join(main, 'cloud-hypervisor'),
      kernelPath: path.join(main, 'vmlinux.bin'),
      rootfsPath: path.join(main, 'rootfs.ext4'),
      supervisorPath: path.join(main, 'awf-supervisor'),
      artifactManifestPath: path.join(main, RELEASE_ASSETS[1]),
      artifactManifestBundlePath: path.join(main, RELEASE_ASSETS[2]),
      vcpuCount: 1,
      memoryMib: 768,
      apiTimeoutMs: require('../../dist/types/runtime-options').CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS,
    },
    enclaves: [
      {
        script: { maxScriptBytes: 16_384 },
        runtime: 'cloud-hypervisor',
        timeout: 120,
        maxInvocations: 8,
        repos: [enclaveRepository],
      },
      {
        agent: {
          model: 'gpt-4.1',
          engine: 'copilot',
          profile: 'openai',
          maxModelRequests: 1,
          maxModelTokens: 256,
          maxTaskBytes: 4096,
        },
        runtime: 'cloud-hypervisor',
        timeout: 180,
        maxInvocations: 3,
        repos: [enclaveRepository],
      },
    ],
    container: { containerRuntime: 'docker' },
    apiProxy: { enabled: true },
    logging: {
      auditDir: path.join(workDir, 'audit'),
      proxyLogsDir: path.join(workDir, 'proxy-logs'),
    },
    testWorkspace: workspace,
    testGateway: handoff,
  };
}

function toAwfConfig(config) {
  const { testWorkspace, testGateway, ...awfConfig } = config;
  void testWorkspace;
  void testGateway;
  return awfConfig;
}

function spawnAwf(awfArguments, environment, stdoutFile, stderrFile, stage) {
  let stdout;
  let stderr;
  try {
    stdout = fs.openSync(stdoutFile, 'w', 0o600);
    stderr = fs.openSync(stderrFile, 'w', 0o600);
    const child = spawn(process.execPath, awfArguments, {
      env: { ...environment, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', stdout, stderr],
    });
    return trackAwfChild(child);
  } catch {
    emitStartupDiagnostic(undefined, 'spawn-failure', stage, stderrFile);
    throw new Error('Could not launch AWF before public enclave broker readiness');
  } finally {
    if (stdout !== undefined) fs.closeSync(stdout);
    if (stderr !== undefined) fs.closeSync(stderr);
  }
}

// The key reaches the fixture only through a private env file, never argv or logs.
function startGatewayFixture({ gatewayEnv, gatewayKey, capability, identity, onStarted }) {
  fs.writeFileSync(gatewayEnv, [
    'MCP_GATEWAY_PORT=8080',
    `MCP_GATEWAY_API_KEY=${gatewayKey}`,
    `AWF_ENCLAVE_MCP_CAPABILITY=${capability}`,
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });

  run('docker', [
    'run', '--detach', '--name', GATEWAY_CONTAINER,
    '--label', `com.github.gh-aw.mcpg.run=${identity}`,
    '--publish', '127.0.0.1::8080',
    '--env-file', gatewayEnv,
    GATEWAY_IMAGE,
  ]);
  onStarted?.();
  const gatewayInspect = JSON.parse(run('docker', [
    'inspect', '--format', '{{json .NetworkSettings.Ports}}', GATEWAY_CONTAINER,
  ]));
  const mapping = gatewayInspect['8080/tcp']?.[0];
  if (!mapping?.HostPort) throw new Error('Live enclave gateway did not bind its loopback route');
  return {
    capability,
    gatewayKey,
    endpoint: `http://127.0.0.1:${mapping.HostPort}/mcp/awf-enclave`,
    identity,
  };
}

function removeGatewayFixture(identity) {
  const gateway = spawnSync('docker', [
    'inspect', '--format', '{{ index .Config.Labels "com.github.gh-aw.mcpg.run" }}',
    GATEWAY_CONTAINER,
  ], { encoding: 'utf8' });
  if (gateway.status === 0 && gateway.stdout.trim() === identity) {
    const removed = spawnSync('docker', ['rm', '--force', GATEWAY_CONTAINER], { encoding: 'utf8' });
    if (removed.error || removed.status !== 0) {
      console.error('Could not remove the identity-checked live gateway fixture');
      return false;
    }
    return true;
  }
  console.error('Could not verify the live gateway fixture identity; it was not removed');
  return false;
}

async function main() {
  if (process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== 'true'
      || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
      || !/^ubuntu/.test(process.env.ImageOS || '')) {
    throw new Error('Live enclave acceptance requires an opted-in GitHub-hosted Ubuntu runner as root');
  }
  const checkout = require('./cloud-hypervisor-enclave-release-gate').verifyAcceptanceCheckout();
  if (!process.env.GH_TOKEN || !process.env.GITHUB_TOKEN) {
    throw new Error('Live enclave acceptance requires GH_TOKEN and GITHUB_TOKEN for public seed staging');
  }
  if (!process.env.COPILOT_GITHUB_TOKEN) {
    throw new Error('Live agent-enclave acceptance requires the COPILOT_GITHUB_TOKEN repository secret');
  }
  const environment = { ...process.env };
  const tag = releaseTag();
  const runnerTemp = environment.RUNNER_TEMP || os.tmpdir();
  const root = fs.mkdtempSync(path.join(runnerTemp, 'awf-enclave-live-'));
  fs.chmodSync(root, 0o700);
  const artifactsDir = path.join(root, 'release-artifacts');
  let workDir = path.join(root, 'awf-work');
  const workspace = path.join(root, 'workspace');
  const gatewayEnv = path.join(root, 'gateway.env');
  const awfOut = path.join(root, 'awf.stdout.log');
  const awfErr = path.join(root, 'awf.stderr.log');
  const gatewayKey = crypto.randomBytes(36).toString('base64url');
  const capability = crypto.randomBytes(32).toString('hex');
  const gatewayIdentity = `gh-aw-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}-enclave-live`;
  let awf;
  let gatewayStarted = false;
  let keepArtifacts = false;
  let preRestartLogContents;
  let awfConfigPath = path.join(root, 'awf-config.json');
  const runDirectories = [workDir];
  let awfEnvironment;
  const launchAwf = (stage) => {
    const awfArguments = [
      path.resolve(__dirname, '../../dist/cli.js'),
      '--config', awfConfigPath,
      '--build-local',
      '--enable-api-proxy',
      '--max-num-tool-calls', '16',
      '--work-dir', workDir,
      '--log-level', 'error',
      '--agent-timeout', '45',
      '--',
      'while [ ! -f /workspace/.awf-enclave-live-stop ]; do sleep 1; done',
    ];
    return spawnAwf(awfArguments, awfEnvironment, awfOut, awfErr, stage);
  };
  const stopComposeAfterCrash = (composeWorkDir = workDir) => run('docker', [
    'compose',
    '--project-directory', composeWorkDir,
    '--file', path.join(composeWorkDir, 'docker-compose.yml'),
    'down', '--volumes', '--remove-orphans', '--timeout', '5',
  ]);
  try {
    const artifacts = prepareReleaseArtifacts(tag, artifactsDir, environment);
    const { assertManifestSource } = require('./cloud-hypervisor-enclave-release-gate');
    for (const manifestPath of [
      path.join(artifacts.directory, RELEASE_ASSETS[1]),
      artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST,
    ]) {
      assertManifestSource(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), checkout.tag, checkout.commit);
    }
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true, mode: 0o755 });
    fs.chmodSync(workspace, 0o755);
    fs.mkdirSync(path.join(workDir, 'audit'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(workDir, 'proxy-logs'), { recursive: true, mode: 0o700 });
    const handoff = startGatewayFixture({
      gatewayEnv, gatewayKey, capability, identity: gatewayIdentity,
      onStarted: () => { gatewayStarted = true; },
    });
    const { endpoint } = handoff;
    const writeAwfConfig = (targetWorkDir, targetConfigPath) => {
      fs.mkdirSync(targetWorkDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(targetWorkDir, 'audit'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(targetWorkDir, 'proxy-logs'), { recursive: true, mode: 0o700 });
      const config = toAwfConfig(makeConfig(artifacts, targetWorkDir, workspace, handoff));
      fs.writeFileSync(targetConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
    };
    writeAwfConfig(workDir, awfConfigPath);
    awfEnvironment = {
      ...environment,
      ...artifacts.enclaveArtifactEnvironment,
      AWF_ENCLAVE_MCP_CAPABILITY: capability,
      AWF_ENCLAVE_MCP_GATEWAY_CONTAINER: GATEWAY_CONTAINER,
      AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: endpoint,
      AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: gatewayIdentity,
      AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS: '120000',
      MCP_GATEWAY_API_KEY: gatewayKey,
      GITHUB_WORKSPACE: workspace,
      GH_TOKEN: environment.GH_TOKEN,
      GITHUB_TOKEN: environment.GITHUB_TOKEN,
    };
    awf = launchAwf('initial');
    await waitForBroker(awf, 'awf-enclave-mcp-server', Date.now() + 15 * 60_000, {
      stage: 'initial', stderrFile: awfErr,
      startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
    });
    await waitForHostGatewayReadiness(awf, Date.now() + 150_000, {
      stage: 'initial', stderrFile: awfErr,
      startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
    });

    const initialized = await requestMcp(
      endpoint, gatewayKey, 1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'awf-live-enclave-conformance', version: '1.0.0' },
      },
    );
    if (initialized?.result?.serverInfo?.name !== 'awmg-awf-enclave') {
      throw new Error('Public enclave MCP initialize did not route through the live broker');
    }
    const tools = await requestMcp(endpoint, gatewayKey, 2, 'tools/list', {});
    const toolNames = tools?.result?.tools?.map((tool) => tool.name).sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(['enclave_run_agent', 'enclave_run_script'])) {
      throw new Error('Public enclave MCP tool list did not expose exactly the static executors');
    }

    const sentinel = `${SENTINEL_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
    const scriptProbe = buildScriptGuestProbe();
    const python = [
      'import errno, json, os, re, resource, socket, sys',
      `print(${JSON.stringify(sentinel)})`,
      `print(${JSON.stringify(sentinel)}, file=sys.stderr)`,
      'status = open("/proc/self/status", encoding="ascii").read()',
      'effective = int(re.search(r"^CapEff:\\s+([0-9a-f]+)$", status, re.M).group(1), 16)',
      'no_new_privileges = re.search(r"^NoNewPrivs:\\s+1$", status, re.M) is not None',
      'seed = "/awf/seed/README.md"',
      'os.stat(seed)',
      'try:',
      '    fd = os.open(seed, os.O_WRONLY | os.O_APPEND)',
      'except OSError as error:',
      '    seed_read_only = error.errno == errno.EROFS',
      'else:',
      '    os.close(fd)',
      '    seed_read_only = False',
      'try:',
      '    socket.create_connection(("1.1.1.1", 443), timeout=2)',
      'except OSError:',
      '    no_network = True',
      'else:',
      '    no_network = False',
      '    raise SystemExit(1)',
      'try:',
      '    os.setuid(0)',
      'except PermissionError:',
      '    privilege_drop_denied = True',
      'else:',
      '    privilege_drop_denied = False',
      '    raise SystemExit(1)',
      'result = {',
      '    "uid": os.geteuid(), "gid": os.getegid(), "seedReadOnly": seed_read_only,',
      '    "noNetwork": no_network, "onlyLoopback": [n for _, n in socket.if_nameindex()] == ["lo"],',
      '    "privilegeDropDenied": privilege_drop_denied, "noNewPrivileges": no_new_privileges,',
      '    "emptyEffectiveCapabilities": effective == 0,',
      '    "processLimit": resource.getrlimit(resource.RLIMIT_NPROC)[0],',
      '    "fileSizeLimit": resource.getrlimit(resource.RLIMIT_FSIZE)[0],',
      '    "openFileLimit": resource.getrlimit(resource.RLIMIT_NOFILE)[0],',
      '}',
      'open("out", "w", encoding="utf8").write(json.dumps(result, separators=(",", ":")))',
    ].join('\n');
    const scriptResponse = await requestMcp(endpoint, gatewayKey, 3, 'tools/call', {
      name: 'enclave_run_script',
      arguments: { privateRepo: 'github/gh-aw-firewall', schema: scriptProbe.schema, script: python },
    });
    const scriptResult = parsePublicToolResult(scriptResponse, 3);
    if (scriptResult.status !== 'ok' || !isDeepStrictEqual(scriptResult.result, scriptProbe.expected)) {
      throw new Error('Live script enclave guest identity, filesystem, network, or resource assertion failed');
    }
    await waitForVmCleanup(15_000);

    const agentResultValue = 'AWF_ENCLAVE_LIVE_AGENT_RESULT';
    const agentResponse = await requestMcp(endpoint, gatewayKey, 4, 'tools/call', {
      name: 'enclave_run_agent',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: { type: 'enum', values: [agentResultValue] },
        prompt: `Return exactly the string ${JSON.stringify(agentResultValue)}. Do not inspect or quote repository files.`,
      },
    });
    const agentResult = parsePublicToolResult(agentResponse, 4);
    if (agentResult.status !== 'ok' || agentResult.result !== agentResultValue) {
      throw new Error('Live agent enclave did not return the bounded canonical result');
    }
    await waitForVmCleanup(15_000);

    const agentProbe = buildAgentGuestProbe();
    const agentProbeResponse = await requestMcp(endpoint, gatewayKey, 5, 'tools/call', {
      name: 'enclave_run_agent',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: agentProbe.schema,
        prompt: agentProbe.prompt,
      },
    });
    assertExpectedToolResult(agentProbeResponse, 5, agentProbe.expected, 'agent identity and network');
    await waitForVmCleanup(15_000);

    const agentEnospcProbe = buildAgentEnospcProbe();
    const agentEnospcResponse = await requestMcp(endpoint, gatewayKey, 6, 'tools/call', {
      name: 'enclave_run_agent',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: agentEnospcProbe.schema,
        prompt: agentEnospcProbe.prompt,
      },
    });
    assertExpectedToolResult(agentEnospcResponse, 6, agentEnospcProbe.expected, 'agent aggregate ENOSPC');
    await waitForVmCleanup(15_000);

    const enospcExpected = { enospcObserved: true, probeFilesRemoved: true };
    const enospcResponse = await requestMcp(endpoint, gatewayKey, 7, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: buildConstantObjectSchema(enospcExpected),
        script: buildEnospcProbeScript(),
      },
    });
    assertExpectedToolResult(enospcResponse, 7, enospcExpected, 'script aggregate ENOSPC');
    await waitForVmCleanup(15_000);

    const oomExpected = { childKilledByOom: true, oomKillCounterIncreased: true };
    const oomResponse = await requestMcp(endpoint, gatewayKey, 8, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: buildConstantObjectSchema(oomExpected),
        script: buildOomProbeScript(),
      },
    });
    assertExpectedToolResult(oomResponse, 8, oomExpected, 'guest OOM');
    await waitForVmCleanup(15_000);

    const errorSchema = { type: 'const', value: true };
    const guestFailure = await requestMcp(endpoint, gatewayKey, 9, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: errorSchema,
        script: 'raise SystemExit(23)',
      },
    });
    assertCanonicalToolError(guestFailure, 9, 'guest failure');
    await waitForVmCleanup(15_000);

    const timeout = await requestMcp(endpoint, gatewayKey, 10, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: errorSchema,
        script: 'import time; time.sleep(150)',
      },
    });
    assertCanonicalToolError(timeout, 10, 'timeout');
    await waitForVmCleanup(15_000);

    const journalRoot = '/var/lib/awf-cloud-hypervisor/host-executor-journal';
    const existingCancellationResources = new Set(resourceRecords(journalRoot).map(({ file }) => file));
    const cancellationMarker = [
      'import time',
      'open("/output/cancel-probe-started", "w", encoding="ascii").write("started")',
      'while True: time.sleep(1)',
    ].join('\n');
    const cancellationController = new AbortController();
    const cancellationRequest = requestMcp(endpoint, gatewayKey, 11, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: errorSchema,
        script: cancellationMarker,
      },
    }, cancellationController.signal);
    const cancellationActive = await waitForInvocationRecord(
      journalRoot, existingCancellationResources, awf.pid, 90_000,
    );
    await waitForPath(path.join(cancellationActive.record.directory, 'output', 'cancel-probe-started'), 90_000);
    cancellationController.abort();
    const cancelled = await cancellationRequest;
    if (cancelled !== undefined) {
      throw new Error('Public MCP disconnect did not cancel the live enclave request');
    }
    await waitForVmCleanup(15_000);

    try {
      await require('./cloud-hypervisor-enclave-startup-faults').runStartupFaultProbes({
        directory: root,
        config: toAwfConfig(makeConfig(artifacts, workDir, workspace, handoff)).cloudHypervisor,
        environment: awfEnvironment,
      });
    } catch (error) {
      keepArtifacts = true;
      throw error;
    }
    await waitForVmCleanup(15_000);

    const existingResources = new Set(resourceRecords(journalRoot).map(({ file }) => file));
    const crashProbe = [
      'import time',
      'open("/output/crash-probe-started", "w", encoding="ascii").write("started")',
      'while True: time.sleep(1)',
    ].join('\n');
    const crashRequest = requestMcp(endpoint, gatewayKey, 12, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: errorSchema,
        script: crashProbe,
      },
    });
    const crashResponse = crashRequest.then(
      (response) => ({ response }),
      () => ({ disconnected: true }),
    );
    const active = await waitForInvocationRecord(journalRoot, existingResources, awf.pid, 90_000);
    const apiSocket = path.join(active.record.storage.directory, 'runs', 'vm', 'api.socket');
    await waitForPath(path.join(active.record.directory, 'output', 'crash-probe-started'), 90_000);
    const vmmPid = findProcessForSocket(apiSocket);
    if (!vmmPid) throw new Error('Live VM crash probe could not identify its exact VMM process');

    const interruptedWorkDir = workDir;
    try {
      process.kill(vmmPid, 'SIGKILL');
      awf.kill('SIGKILL');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('AWF host process did not die for recovery probe')), 15_000);
        awf.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      awf = undefined;
      preRestartLogContents = [
        fs.readFileSync(awfOut, 'utf8'),
        fs.readFileSync(awfErr, 'utf8'),
        ...captureContainerLogs(),
      ];
      run('docker', [
        'compose',
        '--project-directory', interruptedWorkDir,
        '--file', path.join(interruptedWorkDir, 'docker-compose.yml'),
        'down', '--volumes', '--remove-orphans', '--timeout', '5',
      ]);
      workDir = path.join(root, 'awf-work-recovery');
      awfConfigPath = path.join(root, 'awf-config-recovery.json');
      runDirectories.push(workDir);
      writeAwfConfig(workDir, awfConfigPath);
      awf = launchAwf('recovery');
      await waitForBroker(awf, 'awf-enclave-mcp-server', Date.now() + 15 * 60_000, {
        stage: 'recovery', stderrFile: awfErr,
        startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
      });
      await waitForHostGatewayReadiness(awf, Date.now() + 150_000, {
        stage: 'recovery', stderrFile: awfErr,
        startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
      });
      const recoveryTools = await requestMcp(endpoint, gatewayKey, 13, 'tools/list', {});
      if (!Array.isArray(recoveryTools?.result?.tools)) {
        throw new Error('Live broker did not become ready after host-executor recovery');
      }
      const afterCrash = JSON.parse(fs.readFileSync(active.file, 'utf8'));
      assertRecoveredInvocation(active.record, afterCrash, resourceRecords(journalRoot));
      assertNoSuccessfulResult((await crashResponse).response);
      await waitForVmCleanup(15_000);
    } catch (error) {
      if (awf && awf.exitCode === null) awf.kill('SIGKILL');
      try {
        stopComposeAfterCrash(interruptedWorkDir);
      } catch {
        keepArtifacts = true;
      }
      throw error;
    }

    const logContents = [
      ...preRestartLogContents,
      fs.readFileSync(awfOut, 'utf8'),
      fs.readFileSync(awfErr, 'utf8'),
      ...captureContainerLogs(),
    ];
    const privateRoots = runDirectories.map((directory) => path.join(
      '/var/tmp',
      `awf-enclave-private-0-${crypto.createHash('sha256')
        .update(path.resolve(directory), 'utf8').digest('hex').slice(0, 20)}`,
    ));
    assertNoSentinelLeak([
      ...runDirectories.flatMap((directory) => [
        path.join(directory, 'audit'),
        path.join(directory, 'proxy-logs'),
      ]),
      ...privateRoots.flatMap((directory) => [
        path.join(directory, 'audit'),
        path.join(directory, 'api-proxy-logs'),
      ]),
      journalRoot,
    ], [
      ...logContents,
    ], sentinel);
    console.log('Live script and agent identity/network, aggregate ENOSPC, guest OOM, failure/timeout/cancellation, real partial-startup failure, VMM crash recovery, cleanup, and output redaction checks passed.');
  } finally {
    try {
      if (awf && awf.exitCode === null && awf.signalCode === null && !failedSpawns.has(awf)) {
        try {
          fs.writeFileSync(path.join(workspace, '.awf-enclave-live-stop'), 'done\n', { mode: 0o644 });
          await stopAwf(awf);
        } catch {
          console.error('Could not stop AWF within live fixture cleanup');
          keepArtifacts = true;
          process.exitCode = 1;
        }
      }
      if (gatewayStarted && !removeGatewayFixture(gatewayIdentity)) {
        keepArtifacts = true;
        process.exitCode = 1;
      }
      try {
        assertNoVmResidue();
      } catch (error) {
        console.error(error.message);
        keepArtifacts = true;
        process.exitCode = 1;
      }
    } catch {
      console.error('Live enclave fixture cleanup failed; private recovery state was preserved');
      keepArtifacts = true;
      process.exitCode = 1;
    } finally {
      try {
        removePrivateAwfLogs(awfOut, awfErr, runDirectories.map(
          (directory) => path.join(directory, 'proxy-logs', 'awf-startup-error.json'),
        ));
        if (keepArtifacts) {
          console.error('Live enclave private recovery state was retained on the ephemeral runner; AWF stdout/stderr and startup error records were removed.');
        } else {
          fs.rmSync(root, { recursive: true, force: true });
        }
      } catch {
        console.error('Could not remove live enclave private diagnostic files');
        process.exitCode = 1;
      }
    }
  }
}

function removePrivateAwfLogs(stdoutFile, stderrFile, startupErrorFiles = []) {
  let failed = false;
  for (const file of [stdoutFile, stderrFile, ...startupErrorFiles]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('Could not remove live enclave private diagnostic files');
}

function stopAwf(child, graceMs = 60_000, terminateMs = 5000) {
  return new Promise((resolve, reject) => {
    const terminate = setTimeout(() => child.kill('SIGTERM'), graceMs);
    const kill = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('AWF did not exit within the live fixture cleanup deadline'));
    }, graceMs + terminateMs);
    const finish = (error) => {
      clearTimeout(terminate);
      clearTimeout(kill);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    child.once('exit', onExit);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Live enclave acceptance failed');
    process.exitCode = 1;
  });
}

module.exports = {
  GATEWAY_CONTAINER,
  GATEWAY_IMAGE,
  emitStartupDiagnostic,
  prepareReleaseArtifacts,
  releaseTag,
  removeGatewayFixture,
  spawnAwf,
  startGatewayFixture,
  waitForVmCleanup,
  startupDiagnostic,
  waitForBroker,
  waitForHostGatewayReadiness,
  failedSpawns,
  removePrivateAwfLogs,
  stopAwf,
  trackAwfChild,
  assertNoVmResidue,
  RELEASE_ASSETS,
  assertReleaseAssets,
  assertNoSentinelLeak,
  assertExpectedToolResult,
  assertRecoveredInvocation,
  assertNoSuccessfulResult,
  buildAgentGuestProbe,
  buildAgentEnospcProbe,
  buildConstantObjectSchema,
  buildEnospcProbeScript,
  buildOomProbeScript,
  buildScriptGuestProbe,
  parsePublicToolResult,
  requestMcp,
};
