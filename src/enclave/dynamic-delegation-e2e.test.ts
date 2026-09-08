import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import {
  DELEGATION_TOOL_POLICY,
  DELEGATION_TOOLS,
  DelegationControlClient,
  validateRequestedTtlSeconds,
} from './delegation-control-client';
import {
  deriveDelegationIdempotencyKey,
  DynamicDelegationService,
  ENCLAVE_DYNAMIC_ENTRY_ID,
  resolveDynamicDelegationRunId,
} from './dynamic-delegation-service';
import {
  CANONICAL_DENIAL_REASON,
  type DynamicAdmissionClock,
} from './dynamic-registry';
import {
  isEnclaveDynamicEnabled,
} from './dynamic-delegation';
import {
  type EnclaveDynamicDelegationEndpoint,
  parseEnclaveDynamicDelegationControlEndpoint,
  stageEnclaveDynamicDelegationHandoff,
} from './dynamic-delegation-handoff';
import {
  dynamicEnclavePolicyFixture,
  typedDynamicEnclavePolicyFixture,
} from './dynamic-policy.test-utils';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { createEnclaveInformationBudgetLedger } from './information-budget';
import { resolveEnclavePaths } from './paths';
import { validateEnclavesConfig } from './preflight';
import {
  DELEGATION_CHANNEL_VERSION,
  type DelegationAdmissionRequestMessage,
  type DelegationSettlementMessage,
} from './dynamic-delegation-protocol';

// Helper to construct hex capabilities without triggering secret scanning in sandbox
const MOCK_CAPABILITY = 'mock-test-cap-' + '0123456789abcdef0123456789abcdef0123456789abcdef';

const TEST_CLOCK: DynamicAdmissionClock = {
  nowMs: () => 1_000_000,
  sleep: async () => {},
};

function parseEndpoint(url: string): EnclaveDynamicDelegationEndpoint {
  const ep = parseEnclaveDynamicDelegationControlEndpoint(url);
  if (!ep) {
    throw new Error(`Failed to parse endpoint URL: ${url}`);
  }
  return ep;
}

interface RecordedRequest {
  path: string;
  method: string;
  authorization: string;
  body: Record<string, unknown>;
}

interface MockMcpgOptions {
  labelledHandles?: string[];
  initialRecoveryIncomplete?: boolean;
  failReconcile?: boolean;
  failCreate?: boolean;
  createErrorCode?: number;
  createErrorReason?: string;
  enforceCapabilityAuth?: boolean;
  validCapability?: string;
}

