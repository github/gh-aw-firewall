'use strict';

const http = require('http');
const { isDeepStrictEqual } = require('util');
const conformanceDiagnostics = require('../cloud-hypervisor-enclave-diagnostics');

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

function publicMcpFailureReason(error) {
  return mcpFailures.get(error)?.reason;
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

module.exports = {
  mcpFailures,
  mcpResponses,
  mcpResponseMetadata,
  mcpFailure,
  publicMcpFailureReason,
  acceptanceCheck,
  parsePublicToolResult,
  requestMcp,
  assertCanonicalToolError,
  assertExpectedToolResult,
  assertProfileInitialize,
  assertProfileTools,
};
