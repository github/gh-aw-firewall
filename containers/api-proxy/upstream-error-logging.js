'use strict';

const { redactCredentialError } = require('./credential-protection');
const {
  createLogRequestCompletion,
  createLogUpstreamAuthError,
  createLogUpstreamErrorResponse,
} = require('./upstream-log');
const { parseModelNotSupportedFromBody } = require('./upstream-error-classification');
const { auditTrack, auditUpstreamErrorResponse } = require('./token-persistence');

function extractRequestModel(body) {
  if (!body || body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (parsed && typeof parsed.model === 'string') return parsed.model;
  } catch { /* non-JSON body */ }
  return null;
}

/** Maximum number of request tool names echoed into an error diagnostic. */
const MAX_LOGGED_TOOL_NAMES = 32;

function extractToolName(tool) {
  if (!tool || typeof tool !== 'object') return null;
  // OpenAI/Copilot chat-completions shape: { type: 'function', function: { name } }
  if (tool.function && typeof tool.function === 'object' && typeof tool.function.name === 'string') {
    const name = tool.function.name.trim();
    return name.length > 0 ? name : null;
  }
  // Responses API and Anthropic shape: { type: 'function'|..., name }
  if (typeof tool.name === 'string') {
    const name = tool.name.trim();
    return name.length > 0 ? name : null;
  }
  return null;
}

/**
 * Summarise the tool surface of a request body so a zero-token upstream 400 can
 * be correlated with the tool definitions the agent sent (e.g. an MCP server
 * that failed to list tools).  Only tool *names* and counts are captured — no
 * tool descriptions, schemas, or message content.
 *
 * @param {Buffer} body
 * @returns {{tool_count: number, tool_names: string[], unnamed_tool_count: number}|null}
 */
function summarizeRequestTools(body) {
  if (!body || body.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.tools)) return null;
  const names = [];
  let unnamed = 0;
  for (const tool of parsed.tools) {
    const name = extractToolName(tool);
    if (name === null) unnamed += 1;
    else if (names.length < MAX_LOGGED_TOOL_NAMES) names.push(name);
  }
  return { tool_count: parsed.tools.length, tool_names: names, unnamed_tool_count: unnamed };
}

function createUpstreamResponseLogging({
  metrics,
  logRequest,
  sanitizeForLog,
  otel,
  handleRequestError,
  applyMaxRunsInvocation,
  applyPermissionDenied,
}) {
  const logRequestCompletion = createLogRequestCompletion({
    metrics,
    logRequest,
    sanitizeForLog,
    applyMaxRunsInvocation,
  });

  const logUpstreamAuthError = createLogUpstreamAuthError({
    logRequest,
    sanitizeForLog,
    applyPermissionDenied,
    parseModelNotSupportedFromBody,
  });
  const logUpstreamErrorResponse = createLogUpstreamErrorResponse({
    logRequest,
    sanitizeForLog,
    auditTrack: (event, fields) => {
      if (event === 'UPSTREAM_ERROR_RESPONSE') {
        auditUpstreamErrorResponse(fields);
      } else {
        auditTrack(event, fields);
      }
    },
  });

  function handleResponseStreamError(err, {
    res, requestId, provider, req, targetHost, startTime, span,
  }) {
    const cancellation = req.awfUpstreamCancellation;
    if (cancellation?.cancelled) return;
    if (cancellation) cancellation.finalized = true;
    err = redactCredentialError(req, err);
    req.awfEnclaveModelBudgetAttempt?.settleMissing();
    otel.endSpanError(span, err, 502);
    handleRequestError(err, {
      res, requestId, provider, req, targetHost, startTime,
      statusCode: 502, clientMessage: 'Response stream error',
      onHeadersSent: () => {
        if (typeof res.destroy === 'function') res.destroy(err);
      },
    });
  }

  return {
    logRequestCompletion,
    logUpstreamAuthError,
    logUpstreamErrorResponse,
    handleResponseStreamError,
  };
}

module.exports = {
  createUpstreamResponseLogging,
  extractRequestModel,
  summarizeRequestTools,
};
