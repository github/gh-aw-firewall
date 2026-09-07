import * as http from 'http';
import { AddressInfo } from 'net';
import {
  DELEGATION_TOOLS,
  DELEGATION_TOOL_POLICY,
  DelegationControlClient,
  DelegationControlError,
  validateRequestedTtlSeconds,
} from './delegation-control-client';
import { parseEnclaveDynamicDelegationControlEndpoint } from './dynamic-delegation-handoff';

const CAPABILITY = 'b'.repeat(64);
const CONTROL_PATH = '/internal/awf-enclave-mcp-control';

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string;
  contentType: string;
  body: unknown;
}

interface Responder {
  (request: CapturedRequest): { status: number; body: string; contentType?: string };
}

async function withControlServer(
  responder: Responder,
  run: (client: DelegationControlClient, captured: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const request: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: String(req.headers.authorization ?? ''),
        contentType: String(req.headers['content-type'] ?? ''),
        body: raw === '' ? undefined : JSON.parse(raw),
      };
      captured.push(request);
      const reply = responder(request);
      res.writeHead(reply.status, {
        'content-type': reply.contentType ?? 'application/json',
        'content-length': Buffer.byteLength(reply.body),
      });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const endpoint = parseEnclaveDynamicDelegationControlEndpoint(
    `http://127.0.0.1:${port}${CONTROL_PATH}/github-repository-delegation-v1`,
  )!;
  try {
    await run(new DelegationControlClient({ endpoint, capability: CAPABILITY }), captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const baseRequest = {
  runId: '42-1',
  enclaveEntryId: 'agent',
  invocationId: 'a1b2c3d4e5f60718',
  repository: 'octo/private',
  schemaHash: 'c'.repeat(64),
  requestedTtlSeconds: 120,
  invocationExpiresAt: new Date(Date.now() + 150_000),
  idempotencyKey: 'd'.repeat(64),
};

function identityBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    handle: 'dlg_1234',
    executor_bearer: 'dlgbearer_5678',
    repository: 'octo/private',
    tool_policy: DELEGATION_TOOL_POLICY,
    tools: ['issue_read', 'list_issues'],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
}

describe('mcpg delegation control wire contract', () => {
  it('posts create-or-confirm to the sibling operation path with the capability', async () => {
    await withControlServer(
      () => ({ status: 200, body: identityBody() }),
      async (client, captured) => {
        await client.createOrConfirm(baseRequest);
        expect(captured).toHaveLength(1);
        expect(captured[0].method).toBe('POST');
        expect(captured[0].url).toBe(`${CONTROL_PATH}/create-or-confirm`);
        expect(captured[0].authorization).toBe(`Bearer ${CAPABILITY}`);
        expect(captured[0].contentType).toBe('application/json');
      },
    );
  });

  it('encodes requested_ttl as an exact integer number of seconds', async () => {
    await withControlServer(
      () => ({ status: 200, body: identityBody() }),
      async (client, captured) => {
        await client.createOrConfirm(baseRequest);
        const body = captured[0].body as Record<string, unknown>;
        expect(body.requested_ttl).toBe(120);
        expect(Number.isInteger(body.requested_ttl)).toBe(true);
      },
    );
  });

  it('binds the exact envelope subset mcpg decodes with DisallowUnknownFields', async () => {
    await withControlServer(
      () => ({ status: 200, body: identityBody() }),
      async (client, captured) => {
        await client.createOrConfirm(baseRequest);
        expect(Object.keys(captured[0].body as object).sort()).toEqual([
          'enclave_backend',
          'enclave_entry_id',
          'idempotency_key',
          'invocation_expires_at',
          'invocation_id',
          'repository',
          'requested_ttl',
          'run_id',
          'schema_hash',
          'tool_policy',
        ]);
        expect(captured[0].body).toMatchObject({
          run_id: '42-1',
          enclave_backend: 'github',
          enclave_entry_id: 'agent',
          invocation_id: baseRequest.invocationId,
          repository: 'octo/private',
          tool_policy: DELEGATION_TOOL_POLICY,
          schema_hash: baseRequest.schemaHash,
          idempotency_key: baseRequest.idempotencyKey,
        });
      },
    );
  });

  it('omits admitted_default_branch_sha when AWF resolved no confined SHA', async () => {
    await withControlServer(
      () => ({ status: 200, body: identityBody() }),
      async (client, captured) => {
        await client.createOrConfirm(baseRequest);
        expect(captured[0].body).not.toHaveProperty('admitted_default_branch_sha');
      },
    );
  });

  it('binds a resolved SHA when one was admitted', async () => {
    const sha = 'e'.repeat(40);
    await withControlServer(
      () => ({ status: 200, body: identityBody({ admitted_default_branch_sha: sha }) }),
      async (client, captured) => {
        const identity = await client.createOrConfirm({
          ...baseRequest,
          admittedDefaultBranchSha: sha,
        });
        expect(captured[0].body).toMatchObject({ admitted_default_branch_sha: sha });
        expect(identity.admittedDefaultBranchSha).toBe(sha);
      },
    );
  });

  it.each([
    ['status', `${CONTROL_PATH}/status`],
    ['revoke-by-labels', `${CONTROL_PATH}/revoke-by-labels`],
  ])('sends the label pair for %s', async (operation, url) => {
    await withControlServer(
      () => ({
        status: 200,
        body: operation === 'status'
          ? JSON.stringify({
            recovery_incomplete: false,
            generation: 1,
            live_identity_count: 0,
            labelled_handles: [],
          })
          : JSON.stringify({ revoked: 0 }),
      }),
      async (client, captured) => {
        if (operation === 'status') await client.status('42-1', 'agent');
        else await client.revokeByLabels('42-1', 'agent');
        expect(captured[0].url).toBe(url);
        expect(captured[0].body).toEqual({ run_id: '42-1', enclave_entry_id: 'agent' });
      },
    );
  });

  it('sends an empty body for reconcile', async () => {
    await withControlServer(
      () => ({ status: 200, body: JSON.stringify({ reconciled: true }) }),
      async (client, captured) => {
        await client.reconcile();
        expect(captured[0].url).toBe(`${CONTROL_PATH}/reconcile`);
        expect(captured[0].body).toEqual({});
      },
    );
  });

  it('sends only the opaque handle for revoke', async () => {
    await withControlServer(
      () => ({ status: 200, body: JSON.stringify({ revoked: true }) }),
      async (client, captured) => {
        await client.revoke('dlg_1234');
        expect(captured[0].url).toBe(`${CONTROL_PATH}/revoke`);
        expect(captured[0].body).toEqual({ handle: 'dlg_1234' });
      },
    );
  });

  it('reads mcpg status exactly, tolerating a null handle list', async () => {
    await withControlServer(
      () => ({
        status: 200,
        body: JSON.stringify({
          recovery_incomplete: true,
          generation: 3,
          live_identity_count: 2,
          labelled_handles: null,
        }),
      }),
      async (client) => {
        await expect(client.status('42-1', 'agent')).resolves.toEqual({
          recoveryIncomplete: true,
          generation: 3,
          liveIdentityCount: 2,
          labelledHandles: [],
        });
      },
    );
  });
});

describe('mcpg delegation control response validation', () => {
  it.each([
    ['a missing handle', identityBody({ handle: '' })],
    ['a missing bearer', identityBody({ executor_bearer: '' })],
    ['a different repository', identityBody({ repository: 'octo/other' })],
    ['a different tool policy', identityBody({ tool_policy: 'github-repository-write-v1' })],
    ['a widened tool set', identityBody({ tools: ['issue_read', 'list_issues', 'create_issue'] })],
    ['a narrowed tool set', identityBody({ tools: ['issue_read'] })],
    ['an unrequested pinned SHA', identityBody({ admitted_default_branch_sha: 'f'.repeat(40) })],
    ['a missing expiry', identityBody({ expires_at: undefined })],
    ['an unparsable expiry', identityBody({ expires_at: 'never' })],
  ])('rejects %s as a contract violation', async (_label, body) => {
    await withControlServer(
      () => ({ status: 200, body }),
      async (client) => {
        await expect(client.createOrConfirm(baseRequest)).rejects.toMatchObject({
          kind: 'contract-violation',
        });
      },
    );
  });

  it('rejects an identity that outlives the invocation deadline', async () => {
    await withControlServer(
      () => ({
        status: 200,
        body: identityBody({ expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
      }),
      async (client) => {
        await expect(client.createOrConfirm(baseRequest)).rejects.toMatchObject({
          kind: 'contract-violation',
        });
      },
    );
  });

  it('rejects an identity that outlives the requested TTL', async () => {
    await withControlServer(
      () => ({
        status: 200,
        body: identityBody({ expires_at: new Date(Date.now() + 140_000).toISOString() }),
      }),
      async (client) => {
        await expect(client.createOrConfirm({ ...baseRequest, requestedTtlSeconds: 60 }))
          .rejects.toMatchObject({ kind: 'contract-violation' });
      },
    );
  });

  it('rejects a pinned SHA that differs from the admitted one', async () => {
    await withControlServer(
      () => ({ status: 200, body: identityBody({ admitted_default_branch_sha: 'f'.repeat(40) }) }),
      async (client) => {
        await expect(client.createOrConfirm({
          ...baseRequest,
          admittedDefaultBranchSha: 'e'.repeat(40),
        })).rejects.toMatchObject({ kind: 'contract-violation' });
      },
    );
  });

  it('rejects a non-JSON content type', async () => {
    await withControlServer(
      () => ({ status: 200, body: identityBody(), contentType: 'text/html' }),
      async (client) => {
        await expect(client.createOrConfirm(baseRequest)).rejects.toMatchObject({
          kind: 'contract-violation',
        });
      },
    );
  });

  it('rejects invalid JSON', async () => {
    await withControlServer(
      () => ({ status: 200, body: '{' }),
      async (client) => {
        await expect(client.createOrConfirm(baseRequest)).rejects.toMatchObject({
          kind: 'contract-violation',
        });
      },
    );
  });

  it('bounds the response body', async () => {
    await withControlServer(
      () => ({ status: 200, body: JSON.stringify({ pad: 'x'.repeat(200 * 1024) }) }),
      async (client) => {
        await expect(client.createOrConfirm(baseRequest)).rejects.toMatchObject({
          kind: 'contract-violation',
        });
      },
    );
  });

  it.each([
    [403, 'denied'],
    [400, 'malformed-request'],
    [404, 'unsupported'],
    [500, 'unavailable'],
    [502, 'unavailable'],
  ])('classifies HTTP %s as %s', async (status, kind) => {
    await withControlServer(
      () => ({ status, body: JSON.stringify({ error: 'x' }) }),
      async (client) => {
        await expect(client.createOrConfirm(baseRequest)).rejects.toMatchObject({ kind });
      },
    );
  });

  it('treats unresolved control state as requiring reconciliation', () => {
    expect(new DelegationControlError('unavailable', 'revoke', 'x').requiresReconciliation)
      .toBe(true);
    expect(new DelegationControlError('denied', 'create-or-confirm', 'x').requiresReconciliation)
      .toBe(false);
  });

  it.each([
    ['revoke', JSON.stringify({ revoked: false })],
    ['reconcile', JSON.stringify({ reconciled: false })],
  ])('rejects an unconfirmed %s', async (operation, body) => {
    await withControlServer(
      () => ({ status: 200, body }),
      async (client) => {
        const call = operation === 'revoke'
          ? client.revoke('dlg_1234')
          : client.reconcile();
        await expect(call).rejects.toMatchObject({ kind: 'contract-violation' });
      },
    );
  });

  it('exposes the closed v1 tool set', () => {
    expect(DELEGATION_TOOLS).toEqual(['issue_read', 'list_issues']);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'refuses invalid requested TTL value %s',
    (seconds) => {
      expect(() => validateRequestedTtlSeconds(seconds)).toThrow(DelegationControlError);
    },
  );
});
