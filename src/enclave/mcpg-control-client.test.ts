import * as http from 'http';
import {
  McpgControlClient,
  McpgControlClientError,
} from './mcpg-control-client';

const capability = 'a'.repeat(64);
const request = {
  run_id: 'run',
  backend: 'awf-enclave',
  entry_id: 'entry',
  invocation_id: 'invocation',
  repository: 'octo/private',
  policy: 'github-repository-read-v1' as const,
  tools: ['list_issues', 'issue_read'] as ['list_issues', 'issue_read'],
  schema_hash: 'schema',
  requested_ttl_seconds: 30,
  invocation_expires_at: new Date(Date.now() + 60_000).toISOString(),
  idempotency_key: 'idempotency',
};

describe('McpgControlClient', () => {
  it('authenticates control calls and strictly verifies create-or-confirm bindings', async () => {
    const server = http.createServer((incoming, response) => {
      expect(incoming.headers.authorization).toBe('Bearer ' + capability);
      let body = '';
      incoming.on('data', chunk => { body += chunk; });
      incoming.on('end', () => {
        expect(JSON.parse(body)).toEqual(request);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          handle: 'handle',
          executor_bearer: 'bearer',
          repository: request.repository,
          policy: request.policy,
          tools: request.tools,
          expires_at: new Date(Date.now() + 10_000).toISOString(),
        }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
      const client = new McpgControlClient({
        endpoint: `http://127.0.0.1:${address.port}`,
        capability,
      });
      await expect(client.createOrConfirm(request)).resolves.toMatchObject({
        handle: 'handle',
        executor_bearer: 'bearer',
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('rejects non-loopback endpoints and malformed capabilities', () => {
    expect(() => new McpgControlClient({
      endpoint: 'http://0.0.0.0:1234',
      capability,
    })).toThrow(McpgControlClientError);
    expect(() => new McpgControlClient({
      endpoint: 'http://127.0.0.1:1234',
      capability: 'not-a-capability',
    })).toThrow(McpgControlClientError);
  });
});
