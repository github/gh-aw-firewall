import * as http from 'http';
import * as https from 'https';
import { gatewayTransportCode, type GatewayCode } from './startup-progress';
import { readGatewayReadinessResponse } from './gateway-readiness';

export interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

export class GatewayReadinessError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly code: GatewayCode = 'unknown',
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'GatewayReadinessError';
    this.httpStatus = httpStatus !== null && Number.isInteger(httpStatus)
      && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  }
}

export function postJsonRpc(
  endpoint: URL,
  body: Record<string, unknown>,
  timeoutMs: number,
  gatewayApiKey: string,
  sessionId?: string,
): Promise<{ response: JsonRpcResponse; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const resolveBounded = (value: { response: JsonRpcResponse; sessionId?: string }): void => {
      clearTimeout(deadlineTimer);
      resolve(value);
    };
    const rejectBounded = (error: Error): void => {
      clearTimeout(deadlineTimer);
      reject(error);
    };
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const transport = endpoint.protocol === 'https:' ? https : http;
    const request = transport.request(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'content-length': String(payload.length),
        authorization: gatewayApiKey,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      timeout: timeoutMs,
    }, (response) => {
      void readGatewayReadinessResponse(response, request, {
        framing: () => new GatewayReadinessError(
          'Gateway readiness response exceeded its framing bound', false, 'response-too-large',
        ),
        response: error => new GatewayReadinessError(
          'Gateway readiness transport failed', false, gatewayTransportCode(error),
        ),
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
                return new GatewayReadinessError(
                  'Gateway backend is not yet available',
                  true,
                  'backend-unavailable',
                  503,
                );
              }
            } catch {
              // The response is permanent unless it matches the documented recovery shape.
            }
          }
          return new GatewayReadinessError(
            'Gateway readiness request failed', false,
            status === 401 || status === 403 ? 'http-auth' : 'http-status',
            status,
          );
        },
      }, 256 * 1024).then(({ response: readinessResponse, raw }) => {
        try {
          const contentType = String(readinessResponse.headers['content-type'] ?? '');
          const events = raw
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .filter((line) => line !== '' && line !== '[DONE]');
          const jsonText = contentType.includes('text/event-stream')
            ? events[events.length - 1]
            : raw;
          const parsed = !jsonText ? {} : JSON.parse(jsonText) as JsonRpcResponse;
          if (body.id !== undefined && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
            rejectBounded(new GatewayReadinessError(
              'Gateway readiness response was not a JSON-RPC object', false, 'malformed-protocol',
            ));
            return;
          }
          const returnedSession = readinessResponse.headers['mcp-session-id'];
          resolveBounded({
            response: parsed,
            sessionId: typeof returnedSession === 'string' ? returnedSession : sessionId,
          });
        } catch {
          rejectBounded(new GatewayReadinessError(
            'Gateway readiness response was not bounded JSON',
            false, 'malformed-json',
          ));
        }
      }).catch(rejectBounded);
    });
    request.on('timeout', () => request.destroy(
      new GatewayReadinessError('Gateway readiness request timed out', false, 'request-timeout'),
    ));
    request.on('error', (error) => rejectBounded(
      error instanceof GatewayReadinessError ? error : new GatewayReadinessError(
        'Gateway readiness transport failed', false, gatewayTransportCode(error),
      ),
    ));
    const deadlineTimer = setTimeout(() => request.destroy(
      new GatewayReadinessError('Gateway readiness request timed out', false, 'request-timeout'),
    ), timeoutMs);
    request.end(payload);
  });
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'undefined';
}

export function canonicalToolSet(value: unknown): string {
  if (!Array.isArray(value)) return 'invalid';
  const names = value.map((tool) => (
    tool && typeof tool === 'object' ? (tool as Record<string, unknown>).name : undefined
  ));
  if (
    names.some((name) => typeof name !== 'string')
    || new Set(names).size !== names.length
  ) {
    return 'invalid';
  }
  return canonicalJson([...value].sort((left, right) => (
    String((left as Record<string, unknown>).name)
      .localeCompare(String((right as Record<string, unknown>).name))
  )));
}
