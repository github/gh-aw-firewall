import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEnclaveInformationBudgetLedger } from './information-budget';
import { parseEnclaveDynamicDelegationControlEndpoint } from './dynamic-delegation-handoff';
import { typedDynamicEnclavePolicyFixture } from './dynamic-policy.test-utils';
import {
  DELEGATION_CHANNEL_VERSION,
  parseDelegationAdmissionRequest,
  parseDelegationSettlement,
} from './dynamic-delegation-protocol';
import { DynamicDelegationService } from './dynamic-delegation-service';
import { startDynamicDelegationChannel } from './dynamic-delegation-channel';

/* eslint-disable @typescript-eslint/no-require-imports */
const nativeFs = require('fs');
const containersRoot = path.join(__dirname, '..', '..', 'containers');
const {
  createDynamicDelegationClient,
} = require(path.join(containersRoot, 'enclave', 'mcp-server', 'delegation-channel.js'));
const {
  finiteSchemaHash,
} = require(path.join(containersRoot, 'bounded-execution', 'schema-hash.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const ENDPOINT = parseEnclaveDynamicDelegationControlEndpoint(
  'http://127.0.0.1:8090/internal/awf-enclave-mcp-control/github-repository-delegation-v1',
)!;

describe('dynamic delegation channel protocol parsing', () => {
  it('accepts a well-formed admission request', () => {
    expect(parseDelegationAdmissionRequest({
      version: 1,
      invocationId: 'a'.repeat(24),
      selector: 'octo-org/service',
      schemaHash: 'b'.repeat(64),
    })).toMatchObject({ selector: 'octo-org/service' });
  });

  it('forwards a malformed selector unchanged so the registry can deny it uniformly', () => {
    expect(parseDelegationAdmissionRequest({
      version: 1,
      invocationId: 'a'.repeat(24),
      selector: 'Octo-Org/Service',
      schemaHash: 'b'.repeat(64),
    })).toMatchObject({ selector: 'Octo-Org/Service' });
  });

  it.each([
    ['a version mismatch', { version: 2 }],
    ['a non-broker invocation id', { invocationId: '../escape' }],
    ['a missing schema hash', { schemaHash: undefined }],
    ['a truncated schema hash', { schemaHash: 'b'.repeat(63) }],
    ['an oversized selector', { selector: 'o'.repeat(300) }],
  ])('rejects %s', (_label, overrides) => {
    expect(parseDelegationAdmissionRequest({
      version: 1,
      invocationId: 'a'.repeat(24),
      selector: 'octo-org/service',
      schemaHash: 'b'.repeat(64),
      ...overrides,
    })).toBeUndefined();
  });

  it.each([
    ['an unknown outcome', { outcome: 'partially-ok' }],
    ['negative output bytes', { outputBytes: -1 }],
    ['fractional execution seconds', { executionSeconds: 1.5 }],
  ])('rejects a settlement with %s', (_label, overrides) => {
    expect(parseDelegationSettlement({
      version: 1,
      invocationId: 'a'.repeat(24),
      outcome: 'success',
      outputBytes: 1,
      executionSeconds: 1,
      ...overrides,
    })).toBeUndefined();
  });
});

describe('dynamic delegation channel end to end', () => {
  let directory: string;
  let auditPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-delegation-channel-'));
    auditPath = path.join(directory, '..', `${path.basename(directory)}-audit.jsonl`);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(auditPath, { force: true });
  });

  function buildService(clientOverrides: Record<string, unknown> = {}) {
    const created = { count: 0 };
    const client = {
      async status() {
        return {
          recoveryIncomplete: false,
          generation: 1,
          liveIdentityCount: 0,
          labelledHandles: [] as string[],
        };
      },
      async reconcile() { /* reconciled */ },
      async revoke() { /* revoked */ },
      async revokeByLabels() { return 0; },
      async createOrConfirm(request: Record<string, unknown>) {
        created.count += 1;
        return {
          handle: `dlg_${created.count}`,
          executorBearer: `dlgbearer_${created.count}`,
          repository: request.repository as string,
          toolPolicy: 'github-repository-read-v1',
          tools: ['issue_read', 'list_issues'],
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
      ...clientOverrides,
    };
    return new DynamicDelegationService({
      policy: typedDynamicEnclavePolicyFixture(),
      identity: { runId: '42-1', entryId: 'agent' },
      handoff: { endpoint: ENDPOINT, capability: 'c'.repeat(64) },
      ledger: createEnclaveInformationBudgetLedger(new Map()),
      auditPath,
      client: client as never,
      clock: { nowMs: () => 0, sleep: async () => undefined },
      jitter: () => 0,
    });
  }

  function brokerClient() {
    return createDynamicDelegationClient(
      { dynamicChannelDir: directory, dynamicSensitivity: 'confidential' },
      { pollIntervalMs: 1, admissionTimeoutMs: 2_000, settlementTimeoutMs: 2_000 },
    );
  }

  it('admits, executes, and settles one invocation across the private channel', async () => {
    const service = buildService();
    await service.recover();
    const channel = startDynamicDelegationChannel({ directory, service, pollIntervalMs: 1 });
    const broker = brokerClient();
    try {
      const admitted = await broker.admit({
        invocationId: 'abc123abc123abc1',
        selector: 'octo-org/service',
        schema: { type: 'boolean' },
      });
      expect(admitted).toMatchObject({
        admitted: true,
        repo: 'octo-org/service',
        executorBearer: 'dlgbearer_1',
        readMode: 'live',
        sensitivity: 'confidential',
      });
      const receipt = await broker.settle({
        invocationId: 'abc123abc123abc1',
        outcome: 'success',
        outputBytes: 32,
        executionSeconds: 2,
      });
      expect(receipt).toEqual({ settled: true, revoked: true });
      expect(service.quotaUsage.outputBytes).toMatchObject({ debited: 32, reserved: 0 });
    } finally {
      await channel.stop();
    }
  });

  it('sends the canonical finite-schema hash for the invocation', async () => {
    const service = buildService();
    await service.recover();
    const broker = brokerClient();
    const schema = { type: 'object', properties: { b: { type: 'boolean' }, a: { type: 'boolean' } } };
    const pending = broker.admit({
      invocationId: 'def456def456def4',
      selector: 'octo-org/service',
      schema,
    });
    // Read the request document before the host consumes it.
    let raw: string | undefined;
    for (let attempt = 0; attempt < 200 && raw === undefined; attempt += 1) {
      try {
        raw = fs.readFileSync(path.join(directory, 'def456def456def4.admit.json'), 'utf8');
      } catch {
        await new Promise((resolve) => { setTimeout(resolve, 1); });
      }
    }
    expect(JSON.parse(raw!)).toMatchObject({
      version: DELEGATION_CHANNEL_VERSION,
      schemaHash: finiteSchemaHash(schema),
    });
    // Key order must not change the hash.
    expect(finiteSchemaHash({
      type: 'object',
      properties: { a: { type: 'boolean' }, b: { type: 'boolean' } },
    })).toBe(finiteSchemaHash(schema));

    const channel = startDynamicDelegationChannel({ directory, service, pollIntervalMs: 1 });
    try {
      await expect(pending).resolves.toMatchObject({ admitted: true });
    } finally {
      await channel.stop();
    }
  });

  it('publishes broker messages for the host channel owner', async () => {
    const service = buildService();
    await service.recover();
    const broker = brokerClient();
    const owner = fs.statSync(directory);
    const chown = jest.spyOn(nativeFs, 'chownSync').mockImplementation(() => undefined);
    const pending = broker.admit({
      invocationId: 'fed456fed456fed4',
      selector: 'octo-org/service',
      schema: { type: 'boolean' },
    });
    const requestPath = path.join(directory, 'fed456fed456fed4.admit.json');
    try {
      for (let attempt = 0; attempt < 200 && !fs.existsSync(requestPath); attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 1); });
      }
      expect(chown).toHaveBeenCalledWith(`${requestPath}.tmp`, owner.uid, owner.gid);

      const channel = startDynamicDelegationChannel({ directory, service, pollIntervalMs: 1 });
      try {
        await expect(pending).resolves.toMatchObject({ admitted: true });
      } finally {
        await channel.stop();
      }
    } finally {
      chown.mockRestore();
    }
  });

  it('never writes the control endpoint, capability, or identity handle to the channel', async () => {
    const service = buildService();
    await service.recover();
    const channel = startDynamicDelegationChannel({ directory, service, pollIntervalMs: 1 });
    const broker = brokerClient();
    try {
      await broker.admit({
        invocationId: 'aaa111aaa111aaa1',
        selector: 'octo-org/service',
        schema: { type: 'boolean' },
      });
      const written = fs.readdirSync(directory)
        .map((entry) => fs.readFileSync(path.join(directory, entry), 'utf8'))
        .join('\n');
      expect(written).not.toContain('c'.repeat(64));
      expect(written).not.toContain('127.0.0.1');
      expect(written).not.toContain('dlg_1"');
      expect(written).not.toContain('/internal/awf-enclave-mcp-control');
    } finally {
      await channel.stop();
    }
  });

  it('fails closed when the host never answers', async () => {
    const broker = createDynamicDelegationClient(
      { dynamicChannelDir: directory, dynamicSensitivity: 'confidential' },
      { pollIntervalMs: 1, admissionTimeoutMs: 30, settlementTimeoutMs: 30 },
    );
    await expect(broker.admit({
      invocationId: 'bbb222bbb222bbb2',
      selector: 'octo-org/service',
      schema: { type: 'boolean' },
    })).resolves.toEqual({ admitted: false });
    await expect(broker.settle({
      invocationId: 'bbb222bbb222bbb2',
      outcome: 'success',
      outputBytes: 0,
      executionSeconds: 0,
    })).resolves.toEqual({ settled: false, revoked: false });
  });

  it('reports an unresolved revocation so the broker cannot report success', async () => {
    const service = buildService({
      async revoke() {
        throw new Error('control plane down');
      },
    });
    await service.recover();
    const channel = startDynamicDelegationChannel({ directory, service, pollIntervalMs: 1 });
    const broker = brokerClient();
    try {
      await broker.admit({
        invocationId: 'ccc333ccc333ccc3',
        selector: 'octo-org/service',
        schema: { type: 'boolean' },
      });
      await expect(broker.settle({
        invocationId: 'ccc333ccc333ccc3',
        outcome: 'success',
        outputBytes: 1,
        executionSeconds: 1,
      })).resolves.toEqual({ settled: true, revoked: false });
    } finally {
      await channel.stop();
    }
  });

  it('rejects a response bound to a different invocation', async () => {
    const broker = createDynamicDelegationClient(
      { dynamicChannelDir: directory, dynamicSensitivity: 'confidential' },
      { pollIntervalMs: 1, admissionTimeoutMs: 500, settlementTimeoutMs: 500 },
    );
    const pending = broker.admit({
      invocationId: 'ddd444ddd444ddd4',
      selector: 'octo-org/service',
      schema: { type: 'boolean' },
    });
    fs.writeFileSync(path.join(directory, 'ddd444ddd444ddd4.admitted.json'), JSON.stringify({
      version: DELEGATION_CHANNEL_VERSION,
      invocationId: 'eee555eee555eee5',
      admitted: true,
      repository: 'octo-org/service',
      executorBearer: 'dlgbearer_x',
      expiresAt: new Date().toISOString(),
      readMode: 'live',
    }));
    await expect(pending).resolves.toEqual({ admitted: false });
  });

  it('rejects a response bound to a different repository than the selector', async () => {
    const broker = createDynamicDelegationClient(
      { dynamicChannelDir: directory, dynamicSensitivity: 'confidential' },
      { pollIntervalMs: 1, admissionTimeoutMs: 500, settlementTimeoutMs: 500 },
    );
    const pending = broker.admit({
      invocationId: 'fff666fff666fff6',
      selector: 'octo-org/service',
      schema: { type: 'boolean' },
    });
    fs.writeFileSync(path.join(directory, 'fff666fff666fff6.admitted.json'), JSON.stringify({
      version: DELEGATION_CHANNEL_VERSION,
      invocationId: 'fff666fff666fff6',
      admitted: true,
      repository: 'octo-org/sibling',
      executorBearer: 'dlgbearer_x',
      expiresAt: new Date().toISOString(),
      readMode: 'live',
    }));
    await expect(pending).resolves.toEqual({ admitted: false });
  });

  it('discards an oversized channel document rather than parsing it', async () => {
    const service = buildService();
    await service.recover();
    fs.writeFileSync(
      path.join(directory, '0123456789abcdef.admit.json'),
      JSON.stringify({ pad: 'x'.repeat(16 * 1024) }),
    );
    const channel = startDynamicDelegationChannel({ directory, service, pollIntervalMs: 1 });
    try {
      await channel.poll();
      expect(fs.existsSync(path.join(directory, '0123456789abcdef.admitted.json'))).toBe(false);
    } finally {
      await channel.stop();
    }
  });

  it('creates the channel directory owner-only', async () => {
    const nested = path.join(directory, 'nested');
    const service = buildService();
    const channel = startDynamicDelegationChannel({ directory: nested, service, pollIntervalMs: 1 });
    try {
      expect(fs.statSync(nested).mode & 0o777).toBe(0o700);
    } finally {
      await channel.stop();
    }
  });
});