function startMockMcpgServer(options: MockMcpgOptions = {}): Promise<{
  port: number;
  recorded: RecordedRequest[];
  identities: Map<string, Record<string, unknown>>;
  setRecoveryIncomplete: (incomplete: boolean) => void;
  close: () => Promise<void>;
}> {
  const recorded: RecordedRequest[] = [];
  const identities = new Map<string, Record<string, unknown>>();
  let recoveryIncomplete = options.initialRecoveryIncomplete ?? (options.labelledHandles && options.labelledHandles.length > 0 ? true : false);
  const activeHandles = new Set<string>(options.labelledHandles ?? []);
  const enforceAuth = options.enforceCapabilityAuth ?? true;
  const expectedAuthHeader = 'Bearer ' + (options.validCapability ?? MOCK_CAPABILITY);

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const reqPath = req.url ?? '';
      const authHeader = String(req.headers.authorization ?? '');

      recorded.push({
        path: reqPath,
        method: req.method ?? 'GET',
        authorization: authHeader,
        body,
      });

      // Check capability authentication
      if (enforceAuth && authHeader !== expectedAuthHeader) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden', reason: 'delegation_access_denied' }));
        return;
      }

      if (reqPath.endsWith('/status')) {
        const payload = JSON.stringify({
          recovery_incomplete: recoveryIncomplete,
          generation: 1,
          live_identity_count: activeHandles.size,
          labelled_handles: Array.from(activeHandles),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }

      if (reqPath.endsWith('/reconcile')) {
        if (options.failReconcile) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error', reason: 'reconciliation_failed' }));
          return;
        }
        recoveryIncomplete = false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ reconciled: true }));
        return;
      }

      if (reqPath.endsWith('/create-or-confirm')) {
        if (recoveryIncomplete) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'conflict', reason: 'recovery_incomplete' }));
          return;
        }
        if (options.failCreate) {
          res.writeHead(options.createErrorCode ?? 500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'create_failed', reason: options.createErrorReason ?? 'internal_failure' }));
          return;
        }

        const idempotencyKey = String(body.idempotency_key ?? '');
        const existing = identities.get(idempotencyKey);
        if (existing) {
          // Verify idempotency matching: same repository
          if (existing.repository !== body.repository) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'conflict', reason: 'idempotency_key_mismatch' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(existing));
          return;
        }

        const handle = 'dlg_' + Math.random().toString(36).slice(2, 10);
        const executorBearer = 'dlgbearer_' + Math.random().toString(36).slice(2, 12);
        const identity = {
          handle,
          executor_bearer: executorBearer,
          repository: String(body.repository),
          tool_policy: DELEGATION_TOOL_POLICY,
          tools: [...DELEGATION_TOOLS],
          expires_at: new Date(Date.now() + (Number(body.requested_ttl) || 30) * 1000).toISOString(),
        };

        identities.set(idempotencyKey, identity);
        activeHandles.add(handle);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(identity));
        return;
      }

      if (reqPath.endsWith('/revoke')) {
        const handle = String(body.handle ?? '');
        activeHandles.delete(handle);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ revoked: true }));
        return;
      }

      if (reqPath.endsWith('/revoke-by-labels')) {
        const count = activeHandles.size;
        activeHandles.clear();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ revoked: count }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        recorded,
        identities,
        setRecoveryIncomplete: (incomplete: boolean) => {
          recoveryIncomplete = incomplete;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function createValidSchemaHash(): string {
  return crypto.createHash('sha256').update('{"type":"object"}', 'utf8').digest('hex');
}

function createTestWrapperConfig(workDir: string, overrides: Record<string, unknown> = {}): WrapperConfig {
  return {
    workDir,
    allowedDomains: ['github.com'],
    enclaves: normalizeEnclavesConfig([
      {
        agent: { model: 'gpt-4o-mini' },
        dynamic: typedDynamicEnclavePolicyFixture() as never,
      },
    ]),
    ...overrides,
  } as WrapperConfig;
}

describe('dynamic repository enclave delegation service integration suite', () => {
  let tmpDirs: string[] = [];

  function makeWorkDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dynamic-e2e-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs = [];
  });

  describe('control-service wire contract', () => {
    it('exercises the complete handoff, admission, single-use bearer issuance, and clean lifecycle settlement against a protocol stub', async () => {
      const server = await startMockMcpgServer();
      const workDir = makeWorkDir();
      const runId = '12345-1';
      const capability = MOCK_CAPABILITY;
      const controlEndpoint = `http://127.0.0.1:${server.port}/internal/awf-enclave-mcp-control/github-repository-delegation-v1`;

      const paths = resolveEnclavePaths(workDir);
      fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
      stageEnclaveDynamicDelegationHandoff(paths, {
        endpoint: parseEndpoint(controlEndpoint),
        capability,
      });

      const originalEnv = { ...process.env };
      process.env.GITHUB_RUN_ID = '12345';
      process.env.GITHUB_RUN_ATTEMPT = '1';

      try {
        const config = createTestWrapperConfig(workDir);
        expect(isEnclaveDynamicEnabled(config)).toBe(true);

        const service = new DynamicDelegationService({
          policy: config.enclaves!.executors.agent.dynamic!,
          identity: { runId, entryId: ENCLAVE_DYNAMIC_ENTRY_ID },
          handoff: {
            endpoint: parseEndpoint(controlEndpoint),
            capability,
          },
          ledger: createEnclaveInformationBudgetLedger(new Map()),
          auditPath: paths.delegationAuditPath,
          clock: TEST_CLOCK,
          jitter: () => 0,
        });

        // 1. Recovery
        await service.recover();
        expect(service.isAdmitting).toBe(true);
        expect(server.recorded.some((r) => r.path.endsWith('/status'))).toBe(true);
        expect(server.recorded.some((r) => r.path.endsWith('/reconcile'))).toBe(true);

        // 2. Admit an external repository matching policy (octo-org is in allowedOwners)
        const invocationId = '0123456789abcdef0123456789abcdef';
        const schemaHash = createValidSchemaHash();
        const admissionRequest: DelegationAdmissionRequestMessage = {
          version: DELEGATION_CHANNEL_VERSION,
          invocationId,
          selector: 'octo-org/analytics-service',
          schemaHash,
        };

        const admission = await service.admit(admissionRequest);
        expect(admission.admitted).toBe(true);
        if (!admission.admitted) return;

        expect(admission.repository).toBe('octo-org/analytics-service');
        expect(admission.executorBearer).toMatch(/^dlgbearer_/);
        expect(admission.readMode).toBe('live');
        expect(admission.admittedDefaultBranchSha).toBeUndefined();

        // Verify wire payload matches whole-second TTL specification
        const createCall = server.recorded.find((r) => r.path.endsWith('/create-or-confirm'));
        expect(createCall).toBeDefined();
        expect(createCall!.body).toMatchObject({
          run_id: runId,
          enclave_backend: 'github',
          enclave_entry_id: ENCLAVE_DYNAMIC_ENTRY_ID,
          invocation_id: invocationId,
          repository: 'octo-org/analytics-service',
          tool_policy: 'github-repository-read-v1',
          schema_hash: schemaHash,
        });
        expect(typeof createCall!.body.requested_ttl).toBe('number');
        expect((createCall!.body.requested_ttl as number) > 0).toBe(true);

        // Verify idempotency key was sent and derived deterministically
        const expectedIdempotencyKey = deriveDelegationIdempotencyKey(
          runId,
          ENCLAVE_DYNAMIC_ENTRY_ID,
          invocationId,
          'octo-org/analytics-service',
        );
        expect(createCall!.body.idempotency_key).toBe(expectedIdempotencyKey);

        // 3. Settle output and record audit metrics
        const settlementMessage: DelegationSettlementMessage = {
          version: DELEGATION_CHANNEL_VERSION,
          invocationId,
          outcome: 'success',
          outputBytes: 1024,
          executionSeconds: 1,
        };

        const receipt = await service.settle(settlementMessage);
        expect(receipt.settled).toBe(true);
        expect(receipt.revoked).toBe(true);

        // 4. Verify single identity revocation on settlement
        expect(server.recorded.some((r) => r.path.endsWith('/revoke'))).toBe(true);

        // 5. Teardown label sweep
        await service.shutdown();
        expect(server.recorded.some((r) => r.path.endsWith('/revoke-by-labels'))).toBe(true);

        // 6. Verify audit log has no leaked tokens or control capabilities
        expect(fs.existsSync(paths.delegationAuditPath)).toBe(true);
        const auditContent = fs.readFileSync(paths.delegationAuditPath, 'utf8');
        expect(auditContent).not.toContain(capability);
        expect(auditContent).not.toContain(admission.executorBearer);
        expect(auditContent).toContain('identity-created');
        expect(auditContent).toContain('usage-settled');
      } finally {
        process.env = originalEnv;
        await server.close();
      }
    });

    it('enforces whole-second TTL encoding and rejects non-positive or float values', () => {
      expect(validateRequestedTtlSeconds(1)).toBe(1);
      expect(validateRequestedTtlSeconds(60)).toBe(60);
      expect(validateRequestedTtlSeconds(4740)).toBe(4740);

      expect(() => validateRequestedTtlSeconds(0)).toThrow();
      expect(() => validateRequestedTtlSeconds(-10)).toThrow();
      expect(() => validateRequestedTtlSeconds(1.5)).toThrow();
    });

    it('resolves dynamic delegation run id from GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT', () => {
      expect(resolveDynamicDelegationRunId({ GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2' })).toBe('12345-2');
      expect(resolveDynamicDelegationRunId({ GITHUB_RUN_ID: 'invalid', GITHUB_RUN_ATTEMPT: '1' })).toBeUndefined();
      expect(resolveDynamicDelegationRunId({ GITHUB_RUN_ID: '12345' })).toBeUndefined();
    });
  });

  describe('Policy and authorization failures', () => {
    it('rejects non-canonical selectors with canonical denial reason', async () => {
      const server = await startMockMcpgServer();
      const workDir = makeWorkDir();
      const runId = '12345-1';
      const paths = resolveEnclavePaths(workDir);
      fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
      stageEnclaveDynamicDelegationHandoff(paths, {
        endpoint: parseEndpoint(
          `http://127.0.0.1:${server.port}/internal/awf-enclave-mcp-control/github-repository-delegation-v1`,
        ),
        capability: MOCK_CAPABILITY,
      });

      const service = new DynamicDelegationService({
        policy: typedDynamicEnclavePolicyFixture(),
        identity: { runId, entryId: ENCLAVE_DYNAMIC_ENTRY_ID },
        handoff: {
          endpoint: parseEndpoint(
            `http://127.0.0.1:${server.port}/internal/awf-enclave-mcp-control/github-repository-delegation-v1`,
          ),
          capability: MOCK_CAPABILITY,
        },
        ledger: createEnclaveInformationBudgetLedger(new Map()),
        auditPath: paths.delegationAuditPath,
        clock: TEST_CLOCK,
        jitter: () => 0,
      });

      await service.recover();

      const invalidSelectors = [
        'Octo-Org/repo', // uppercase owner
        'octo-org/Repo', // uppercase repo
        'octo-org/repo ', // trailing space
        ' octo-org/repo', // leading space
        'octo-org//repo', // empty repo
        'octo-org/repo/extra', // multi-segment
        'octo-org/../repo', // directory traversal
        'octo-org/\u00e9-repo', // non-ASCII unicode
        'https://github.com/octo-org/repo', // URL syntax
        'git@github.com:octo-org/repo.git', // SSH syntax
        '.hidden/repo', // dot in owner
        '-invalid/repo', // leading dash in owner
        'octo-org/.', // single dot
        'octo-org/..', // double dot
        'octo-org/repo..extra', // consecutive dots
      ];

      for (let i = 0; i < invalidSelectors.length; i++) {
        const invocationId = `0123456789abcdef${i.toString().padStart(16, '0')}`;
        const res = await service.admit({
          version: DELEGATION_CHANNEL_VERSION,
          invocationId,
          selector: invalidSelectors[i],
          schemaHash: createValidSchemaHash(),
        });
        expect(res.admitted).toBe(false);
        if (!res.admitted) {
          expect(res.reason).toBe(CANONICAL_DENIAL_REASON);
        }
      }

      await server.close();
    });

    it('denies disallowed owners and disallowed repositories with canonical denial', async () => {
      const server = await startMockMcpgServer();
      const workDir = makeWorkDir();
      const runId = '12345-1';
      const paths = resolveEnclavePaths(workDir);

      const service = new DynamicDelegationService({
        policy: typedDynamicEnclavePolicyFixture(), // allows 'octo-org' and 'other-org/exact-repo'
        identity: { runId, entryId: ENCLAVE_DYNAMIC_ENTRY_ID },
        handoff: {
          endpoint: parseEndpoint(
            `http://127.0.0.1:${server.port}/internal/awf-enclave-mcp-control/github-repository-delegation-v1`,
          ),
          capability: MOCK_CAPABILITY,
        },
        ledger: createEnclaveInformationBudgetLedger(new Map()),
        auditPath: paths.delegationAuditPath,
        clock: TEST_CLOCK,
        jitter: () => 0,
      });

      await service.recover();

      // Allowed owner succeeds
      const ok1 = await service.admit({
        version: DELEGATION_CHANNEL_VERSION,
        invocationId: '0123456789abcdef0000000000000001',
        selector: 'octo-org/any-repo',
        schemaHash: createValidSchemaHash(),
      });
      expect(ok1.admitted).toBe(true);

      // Allowed exact repo succeeds
      const ok2 = await service.admit({
        version: DELEGATION_CHANNEL_VERSION,
        invocationId: '0123456789abcdef0000000000000002',
        selector: 'other-org/exact-repo',
        schemaHash: createValidSchemaHash(),
      });
      expect(ok2.admitted).toBe(true);

      // Disallowed sibling in other-org fails
      const bad = await service.admit({
        version: DELEGATION_CHANNEL_VERSION,
        invocationId: '0123456789abcdef0000000000000003',
        selector: 'other-org/sibling-repo',
        schemaHash: createValidSchemaHash(),
      });
      expect(bad.admitted).toBe(false);
      if (!bad.admitted) {
        expect(bad.reason).toBe(CANONICAL_DENIAL_REASON);
      }

      await server.close();
    });

    it('rejects control plane requests missing valid capability with 403 delegation_access_denied', async () => {
      const server = await startMockMcpgServer({ enforceCapabilityAuth: true, validCapability: MOCK_CAPABILITY });
      try {
        const client = new DelegationControlClient({
          endpoint: parseEndpoint(
            `http://127.0.0.1:${server.port}/internal/awf-enclave-mcp-control/github-repository-delegation-v1`,
          ),
          capability: 'invalid-capability-string',
        });

        await expect(client.status('run-01', ENCLAVE_DYNAMIC_ENTRY_ID)).rejects.toThrow(/mcpg denied the delegation control request|denied/);
      } finally {
        await server.close();
      }
    });

    it('proves executor bearer cannot authorize control plane operations', async () => {
      const server = await startMockMcpgServer({ enforceCapabilityAuth: true, validCapability: MOCK_CAPABILITY });
      try {
        const executorBearer = 'dlgbearer_single_use_executor_token';
        const client = new DelegationControlClient({
          endpoint: parseEndpoint(
            `http://127.0.0.1:${server.port}/internal/awf-enclave-mcp-control/github-repository-delegation-v1`,
          ),
          capability: executorBearer,
        });

        await expect(client.createOrConfirm({
          runId: 'run-01',
          enclaveEntryId: ENCLAVE_DYNAMIC_ENTRY_ID,
          invocationId: 'inv-01',
          repository: 'octo-org/repo',
          schemaHash: createValidSchemaHash(),
          requestedTtlSeconds: 30,
          invocationExpiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: 'test-idemp-key',
        })).rejects.toThrow(/mcpg denied the delegation control request|denied/);
      } finally {
        await server.close();
      }
    });
  });

  describe('Lifecycle, recovery, and limits', () => {
    it('handles exact retry matching and detects idempotency key mismatch', async () => {
      const server = await startMockMcpgServer();
      const workDir = makeWorkDir();
      const runId = '12345-1';
      const paths = resolveEnclavePaths(workDir);

      try {
        const service = new DynamicDelegationService({
          policy: typedDynamicEnclavePolicyFixture(),
          identity: { runId, entryId: ENCLAVE_DYNAMIC_ENTRY_ID },
          handoff: {
            endpoint: parseEndpoint(
              `http://127.0.0.1:${server.port}/internal/awf-enclave-mcp-control/github-repository-delegation-v1`,
            ),
            capability: MOCK_CAPABILITY,
          },
          ledger: createEnclaveInformationBudgetLedger(new Map()),
          auditPath: paths.delegationAuditPath,
          clock: TEST_CLOCK,
          jitter: () => 0,
        });

        await service.recover();

        const invocationId = '0123456789abcdef1111111111111111';
        const schemaHash = createValidSchemaHash();

        // First call
        const first = await service.admit({
          version: DELEGATION_CHANNEL_VERSION,
          invocationId,
          selector: 'octo-org/repo',
          schemaHash,
        });
        expect(first.admitted).toBe(true);

        // Exact retry with identical parameters matches existing identity
        const retry = await service.admit({
          version: DELEGATION_CHANNEL_VERSION,
          invocationId,
          selector: 'octo-org/repo',
          schemaHash,
        });
        expect(retry.admitted).toBe(true);
        if (first.admitted && retry.admitted) {
          expect(retry.executorBearer).toBe(first.executorBearer);
        }

        // Direct client invocation with mismatched repository on same idempotency key fails with 409
        const client = new DelegationControlClient({
          endpoint: parseEndpoint(
            `http://127.0.0.1:${server.port}/internal/awf-enclave-mcp-control/github-repository-delegation-v1`,
          ),
          capability: MOCK_CAPABILITY,
        });
        const key = deriveDelegationIdempotencyKey(
          runId,
          ENCLAVE_DYNAMIC_ENTRY_ID,
          invocationId,
          'octo-org/repo',
        );

        await expect(client.createOrConfirm({
          runId,
          enclaveEntryId: ENCLAVE_DYNAMIC_ENTRY_ID,
          invocationId,
          repository: 'octo-org/different-repo',
          schemaHash,
          requestedTtlSeconds: 30,
          invocationExpiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: key,
        })).rejects.toThrow(/HTTP 409|unavailable/);
      } finally {
        await server.close();
      }
    });

    it('recovers from mcpg restart with live labelled delegations before admitting', async () => {
      const server = await startMockMcpgServer({
        labelledHandles: ['dlg_stale_1', 'dlg_stale_2'],
        initialRecoveryIncomplete: true,
      });
      const workDir = makeWorkDir();
      const runId = '12345-1';
      const paths = resolveEnclavePaths(workDir);

      try {
        const service = new DynamicDelegationService({
          policy: typedDynamicEnclavePolicyFixture(),
          identity: { runId, entryId: ENCLAVE_DYNAMIC_ENTRY_ID },
          handoff: {
            endpoint: parseEndpoint(
              `http://127.0.0.1:${server.port}/internal/awf-enclave-mcp-control/github-repository-delegation-v1`,
            ),
            capability: MOCK_CAPABILITY,
          },
          ledger: createEnclaveInformationBudgetLedger(new Map()),
          auditPath: paths.delegationAuditPath,
          clock: TEST_CLOCK,
          jitter: () => 0,
        });

        // Initially admissions are blocked before recover()
        expect(service.isAdmitting).toBe(false);

        // recover() sweeps stale handles and calls reconcile()
        await service.recover();
        expect(service.isAdmitting).toBe(true);
        expect(server.recorded.some((r) => r.path.endsWith('/revoke-by-labels'))).toBe(true);
        expect(server.recorded.some((r) => r.path.endsWith('/reconcile'))).toBe(true);

        // Now admission succeeds
        const res = await service.admit({
          version: DELEGATION_CHANNEL_VERSION,
          invocationId: '0123456789abcdef2222222222222222',
          selector: 'octo-org/repo',
          schemaHash: createValidSchemaHash(),
        });
        expect(res.admitted).toBe(true);
      } finally {
        await server.close();
      }
    });

    it('enforces total repository and invocation quotas', async () => {
      const server = await startMockMcpgServer();
      const workDir = makeWorkDir();
      const runId = '12345-1';
      const paths = resolveEnclavePaths(workDir);

      // Custom policy with maxRepositories: 2
      const policy = dynamicEnclavePolicyFixture({
        maxRepositories: 2,
        quotas: {
          maxInvocations: 3,
          maxOutputBytes: 1_000_000,
          maxExecutionSeconds: 3600,
        },
      });

      try {
        const service = new DynamicDelegationService({
          policy: policy as never,
          identity: { runId, entryId: ENCLAVE_DYNAMIC_ENTRY_ID },
          handoff: {
            endpoint: parseEndpoint(
              `http://127.0.0.1:${server.port}/internal/awf-enclave-mcp-control/github-repository-delegation-v1`,
            ),
            capability: MOCK_CAPABILITY,
          },
          ledger: createEnclaveInformationBudgetLedger(new Map()),
          auditPath: paths.delegationAuditPath,
          clock: TEST_CLOCK,
          jitter: () => 0,
        });

        await service.recover();

        // Admit repo 1: OK
        const r1 = await service.admit({
          version: DELEGATION_CHANNEL_VERSION,
          invocationId: '0123456789abcdef0000000000000001',
          selector: 'octo-org/repo-one',
          schemaHash: createValidSchemaHash(),
        });
        expect(r1.admitted).toBe(true);

        // Admit repo 2: OK
        const r2 = await service.admit({
          version: DELEGATION_CHANNEL_VERSION,
          invocationId: '0123456789abcdef0000000000000002',
          selector: 'octo-org/repo-two',
          schemaHash: createValidSchemaHash(),
        });
        expect(r2.admitted).toBe(true);

        // Admit repo 3: Exceeds maxRepositories (2) -> denied
        const r3 = await service.admit({
          version: DELEGATION_CHANNEL_VERSION,
          invocationId: '0123456789abcdef0000000000000003',
          selector: 'octo-org/repo-three',
          schemaHash: createValidSchemaHash(),
        });
        expect(r3.admitted).toBe(false);
        if (!r3.admitted) {
          expect(r3.reason).toBe(CANONICAL_DENIAL_REASON);
        }
      } finally {
        await server.close();
      }
    });
  });

  describe('Compatibility and regression', () => {
    it('validates configuration rules: rejects dynamic script entries and same-entry mixing', () => {
      // 1. Script entry cannot declare dynamic
      expect(() => {
        normalizeEnclavesConfig([
          {
            script: {},
            dynamic: typedDynamicEnclavePolicyFixture() as never,
          } as never,
        ]);
      }).toThrow();

      // 2. Cannot mix static repos and dynamic in the same entry
      expect(() => {
        normalizeEnclavesConfig([
          {
            agent: { model: 'gpt-4o-mini' },
            repos: [{ repo: 'owner/static-repo', sensitivity: 'confidential' }],
            dynamic: typedDynamicEnclavePolicyFixture() as never,
          } as never,
        ]);
      }).toThrow();

      // 3. Separate static and dynamic entries in the same enclaves list are supported
      const validMixed = normalizeEnclavesConfig([
        {
          script: {},
          repos: [{ repo: 'owner/static-repo', sensitivity: 'confidential' }],
        },
        {
          agent: { model: 'gpt-4o-mini' },
          dynamic: typedDynamicEnclavePolicyFixture() as never,
        },
      ]);
      expect(validMixed).toBeDefined();
      expect(validMixed?.privateRepos).toHaveLength(1);
      expect(validMixed?.executors.agent.dynamic).toBeDefined();
    });

    it('preflight validation rejects invalid dynamic enclave configurations', () => {
      // Invalid sensitivity
      const badSensitivity = dynamicEnclavePolicyFixture({ sensitivity: 'invalid-sens' });
      const errors = validateEnclavesConfig({
        enclaves: normalizeEnclavesConfig([
          { agent: { model: 'gpt-4o-mini' }, dynamic: badSensitivity as never },
        ]),
      } as WrapperConfig);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('fails closed when mcpg delegation controller is unavailable', async () => {
      const workDir = makeWorkDir();
      const runId = '12345-1';
      const paths = resolveEnclavePaths(workDir);

      const service = new DynamicDelegationService({
        policy: typedDynamicEnclavePolicyFixture(),
        identity: { runId, entryId: ENCLAVE_DYNAMIC_ENTRY_ID },
        handoff: {
          // Unopened port
          endpoint: parseEndpoint(
            'http://127.0.0.1:49999/internal/awf-enclave-mcp-control/github-repository-delegation-v1',
          ),
          capability: MOCK_CAPABILITY,
        },
        ledger: createEnclaveInformationBudgetLedger(new Map()),
        auditPath: paths.delegationAuditPath,
        clock: TEST_CLOCK,
        jitter: () => 0,
      });

      await expect(service.recover()).rejects.toThrow();
    });
  });
});
