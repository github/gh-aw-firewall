import * as http from 'http';
import type { WrapperConfig } from '../types';
import type { EnclaveGithubGatewayContract } from './github-gateway-contract';
import {
  assertAgentNetworkMembership,
  assertSharedGatewayAttachment,
} from './github-gateway-network';
import { readGatewayReadinessResponse } from './gateway-readiness';
import { getStaticGithubExecutorCapability } from './static-github-handoff';

const MCP_PROTOCOL_VERSION = '2025-06-18';
export const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 5_000;
export const RETRY_DELAY_MS = 500;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class GithubGatewayReadinessError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

export function postJsonRpc(
  endpoint: URL,
  agentId: string,
  message: Record<string, unknown>,
  sessionId?: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ body: JsonRpcResponse; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const rejectBounded = (error: Error): void => {
      clearTimeout(deadlineTimer);
      reject(error);
    };
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const request = http.request(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: agentId,
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      timeout: timeoutMs,
    }, response => {
      void readGatewayReadinessResponse(response, request, {
        framing: () => new GithubGatewayReadinessError(
          'Shared MCP gateway response exceeded its framing bound',
        ),
        response: error => error,
        status: (status, raw) => {
          if (status === 503) {
            try {
              const unavailable = JSON.parse(raw) as {
                error?: unknown;
                retryable?: unknown;
              };
              if (
                unavailable.error === 'backend_unavailable'
                && unavailable.retryable !== false
              ) {
                return new GithubGatewayReadinessError(
                  'Shared MCP gateway backend is not yet available',
                  true,
                );
              }
            } catch {
              // Treat every undocumented response shape as a terminal failure.
            }
          }
          return new GithubGatewayReadinessError('Shared MCP gateway request failed');
        },
      }, MAX_RESPONSE_BYTES).then(({ response: readinessResponse, raw }) => {
        try {
          const contentType = String(readinessResponse.headers['content-type'] ?? '');
          const events = raw
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())
            .filter(line => line !== '' && line !== '[DONE]');
          const jsonText = contentType.includes('text/event-stream')
            ? events[events.length - 1]
            : raw;
          const returnedSession = readinessResponse.headers['mcp-session-id'];
          clearTimeout(deadlineTimer);
          resolve({
            body: !jsonText ? {} : JSON.parse(jsonText) as JsonRpcResponse,
            sessionId: typeof returnedSession === 'string' ? returnedSession : sessionId,
          });
        } catch {
          rejectBounded(new GithubGatewayReadinessError(
            'Shared MCP gateway returned invalid bounded JSON',
          ));
        }
      }).catch(rejectBounded);
    });
    request.on('timeout', () => request.destroy(
      new GithubGatewayReadinessError('Shared MCP gateway request timed out'),
    ));
    request.on('error', rejectBounded);
    const deadlineTimer = setTimeout(() => request.destroy(
      new GithubGatewayReadinessError('Shared MCP gateway request timed out'),
    ), timeoutMs);
    request.end(payload);
  });
}

export async function proveGithubGatewayReadiness(
  config: WrapperConfig,
  contract: EnclaveGithubGatewayContract,
  deadline: number,
): Promise<void> {
  const requestBudget = (): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GithubGatewayReadinessError('Readiness deadline expired');
    return Math.min(REQUEST_TIMEOUT_MS, remaining);
  };
  await assertAgentNetworkMembership(contract);
  await assertSharedGatewayAttachment(contract);
  if (contract.mode === 'dynamic' || contract.agentId === undefined) {
    // A dynamic entry has no static identity to authenticate a readiness
    // session with: every identity is minted per invocation through the
    // private control channel, after the primary agent has already started.
    // Topology and attachment are still proven exactly as for the static
    // profile; tool exposure is enforced by the delegated identity itself.
    return;
  }
  const scoped = getStaticGithubExecutorCapability(config);
  const agentId = scoped ? scoped.bearer : contract.agentId;
  const initialized = await postJsonRpc(contract.endpoint, agentId, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'awf-enclave-readiness', version: '1.0.0' },
    },
  }, undefined, requestBudget());
  if (
    initialized.body.error !== undefined
    || initialized.body.id !== 1
    || !initialized.sessionId
  ) {
    throw new Error('Shared MCP gateway rejected the enclave identity');
  }
  await postJsonRpc(contract.endpoint, agentId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  }, initialized.sessionId, requestBudget());
  const tools = await listAllGithubGatewayTools(
    contract,
    agentId,
    initialized.sessionId,
    requestBudget,
  );
  if (JSON.stringify(tools) !== JSON.stringify(contract.allowedTools)) {
    throw new Error('Shared MCP gateway did not expose exactly the configured allowed tools');
  }
}

/** Bounds `tools/list` pagination so a misbehaving gateway cannot stall readiness. */
const MAX_TOOLS_LIST_PAGES = 20;

/**
 * Consumes every `tools/list` page (MCP 2025-06-18 permits `nextCursor`) and
 * rejects the whole response if any page errors, is malformed, or contains a
 * malformed tool entry, so a partially valid first page can never mask extra
 * or invalid tools advertised elsewhere in the pagination.
 */
async function listAllGithubGatewayTools(
  contract: EnclaveGithubGatewayContract,
  agentId: string,
  sessionId: string,
  requestBudget: () => number,
): Promise<string[]> {
  const tools: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_TOOLS_LIST_PAGES) {
      throw new Error('Shared MCP gateway returned too many tools/list pages');
    }
    const listed = await postJsonRpc(contract.endpoint, agentId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: cursor === undefined ? {} : { cursor },
    }, sessionId, requestBudget());
    if (listed.body.error !== undefined) {
      throw new Error('Shared MCP gateway rejected the tools/list request');
    }
    const result = listed.body.result;
    if (
      !result
      || typeof result !== 'object'
      || !('tools' in result)
      || !Array.isArray(result.tools)
    ) {
      throw new Error('Shared MCP gateway returned a malformed tools/list response');
    }
    for (const tool of result.tools) {
      if (
        !tool
        || typeof tool !== 'object'
        || !('name' in tool)
        || typeof tool.name !== 'string'
        || tool.name === ''
      ) {
        throw new Error('Shared MCP gateway returned a malformed tools/list entry');
      }
      tools.push(tool.name);
    }
    const nextCursor = 'nextCursor' in result ? result.nextCursor : undefined;
    if (nextCursor === undefined) break;
    if (typeof nextCursor !== 'string' || nextCursor === '') {
      throw new Error('Shared MCP gateway returned a malformed tools/list nextCursor');
    }
    cursor = nextCursor;
  }
  return tools.sort();
}
