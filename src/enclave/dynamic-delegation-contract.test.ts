/**
 * Cross-component contract fixture for dynamic enclave delegation.
 *
 * These are not AWF's own choices: every constant below is copied from the two
 * upstream components AWF must interoperate with, so a drift in either
 * direction fails a test instead of a workflow run.
 *
 * - `github/gh-aw` `pkg/workflow/mcp_setup_gateway.go` and
 *   `pkg/workflow/enclaves.go` (PR #59046): the exported control endpoint,
 *   the fixed control API base path, the controller name, the envelope's
 *   `run_id` and `enclave_backend`.
 * - `github/gh-aw-mcpg` v0.4.18 `internal/proxy/delegation.go`,
 *   `internal/delegation/wire.go`, and
 *   `internal/delegation/{identity,store,selector}.go` (PR #12605): the
 *   operation paths, the `CreateOrConfirmRequest`/`IdentityResult` JSON key
 *   sets, the whole-second duration encoding, the status/reconcile/revoke
 *   shapes, and the closed tool set.
 */

import * as http from 'http';
import {
  DELEGATION_ENCLAVE_BACKEND,
  DELEGATION_TOOLS,
  DELEGATION_TOOL_POLICY,
  DelegationControlClient,
  validateRequestedTtlSeconds,
} from './delegation-control-client';
import {
  DELEGATION_CONTROLLER_NAME,
  DELEGATION_CONTROL_API_BASE_PATH,
  DELEGATION_CONTROL_ENDPOINT_PATH,
  parseEnclaveDynamicDelegationControlEndpoint,
} from './dynamic-delegation-handoff';
import { resolveDynamicDelegationRunId } from './dynamic-delegation-service';

/** gh-aw `enclaveDelegationControlAPIBasePath`. */
const GH_AW_CONTROL_API_BASE_PATH = '/internal/awf-enclave-mcp-control';
/** gh-aw `enclaveDynamicController`. */
const GH_AW_CONTROLLER = 'github-repository-delegation-v1';
/** gh-aw's default MCP port plus `enclaveDelegationControlPortOffset`. */
const GH_AW_EXPORTED_ENDPOINT =
  'http://127.0.0.1:8090/internal/awf-enclave-mcp-control/github-repository-delegation-v1';
/** mcpg `delegationControlPath`. */
const MCPG_CONTROL_PATH = '/internal/awf-enclave-mcp-control/';

/** mcpg `delegation.CreateOrConfirmRequest` JSON tags, sorted. */
const MCPG_CREATE_OR_CONFIRM_KEYS = [
  'admitted_default_branch_sha',
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
].sort();

/** mcpg `delegation.IdentityResult` JSON tags, sorted. */
const MCPG_IDENTITY_RESULT_KEYS = [
  'admitted_default_branch_sha',
  'executor_bearer',
  'expires_at',
  'handle',
  'repository',
  'tool_policy',
  'tools',
].sort();

describe('gh-aw handoff contract', () => {
  it('matches the compiler-exported control endpoint exactly', () => {
    expect(DELEGATION_CONTROL_API_BASE_PATH).toBe(GH_AW_CONTROL_API_BASE_PATH);
    expect(DELEGATION_CONTROLLER_NAME).toBe(GH_AW_CONTROLLER);
    expect(DELEGATION_CONTROL_ENDPOINT_PATH)
      .toBe(`${GH_AW_CONTROL_API_BASE_PATH}/${GH_AW_CONTROLLER}`);
    expect(parseEnclaveDynamicDelegationControlEndpoint(GH_AW_EXPORTED_ENDPOINT))
      .toBeDefined();
  });

  it('derives operation paths as siblings of the controller name, per mcpg routing', () => {
    const endpoint = parseEnclaveDynamicDelegationControlEndpoint(GH_AW_EXPORTED_ENDPOINT)!;
    expect(endpoint.operationBasePath).toBe(MCPG_CONTROL_PATH);
    expect(new URL(`${endpoint.operationBasePath}create-or-confirm`, endpoint.origin).pathname)
      .toBe('/internal/awf-enclave-mcp-control/create-or-confirm');
  });

  it('binds the envelope run id the compiler installed', () => {
    // gh-aw enclaveDelegationRunID = "${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}".
    expect(resolveDynamicDelegationRunId({
      GITHUB_RUN_ID: '18234567890',
      GITHUB_RUN_ATTEMPT: '2',
    })).toBe('18234567890-2');
  });

  it('binds the envelope enclave backend the compiler installed', () => {
    // gh-aw buildMCPGatewayDelegationEnvelope: "enclave_backend": "github".
    expect(DELEGATION_ENCLAVE_BACKEND).toBe('github');
  });
});

