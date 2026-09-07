import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import { typedDynamicEnclavePolicyFixture } from './dynamic-policy.test-utils';
import { resolveEnclavePaths } from './paths';
import {
  resolveEnclaveDynamicDelegationHandoff,
  stageEnclaveDynamicDelegationHandoff,
} from './dynamic-delegation-handoff';
import {
  enclaveDynamicDelegationTestHelpers,
  isEnclaveDynamicEnabled,
  startEnclaveDynamicDelegation,
  stopEnclaveDynamicDelegation,
} from './dynamic-delegation';
import { DELEGATION_CHANNEL_VERSION } from './dynamic-delegation-protocol';

const CAPABILITY = 'a'.repeat(64);

interface Recorded {
  path: string;
  authorization: string;
  body: Record<string, unknown>;
}

function dynamicConfig(workDir: string): WrapperConfig {
  return {
    workDir,
    enclaves: normalizeEnclavesConfig([
      { agent: { model: 'gpt-test' }, dynamic: typedDynamicEnclavePolicyFixture() as never },
    ]),
  } as WrapperConfig;
}

async function startControlServer(
  labelledHandles: string[] = [],
): Promise<{ port: number; recorded: Recorded[]; close: () => Promise<void> }> {
  const recorded: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      recorded.push({
        path: req.url ?? '',
        authorization: String(req.headers.authorization ?? ''),
        body,
      });
      let payload = '{}';
      if ((req.url ?? '').endsWith('/status')) {
        payload = JSON.stringify({
          recovery_incomplete: labelledHandles.length > 0,
          generation: 1,
          live_identity_count: labelledHandles.length,
          labelled_handles: labelledHandles,
        });
      } else if ((req.url ?? '').endsWith('/reconcile')) {
        payload = JSON.stringify({ reconciled: true });
      } else if ((req.url ?? '').endsWith('/revoke-by-labels')) {
        payload = JSON.stringify({ revoked: labelledHandles.length });
      } else if ((req.url ?? '').endsWith('/revoke')) {
        payload = JSON.stringify({ revoked: true });
      } else if ((req.url ?? '').endsWith('/create-or-confirm')) {
        payload = JSON.stringify({
          handle: 'dlg_live',
          executor_bearer: 'dlgbearer_live',
          repository: body.repository,
          tool_policy: 'github-repository-read-v1',
          tools: ['issue_read', 'list_issues'],
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        });
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    recorded,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('dynamic delegation runtime', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dynamic-runtime-'));
    await enclaveDynamicDelegationTestHelpers.reset();
  });

  afterEach(async () => {
    await enclaveDynamicDelegationTestHelpers.reset();
    fs.rmSync(resolveEnclavePaths(workDir).root, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function stageHandoff(port: number): ReturnType<typeof resolveEnclavePaths> {
    const paths = resolveEnclavePaths(workDir);
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.delegationChannelDir, { recursive: true, mode: 0o700 });
    const resolution = resolveEnclaveDynamicDelegationHandoff({
      endpoint:
        `http://127.0.0.1:${port}/internal/awf-enclave-mcp-control/github-repository-delegation-v1`,
      capability: CAPABILITY,
    });
    stageEnclaveDynamicDelegationHandoff(paths, resolution.handoff!);
    return paths;
  }

  const runEnv = { GITHUB_RUN_ID: '18234567890', GITHUB_RUN_ATTEMPT: '1' };

  it('detects a dynamic entry', () => {
    expect(isEnclaveDynamicEnabled(dynamicConfig(workDir))).toBe(true);
    expect(isEnclaveDynamicEnabled({ workDir } as WrapperConfig)).toBe(false);
  });

  it('recovers with status then reconcile before opening admission', async () => {
    const control = await startControlServer();
    const config = dynamicConfig(workDir);
    stageHandoff(control.port);
    try {
      await startEnclaveDynamicDelegation(config, runEnv);
      expect(control.recorded.map((entry) => entry.path)).toEqual([
        '/internal/awf-enclave-mcp-control/status',
        '/internal/awf-enclave-mcp-control/reconcile',
      ]);
      expect(control.recorded[0].authorization).toBe(`Bearer ${CAPABILITY}`);
      expect(control.recorded[0].body).toEqual({
        run_id: '18234567890-1',
        enclave_entry_id: 'agent',
      });
    } finally {
      await stopEnclaveDynamicDelegation(config);
      await control.close();
    }
  });

  it('revokes stale labelled identities from a prior attempt before reconciling', async () => {
    const control = await startControlServer(['dlg_stale']);
    const config = dynamicConfig(workDir);
    stageHandoff(control.port);
    try {
      await startEnclaveDynamicDelegation(config, runEnv);
      expect(control.recorded.map((entry) => entry.path)).toEqual([
        '/internal/awf-enclave-mcp-control/status',
        '/internal/awf-enclave-mcp-control/revoke-by-labels',
        '/internal/awf-enclave-mcp-control/reconcile',
      ]);
    } finally {
      await stopEnclaveDynamicDelegation(config);
      await control.close();
    }
  });

  it('serves one admission and settlement through the private channel', async () => {
    const control = await startControlServer();
    const config = dynamicConfig(workDir);
    const paths = stageHandoff(control.port);
    try {
      await startEnclaveDynamicDelegation(config, runEnv);
      fs.writeFileSync(path.join(paths.delegationChannelDir, 'abcabcabcabcabca.admit.json'),
        JSON.stringify({
          version: DELEGATION_CHANNEL_VERSION,
          invocationId: 'abcabcabcabcabca',
          selector: 'octo-org/service',
          schemaHash: 'b'.repeat(64),
        }));
      const response = await waitForJson(
        path.join(paths.delegationChannelDir, 'abcabcabcabcabca.admitted.json'),
      );
      expect(response).toMatchObject({
        admitted: true,
        repository: 'octo-org/service',
        executorBearer: 'dlgbearer_live',
        readMode: 'live',
      });
      expect(JSON.stringify(response)).not.toContain('dlg_live"');

      fs.writeFileSync(path.join(paths.delegationChannelDir, 'abcabcabcabcabca.settle.json'),
        JSON.stringify({
          version: DELEGATION_CHANNEL_VERSION,
          invocationId: 'abcabcabcabcabca',
          outcome: 'success',
          outputBytes: 16,
          executionSeconds: 2,
        }));
      const receipt = await waitForJson(
        path.join(paths.delegationChannelDir, 'abcabcabcabcabca.settled.json'),
      );
      expect(receipt).toMatchObject({ settled: true, revoked: true });
      expect(control.recorded.map((entry) => entry.path)).toContain(
        '/internal/awf-enclave-mcp-control/revoke',
      );
    } finally {
      await stopEnclaveDynamicDelegation(config);
      await control.close();
    }
  }, 20_000);

  it('sweeps every labelled identity at shutdown', async () => {
    const control = await startControlServer();
    const config = dynamicConfig(workDir);
    stageHandoff(control.port);
    await startEnclaveDynamicDelegation(config, runEnv);
    await stopEnclaveDynamicDelegation(config);
    expect(control.recorded[control.recorded.length - 1].path)
      .toBe('/internal/awf-enclave-mcp-control/revoke-by-labels');
    await control.close();
  });

  it('refuses to start without a staged handoff', async () => {
    const config = dynamicConfig(workDir);
    fs.mkdirSync(resolveEnclavePaths(workDir).root, { recursive: true, mode: 0o700 });
    await expect(startEnclaveDynamicDelegation(config, runEnv))
      .rejects.toThrow(/staged mcpg delegation-control handoff is missing/);
  });

  it('refuses to start without the workflow run identity mcpg bound', async () => {
    const control = await startControlServer();
    const config = dynamicConfig(workDir);
    stageHandoff(control.port);
    try {
      await expect(startEnclaveDynamicDelegation(config, {}))
        .rejects.toThrow(/GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are required/);
    } finally {
      await control.close();
    }
  });

  it('is a no-op for a static-only run', async () => {
    const config = { workDir } as WrapperConfig;
    await expect(startEnclaveDynamicDelegation(config, runEnv)).resolves.toBeUndefined();
    await expect(stopEnclaveDynamicDelegation(config)).resolves.toBeUndefined();
  });
});

async function waitForJson(target: string): Promise<unknown> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
  }
  throw new Error(`Timed out waiting for ${target}`);
}
