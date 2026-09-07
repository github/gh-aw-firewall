import * as http from 'http';
import {
  ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT_ENV,
  isValidEnclaveDynamicDelegationControlEndpoint,
} from './dynamic-registry';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface McpgCreateOrConfirmRequest {
  run_id: string;
  backend: string;
  entry_id: string;
  invocation_id: string;
  repository: string;
  policy: 'github-repository-read-v1';
  tools: ['list_issues', 'issue_read'];
  schema_hash: string;
  requested_ttl_seconds: number;
  invocation_expires_at: string;
  idempotency_key: string;
  admitted_default_branch_sha?: string;
}

export interface McpgDelegation {
  handle: string;
  executor_bearer: string;
  repository: string;
  policy: string;
  tools: string[];
  expires_at: string;
  admitted_default_branch_sha?: string;
}

export interface McpgControlClientOptions {
  endpoint: string;
  capability: string;
  timeoutMs?: number;
}

export class McpgControlClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpgControlClientError';
  }
}

function boundedString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new McpgControlClientError(`mcpg response field ${name} is invalid`);
  }
  return value;
}

function parseDelegation(value: unknown, request: McpgCreateOrConfirmRequest): McpgDelegation {
  if (!value || typeof value !== 'object') {
    throw new McpgControlClientError('mcpg create-or-confirm response is invalid');
  }
  const response = value as Record<string, unknown>;
  const delegation: McpgDelegation = {
    handle: boundedString(response.handle, 'handle'),
    executor_bearer: boundedString(response.executor_bearer, 'executor_bearer'),
    repository: boundedString(response.repository, 'repository'),
    policy: boundedString(response.policy, 'policy'),
    tools: Array.isArray(response.tools)
      ? response.tools.map((tool) => boundedString(tool, 'tools'))
      : [],
    expires_at: boundedString(response.expires_at, 'expires_at'),
    ...(response.admitted_default_branch_sha === undefined
      ? {}
      : { admitted_default_branch_sha: boundedString(response.admitted_default_branch_sha, 'admitted_default_branch_sha') }),
  };
  if (
    delegation.repository !== request.repository
    || delegation.policy !== request.policy
    || JSON.stringify(delegation.tools) !== JSON.stringify(request.tools)
    || (request.admitted_default_branch_sha !== undefined
      && delegation.admitted_default_branch_sha !== request.admitted_default_branch_sha)
    || Date.parse(delegation.expires_at) > Math.min(
      Date.parse(request.invocation_expires_at),
      Date.now() + request.requested_ttl_seconds * 1000,
    )
  ) {
    throw new McpgControlClientError('mcpg create-or-confirm response does not match the request binding');
  }
  return delegation;
}

function requestJson(
  endpoint: URL,
  capability: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const target = new URL(endpoint.toString());
    target.pathname = `${target.pathname.replace(/\/$/, '')}${path}`;
    const request = http.request(target, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + capability,
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
      timeout: timeoutMs,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new McpgControlClientError('mcpg response exceeded its framing bound'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        if (response.statusCode !== 200 && response.statusCode !== 201) {
          reject(new McpgControlClientError('mcpg control request failed'));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new McpgControlClientError('mcpg control response is not valid JSON'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new McpgControlClientError('mcpg control request timed out')));
    request.on('error', error => reject(error instanceof McpgControlClientError
      ? error
      : new McpgControlClientError('mcpg control request failed')));
    request.end(payload);
  });
}

export class McpgControlClient {
  private readonly endpoint: URL;
  private readonly capability: string;
  private readonly timeoutMs: number;

  constructor(options: McpgControlClientOptions) {
    if (!isValidEnclaveDynamicDelegationControlEndpoint(options.endpoint)) {
      throw new McpgControlClientError(
        `${ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT_ENV} must be a loopback HTTP endpoint`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(options.capability)) {
      throw new McpgControlClientError('dynamic delegation control capability is invalid');
    }
    this.endpoint = new URL(options.endpoint);
    this.capability = options.capability;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async createOrConfirm(request: McpgCreateOrConfirmRequest): Promise<McpgDelegation> {
    const response = await requestJson(
      this.endpoint,
      this.capability,
      '/create-or-confirm',
      request as unknown as Record<string, unknown>,
      this.timeoutMs,
    );
    return parseDelegation(response, request);
  }

  status(labels: Record<string, string>): Promise<unknown> {
    return requestJson(this.endpoint, this.capability, '/status', { labels }, this.timeoutMs);
  }

  reconcile(labels: Record<string, string>): Promise<unknown> {
    return requestJson(this.endpoint, this.capability, '/reconcile', { labels }, this.timeoutMs);
  }

  revoke(handle: string): Promise<unknown> {
    return requestJson(this.endpoint, this.capability, '/revoke', { handle }, this.timeoutMs);
  }

  revokeByLabels(labels: Record<string, string>): Promise<unknown> {
    return requestJson(this.endpoint, this.capability, '/revoke-by-labels', { labels }, this.timeoutMs);
  }
}