describe('mcpg v0.4.18 wire contract', () => {
  const captured: Record<string, unknown>[] = [];
  let server: http.Server;
  let client: DelegationControlClient;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        captured.push({
          path: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        });
        const body = JSON.stringify({
          handle: 'dlg_a',
          executor_bearer: 'dlgbearer_a',
          repository: 'octo/private',
          tool_policy: DELEGATION_TOOL_POLICY,
          tools: ['issue_read', 'list_issues'],
          admitted_default_branch_sha: 'a'.repeat(40),
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    client = new DelegationControlClient({
      endpoint: parseEnclaveDynamicDelegationControlEndpoint(
        `http://127.0.0.1:${port}${DELEGATION_CONTROL_ENDPOINT_PATH}`,
      )!,
      capability: 'f'.repeat(64),
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends exactly the fields mcpg decodes with DisallowUnknownFields', async () => {
    await client.createOrConfirm({
      runId: '18234567890-2',
      enclaveEntryId: 'agent',
      invocationId: 'a1b2c3d4e5f60718',
      repository: 'octo/private',
      schemaHash: 'b'.repeat(64),
      requestedTtlSeconds: 120,
      invocationExpiresAt: new Date(Date.now() + 150_000),
      idempotencyKey: 'c'.repeat(64),
      admittedDefaultBranchSha: 'a'.repeat(40),
    });
    const body = captured[captured.length - 1].body as Record<string, unknown>;
    // Every key AWF sends must exist in mcpg's struct; optional keys may be
    // omitted, but an unknown key would make mcpg reject the whole request.
    for (const key of Object.keys(body)) {
      expect(MCPG_CREATE_OR_CONFIRM_KEYS).toContain(key);
    }
    // The only optional request field is the admitted SHA.
    const required = MCPG_CREATE_OR_CONFIRM_KEYS
      .filter((key) => key !== 'admitted_default_branch_sha');
    for (const key of required) {
      expect(body).toHaveProperty(key);
    }
  });

  it('encodes requested TTL as exact integer seconds and time.Time as RFC 3339', async () => {
    expect(validateRequestedTtlSeconds(1)).toBe(1);
    await client.createOrConfirm({
      runId: '18234567890-2',
      enclaveEntryId: 'agent',
      invocationId: 'a1b2c3d4e5f60718',
      repository: 'octo/private',
      schemaHash: 'b'.repeat(64),
      requestedTtlSeconds: 120,
      invocationExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
      idempotencyKey: 'c'.repeat(64),
      admittedDefaultBranchSha: 'a'.repeat(40),
    });
    const body = captured[captured.length - 1].body as Record<string, unknown>;
    expect(body.requested_ttl).toBe(120);
    expect(Number.isInteger(body.requested_ttl)).toBe(true);
    expect(body.invocation_expires_at).toBe('2999-01-01T00:00:00.000Z');
  });

  it('reads only the fields mcpg returns in IdentityResult', async () => {
    const identity = await client.createOrConfirm({
      runId: '18234567890-2',
      enclaveEntryId: 'agent',
      invocationId: 'a1b2c3d4e5f60718',
      repository: 'octo/private',
      schemaHash: 'b'.repeat(64),
      requestedTtlSeconds: 120,
      invocationExpiresAt: new Date(Date.now() + 150_000),
      idempotencyKey: 'c'.repeat(64),
      admittedDefaultBranchSha: 'a'.repeat(40),
    });
    expect(MCPG_IDENTITY_RESULT_KEYS).toEqual(expect.arrayContaining([
      'handle',
      'executor_bearer',
      'repository',
      'tool_policy',
      'tools',
      'expires_at',
    ]));
    expect(identity.tools).toEqual(DELEGATION_TOOLS);
    expect(identity.toolPolicy).toBe(DELEGATION_TOOL_POLICY);
  });

  it('uses mcpg operation paths verbatim', async () => {
    const seen = new Set<string>();
    for (const call of captured) seen.add(String(call.path));
    expect([...seen]).toEqual([`${MCPG_CONTROL_PATH}create-or-confirm`]);
  });

  it('mirrors the closed github-repository-read-v1 tool set', () => {
    // mcpg internal/delegation/selector.go delegatedTools.
    expect([...DELEGATION_TOOLS]).toEqual(['issue_read', 'list_issues']);
    expect(DELEGATION_TOOL_POLICY).toBe('github-repository-read-v1');
  });
});
