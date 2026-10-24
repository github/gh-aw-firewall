'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');
const conformanceDiagnostics = require('./cloud-hypervisor-enclave-diagnostics');
const diagnosticCollector = require('./collect-enclave-smoke-debug.cjs');
const { HOST_EXECUTOR_ID_PATTERN } = require('../../dist/enclave/host-executor-protocol');
const { HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY } = require('../../dist/enclave/host-executor-journal');

const RELEASE_ASSETS = [
  'cloud-hypervisor-test-x86_64.tar.gz',
  'cloud-hypervisor-test-x86_64.manifest.json',
  'cloud-hypervisor-test-x86_64.manifest.sigstore.jsonl',
  'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json',
  'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
  'enclave-rootfs.ext4',
  'enclave-rootfs.sbom.spdx.json',
  'enclave-rootfs.provenance.sigstore.jsonl',
];
const GATEWAY_IMAGE = 'awf-cloud-hypervisor-enclave-live-gateway:test';
const GATEWAY_CONTAINER = 'awmg-mcpg';
const SENTINEL_PREFIX = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_';

function assertReleaseAssets(required, published) {
  const available = new Set(published);
  const missing = required.filter((asset) => !available.has(asset)
    && !(asset.endsWith('.ext4') && available.has(`${asset}.gz`)));
  if (missing.length) {
    throw new Error(
      `Package-matched AWF release is missing required release-attested Cloud Hypervisor assets: ${missing.join(', ')}. `
      + 'Publish a release for this package version with the attested Cloud Hypervisor and enclave artifact set; '
      + 'unattested build artifacts are not accepted.',
    );
  }
}

const mcpFailures = new WeakMap();
const mcpResponses = new WeakMap();

function mcpResponseMetadata(response, requestId, httpStatus) {
  const structured = response?.result?.structuredContent;
  return {
    httpStatus: httpStatus ?? (response && typeof response === 'object'
      ? mcpResponses.get(response) : undefined),
    ...(response === undefined ? {} : { response: {
      present: !!response,
      jsonrpcValid: response?.jsonrpc === '2.0',
      idMatches: response?.id === requestId,
      rpcError: !!response?.error,
      rpcErrorClass: !response?.error ? 'absent'
        : new Map([[-32700, 'parse-error'], [-32600, 'invalid-request'], [-32601, 'method-not-found'],
          [-32602, 'invalid-params'], [-32603, 'internal-error']]).get(response.error.code)
          || (Number.isInteger(response.error.code) && response.error.code >= -32099
            && response.error.code <= -32000 ? 'server-error' : 'other'),
      resultPresent: !!response?.result,
      toolIsError: response?.result?.isError === true,
      structuredPresent: !!structured,
      structuredStatus: structured === undefined ? 'absent'
        : ['ok', 'error'].includes(structured?.status) ? structured.status : 'invalid',
      contentMatches: Array.isArray(response?.result?.content)
        && response.result.content.length === 1
        && response.result.content[0]?.type === 'text'
        && response.result.content[0].text === JSON.stringify(structured),
    } }),
  };
}

function mcpFailure(reason, response, requestId, httpStatus) {
  const error = new Error('Public enclave MCP request failed');
  mcpFailures.set(error, { reason, ...mcpResponseMetadata(response, requestId, httpStatus) });
  return error;
}

async function acceptanceCheck(context, step, phase, action) {
  const record = (status, details = {}) => {
    const check = conformanceDiagnostics.projectAcceptanceCheck({ step, phase, status, ...details });
    if (!check) throw new Error('Invalid acceptance diagnostic step');
    if (context.check?.status !== 'failed') context.check = check;
    context.checks = [...(context.checks || []), check].slice(-16);
    console.log(`AWF_ENCLAVE_ACCEPTANCE_CHECK ${JSON.stringify(check)}`);
    if (context.observeAdmission && (status === 'failed' || (phase === 'request' && status === 'passed'))) {
      try {
        context.admissionEvidence = conformanceDiagnostics.projectAdmissionEvidence(context.observeAdmission());
      } catch {
        context.admissionEvidence = conformanceDiagnostics.projectAdmissionEvidence({
          broker: { status: 'read-failed' }, hostControl: { status: 'read-failed' },
        });
        console.error('Could not capture enclave admission evidence; raw error details were suppressed.');
        if (status !== 'failed') throw mcpFailure('admission-evidence-failed');
      }
      console.log(`AWF_ENCLAVE_ADMISSION_EVIDENCE ${JSON.stringify({
        step, phase, ...context.admissionEvidence,
      })}`);
    }
  };
  record('started');
  try {
    const result = await action();
    const requestId = { 'agent-enospc': 6, 'script-enospc': 7, 'guest-oom': 8,
      'guest-failure': 9, 'guest-timeout': 10, 'guest-cancellation': 11,
      'script-only': 16, 'agent-only': 19 }[step];
    let details = {};
    if (phase === 'request') details = mcpResponseMetadata(result, requestId);
    else if (phase === 'resource-refresh') details = { inventory: result?.inventory, baseline: result?.baseline };
    else if (['resource-discovery', 'resource-read'].includes(phase)) details = { inventory: result?.inventory };
    else if (step === 'crash-recovery' && phase === 'recovery-validation') details = { recovery: result };
    else if (step === 'crash-recovery' && phase === 'tools-list') details = mcpResponseMetadata(result, 13);
    else if (step === 'crash-recovery' && phase === 'interrupted-response') {
      details = { ...mcpResponseMetadata(result?.response, 12),
        interrupted: result?.disconnected ? 'disconnected' : 'returned' };
    } else if (['script-only', 'agent-only'].includes(step)) {
      if (phase === 'initialize') details = mcpResponseMetadata(result, requestId - 2);
      else if (phase === 'tools-list') details = mcpResponseMetadata(result, requestId - 1);
      else if (['initialize-validation', 'tools-validation'].includes(phase)) details = { profile: result };
    }
    record('passed', details);
    return result;
  } catch (error) {
    record('failed', {
      ...(['crash-recovery', 'script-only', 'agent-only'].includes(step)
        ? { code: typeof error?.code === 'string' ? error.code : 'unknown' } : {}),
      ...(mcpFailures.get(error) || { reason: 'operation-failed' }),
    });
    throw error;
  }
}

function parsePublicToolResult(response, requestId) {
  if (!response) throw mcpFailure('response-missing', response, requestId);
  if (response.jsonrpc !== '2.0') throw mcpFailure('jsonrpc-version', response, requestId);
  if (response.id !== requestId) throw mcpFailure('request-id', response, requestId);
  if (response.error) throw mcpFailure('jsonrpc-error', response, requestId);
  if (!response.result) throw mcpFailure('result-missing', response, requestId);
  if (response.result.isError === true) throw mcpFailure('tool-is-error', response, requestId);
  const structured = response.result.structuredContent;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)
      || !['ok', 'error'].includes(structured.status)) {
    throw mcpFailure('structured-content', response, requestId);
  }
  const keys = Object.keys(structured).sort();
  if (JSON.stringify(keys) !== JSON.stringify(
    structured.status === 'ok' ? ['result', 'status'] : ['status'],
  )) {
    throw mcpFailure('structured-fields', response, requestId);
  }
  const content = response.result.content;
  if (!Array.isArray(content) || content.length !== 1
      || content[0]?.type !== 'text'
      || content[0].text !== JSON.stringify(structured)) {
    throw mcpFailure('content-mismatch', response, requestId);
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

function captureContainerLogs(profile = 'combined') {
  return [
    GATEWAY_CONTAINER,
    'awf-enclave-mcp-server',
    'awf-api-proxy',
    ...(profile === 'script-only' ? [] : ['awf-enclave-agent-api-proxy']),
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
      const httpStatus = response.statusCode;
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 420 * 1024) {
          const error = mcpFailure('response-too-large', undefined, requestId, httpStatus);
          reject(error);
          request.destroy(error);
        } else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (value && typeof value === 'object') mcpResponses.set(value, httpStatus);
          resolve(value);
        } catch {
          reject(mcpFailure(httpStatus === 200 ? 'invalid-json' : 'http-status',
            undefined, requestId, httpStatus));
        }
      });
      response.on('aborted', () => reject(mcpFailure('response-aborted', undefined, requestId, httpStatus)));
      response.on('error', () => reject(mcpFailure('response-failed', undefined, requestId, httpStatus)));
    });
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      request.destroy();
      resolve(undefined);
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    request.on('error', (error) => {
      if (!cancelled) reject(mcpFailures.has(error) ? error : mcpFailure('request-failed'));
    });
    request.on('timeout', () => {
      const error = mcpFailure('request-timeout');
      reject(error);
      request.destroy(error);
    });
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
const { schema: hostPreflightSchema } = require('../../dist/cloud-hypervisor/host-preflight-schema');
const mountTopologySchema = require('../../src/cloud-hypervisor/mount-topology-schema.json');
const storagePropagationSchema = require('../../src/cloud-hypervisor/storage-propagation-schema.json');

function safeStoragePropagation(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !==
      '["destinationBeforeBind","invocationLocation","mounts","schemaVersion","sourceBeforeBind"]'
      || value.schemaVersion !== 1 || !storagePropagationSchema.location.includes(value.invocationLocation)
      || [value.sourceBeforeBind, value.destinationBeforeBind].some((item) =>
        item !== null && !storagePropagationSchema.propagation.includes(item))
      || !value.mounts || JSON.stringify(Object.keys(value.mounts).sort()) !==
        JSON.stringify([...storagePropagationSchema.mounts].sort())) return undefined;
  const mounts = {};
  for (const key of storagePropagationSchema.mounts) {
    const item = value.mounts[key];
    if (item !== null && (!Array.isArray(item) || item.length !== 4
        || JSON.stringify(Object.keys(item)) !== '["0","1","2","3"]'
        || item.some((field, index) => !storagePropagationSchema.observation[index].includes(field)))) return undefined;
    mounts[key] = item === null ? null : [...item];
  }
  return {
    schemaVersion: 1, invocationLocation: value.invocationLocation,
    sourceBeforeBind: value.sourceBeforeBind, destinationBeforeBind: value.destinationBeforeBind, mounts,
  };
}

function safeMountTopology(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== '["after","before","bindCalls","schemaVersion"]'
      || value.schemaVersion !== 1 || !['zero', 'one', 'multiple'].includes(value.bindCalls)) return undefined;
  const observation = (item) => {
    if (item === null) return null;
    if (!item || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(Object.keys(mountTopologySchema).sort())) {
      return undefined;
    }
    const safe = {};
    for (const [key, values] of Object.entries(mountTopologySchema)) {
      if (!values.includes(item[key])) return undefined;
      safe[key] = item[key];
    }
    return safe;
  };
  const before = observation(value.before);
  const after = observation(value.after);
  if (before === undefined || after === undefined) return undefined;
  return { schemaVersion: 1, bindCalls: value.bindCalls, before, after };
}

function safeHostPreflight(value) {
  const keys = ['checks', 'schemaVersion', 'scope'];
  if (value?.schemaVersion === 2) keys.push('phase', 'profile');
  if (value && Object.prototype.hasOwnProperty.call(value, 'mountTopology')) keys.push('mountTopology');
  if (value && Object.prototype.hasOwnProperty.call(value, 'storagePropagation')) keys.push('storagePropagation');
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
      || ![1, 2].includes(value.schemaVersion)
      || (value.schemaVersion === 2
        && (!['preflight', 'execution', 'cleanup', 'persistence'].includes(value.phase)
          || !['common', 'primary', 'script', 'agent'].includes(value.profile)))
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
  const mountTopology = value.mountTopology === undefined ? undefined : safeMountTopology(value.mountTopology);
  if (Object.prototype.hasOwnProperty.call(value, 'mountTopology') && !mountTopology) return undefined;
  const storagePropagation = value.storagePropagation === undefined ? undefined : safeStoragePropagation(value.storagePropagation);
  if (Object.prototype.hasOwnProperty.call(value, 'storagePropagation') && !storagePropagation) return undefined;
  return {
    schemaVersion: value.schemaVersion, scope: value.scope,
    ...(value.schemaVersion === 2 ? { phase: value.phase, profile: value.profile } : {}),
    checks, ...(mountTopology ? { mountTopology } : {}),
    ...(storagePropagation ? { storagePropagation } : {}),
  };
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

const ENCLAVE_STARTUP_STAGES = [
  'host-bootstrap', 'runtime-preflight', 'configuration', 'enclave-preflight',
  'host-preflight', 'artifact-preflight', 'seed-staging', 'storage-preflight',
  'recovery', 'host-service',
  'host-network', 'compose-config', 'containers', 'gateway-attach',
  'github-readiness', 'gateway-contract', 'initialize', 'initialized',
  'tools-list', 'delegation', 'primary-agent',
];

function safeEnclaveStartup(value) {
  const keys = ['attempts', 'code', 'httpStatus', 'perspective', 'readiness', 'schemaVersion', 'stage'];
  if (value && Object.prototype.hasOwnProperty.call(value, 'hostPreflight')) keys.push('hostPreflight');
  if (value && Object.prototype.hasOwnProperty.call(value, 'startupChecks')) keys.push('startupChecks');
  if (value && Object.prototype.hasOwnProperty.call(value, 'mountTopology')) keys.push('mountTopology');
  if (value && Object.prototype.hasOwnProperty.call(value, 'storagePropagation')) keys.push('storagePropagation');
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
      || value.schemaVersion !== 1 || value.perspective !== 'awf-host'
      || !ENCLAVE_STARTUP_STAGES.includes(value.stage)
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
  const mountTopology = value.mountTopology === undefined ? undefined : safeMountTopology(value.mountTopology);
  if (Object.prototype.hasOwnProperty.call(value, 'mountTopology') && !mountTopology) return undefined;
  const storagePropagation = value.storagePropagation === undefined ? undefined : safeStoragePropagation(value.storagePropagation);
  if (Object.prototype.hasOwnProperty.call(value, 'storagePropagation') && !storagePropagation) return undefined;
  return {
    schemaVersion: 1, perspective: 'awf-host', stage: value.stage,
    readiness: value.readiness, code: value.code, attempts: value.attempts,
    httpStatus: value.httpStatus,
    ...(hostPreflight ? { hostPreflight } : {}),
    ...(startupChecks ? { startupChecks } : {}),
    ...(mountTopology ? { mountTopology } : {}),
    ...(storagePropagation ? { storagePropagation } : {}),
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
  awfStartTimes.set(child, Date.now());
  child.on('error', () => {
    if (!child.pid) failedSpawns.add(child);
  });
  return child;
}

// Bounds are deliberately generous: later startup stages carry more checks and
// --build-local compose output reaches AWF stderr. Only fixed codes leave this module.
const STARTUP_RECORD_MAX_BYTES = 64 * 1024;
const STDERR_SCAN_MAX_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_BYTES = 1024 * 1024;
const STABLE_READ_ATTEMPTS = 5;
const STABLE_READ_DELAY_MS = 200;
const startupRecordCache = new Map();
const awfStartTimes = new WeakMap();

function sizeBucket(size) {
  if (!Number.isInteger(size) || size < 0) return null;
  if (size === 0) return 'empty';
  if (size <= 16 * 1024) return '<=16KiB';
  if (size <= 64 * 1024) return '<=64KiB';
  if (size <= 1024 * 1024) return '<=1MiB';
  if (size <= 8 * 1024 * 1024) return '<=8MiB';
  return '>8MiB';
}

function elapsedBucket(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  for (const [limit, label] of [
    [60_000, '<1m'], [3 * 60_000, '<3m'], [5 * 60_000, '<5m'], [8 * 60_000, '<8m'],
    [10 * 60_000, '<10m'], [15 * 60_000, '<15m'],
  ]) {
    if (ms < limit) return label;
  }
  return '>=15m';
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Returns a fixed outcome code plus bytes only from a regular, unlinked-safe file.
// Oversized files either fail ("oversize") or, when tailBytes is set, yield a
// stable tail ("tail"). Changing files are retried on the same inode before
// reporting "unstable"; a different inode reports "replaced".
function inspectDiagnosticFile(file, maxBytes, {
  tailBytes, attempts = STABLE_READ_ATTEMPTS, ownerOnly = false,
} = {}) {
  let result = { outcome: 'io-error', size: null, attempts: 0 };
  let identity;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) return { outcome: 'not-regular', size: null, attempts: attempt };
      if (ownerOnly && (stat.uid !== process.getuid() || stat.nlink !== 1
          || (stat.mode & 0o777) !== 0o600)) {
        return { outcome: 'unsafe-owner', size: null, attempts: attempt };
      }
      // Retries must observe the same inode; a replaced pathname is never trusted.
      if (identity && (identity.dev !== stat.dev || identity.ino !== stat.ino)) {
        return { outcome: 'replaced', size: null, attempts: attempt };
      }
      identity = { dev: stat.dev, ino: stat.ino };
      let offset = 0;
      let length = stat.size;
      let outcome = 'ok';
      if (stat.size > maxBytes) {
        if (!tailBytes) return { outcome: 'oversize', size: stat.size, attempts: attempt };
        offset = stat.size - tailBytes;
        length = tailBytes;
        outcome = 'tail';
      }
      const buffer = Buffer.alloc(length + 1);
      let size = 0;
      while (size < buffer.length) {
        const bytes = fs.readSync(descriptor, buffer, size, buffer.length - size, offset + size);
        if (bytes === 0) break;
        size += bytes;
      }
      const after = fs.fstatSync(descriptor);
      if (size !== length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
          || after.ctimeMs !== stat.ctimeMs) {
        result = { outcome: 'unstable', size: after.size, attempts: attempt };
      } else {
        return { outcome, size: stat.size, attempts: attempt, buffer: buffer.subarray(0, size) };
      }
    } catch (error) {
      if (error.code === 'ENOENT') return { outcome: 'missing', size: null, attempts: attempt };
      if (error.code === 'ELOOP') return { outcome: 'not-regular', size: null, attempts: attempt };
      return { outcome: 'io-error', size: null, attempts: attempt };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    if (attempt < attempts) sleepSync(STABLE_READ_DELAY_MS);
  }
  return result;
}

function parseStartupRecord(buffer) {
  let record;
  try {
    record = JSON.parse(buffer.toString('utf8'));
  } catch {
    return { outcome: 'parse' };
  }
  if ((record?.phase === 'startup'
      || (record?.phase === 'enclave-startup-progress'
        && record.message === 'Enclave startup in progress'))
      && typeof record.message === 'string'
      && typeof record.timestamp === 'string'
      && [
        '["message","phase","timestamp"]',
        '["enclaveStartup","message","phase","timestamp"]',
      ].includes(JSON.stringify(Object.keys(record).sort()))) {
    return { outcome: 'valid', record };
  }
  return { outcome: 'shape' };
}

// Caches the last validated record so AWF cleanup removing its work directory
// cannot erase the only failure evidence before the probe reads it.
function cacheStartupRecord(file) {
  if (!file) return undefined;
  const inspected = inspectDiagnosticFile(file, STARTUP_RECORD_MAX_BYTES, { attempts: 1 });
  if (inspected.outcome !== 'ok') return undefined;
  const parsed = parseStartupRecord(inspected.buffer);
  if (parsed.outcome !== 'valid') return undefined;
  const previous = startupRecordCache.get(file);
  startupRecordCache.set(file, {
    record: parsed.record, size: inspected.size, polls: (previous?.polls ?? 0) + 1,
  });
  return parsed.record;
}

const EXIT_MARKER = 'AWF_STARTUP_EXIT ';
const WRITE_OUTCOMES = ['written', 'oversize', 'unsafe-target', 'io-error', 'error', 'not-attempted'];

function safeExitMarker(line) {
  let value;
  try {
    value = JSON.parse(line.slice(EXIT_MARKER.length));
  } catch {
    return undefined;
  }
  const keys = '["agentStarted","cleanup","containersStarted","elapsed","exitCode","failedCheck",'
    + '"lastProgressWrite","path","progressWriteFailures","recordAfterCleanup","recordWrite",'
    + '"schemaVersion","stage"]';
  if (!value || typeof value !== 'object' || JSON.stringify(Object.keys(value).sort()) !== keys
      || value.schemaVersion !== 1
      || !['fatal', 'workflow-return'].includes(value.path)
      || !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255
      || !(value.stage === null || ENCLAVE_STARTUP_STAGES.includes(value.stage))
      || !(value.failedCheck === null || (typeof value.failedCheck === 'string'
        && /^[a-z0-9-]+\/[a-z0-9-]+$/.test(value.failedCheck)
        && Object.prototype.hasOwnProperty.call(hostPreflightSchema.scopes, value.failedCheck.split('/')[0])
        && Object.prototype.hasOwnProperty.call(
          hostPreflightSchema.scopes[value.failedCheck.split('/')[0]],
          value.failedCheck.split('/')[1],
        )))
      || typeof value.containersStarted !== 'boolean' || typeof value.agentStarted !== 'boolean'
      || !WRITE_OUTCOMES.includes(value.recordWrite)
      || !WRITE_OUTCOMES.includes(value.lastProgressWrite)
      || !Number.isInteger(value.progressWriteFailures) || value.progressWriteFailures < 0
      || value.progressWriteFailures > 1_000_000
      || !['pending', 'completed', 'failed'].includes(value.cleanup)
      || !['present', 'missing', 'unknown'].includes(value.recordAfterCleanup)
      || !(value.elapsed === null || [
        '<1m', '<3m', '<5m', '<8m', '<10m', '<15m', '>=15m',
      ].includes(value.elapsed))) return undefined;
  return {
    schemaVersion: 1, path: value.path, exitCode: value.exitCode, stage: value.stage,
    failedCheck: value.failedCheck, containersStarted: value.containersStarted,
    agentStarted: value.agentStarted, recordWrite: value.recordWrite,
    lastProgressWrite: value.lastProgressWrite,
    progressWriteFailures: value.progressWriteFailures, cleanup: value.cleanup,
    recordAfterCleanup: value.recordAfterCleanup, elapsed: value.elapsed,
  };
}

function collectStartupEvidence(child, reason, stage, stderrFile, startupErrorFile) {
  let category = 'unknown';
  let logInspection = 'unavailable';
  let enclaveStartup;
  let cachedRecordApplied = false;
  const evidence = {
    schemaVersion: 1,
    record: { final: 'not-attempted', size: null, source: 'none', cachedPolls: 0, cachedSize: null },
    stderr: { inspection: 'not-attempted', size: null, attempts: 0 },
    awfExit: null,
    awfExitMarkers: 0,
    elapsed: child && awfStartTimes.has(child) ? elapsedBucket(Date.now() - awfStartTimes.get(child)) : null,
  };
  const applyRecord = (record) => {
    category = STARTUP_CATEGORIES.get(record.message) || 'unknown';
    logInspection = 'structured';
    enclaveStartup = safeEnclaveStartup(record.enclaveStartup);
    if (enclaveStartup) {
      category = gatewayCategory(enclaveStartup.code)
        || (enclaveStartup.hostPreflight?.checks.some((check) => check.result === 'failed')
          || Object.values(enclaveStartup.startupChecks?.checks ?? {}).some(([result]) => result === 'failed')
          ? 'host-preflight' : category);
    }
  };
  if (reason !== 'spawn-failure' && startupErrorFile) {
    const inspected = inspectDiagnosticFile(startupErrorFile, STARTUP_RECORD_MAX_BYTES);
    evidence.record.size = sizeBucket(inspected.size);
    evidence.record.final = inspected.outcome;
    if (inspected.outcome === 'ok') {
      const parsed = parseStartupRecord(inspected.buffer);
      evidence.record.final = parsed.outcome;
      if (parsed.outcome === 'valid') {
        applyRecord(parsed.record);
        evidence.record.source = 'final';
      }
    }
    const cached = startupRecordCache.get(startupErrorFile);
    if (cached) {
      evidence.record.cachedPolls = Math.min(cached.polls, 1_000_000);
      evidence.record.cachedSize = sizeBucket(cached.size);
      if (evidence.record.source === 'none') {
        applyRecord(cached.record);
        evidence.record.source = 'cached';
        cachedRecordApplied = true;
      }
    }
  }
  if (reason !== 'spawn-failure') {
    const inspected = inspectDiagnosticFile(stderrFile, STDERR_SCAN_MAX_BYTES, { tailBytes: STDERR_TAIL_BYTES });
    evidence.stderr = {
      inspection: inspected.outcome, size: sizeBucket(inspected.size), attempts: inspected.attempts,
    };
    if (inspected.buffer) {
      const lines = inspected.buffer.toString('utf8').split('\n');
      const markers = lines.filter((line) => line.startsWith(EXIT_MARKER));
      evidence.awfExitMarkers = Math.min(markers.length, 1000);
      for (const line of markers.reverse()) {
        const marker = safeExitMarker(line);
        if (marker) {
          evidence.awfExit = marker;
          break;
        }
      }
      if (logInspection !== 'structured') logInspection = 'bounded';
      if (category === 'unknown' && (logInspection !== 'structured' || cachedRecordApplied)) {
        const header = lines.find((line) => line.startsWith('[ERROR] Fatal error: '));
        const prefix = '[ERROR] Fatal error: Error: ';
        if (header?.startsWith(prefix)) {
          category = STARTUP_CATEGORIES.get(header.slice(prefix.length)) || 'unknown';
        } else if (header?.startsWith('[ERROR] Fatal error: CloudHypervisorUnsupportedHostError: ')) {
          category = 'unsupported-host';
        }
      }
    }
  }
  const diagnostic = {
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
  return { diagnostic, evidence };
}

function startupDiagnostic(child, reason, stage, stderrFile, startupErrorFile) {
  return collectStartupEvidence(child, reason, stage, stderrFile, startupErrorFile).diagnostic;
}

function startupEvidence(child, reason, stage, stderrFile, startupErrorFile) {
  return collectStartupEvidence(child, reason, stage, stderrFile, startupErrorFile).evidence;
}

function startupSnapshot(child, reason, stage, profile, stderrFile, startupErrorFile) {
  if (!['initial', 'recovery', 'script-only', 'agent-only'].includes(stage)
      || !['combined', 'script-only', 'agent-only'].includes(profile)) {
    throw new Error('Invalid public enclave startup snapshot identity');
  }
  return {
    stage, profile,
    ...collectStartupEvidence(child, reason, stage, stderrFile, startupErrorFile),
  };
}

function emitStartupDiagnostic(child, reason, stage, stderrFile, startupErrorFile) {
  const { diagnostic, evidence } = collectStartupEvidence(child, reason, stage, stderrFile, startupErrorFile);
  console.error(`AWF_HOST_STARTUP_DIAGNOSTIC ${JSON.stringify(diagnostic)}`);
  console.error(`AWF_HOST_STARTUP_EVIDENCE ${JSON.stringify(evidence)}`);
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
    cacheStartupRecord(diagnostics?.startupErrorFile);
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
    // Publication can be interrupted; only a complete validated record proves readiness.
    const record = cacheStartupRecord(diagnostics.startupErrorFile);
    if (record?.phase === 'enclave-startup-progress'
        && record.message === 'Enclave startup in progress') {
      progress = safeEnclaveStartup(record.enclaveStartup);
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

function captureVmResidue(deadline = Date.now() + 10_000) {
  const options = () => ({
    encoding: 'utf8', maxBuffer: 1024 * 1024,
    timeout: Math.max(1, Math.min(5000, deadline - Date.now())), killSignal: 'SIGKILL',
  });
  const namespaces = run('ip', ['netns', 'list'], options());
  const namespaceNames = namespaces.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter((name) => name?.startsWith('awfvm-'))
    .sort();
  const processes = spawnSync('pgrep', [
    '-f', '[c]loud-hypervisor --api-socket',
  ], options());
  if (processes.error || ![0, 1].includes(processes.status)) {
    throw new Error('Could not inspect Cloud Hypervisor process state');
  }
  const processIdentities = (processes.stdout || '').trim().split(/\r?\n/)
    .filter(Boolean)
    .map((pid) => {
      if (!/^\d+$/.test(pid)) throw new Error('Could not inspect Cloud Hypervisor process state');
      let stat;
      try {
        stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      } catch {
        throw new Error('Cloud Hypervisor VM residue remains');
      }
      const commandEnd = stat.lastIndexOf(')');
      const startTime = stat.slice(commandEnd + 2).split(/\s+/)[19];
      if (commandEnd < 0 || !/^\d+$/.test(startTime || '')) {
        throw new Error('Could not inspect Cloud Hypervisor process state');
      }
      return { pid, startTime };
    })
    .sort((left, right) => Number(left.pid) - Number(right.pid));
  const cgroupRoot = '/sys/fs/cgroup/awf-cloud-hypervisor';
  const cgroups = fs.existsSync(cgroupRoot)
    ? fs.readdirSync(cgroupRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const stat = fs.statSync(path.join(cgroupRoot, entry.name));
        return { name: entry.name, device: stat.dev, inode: stat.ino };
      })
      .sort((left, right) => left.name.localeCompare(right.name))
    : [];
  return { namespaces: namespaceNames, processes: processIdentities, cgroups };
}

function assertNoVmResidue(expectedPrimary, observed = captureVmResidue()) {
  const empty = { namespaces: [], processes: [], cgroups: [] };
  if (expectedPrimary === undefined) {
    if (!isDeepStrictEqual(observed, empty)) {
      throw new Error('Cloud Hypervisor VM residue remains');
    }
    return;
  }
  if (!Array.isArray(expectedPrimary.namespaces)
      || !Array.isArray(expectedPrimary.processes)
      || !Array.isArray(expectedPrimary.cgroups)
      || expectedPrimary.namespaces.length !== 1
      || expectedPrimary.processes.length !== 1
      || expectedPrimary.cgroups.length !== 1) {
    throw new Error('Could not verify the live Cloud Hypervisor primary VM');
  }
  if (!isDeepStrictEqual(observed, expectedPrimary)) {
    throw new Error('Cloud Hypervisor enclave resource residue remains');
  }
}

function readPrimaryVmProgress(file, child) {
  const { PRIMARY_BOOT_STAGES } = require('../../dist/cloud-hypervisor/primary-readiness');
  const { CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS } = require('../../dist/cloud-hypervisor/preflight');
  const inspected = inspectDiagnosticFile(file, 4096, { attempts: 1, ownerOnly: true });
  if (['missing', 'unstable'].includes(inspected.outcome)) return undefined;
  if (inspected.outcome !== 'ok') throw new Error('Primary VM progress inspection failed');
  let value;
  try {
    value = JSON.parse(inspected.buffer.toString('utf8'));
  } catch {
    return undefined; // A truncated publication is never readiness.
  }
  if (JSON.stringify(Object.keys(value || {}).sort())
        !== '["bootAttempt","ownerPid","runId","schemaVersion","stage","state"]'
      || value.schemaVersion !== 1 || value.ownerPid !== child.pid
      || !PRIMARY_BOOT_STAGES.includes(value.stage)
      || !['starting', 'ready', 'failed'].includes(value.state)
      || !Number.isInteger(value.bootAttempt) || value.bootAttempt < 0
      || value.bootAttempt > CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS
      || !(value.runId === null || (typeof value.runId === 'string'
        && /^[A-Za-z0-9_.-]{1,128}$/.test(value.runId)))
      || (value.state === 'ready'
        && (value.stage !== 'ready' || !value.runId || value.bootAttempt === 0))) return undefined;
  return value;
}

async function verifyPrimaryVmIdentity(progress, child, observed) {
  const { validateRecord } = require('../../dist/cloud-hypervisor/cleanup-identity');
  const { processMatches } = require('../../dist/cloud-hypervisor/cleanup-process');
  const registry = '/run/awf-cloud-hypervisor/pending-cleanup';
  const file = path.join(registry, `${progress.runId}.json`);
  const inspected = inspectDiagnosticFile(file, 1024 * 1024, { attempts: 1, ownerOnly: true });
  if (['missing', 'unstable'].includes(inspected.outcome)) return 'pending';
  if (inspected.outcome !== 'ok') throw new Error('Primary VM journal inspection failed');
  let record;
  try {
    record = JSON.parse(inspected.buffer.toString('utf8'));
  } catch {
    return 'pending';
  }
  try {
    validateRecord(record, file, registry);
  } catch {
    return 'mismatch';
  }
  const vmm = record.processes.vmm;
  if (record.runId !== progress.runId || record.owner.pid !== child.pid
      || record.workload?.kind !== 'primary-agent'
      || record.workload.ownerId !== 'primary-agent' || record.network?.mode !== 'primary'
      || vmm?.state !== 'live' || !vmm.identity || !record.identities.cgroup
      || !record.identities.netns) return 'mismatch';
  const expected = {
    namespaces: [record.network.namespaceName],
    processes: [{ pid: String(vmm.identity.pid), startTime: vmm.identity.startTime }],
    cgroups: [{
      name: progress.runId,
      device: Number(record.identities.cgroup.device),
      inode: Number(record.identities.cgroup.inode),
    }],
  };
  if (!isDeepStrictEqual(observed, expected)) return 'mismatch';
  // Reuse the cleanup verifier: PID/start time alone cannot establish ownership.
  const dependencies = fs.promises;
  if (!await processMatches(dependencies, record.owner)
      || !await processMatches(dependencies, vmm.identity, vmm)) return 'mismatch';
  const namespace = fs.statSync(record.network.netnsPath);
  const membership = fs.readFileSync(`/proc/${vmm.identity.pid}/cgroup`, 'utf8');
  if (String(namespace.dev) !== record.identities.netns.device
      || String(namespace.ino) !== record.identities.netns.inode
      || vmm.identity.networkNamespace !== `net:[${namespace.ino}]`
      || !membership.split('\n').includes(`0::/awf-cloud-hypervisor/${progress.runId}`)) {
    return 'mismatch';
  }
  return 'verified';
}

// Shared by the public script probe and every combined/recovery/profile launch.
// A gateway handshake and even exactly one VMM do not prove guest readiness.
async function waitForPrimaryVmReadiness(child, deadline, diagnostics, dependencies = {}) {
  const {
    PRIMARY_READINESS_FILENAME,
    PRIMARY_READINESS_DIRECTORY,
  } = require('../../dist/cloud-hypervisor/primary-readiness');
  const readProgress = dependencies.readProgress || readPrimaryVmProgress;
  const capture = dependencies.capture || captureVmResidue;
  const verify = dependencies.verify || verifyPrimaryVmIdentity;
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const file = path.join(path.dirname(diagnostics.startupErrorFile),
    PRIMARY_READINESS_DIRECTORY, PRIMARY_READINESS_FILENAME);
  let progress;
  let observed;
  let inspection = 'not-attempted';
  let identity = 'not-attempted';
  const fail = (reason) => {
    try {
      progress = readProgress(file, child) || progress;
    } catch {
      // Child status remains authoritative if its final progress is unavailable.
    }
    if (inspection === 'not-attempted') {
      try {
        observed = capture(now() + 10_000);
        inspection = 'complete';
      } catch {
        inspection = 'failed';
      }
    }
    const count = (key) => observed ? Math.min(1000, observed[key].length) : null;
    console.error(`AWF_PRIMARY_VM_READINESS ${JSON.stringify({
      schemaVersion: 1, stage: 'primary-vm-readiness', reason,
      primary: progress ? {
        stage: progress.stage, state: progress.state, bootAttempt: progress.bootAttempt,
      } : { stage: 'unknown', state: 'not-observed', bootAttempt: null },
      resources: {
        inspection, namespaces: count('namespaces'), processes: count('processes'),
        cgroups: count('cgroups'), identity,
      },
      child: {
        status: failedSpawns.has(child) ? 'spawn-failed'
          : child.signalCode !== null ? 'signalled'
            : child.exitCode !== null ? 'exited' : 'running',
        exitCode: Number.isInteger(child.exitCode) && child.exitCode >= 0 && child.exitCode <= 255
          ? child.exitCode : null,
        signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGBUS']
          .includes(child.signalCode) ? child.signalCode : null,
      },
    })}`);
    throw new Error(`Primary VM readiness failed: ${reason}`);
  };
  const checkChild = () => {
    if (failedSpawns.has(child)) fail('spawn-failure');
    if (child.signalCode !== null) fail('signal');
    if (child.exitCode !== null) fail('exit');
  };
  while (now() < deadline) {
    checkChild();
    let current;
    try {
      current = readProgress(file, child);
      progress = current || progress;
    } catch {
      fail('inspection-failure');
    }
    if (progress?.state === 'failed') fail('startup-failure');
    // Never use a cached ready record if its current publication is incomplete.
    if (current?.state === 'ready') {
      try {
        observed = capture(deadline);
        inspection = 'complete';
      } catch {
        observed = undefined;
        inspection = 'failed';
        fail('inspection-failure');
      }
      if (Object.values(observed).some((items) => items.length > 1)) {
        identity = 'mismatch';
        fail('unexpected-resources');
      }
      if (Object.values(observed).every((items) => items.length === 1)) {
        try {
          identity = await verify(current, child, observed);
        } catch {
          identity = 'inspection-failed';
          checkChild();
          fail('inspection-failure');
        }
        checkChild();
        if (identity === 'mismatch') fail('unexpected-resources');
        if (identity === 'verified' && now() < deadline) return observed;
      }
    }
    await sleep(Math.max(0, Math.min(250, deadline - now())));
  }
  checkChild();
  fail('timeout');
}

async function waitForVmCleanup(timeoutMs, expectedPrimary) {
  const deadline = Date.now() + timeoutMs;
  let residueError;
  while (Date.now() < deadline) {
    try {
      assertNoVmResidue(expectedPrimary);
      return;
    } catch (error) {
      if (!/residue remains/.test(error.message)) throw error;
      residueError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw residueError || new Error('Cloud Hypervisor VM cleanup did not complete');
}

function assertCanonicalToolError(response, requestId) {
  const result = parsePublicToolResult(response, requestId);
  if (result.status !== 'error') {
    throw mcpFailure('expected-error-status', response, requestId);
  }
}

function assertExpectedToolResult(response, requestId, expected, label) {
  const result = parsePublicToolResult(response, requestId);
  if (result.status !== 'ok' || !isDeepStrictEqual(result.result, expected)) {
    const error = mcpFailure(result.status !== 'ok' ? 'expected-ok-status' : 'result-mismatch',
      response, requestId);
    error.message = `Live enclave ${label} guest assertion failed`;
    throw error;
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
    'import errno, json, os, stat, sys',
    'def record(stage, **flags):',
    '    fd = None',
    '    try:',
    '        fd = os.open("/tmp/.awf-enclave-storage-probe.jsonl", os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)',
    '        if not stat.S_ISREG(os.fstat(fd).st_mode):',
    '            raise OSError(errno.EINVAL, "invalid diagnostic file")',
    '        data = (json.dumps({"stage": stage, **flags}, separators=(",", ":")) + "\\n").encode("ascii")',
    '        if os.write(fd, data) != len(data):',
    '            raise OSError(errno.EIO, "short diagnostic write")',
    '    except OSError:',
    '        print("AWF_ENCLAVE_PROBE_DIAGNOSTIC write-failed", file=sys.stderr)',
    '    finally:',
    '        if fd is not None:',
    '            try:',
    '                os.close(fd)',
    '            except OSError:',
    '                print("AWF_ENCLAVE_PROBE_DIAGNOSTIC close-failed", file=sys.stderr)',
    'record("started")',
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
    '    record("storage-complete", enospcObserved=observed)',
    '    result = {"enospcObserved": observed, "probeFilesRemoved": False}',
    'finally:',
    '    record("cleanup-started")',
    '    for name in created:',
    '        os.unlink(name)',
    'result["probeFilesRemoved"] = all(not os.path.exists(name) for name in created)',
    'record("cleanup-complete", probeFilesRemoved=result["probeFilesRemoved"])',
    'encoded = json.dumps(result, separators=(",", ":"))',
    'print(encoded)',
    'record("output-write-started")',
    'with open("/output/out", "w", encoding="utf8") as output:',
    '    output.write(encoded)',
    'record("output-write-complete")',
    'def check(operation, action):',
    '    try: return action()',
    '    except OSError as error:',
    '        record("output-check-failed", operation=operation, errno=error.errno)',
    'def readback(name, label):',
    '    handle = check(label+"-open", lambda: open(name, "rb", opener=lambda n,f: os.open(n,f|os.O_NONBLOCK)))',
    '    if handle is None: return None',
    '    try: return check(label+"-read", lambda: handle.read(1025))',
    '    finally: check(label+"-close", handle.close)',
    'link = check("link-lstat", lambda: os.lstat("/awf/out"))',
    'is_link = link is not None and stat.S_ISLNK(link.st_mode)',
    'target = check("link-readlink", lambda: os.readlink("/awf/out")) if is_link else None',
    'direct = readback("/output/out", "direct")',
    'alias = readback("/awf/out", "alias")',
    'a = check("direct-stat", lambda: os.stat("/output/out"))',
    'b = check("alias-stat", lambda: os.stat("/awf/out"))',
    'record("output-verified", symlink=is_link, targetMatches=target=="/output/out",',
    '       sameFile=a is not None and b is not None and (a.st_dev,a.st_ino)==(b.st_dev,b.st_ino),',
    '       directReadable=direct is not None, aliasReadable=alias is not None,',
    '       directMatchesExpected=direct==encoded.encode(), aliasMatchesExpected=alias==encoded.encode())',
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
      'Return the diagnostic\'s exact JSON object, without extra fields, in /awf/out.',
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

function countBucket(count) {
  return count === 0 ? 'zero' : count === 1 ? 'one' : 'many';
}

function resourceRecords(directory, inventory = {}) {
  inventory.operation = 'directory-lstat';
  inventory.location = directory === HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY ? 'default' : 'custom';
  try {
    const stat = fs.lstatSync(directory);
    inventory.directory = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'ready' : 'not-directory';
    inventory.operation = 'directory-trust';
    diagnosticCollector.directory(directory, process.getuid());
    inventory.operation = 'directory-readdir';
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    inventory.entries = countBucket(entries.length);
    if (entries.length > 4096) throw new Error('Resource inventory exceeds bound');
    const regular = entries.filter(entry => entry.isFile() && !entry.isSymbolicLink());
    inventory.regularFiles = countBucket(regular.length);
    const suffixed = regular.filter(entry => entry.name.endsWith('.resources.json'));
    inventory.resourceSuffix = countBucket(suffixed.length);
    const named = suffixed.filter(entry =>
      entry.name.slice(0, -'.resources.json'.length).split('-').length === 2
      && entry.name.slice(0, -'.resources.json'.length).split('-').every(id => HOST_EXECUTOR_ID_PATTERN.test(id)));
    inventory.nameMatches = countBucket(named.length);
    inventory.rejectedNames = countBucket(suffixed.length - named.length);
    return named.map(entry => {
      const file = path.join(directory, entry.name);
      inventory.operation = 'record-read';
      const bytes = diagnosticCollector.readRegular(file, 128 * 1024, process.getuid(),
        operation => { inventory.operation = `record-${operation}`; });
      inventory.operation = 'record-parse';
      const record = JSON.parse(bytes);
      inventory.operation = 'record-identity';
      if (!record || !['pending', 'cleaned'].includes(record.state)
          || !HOST_EXECUTOR_ID_PATTERN.test(record.runId || '')
          || !HOST_EXECUTOR_ID_PATTERN.test(record.invocationId || '')
          || entry.name !== `${record.runId}-${record.invocationId}.resources.json`) {
        throw new Error('Resource record identity differs from filename');
      }
      inventory.operation = 'complete';
      return { file, record };
    });
  } catch (cause) {
    inventory.code = ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'ELOOP'].includes(cause.code)
      ? cause.code : 'unknown';
    if (inventory.operation === 'directory-lstat') {
      inventory.directory = cause.code === 'ENOENT' ? 'missing' : 'unavailable';
    }
    const error = mcpFailure('resource-inventory-failed');
    mcpFailures.get(error).inventory = inventory;
    throw error;
  }
}

function readRecoveredInvocation(directory, file) {
  const inventory = {};
  const records = resourceRecords(directory, inventory);
  const match = records.find(record => record.file === file);
  if (!match) {
    const error = mcpFailure('recovery-record-missing');
    mcpFailures.get(error).inventory = inventory;
    throw error;
  }
  return { after: match.record, records, inventory };
}

function readCrashRecoveryBaseline(directory, active, ownerPid) {
  const { after, records, inventory } = readRecoveredInvocation(directory, active.file);
  const stableIdentity = record => {
    const identity = { ...record, storage: { ...record.storage } };
    delete identity.storage.mounts;
    delete identity.storage.pending;
    return identity;
  };
  const beforeMounts = active.record.storage?.mounts;
  const mounts = after.storage?.mounts;
  const baseline = {
    uniqueRecord: records.filter(({ record }) =>
      record.runId === active.record.runId && record.invocationId === active.record.invocationId).length === 1,
    pending: after.state === 'pending',
    ownerMatches: Number.isSafeInteger(ownerPid) && ownerPid > 0 && after.owner?.pid === ownerPid,
    identityMatches: isDeepStrictEqual(stableIdentity(after), stableIdentity(active.record)),
    mountsRetained: Array.isArray(beforeMounts) && Array.isArray(mounts)
      && beforeMounts.every((mount, index) => isDeepStrictEqual(mounts[index], mount)),
    mountsCommitted: after.storage?.pending === undefined
      && after.mountPending === false && after.snapshotPending === false,
    snapshotMounted: typeof after.snapshot?.path === 'string' && Array.isArray(mounts)
      && mounts.filter(mount => mount?.mountPoint === after.snapshot.path).length === 1,
  };
  if (Object.values(baseline).some(value => !value)) {
    const error = mcpFailure('crash-baseline-invalid');
    Object.assign(mcpFailures.get(error), { inventory, baseline });
    throw error;
  }
  return { record: after, inventory, baseline };
}

function resourceDiscoveryEvidence(directory, ownerPid, inventory) {
  const result = { ...inventory };
  let ownNamespace;
  result.namespaceOperation = 'observer-readlink';
  try {
    ownNamespace = fs.readlinkSync('/proc/self/ns/mnt');
    result.namespaceOperation = 'host-readlink';
    result.mountNamespace = ownNamespace === fs.readlinkSync(`/proc/${ownerPid}/ns/mnt`)
      ? 'same' : 'different';
    result.namespaceOperation = 'complete';
  } catch (error) {
    result.mountNamespace = 'unavailable';
    result.namespaceCode = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'unknown';
  }
  result.producer = 'missing';
  result.producerOperation = 'directory-trust';
  try {
    const diagnostics = path.join(directory, 'diagnostics');
    diagnosticCollector.directory(diagnostics, process.getuid());
    result.producerOperation = 'directory-readdir';
    const names = fs.readdirSync(diagnostics);
    if (names.length > 4096) throw new Error('Producer inventory exceeds bound');
    const files = names.filter(name => /^[a-f0-9]{16,64}-[a-f0-9]{32}\.json$/.test(name));
    if (files.length > 128) throw new Error('Producer diagnostics exceed bound');
    result.producerOperation = 'directory-lstat';
    const ownDirectory = fs.lstatSync(directory);
    let matches = 0;
    for (const name of files) {
      result.producerOperation = 'record-read';
      const bytes = diagnosticCollector.readRegular(
        path.join(diagnostics, name), 320 * 1024, process.getuid(),
        operation => { result.producerOperation = `record-${operation}`; },
      );
      result.producerOperation = 'record-parse';
      const value = JSON.parse(bytes);
      const evidence = value.resourcePublication;
      if (!evidence || evidence.ownerPid !== ownerPid) continue;
      matches += 1;
      result.producer = evidence.status;
      result.producerLocation = evidence.location;
      result.producerRecordSafe = evidence.recordSafe;
      result.producerDirectory = !evidence.directoryIdentity ? 'unavailable'
        : evidence.directoryIdentity.device === ownDirectory.dev && evidence.directoryIdentity.inode === ownDirectory.ino
          ? 'same' : 'different';
      result.producerNamespace = !ownNamespace || !evidence.mountNamespace ? 'unavailable'
        : ownNamespace === evidence.mountNamespace ? 'same' : 'different';
      const active = !value.milestones?.some(event => event.phase === 'cleanup-start');
      result.producerActive = active;
      if (active) break;
    }
    result.producerMatches = countBucket(matches);
    result.producerOperation = 'complete';
  } catch (error) {
    result.producer = 'read-failed';
    result.producerCode = ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code) ? error.code : 'unknown';
  }
  return result;
}

function observeInvocationRecords(records, existing, ownerPid) {
  const counts = {};
  let candidates = records.filter(({ file }) => !existing.has(file));
  const bucket = count => count === 0 ? 'zero' : count === 1 ? 'one' : 'many';
  counts.newRecords = bucket(candidates.length);
  for (const [key, predicate] of [
    ['pending', value => value.state === 'pending'],
    ['ownerMatches', value => value.owner?.pid === ownerPid],
    ['directoryReady', value => Boolean(value.storage?.directory)],
    ['identityReady', value => Boolean(value.directoryIdentity)],
    ['snapshotReady', value => Boolean(value.snapshot)],
  ]) {
    candidates = candidates.filter(({ record }) => predicate(record));
    counts[key] = bucket(candidates.length);
  }
  counts.eligible = bucket(candidates.length);
  return { counts, record: candidates[0] };
}

async function waitForInvocationRecord(directory, existing, ownerPid, timeoutMs, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const read = dependencies.read || resourceRecords;
  const deadline = now() + timeoutMs;
  let counts;
  let lastInventory;
  while (now() < deadline) {
    let observation;
    const inventory = {};
    try {
      observation = observeInvocationRecords(read(directory, inventory), existing, ownerPid);
    } catch (cause) {
      const error = mcpFailures.has(cause) ? cause : mcpFailure('resource-inventory-failed');
      Object.assign(mcpFailures.get(error), { resources: counts,
        inventory: resourceDiscoveryEvidence(directory, ownerPid, mcpFailures.get(error).inventory || inventory) });
      throw error;
    }
    counts = observation.counts;
    const record = observation.record;
    if (record) return { ...record, inventory: resourceDiscoveryEvidence(directory, ownerPid, inventory) };
    lastInventory = inventory;
    await sleep(100);
  }
  const error = mcpFailure('resource-discovery-timeout');
  mcpFailures.get(error).resources = counts;
  mcpFailures.get(error).inventory = resourceDiscoveryEvidence(directory, ownerPid, lastInventory);
  throw error;
}

async function waitForInvocationOutcome(directory, identity, expected, timeoutMs = 15_000, dependencies = {}) {
  if (!HOST_EXECUTOR_ID_PATTERN.test(identity.runId || '')
      || !HOST_EXECUTOR_ID_PATTERN.test(identity.invocationId || '')
      || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(identity.entryId || '')
      || !['timeout', 'cancelled'].includes(expected)) {
    throw mcpFailure('invocation-evidence-invalid');
  }
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const read = dependencies.read || (() => {
    diagnosticCollector.directory(directory, process.getuid());
    return diagnosticCollector.readRegular(
      path.join(directory, `${identity.runId}.journal`), 1024 * 1024, process.getuid(),
    ).toString('utf8');
  });
  const deadline = now() + timeoutMs;
  const expectedDigest = require('../../dist/enclave/host-executor-protocol').hostExecutorResultDigest(expected);
  while (now() < deadline) {
    let records;
    try {
      records = read().trim().split('\n').map(line => JSON.parse(line));
      if (records[0]?.runId !== identity.runId) throw new Error('Invalid run identity');
    } catch {
      throw mcpFailure('invocation-evidence-invalid');
    }
    const terminal = records.filter(record => record.entryId === identity.entryId
      && record.invocationId === identity.invocationId && ['terminal', 'settled'].includes(record.state));
    if (terminal.some(record => (record.state === 'terminal' && record.outcome !== expected)
        || record.resultDigest !== expectedDigest)) throw mcpFailure('invocation-outcome-mismatch');
    if (terminal.some(record => record.state === 'terminal')
        && terminal.some(record => record.state === 'settled')) return;
    await sleep(100);
  }
  throw mcpFailure('invocation-evidence-timeout');
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
    const error = new Error('Interrupted live enclave invocation returned a successful result');
    mcpFailures.set(error, { reason: 'interrupted-success', ...mcpResponseMetadata(response, 12) });
    throw error;
  }
}

function assertRecoveredInvocation(before, after, records) {
  const matches = records.filter(({ record }) =>
    record.runId === before.runId && record.invocationId === before.invocationId);
  const recovery = {
    uniqueRecord: matches.length === 1,
    cleaned: after?.state === 'cleaned',
    runMatches: after?.runId === before.runId,
    invocationMatches: after?.invocationId === before.invocationId,
    directoryIdentityPresent: !!before.directoryIdentity,
    storageDirectoryIdentityPresent: !!before.storage?.directoryIdentity,
    storageMountedIdentityPresent: !!before.storage?.mountedIdentity,
    snapshotPresent: !!before.snapshot,
    directoryMatches: isDeepStrictEqual(after?.directory, before.directory),
    directoryIdentityMatches: isDeepStrictEqual(after?.directoryIdentity, before.directoryIdentity),
    ancestorsMatch: isDeepStrictEqual(after?.ancestors, before.ancestors),
    mountMatches: isDeepStrictEqual(after?.mount, before.mount),
    snapshotMatches: isDeepStrictEqual(after?.snapshot, before.snapshot),
    storageDirectoryMatches: isDeepStrictEqual(after?.storage?.directory, before.storage?.directory),
    storageParentIdentityMatches: isDeepStrictEqual(after?.storage?.parentIdentity, before.storage?.parentIdentity),
    storageAncestorsMatch: isDeepStrictEqual(after?.storage?.ancestors, before.storage?.ancestors),
    storageDirectoryIdentityMatches: isDeepStrictEqual(
      after?.storage?.directoryIdentity, before.storage?.directoryIdentity,
    ),
    storageMountedIdentityMatches: isDeepStrictEqual(after?.storage?.mountedIdentity, before.storage?.mountedIdentity),
    storageMountsMatch: isDeepStrictEqual(after?.storage?.mounts, before.storage?.mounts),
  };
  if (Object.values(recovery).some(value => !value)) {
    const error = new Error('Live VMM crash recovery did not clean the exact interrupted invocation');
    mcpFailures.set(error, { reason: 'recovery-validation-failed', recovery });
    throw error;
  }
  return recovery;
}

function killAwfForRecovery(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null || failedSpawns.has(child)) {
      reject(mcpFailure('host-already-exited'));
      return;
    }
    const finish = (error) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = () => finish(mcpFailure('host-kill-failed'));
    const timer = setTimeout(() => finish(mcpFailure('host-exit-timeout')), timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
    try {
      if (!child.kill('SIGKILL') && child.exitCode === null && child.signalCode === null) {
        finish(mcpFailure('host-kill-failed'));
      }
    } catch (cause) {
      const error = mcpFailure('host-kill-failed');
      mcpFailures.get(error).code = cause?.code;
      finish(error);
    }
  });
}

async function withCrashRecoveryCleanup(context, action, cleanups, onCleanupFailure) {
  try {
    return await action();
  } catch (error) {
    for (const { phase, action: cleanup } of cleanups) {
      try {
        await acceptanceCheck(context, 'crash-recovery', phase, cleanup);
      } catch {
        onCleanupFailure();
      }
    }
    throw error;
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
  AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS: path.join(enclaveDirectory, 'enclave-rootfs.ext4'),
  AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS: path.join(enclaveDirectory, 'enclave-rootfs.ext4'),
  AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS: path.join(enclaveDirectory, 'enclave-rootfs.ext4'),
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

function prepareAcceptanceArtifacts(checkout, directory, environment) {
  if (checkout.mode !== 'candidate') return prepareReleaseArtifacts(checkout.tag, directory, environment);
  const { SIGNER_WORKFLOW, candidateAttestationArguments } = require('./cloud-hypervisor-enclave-candidate');
  const candidate = environment.AWF_CLOUD_HYPERVISOR_CANDIDATE_ARTIFACTS;
  const policy = require('../../dist/cloud-hypervisor/artifact-manifest');
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)
      || path.normalize(candidate) !== candidate
      || policy.CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG !== checkout.tag
      || policy.CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW !== SIGNER_WORKFLOW) {
    throw new Error('Candidate acceptance requires its exact compiled artifact compatibility profile');
  }
  const enclaveManifest = path.join(candidate, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json');
  const enclaveBundle = path.join(candidate, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl');
  const subjects = [
    [path.join(candidate, RELEASE_ASSETS[1]), path.join(candidate, RELEASE_ASSETS[2])],
    [enclaveManifest, enclaveBundle],
    [path.join(candidate, 'enclave-rootfs.ext4'), path.join(candidate, 'enclave-rootfs.provenance.sigstore.jsonl')],
  ];
  for (const [subject, bundle] of subjects) {
    run('gh', ['attestation', 'verify', subject, '--bundle', bundle,
      ...candidateAttestationArguments(checkout)], { env: environment });
  }
  console.log(`AWF_ENCLAVE_ACCEPTANCE_SOURCE ${JSON.stringify({
    mode: 'candidate', commit: checkout.commit, tag: checkout.tag,
  })}`);
  return {
    directory: candidate, enclaveDirectory: candidate, tag: checkout.tag,
    enclaveArtifactEnvironment: {
      AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS: path.join(candidate, 'enclave-rootfs.ext4'),
      AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS: path.join(candidate, 'enclave-rootfs.ext4'),
      AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS: path.join(candidate, 'enclave-rootfs.ext4'),
      AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST: enclaveManifest,
      AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE: enclaveBundle,
    },
  };
}

function makeConfig(artifacts, workDir, workspace, handoff, profile = 'combined') {
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
          maxTaskBytes: 4096,
        },
        runtime: 'cloud-hypervisor',
        timeout: 360,
        maxInvocations: 3,
        repos: [enclaveRepository],
      },
    ].filter((entry) => profile === 'combined'
      || (profile === 'script-only' && entry.script)
      || (profile === 'agent-only' && entry.agent)),
    container: { containerRuntime: 'cloud-hypervisor', imageTag: artifacts.tag },
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
  const { testWorkspace, testGateway, enclaves, ...awfConfig } = config;
  void testWorkspace;
  void testGateway;
  return enclaves.length ? { ...awfConfig, enclaves } : awfConfig;
}

function assertUnifiedProfiles(artifacts, primaryManifest, enclaveManifest, enclaveSbom) {
  const primaryRootfs = primaryManifest?.artifacts?.rootfs;
  const enclaveRootfs = enclaveManifest?.rootfs;
  const base = primaryManifest?.userspace;
  const guestBase = enclaveManifest?.guestBase;
  const digest = enclaveRootfs?.sha256;
  const sbomRootfs = enclaveSbom?.packages?.find((item) => item.SPDXID === 'SPDXRef-Rootfs');
  const sbomDigest = sbomRootfs?.checksums?.find((item) => item.algorithm === 'SHA256')?.checksumValue;
  const sourceImage = enclaveSbom?.packages?.find((item) => item.SPDXID === 'SPDXRef-SourceImage');
  if (!base?.baseImage || !/^sha256:[a-f0-9]{64}$/.test(base.baseImageId || '')
      || base.baseImage !== guestBase?.image || base.baseImageId !== guestBase.imageId) {
    throw new Error('Unified Cloud Hypervisor profiles do not share the manifest guest base image');
  }
  if (enclaveManifest?.schemaVersion !== 2
      || primaryRootfs?.file !== 'rootfs.ext4' || !/^[a-f0-9]{64}$/.test(primaryRootfs.sha256 || '')
      || enclaveRootfs?.file !== 'enclave-rootfs.ext4' || !/^[a-f0-9]{64}$/.test(digest || '')
      || digest !== sbomDigest
      || !/^[a-f0-9]{64}$/.test(enclaveRootfs.sourceImageDigest || '')
      || !enclaveRootfs.sourceImage
      || sourceImage?.versionInfo !== enclaveRootfs.sourceImageDigest
      || sourceImage?.externalRefs?.[0]?.referenceLocator !== enclaveRootfs.sourceImage) {
    throw new Error('Unified Cloud Hypervisor profiles lack matching final enclave rootfs metadata');
  }
  const scriptRootfs = artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS;
  const agentRootfs = artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS;
  const sharedRootfs = artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS;
  if (scriptRootfs !== sharedRootfs || agentRootfs !== sharedRootfs
      || sharedRootfs !== path.join(artifacts.enclaveDirectory, enclaveRootfs.file)) {
    throw new Error('Unified Cloud Hypervisor profiles must use the same final enclave rootfs');
  }
  for (const [name, count] of [['primary', 0], ['script-only', 1], ['agent-only', 1], ['combined', 2]]) {
    const config = makeConfig(artifacts, 'profile-work', 'profile-workspace', {}, name);
    const enclaves = config.enclaves;
    if (config.container.containerRuntime !== 'cloud-hypervisor'
        || config.container.imageTag !== artifacts.tag
        || config.cloudHypervisor.rootfsPath !== path.join(artifacts.directory, primaryRootfs.file)
        || enclaves.length !== count
        || enclaves.some((entry) => entry.runtime !== 'cloud-hypervisor')
        || (name === 'script-only' && !enclaves[0]?.script)
        || (name === 'agent-only' && !enclaves[0]?.agent)
        || (name === 'combined' && (!enclaves[0]?.script || !enclaves[1]?.agent))) {
      throw new Error(`Unified Cloud Hypervisor ${name} profile configuration is inconsistent`);
    }
  }
}

function assertProfileInitialize(response, requestId) {
  const profile = { serverMatches: response?.result?.serverInfo?.name === 'awmg-awf-enclave' };
  if (!profile.serverMatches) {
    const error = mcpFailure('profile-initialize-invalid', response, requestId);
    mcpFailures.get(error).profile = profile;
    throw error;
  }
  return profile;
}

function assertProfileTools(response, profile, requestId) {
  const expected = profile === 'script-only' ? ['enclave_run_script']
    : profile === 'agent-only' ? ['enclave_run_agent']
      : ['enclave_run_agent', 'enclave_run_script'];
  const tools = response?.result?.tools;
  const names = Array.isArray(tools) ? tools.map(tool => tool?.name).sort() : undefined;
  const checks = {
    toolsArray: Array.isArray(tools),
    scriptPresent: names?.includes('enclave_run_script') || false,
    agentPresent: names?.includes('enclave_run_agent') || false,
    toolsMatch: isDeepStrictEqual(names, expected),
  };
  if (!checks.toolsMatch) {
    const error = mcpFailure('profile-tools-invalid', response, requestId);
    error.message = `Live ${profile} enclave profile did not expose exactly its configured executors`;
    mcpFailures.get(error).profile = checks;
    throw error;
  }
  return checks;
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

const FAILURE_STAGES = Object.freeze({
  RUNNER: 'runner eligibility',
  CHECKOUT: 'acceptance checkout',
  PUBLIC_SEED_TOKENS: 'GH_TOKEN/GITHUB_TOKEN prerequisites',
  COPILOT_TOKEN: 'COPILOT_GITHUB_TOKEN prerequisite',
  RELEASE: 'release artifact setup',
  GATEWAY: 'gateway setup',
  BROKER: 'broker readiness',
  PRIMARY: 'primary VM readiness',
  MCP_ROUTE: 'public MCP route',
  SCRIPT: 'script enclave checks',
  AGENT: 'agent enclave checks',
  SCRIPT_ONLY: 'script-only profile acceptance',
  AGENT_ONLY: 'agent-only profile acceptance',
  RESOURCE_LIMITS: 'resource-limit checks',
  FAILURE_HANDLING: 'failure, timeout, and cancellation checks',
  STARTUP_FAULTS: 'startup fault checks',
  CRASH_RECOVERY: 'VMM crash recovery',
  OUTPUT_REDACTION: 'output redaction checks',
  CLEANUP: 'fixture cleanup',
});

async function main(failureContext = { stage: FAILURE_STAGES.RUNNER }) {
  failureContext.stage = FAILURE_STAGES.RUNNER;
  if (process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== 'true'
      || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
      || !/^ubuntu/.test(process.env.ImageOS || '')) {
    throw new Error('Live enclave acceptance requires an opted-in GitHub-hosted Ubuntu runner as root');
  }
  failureContext.stage = FAILURE_STAGES.CHECKOUT;
  const checkout = require('./cloud-hypervisor-enclave-candidate').verifyAcceptanceSource();
  failureContext.stage = FAILURE_STAGES.PUBLIC_SEED_TOKENS;
  if (!process.env.GH_TOKEN || !process.env.GITHUB_TOKEN) {
    throw new Error('Live enclave acceptance requires GH_TOKEN and GITHUB_TOKEN for public seed staging');
  }
  failureContext.stage = FAILURE_STAGES.COPILOT_TOKEN;
  if (!process.env.COPILOT_GITHUB_TOKEN) {
    throw new Error('Live agent-enclave acceptance requires the COPILOT_GITHUB_TOKEN repository secret');
  }
  failureContext.stage = FAILURE_STAGES.RELEASE;
  const environment = { ...process.env };
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
  let acceptancePassed = false;
  let preRestartLogContents;
  let awfConfigPath = path.join(root, 'awf-config.json');
  const runDirectories = [workDir];
  let awfEnvironment;
  let primaryVmResidue;
  let diagnosticContext;
  const startupSnapshots = [];
  const launchAwf = (stage, profile = stage === 'initial' || stage === 'recovery' ? 'combined' : stage) => {
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
    const startupErrorFile = path.join(workDir, 'proxy-logs', 'awf-startup-error.json');
    let child;
    try {
      child = spawnAwf(awfArguments, awfEnvironment, awfOut, awfErr, stage);
    } catch {
      startupSnapshots.push(startupSnapshot(undefined, 'spawn-failure', stage, profile, awfErr, startupErrorFile));
      throw new Error('Could not launch AWF before public enclave broker readiness');
    }
    const snapshot = { stage, profile, child, stderrFile: awfErr, startupErrorFile };
    startupSnapshots.push(snapshot);
    const capture = (reason) => {
      if (snapshot.diagnostic) return;
      Object.assign(snapshot, startupSnapshot(child, reason, stage, profile, awfErr, startupErrorFile));
      delete snapshot.child;
      delete snapshot.stderrFile;
      delete snapshot.startupErrorFile;
    };
    child.once('exit', () => capture(failedSpawns.has(child) ? 'spawn-failure'
      : child.signalCode ? 'signal' : 'exit'));
    child.once('error', () => {
      if (failedSpawns.has(child)) capture('spawn-failure');
    });
    return child;
  };
  const stopComposeAfterCrash = (composeWorkDir = workDir) => run('docker', [
    'compose',
    '--project-directory', composeWorkDir,
    '--file', path.join(composeWorkDir, 'docker-compose.yml'),
    'down', '--volumes', '--remove-orphans', '--timeout', '5',
  ]);
  try {
    failureContext.stage = FAILURE_STAGES.RELEASE;
    const artifacts = prepareAcceptanceArtifacts(checkout, artifactsDir, environment);
    const { assertManifestSource } = require('./cloud-hypervisor-enclave-release-gate');
    for (const manifestPath of [
      path.join(artifacts.directory, RELEASE_ASSETS[1]),
      artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST,
    ]) {
      assertManifestSource(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), checkout.tag, checkout.commit);
    }
    assertUnifiedProfiles(
      artifacts,
      JSON.parse(fs.readFileSync(path.join(artifacts.directory, RELEASE_ASSETS[1]), 'utf8')),
      JSON.parse(fs.readFileSync(artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST, 'utf8')),
      JSON.parse(fs.readFileSync(path.join(artifacts.enclaveDirectory, 'enclave-rootfs.sbom.spdx.json'), 'utf8')),
    );
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true, mode: 0o755 });
    fs.chmodSync(workspace, 0o755);
    fs.mkdirSync(path.join(workDir, 'audit'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(workDir, 'proxy-logs'), { recursive: true, mode: 0o700 });
    diagnosticContext = conformanceDiagnostics.prepareForJob(
      toAwfConfig(makeConfig(artifacts, workDir, workspace, {})), 'live',
    );
    if (diagnosticContext) {
      failureContext.observeAdmission = () => conformanceDiagnostics.captureAdmissionEvidence(
        diagnosticContext, require('../../dist/enclave/paths').resolveEnclavePaths(workDir).auditDir,
      );
    }
    failureContext.stage = FAILURE_STAGES.GATEWAY;
    const handoff = startGatewayFixture({
      gatewayEnv, gatewayKey, capability, identity: gatewayIdentity,
      onStarted: () => { gatewayStarted = true; },
    });
    const { endpoint } = handoff;
    const writeAwfConfig = (targetWorkDir, targetConfigPath, profile = 'combined') => {
      fs.mkdirSync(targetWorkDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(targetWorkDir, 'audit'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(targetWorkDir, 'proxy-logs'), { recursive: true, mode: 0o700 });
      const config = toAwfConfig(makeConfig(artifacts, targetWorkDir, workspace, handoff, profile));
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
    failureContext.stage = FAILURE_STAGES.BROKER;
    awf = launchAwf('initial', 'combined');
    await waitForBroker(awf, 'awf-enclave-mcp-server', Date.now() + 15 * 60_000, {
      stage: 'initial', stderrFile: awfErr,
      startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
    });
    await waitForHostGatewayReadiness(awf, Date.now() + 150_000, {
      stage: 'initial', stderrFile: awfErr,
      startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
    });
    failureContext.stage = FAILURE_STAGES.PRIMARY;
    primaryVmResidue = await waitForPrimaryVmReadiness(awf, Date.now() + 5 * 60_000, {
      startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
    });

    failureContext.stage = FAILURE_STAGES.MCP_ROUTE;
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
    assertProfileTools(tools, 'combined');

    failureContext.stage = FAILURE_STAGES.SCRIPT;
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
    await waitForVmCleanup(15_000, primaryVmResidue);

    failureContext.stage = FAILURE_STAGES.AGENT;
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
    await waitForVmCleanup(15_000, primaryVmResidue);

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
    await waitForVmCleanup(15_000, primaryVmResidue);

    failureContext.stage = FAILURE_STAGES.RESOURCE_LIMITS;
    const agentEnospcProbe = buildAgentEnospcProbe();
    const agentEnospcResponse = await acceptanceCheck(failureContext, 'agent-enospc', 'request',
      () => requestMcp(endpoint, gatewayKey, 6, 'tools/call', {
        name: 'enclave_run_agent',
        arguments: {
          privateRepo: 'github/gh-aw-firewall',
          schema: agentEnospcProbe.schema,
          prompt: agentEnospcProbe.prompt,
        },
      }));
    await acceptanceCheck(failureContext, 'agent-enospc', 'result-validation',
      () => assertExpectedToolResult(agentEnospcResponse, 6, agentEnospcProbe.expected, 'agent aggregate ENOSPC'));
    await acceptanceCheck(failureContext, 'agent-enospc', 'cleanup',
      () => waitForVmCleanup(15_000, primaryVmResidue));

    const enospcExpected = { enospcObserved: true, probeFilesRemoved: true };
    const enospcResponse = await acceptanceCheck(failureContext, 'script-enospc', 'request',
      () => requestMcp(endpoint, gatewayKey, 7, 'tools/call', {
        name: 'enclave_run_script',
        arguments: {
          privateRepo: 'github/gh-aw-firewall',
          schema: buildConstantObjectSchema(enospcExpected),
          script: buildEnospcProbeScript(),
        },
      }));
    await acceptanceCheck(failureContext, 'script-enospc', 'result-validation',
      () => assertExpectedToolResult(enospcResponse, 7, enospcExpected, 'script aggregate ENOSPC'));
    await acceptanceCheck(failureContext, 'script-enospc', 'cleanup',
      () => waitForVmCleanup(15_000, primaryVmResidue));

    const oomExpected = { childKilledByOom: true, oomKillCounterIncreased: true };
    const oomResponse = await acceptanceCheck(failureContext, 'guest-oom', 'request',
      () => requestMcp(endpoint, gatewayKey, 8, 'tools/call', {
        name: 'enclave_run_script',
        arguments: {
          privateRepo: 'github/gh-aw-firewall',
          schema: buildConstantObjectSchema(oomExpected),
          script: buildOomProbeScript(),
        },
      }));
    await acceptanceCheck(failureContext, 'guest-oom', 'result-validation',
      () => assertExpectedToolResult(oomResponse, 8, oomExpected, 'guest OOM'));
    await acceptanceCheck(failureContext, 'guest-oom', 'cleanup',
      () => waitForVmCleanup(15_000, primaryVmResidue));

    failureContext.stage = FAILURE_STAGES.FAILURE_HANDLING;
    const errorSchema = { type: 'const', value: true };
    const guestFailure = await acceptanceCheck(failureContext, 'guest-failure', 'request',
      () => requestMcp(endpoint, gatewayKey, 9, 'tools/call', {
        name: 'enclave_run_script',
        arguments: {
          privateRepo: 'github/gh-aw-firewall',
          schema: errorSchema,
          script: 'raise SystemExit(23)',
        },
      }));
    await acceptanceCheck(failureContext, 'guest-failure', 'result-validation',
      () => assertCanonicalToolError(guestFailure, 9));
    await acceptanceCheck(failureContext, 'guest-failure', 'cleanup',
      () => waitForVmCleanup(15_000, primaryVmResidue));

    const journalRoot = HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY;
    const existingTimeoutResources = await acceptanceCheck(failureContext, 'guest-timeout', 'resource-baseline',
      () => new Set(resourceRecords(journalRoot).map(({ file }) => file)));
    const [timeout, timeoutActive] = await Promise.all([
      acceptanceCheck(failureContext, 'guest-timeout', 'request',
        () => requestMcp(endpoint, gatewayKey, 10, 'tools/call', {
          name: 'enclave_run_script',
          arguments: {
            privateRepo: 'github/gh-aw-firewall',
            schema: errorSchema,
            script: 'import time\nopen("/output/timeout-probe-started", "w").write("started")\ntime.sleep(150)',
          },
        })),
      (async () => {
        const active = await acceptanceCheck(failureContext, 'guest-timeout', 'resource-discovery',
          () => waitForInvocationRecord(journalRoot, existingTimeoutResources, awf.pid, 90_000));
        await acceptanceCheck(failureContext, 'guest-timeout', 'marker-wait',
          () => waitForPath(path.join(active.record.directory, 'output', 'timeout-probe-started'), 90_000));
        return active;
      })(),
    ]);
    await acceptanceCheck(failureContext, 'guest-timeout', 'result-validation',
      () => assertCanonicalToolError(timeout, 10));
    await acceptanceCheck(failureContext, 'guest-timeout', 'cleanup',
      () => waitForVmCleanup(15_000, primaryVmResidue));
    await acceptanceCheck(failureContext, 'guest-timeout', 'execution-validation',
      () => waitForInvocationOutcome(journalRoot, timeoutActive.record, 'timeout'));

    const existingCancellationResources = await acceptanceCheck(failureContext, 'guest-cancellation', 'resource-baseline',
      () => new Set(resourceRecords(journalRoot).map(({ file }) => file)));
    const cancellationMarker = [
      'import time',
      'open("/output/cancel-probe-started", "w", encoding="ascii").write("started")',
      'while True: time.sleep(1)',
    ].join('\n');
    const cancellationController = new AbortController();
    const cancellationRequest = acceptanceCheck(failureContext, 'guest-cancellation', 'request',
      () => requestMcp(endpoint, gatewayKey, 11, 'tools/call', {
        name: 'enclave_run_script',
        arguments: {
          privateRepo: 'github/gh-aw-firewall',
          schema: errorSchema,
          script: cancellationMarker,
        },
      }, cancellationController.signal));
    const [cancelled, cancellationActive] = await Promise.all([
      cancellationRequest,
      (async () => {
        const active = await acceptanceCheck(failureContext, 'guest-cancellation', 'resource-discovery',
          () => waitForInvocationRecord(journalRoot, existingCancellationResources, awf.pid, 90_000));
        await acceptanceCheck(failureContext, 'guest-cancellation', 'marker-wait',
          () => waitForPath(path.join(active.record.directory, 'output', 'cancel-probe-started'), 90_000));
        cancellationController.abort();
        return active;
      })(),
    ]);
    await acceptanceCheck(failureContext, 'guest-cancellation', 'disconnect-validation', () => {
      if (cancelled !== undefined) throw mcpFailure('disconnect-not-cancelled');
    });
    await acceptanceCheck(failureContext, 'guest-cancellation', 'cleanup',
      () => waitForVmCleanup(15_000, primaryVmResidue));
    await acceptanceCheck(failureContext, 'guest-cancellation', 'execution-validation',
      () => waitForInvocationOutcome(journalRoot, cancellationActive.record, 'cancelled'));

    failureContext.stage = FAILURE_STAGES.STARTUP_FAULTS;
    try {
      await require('./cloud-hypervisor-enclave-startup-faults').runStartupFaultProbes({
        directory: root,
        config: toAwfConfig(makeConfig(artifacts, workDir, workspace, handoff)).cloudHypervisor,
        environment: awfEnvironment,
        primaryVmResidue,
      });
    } catch (error) {
      keepArtifacts = true;
      throw error;
    }
    await waitForVmCleanup(15_000, primaryVmResidue);

    failureContext.stage = FAILURE_STAGES.CRASH_RECOVERY;
    const crashProbe = [
      'import time',
      'open("/output/crash-probe-started", "w", encoding="ascii").write("started")',
      'while True: time.sleep(1)',
    ].join('\n');
    const crashController = new AbortController();
    const interruptedWorkDir = workDir;
    await withCrashRecoveryCleanup(failureContext, async () => {
      const existingResources = await acceptanceCheck(failureContext, 'crash-recovery', 'resource-baseline',
        () => new Set(resourceRecords(journalRoot).map(({ file }) => file)));
      let crashResponse;
      await acceptanceCheck(failureContext, 'crash-recovery', 'request-start', () => {
        const crashRequest = requestMcp(endpoint, gatewayKey, 12, 'tools/call', {
          name: 'enclave_run_script',
          arguments: {
            privateRepo: 'github/gh-aw-firewall',
            schema: errorSchema,
            script: crashProbe,
          },
        }, crashController.signal);
        crashResponse = crashRequest.then(
          (response) => ({ response }),
          () => ({ disconnected: true }),
        );
      });
      const active = await acceptanceCheck(failureContext, 'crash-recovery', 'resource-discovery',
        () => waitForInvocationRecord(journalRoot, existingResources, awf.pid, 90_000));
      await acceptanceCheck(failureContext, 'crash-recovery', 'marker-wait',
        () => waitForPath(path.join(active.record.directory, 'output', 'crash-probe-started'), 90_000));
      const crashBaseline = await acceptanceCheck(failureContext, 'crash-recovery', 'resource-refresh',
        () => readCrashRecoveryBaseline(journalRoot, active, awf.pid));
      const vmmPid = await acceptanceCheck(failureContext, 'crash-recovery', 'vmm-discovery', () => {
        const apiSocket = path.join(crashBaseline.record.storage.directory, 'runs', 'vm', 'api.socket');
        const pid = findProcessForSocket(apiSocket);
        if (!pid) throw mcpFailure('vmm-not-found');
        return pid;
      });
      await acceptanceCheck(failureContext, 'crash-recovery', 'vmm-kill',
        () => process.kill(vmmPid, 'SIGKILL'));
      await acceptanceCheck(failureContext, 'crash-recovery', 'host-kill',
        () => killAwfForRecovery(awf));
      awf = undefined;
      const stdout = await acceptanceCheck(failureContext, 'crash-recovery', 'stdout-read',
        () => fs.readFileSync(awfOut, 'utf8'));
      const stderr = await acceptanceCheck(failureContext, 'crash-recovery', 'stderr-read',
        () => fs.readFileSync(awfErr, 'utf8'));
      const containerLogs = await acceptanceCheck(failureContext, 'crash-recovery', 'container-logs',
        () => captureContainerLogs());
      preRestartLogContents = [stdout, stderr, ...containerLogs];
      await acceptanceCheck(failureContext, 'crash-recovery', 'compose-stop',
        () => stopComposeAfterCrash(interruptedWorkDir));
      await acceptanceCheck(failureContext, 'crash-recovery', 'recovery-config', () => {
        workDir = path.join(root, 'awf-work-recovery');
        awfConfigPath = path.join(root, 'awf-config-recovery.json');
        runDirectories.push(workDir);
        writeAwfConfig(workDir, awfConfigPath);
      });
      await acceptanceCheck(failureContext, 'crash-recovery', 'recovery-launch', () => {
        awf = launchAwf('recovery', 'combined');
      });
      await acceptanceCheck(failureContext, 'crash-recovery', 'broker-readiness',
        () => waitForBroker(awf, 'awf-enclave-mcp-server', Date.now() + 15 * 60_000, {
          stage: 'recovery', stderrFile: awfErr,
          startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
        }));
      await acceptanceCheck(failureContext, 'crash-recovery', 'gateway-readiness',
        () => waitForHostGatewayReadiness(awf, Date.now() + 150_000, {
          stage: 'recovery', stderrFile: awfErr,
          startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
        }));
      primaryVmResidue = await acceptanceCheck(failureContext, 'crash-recovery', 'primary-readiness',
        () => waitForPrimaryVmReadiness(awf, Date.now() + 5 * 60_000, {
          startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
        }));
      await acceptanceCheck(failureContext, 'crash-recovery', 'tools-list', async () => {
        const recoveryTools = await requestMcp(endpoint, gatewayKey, 13, 'tools/list', {});
        if (!Array.isArray(recoveryTools?.result?.tools)) {
          throw mcpFailure('recovery-tools-invalid', recoveryTools, 13);
        }
        return recoveryTools;
      });
      const recovered = await acceptanceCheck(failureContext, 'crash-recovery', 'resource-read',
        () => readRecoveredInvocation(journalRoot, active.file));
      await acceptanceCheck(failureContext, 'crash-recovery', 'recovery-validation',
        () => assertRecoveredInvocation(crashBaseline.record, recovered.after, recovered.records));
      await acceptanceCheck(failureContext, 'crash-recovery', 'interrupted-response', async () => {
        const result = await crashResponse;
        assertNoSuccessfulResult(result.response);
        return result;
      });
      await acceptanceCheck(failureContext, 'crash-recovery', 'cleanup',
        () => waitForVmCleanup(15_000, primaryVmResidue));
    }, [
      { phase: 'request-abort', action: () => crashController.abort() },
      { phase: 'host-cleanup', action: async () => {
        if (awf && awf.exitCode === null && awf.signalCode === null && !failedSpawns.has(awf)) {
          await stopAwf(awf);
        }
      } },
      { phase: 'compose-cleanup', action: () => stopComposeAfterCrash(interruptedWorkDir) },
    ], () => { keepArtifacts = true; });

    failureContext.stage = FAILURE_STAGES.OUTPUT_REDACTION;
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

    // Exercise each single-executor configuration through a fresh broker and real VM.
    // The combined run above retains the full failure/recovery coverage.
    for (const profile of ['script-only', 'agent-only']) {
      failureContext.stage = profile === 'script-only'
        ? FAILURE_STAGES.SCRIPT_ONLY : FAILURE_STAGES.AGENT_ONLY;
      await acceptanceCheck(failureContext, profile, 'stop-marker',
        () => fs.writeFileSync(path.join(workspace, '.awf-enclave-live-stop'), 'done\n', { mode: 0o644 }));
      await acceptanceCheck(failureContext, profile, 'host-stop', () => stopAwf(awf));
      await acceptanceCheck(failureContext, profile, 'host-stop-validation', () => {
        if (awf.exitCode !== 0 || awf.signalCode !== null) throw mcpFailure('profile-stop-invalid');
      });
      awf = undefined;
      await acceptanceCheck(failureContext, profile, 'stop-marker-remove',
        () => fs.rmSync(path.join(workspace, '.awf-enclave-live-stop')));
      await acceptanceCheck(failureContext, profile, 'profile-config', () => {
        workDir = path.join(root, `awf-work-${profile}`);
        awfConfigPath = path.join(root, `awf-config-${profile}.json`);
        runDirectories.push(workDir);
        writeAwfConfig(workDir, awfConfigPath, profile);
      });
      await acceptanceCheck(failureContext, profile, 'profile-launch', () => {
        awf = launchAwf(profile, profile);
      });
      const diagnostics = {
        stage: profile, stderrFile: awfErr,
        startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
      };
      await acceptanceCheck(failureContext, profile, 'broker-readiness',
        () => waitForBroker(awf, 'awf-enclave-mcp-server', Date.now() + 15 * 60_000, diagnostics));
      await acceptanceCheck(failureContext, profile, 'gateway-readiness',
        () => waitForHostGatewayReadiness(awf, Date.now() + 150_000, diagnostics));
      const profileStage = failureContext.stage;
      failureContext.stage = FAILURE_STAGES.PRIMARY;
      primaryVmResidue = await acceptanceCheck(failureContext, profile, 'primary-readiness',
        () => waitForPrimaryVmReadiness(awf, Date.now() + 5 * 60_000, diagnostics));
      failureContext.stage = profileStage;
      const requestId = profile === 'script-only' ? 14 : 17;
      const profileInit = await acceptanceCheck(failureContext, profile, 'initialize',
        () => requestMcp(endpoint, gatewayKey, requestId, 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'awf-live-enclave-conformance', version: '1.0.0' },
        }));
      await acceptanceCheck(failureContext, profile, 'initialize-validation',
        () => assertProfileInitialize(profileInit, requestId));
      const profileTools = await acceptanceCheck(failureContext, profile, 'tools-list',
        () => requestMcp(endpoint, gatewayKey, requestId + 1, 'tools/list', {}));
      await acceptanceCheck(failureContext, profile, 'tools-validation',
        () => assertProfileTools(profileTools, profile, requestId + 1));
      if (profile === 'script-only') {
        const response = await acceptanceCheck(failureContext, profile, 'request',
          () => requestMcp(endpoint, gatewayKey, requestId + 2, 'tools/call', {
            name: 'enclave_run_script',
            arguments: { privateRepo: 'github/gh-aw-firewall', schema: scriptProbe.schema, script: python },
          }));
        await acceptanceCheck(failureContext, profile, 'result-validation',
          () => assertExpectedToolResult(response, requestId + 2, scriptProbe.expected, 'script-only profile'));
      } else {
        const response = await acceptanceCheck(failureContext, profile, 'request',
          () => requestMcp(endpoint, gatewayKey, requestId + 2, 'tools/call', {
            name: 'enclave_run_agent',
            arguments: {
              privateRepo: 'github/gh-aw-firewall',
              schema: { type: 'enum', values: [agentResultValue] },
              prompt: `Return exactly the string ${JSON.stringify(agentResultValue)}. Do not inspect or quote repository files.`,
            },
          }));
        await acceptanceCheck(failureContext, profile, 'result-validation',
          () => assertExpectedToolResult(response, requestId + 2, agentResultValue, 'agent-only profile'));
      }
      await acceptanceCheck(failureContext, profile, 'cleanup',
        () => waitForVmCleanup(15_000, primaryVmResidue));
      const profileStdout = await acceptanceCheck(failureContext, profile, 'stdout-read',
        () => fs.readFileSync(awfOut, 'utf8'));
      const profileStderr = await acceptanceCheck(failureContext, profile, 'stderr-read',
        () => fs.readFileSync(awfErr, 'utf8'));
      const profileContainerLogs = await acceptanceCheck(failureContext, profile, 'container-logs',
        () => captureContainerLogs(profile));
      await acceptanceCheck(failureContext, profile, 'output-redaction', () => {
        const privateRoot = path.join(
          '/var/tmp',
          `awf-enclave-private-0-${crypto.createHash('sha256')
            .update(path.resolve(workDir), 'utf8').digest('hex').slice(0, 20)}`,
        );
        assertNoSentinelLeak([
          path.join(workDir, 'audit'), path.join(workDir, 'proxy-logs'),
          path.join(privateRoot, 'audit'), path.join(privateRoot, 'api-proxy-logs'),
          journalRoot,
        ], [profileStdout, profileStderr, ...profileContainerLogs], sentinel);
      });
    }
    acceptancePassed = true;
    console.log('Live combined, script-only, and agent-only profile invocations, guest identity/network, resource limits, failure/timeout/cancellation, VMM crash recovery, cleanup, and output redaction checks passed.');
  } finally {
    if (acceptancePassed) failureContext.stage = FAILURE_STAGES.CLEANUP;
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
        for (const snapshot of startupSnapshots) {
          if (snapshot.diagnostic) continue;
          const child = snapshot.child;
          const reason = child && failedSpawns.has(child) ? 'spawn-failure'
            : child?.signalCode ? 'signal' : child?.exitCode !== null && child?.exitCode !== undefined
              ? 'exit' : 'unknown';
          Object.assign(snapshot, startupSnapshot(
            child, reason, snapshot.stage, snapshot.profile, snapshot.stderrFile, snapshot.startupErrorFile,
          ));
          delete snapshot.child;
          delete snapshot.stderrFile;
          delete snapshot.startupErrorFile;
        }
        conformanceDiagnostics.collect(diagnosticContext, {
          status: acceptancePassed && !process.exitCode ? 'passed' : 'failed',
          stage: Object.values(FAILURE_STAGES).includes(failureContext.stage) ? failureContext.stage : 'unknown stage',
          check: failureContext.check,
          checks: failureContext.checks,
          admissionEvidence: failureContext.admissionEvidence,
          startup: startupSnapshots.map(({ stage, profile, diagnostic, evidence }) =>
            ({ stage, profile, diagnostic, evidence })),
        });
      } catch {
        console.error('Could not retain public enclave conformance diagnostics; raw files will not be uploaded.');
        process.exitCode = 1;
      }
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
  for (const file of [stdoutFile, stderrFile, ...startupErrorFiles,
    ...startupErrorFiles.map((startupFile) =>
      path.join(path.dirname(startupFile), 'cloud-hypervisor', 'awf-primary-vm-readiness.json')),
  ]) {
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
    if (typeof child.exitCode === 'number' || child.signalCode) {
      resolve();
      return;
    }
    const sendSignal = (signal) => {
      try {
        child.kill(signal);
        return true;
      } catch (cause) {
        onError(cause);
        return false;
      }
    };
    const terminate = setTimeout(() => sendSignal('SIGTERM'), graceMs);
    const kill = setTimeout(() => {
      if (sendSignal('SIGKILL')) {
        finish(new Error('AWF did not exit within the live fixture cleanup deadline'));
      }
    }, graceMs + terminateMs);
    const finish = (error) => {
      clearTimeout(terminate);
      clearTimeout(kill);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = (cause) => {
      const error = mcpFailure('host-kill-failed');
      mcpFailures.get(error).code = cause?.code;
      finish(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function reportFailure(_error, stage) {
  const safeStage = Object.values(FAILURE_STAGES).includes(stage) ? stage : 'unknown stage';
  console.error(
    `Live enclave acceptance failed during ${safeStage}; raw error details were suppressed. `
    + 'Review AWF_ENCLAVE_ACCEPTANCE_CHECK, AWF_HOST_STARTUP_DIAGNOSTIC and AWF_PRIMARY_VM_READINESS records above.',
  );
  process.exitCode = 1;
}

if (require.main === module) {
  const failureContext = { stage: FAILURE_STAGES.RUNNER };
  main(failureContext).catch((error) => reportFailure(error, failureContext.stage));
}

module.exports = {
  GATEWAY_CONTAINER,
  GATEWAY_IMAGE,
  emitStartupDiagnostic,
  startupEvidence,
  prepareReleaseArtifacts,
  prepareAcceptanceArtifacts,
  releaseTag,
  removeGatewayFixture,
  spawnAwf,
  startGatewayFixture,
  waitForVmCleanup,
  waitForPrimaryVmReadiness,
  readPrimaryVmProgress,
  verifyPrimaryVmIdentity,
  startupDiagnostic,
  startupSnapshot,
  waitForBroker,
  waitForHostGatewayReadiness,
  failedSpawns,
  removePrivateAwfLogs,
  stopAwf,
  reportFailure,
  trackAwfChild,
  assertNoVmResidue,
  RELEASE_ASSETS,
  assertReleaseAssets,
  assertUnifiedProfiles,
  makeConfig,
  toAwfConfig,
  assertProfileTools,
  assertProfileInitialize,
  captureContainerLogs,
  assertNoSentinelLeak,
  assertExpectedToolResult,
  assertRecoveredInvocation,
  assertNoSuccessfulResult,
  killAwfForRecovery,
  withCrashRecoveryCleanup,
  buildAgentGuestProbe,
  buildAgentEnospcProbe,
  buildConstantObjectSchema,
  buildEnospcProbeScript,
  buildOomProbeScript,
  buildScriptGuestProbe,
  parsePublicToolResult,
  assertCanonicalToolError,
  acceptanceCheck,
  observeInvocationRecords,
  resourceRecords,
  readRecoveredInvocation,
  readCrashRecoveryBaseline,
  resourceDiscoveryEvidence,
  waitForInvocationRecord,
  waitForInvocationOutcome,
  requestMcp,
};
