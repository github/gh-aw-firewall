import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const root = path.resolve(__dirname, '../..');
const harnessPath = path.join(root, 'scripts/ci/cloud-hypervisor-enclave-live-smoke.js');
const workflowPath = path.join(root, '.github/workflows/test-cloud-hypervisor-enclaves.yml');
const harness = require(harnessPath) as {
  RELEASE_ASSETS: string[];
  assertReleaseAssets(required: string[], published: string[]): void;
  assertNoSentinelLeak(directories: string[], logs: string[], sentinel: string): void;
  assertExpectedToolResult(response: unknown, requestId: number, expected: unknown, label: string): void;
  assertNoSuccessfulResult(response: unknown): void;
  assertRecoveredInvocation(
    before: {
      runId: string;
      invocationId: string;
      directory: string;
      directoryIdentity: unknown;
      ancestors: unknown;
      mount: unknown;
      snapshot: unknown;
      storage: {
        directory: string;
        parentIdentity: unknown;
        ancestors: unknown;
        directoryIdentity: unknown;
        mountedIdentity: unknown;
        mounts: unknown;
      };
    },
    after: {
      runId: string;
      invocationId: string;
      state: string;
      directory: string;
      directoryIdentity: unknown;
      ancestors: unknown;
      mount: unknown;
      snapshot: unknown;
      storage: {
        directory: string;
        parentIdentity: unknown;
        ancestors: unknown;
        directoryIdentity: unknown;
        mountedIdentity: unknown;
        mounts: unknown;
      };
    },
    records: Array<{ record: { runId: string; invocationId: string } }>,
  ): void;
  buildAgentGuestProbe(): { expected: Record<string, unknown>; schema: unknown; prompt: string };
  buildAgentEnospcProbe(): { expected: Record<string, unknown>; schema: unknown; prompt: string };
  buildEnospcProbeScript(maxStorageMib?: number): string;
  buildOomProbeScript(): string;
  parsePublicToolResult(response: unknown, requestId: number): { status: string; result?: unknown };
  requestMcp(
    endpoint: string,
    apiKey: string,
    requestId: number,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

describe('Cloud Hypervisor enclave live acceptance harness', () => {
  it('requires the package-matched release assets, never development artifacts', () => {
    expect(() => harness.assertReleaseAssets(harness.RELEASE_ASSETS, harness.RELEASE_ASSETS))
      .not.toThrow();
    expect(() => harness.assertReleaseAssets(harness.RELEASE_ASSETS, []))
      .toThrow(/release-attested.*not accepted/);
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain('setup-enclave-artifacts.sh');
    expect(source).toContain("run('gh', [");
    expect(source).not.toMatch(/DEVELOPMENT_ALLOW_UNATTESTED|allow-unattested|fake.?vm|mock.?manager/i);
  });

  it('accepts only canonical bounded public MCP results', () => {
    expect(harness.parsePublicToolResult({
      jsonrpc: '2.0',
      id: 3,
      result: {
        structuredContent: { status: 'ok', result: true },
        content: [{ type: 'text', text: '{"status":"ok","result":true}' }],
      },
    }, 3)).toEqual({ status: 'ok', result: true });
    expect(harness.parsePublicToolResult({
      jsonrpc: '2.0',
      id: 4,
      result: {
        structuredContent: { status: 'error' },
        content: [{ type: 'text', text: '{"status":"error"}' }],
      },
    }, 4)).toEqual({ status: 'error' });
    for (const invalid of [
      { jsonrpc: '2.0', id: 3, error: { message: 'failed' } },
      { jsonrpc: '2.0', id: 3, result: { structuredContent: { status: 'ok', debug: 'raw' }, content: [] } },
      { jsonrpc: '2.0', id: 3, result: { structuredContent: { status: 'ok', result: true }, content: [{ type: 'text', text: '{"status":"error"}' }] } },
    ]) {
      expect(() => harness.parsePublicToolResult(invalid, 3)).toThrow();
    }
  });

  it('requires live agent identity, capabilities, API proxy peer/port, and denial of unrelated routes', () => {
    const probe = harness.buildAgentGuestProbe();
    expect(probe.expected).toEqual({
      uid: 65534,
      gid: 65534,
      onlyExpectedInterfaces: true,
      emptyEffectiveCapabilities: true,
      noNewPrivileges: true,
      processLimit: 47,
      fileSizeLimit: 268435456,
      openFileLimit: 1024,
      apiProxyReachable: true,
      wrongPortBlocked: true,
      wrongPeerBlocked: true,
      githubPeerBlocked: true,
      publicEgressBlocked: true,
    });
    expect(probe.prompt).toContain('172.31.0.30", 10002');
    expect(probe.prompt).toContain('172.31.0.30", 10000');
    expect(probe.prompt).toContain('172.31.0.99", 10002');
    expect(probe.prompt).toContain('172.31.0.40", 8080');
    expect(probe.prompt).toContain('1.1.1.1", 443');
    const python = probe.prompt.split("python3 - <<'PY'\n")[1].split('\nPY')[0];
    expect(Buffer.byteLength(probe.prompt)).toBeLessThanOrEqual(4096);
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<agent-probe>", "exec")'], {
      input: python,
    })).not.toThrow();
    expect(() => harness.assertExpectedToolResult({
      jsonrpc: '2.0',
      id: 5,
      result: {
        structuredContent: { status: 'ok', result: probe.expected },
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', result: probe.expected }) }],
      },
    }, 5, probe.expected, 'agent')).not.toThrow();
    expect(() => harness.assertExpectedToolResult({
      jsonrpc: '2.0',
      id: 5,
      result: {
        structuredContent: { status: 'ok', result: { ...probe.expected, wrongPortBlocked: false } },
        content: [{ type: 'text', text: JSON.stringify({
          status: 'ok', result: { ...probe.expected, wrongPortBlocked: false },
        }) }],
      },
    }, 5, probe.expected, 'agent')).toThrow(/guest assertion failed/);
  });

  it('exercises guest-visible aggregate ENOSPC and verifies the bounded probe cleans its data', () => {
    const script = harness.buildEnospcProbeScript();
    expect(script).toContain('errno.ENOSPC');
    expect(script).toContain('"/output"');
    expect(script).toContain('os.unlink(name)');
    expect(script).toContain('range(16)');
    expect(() => harness.buildEnospcProbeScript(768)).toThrow(/supported role ceiling/);
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<enospc-probe>", "exec")'], {
      input: script,
    })).not.toThrow();
    const agentProbe = harness.buildAgentEnospcProbe();
    expect(agentProbe.expected).toEqual({ enospcObserved: true, probeFilesRemoved: true });
    expect(Buffer.byteLength(agentProbe.prompt)).toBeLessThanOrEqual(4096);
    const agentScript = agentProbe.prompt.split("python3 - <<'PY'\n")[1].split('\nPY')[0];
    expect(agentScript).toContain('range(8)');
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<agent-enospc-probe>", "exec")'], {
      input: agentScript,
    })).not.toThrow();
    expect(agentProbe.prompt).toContain('print(encoded)');
    expect(() => harness.assertExpectedToolResult({
      jsonrpc: '2.0',
      id: 6,
      result: {
        structuredContent: {
          status: 'ok',
          result: { enospcObserved: true, probeFilesRemoved: true },
        },
        content: [{
          type: 'text',
          text: '{"status":"ok","result":{"enospcObserved":true,"probeFilesRemoved":true}}',
        }],
      },
    }, 6, { enospcObserved: true, probeFilesRemoved: true }, 'ENOSPC')).not.toThrow();
  });

  it('requires a guest OOM kill counter increase, not merely an error response', () => {
    const script = harness.buildOomProbeScript();
    expect(script).toContain('"/proc/vmstat"');
    expect(script).toContain('name == "oom_kill"');
    expect(script).toContain('signal == -9');
    expect(script).toContain('after > before');
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<oom-probe>", "exec")'], {
      input: script,
    })).not.toThrow();
  });

  it('requires identity-checked crash recovery without accepting replayed success', () => {
    const before = {
      runId: 'a'.repeat(32),
      invocationId: 'b'.repeat(32),
      state: 'pending',
      directory: '/host/invocation',
      directoryIdentity: { device: 1, inode: 2 },
      ancestors: [{ path: '/host', identity: { device: 1, inode: 3 } }],
      mount: { mountId: 1, device: 2 },
      snapshot: { path: '/storage/artifacts/run-1', identity: { device: 3, inode: 4 } },
      storage: {
        directory: '/storage',
        parentIdentity: { device: 1, inode: 5 },
        ancestors: [{ path: '/', identity: { device: 1, inode: 1 } }],
        directoryIdentity: { device: 4, inode: 5 },
        mountedIdentity: { device: 4, inode: 6 },
        mounts: [{ mountId: 7, device: 8 }],
      },
    };
    const cleaned = { ...before, state: 'cleaned' };
    expect(() => harness.assertRecoveredInvocation(before, cleaned, [{ record: cleaned }]))
      .not.toThrow();
    expect(() => harness.assertRecoveredInvocation(before, before, [{ record: before }]))
      .toThrow(/exact interrupted invocation/);
    expect(() => harness.assertRecoveredInvocation(before, cleaned, [
      { record: cleaned }, { record: cleaned },
    ])).toThrow(/exact interrupted invocation/);
    expect(() => harness.assertRecoveredInvocation(before, {
      ...cleaned,
      storage: { ...before.storage, directoryIdentity: { device: 99, inode: 99 } },
    }, [{ record: cleaned }])).toThrow(/exact interrupted invocation/);
    expect(() => harness.assertNoSuccessfulResult({
      result: { structuredContent: { status: 'ok' } },
    })).toThrow(/successful result/);
    expect(() => harness.assertNoSuccessfulResult({
      error: { code: -32603, message: 'interrupted' },
    })).not.toThrow();
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain("process.kill(vmmPid, 'SIGKILL')");
    expect(source).toContain("awf.kill('SIGKILL')");
    expect(source).toContain("awf = launchAwf()");
    expect(source).toContain("recoveryTools = await requestMcp");
    expect(source).toContain("open(\"/output/cancel-probe-started\"");
    expect(source).toContain("cancellationController.abort()");
  });

  it('propagates public-client cancellation by closing its in-flight MCP request', async () => {
    let bodyReceived!: () => void;
    let clientDisconnected!: () => void;
    const received = new Promise<void>((resolve) => { bodyReceived = resolve; });
    const disconnected = new Promise<void>((resolve) => { clientDisconnected = resolve; });
    const server = http.createServer((request, response) => {
      request.on('end', bodyReceived);
      request.resume();
      response.on('close', clientDisconnected);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test MCP server did not bind');
    try {
      const controller = new AbortController();
      const pending = harness.requestMcp(
        `http://127.0.0.1:${address.port}/mcp`,
        'test-gateway-key',
        1,
        'tools/call',
        {},
        controller.signal,
      );
      await received;
      controller.abort();
      await expect(pending).resolves.toBeUndefined();
      await disconnected;
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('detects synthetic raw-output leaks without echoing the sentinel', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-redaction-'));
    const sentinel = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_synthetic';
    try {
      const diagnostic = path.join(directory, 'audit.jsonl');
      fs.writeFileSync(diagnostic, '{"category":"success"}\n');
      expect(() => harness.assertNoSentinelLeak([directory], ['safe'], sentinel)).not.toThrow();
      fs.writeFileSync(diagnostic, `{"message":"${sentinel}"}\n`);
      try {
        harness.assertNoSentinelLeak([directory], [], sentinel);
        throw new Error('expected sentinel leak rejection');
      } catch (error) {
        expect((error as Error).message).not.toContain(sentinel);
        expect((error as Error).message).toMatch(/sentinel escaped/);
      }
      expect(() => harness.assertNoSentinelLeak([], [sentinel], sentinel)).toThrow(/captured log/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gates KVM acceptance separately and fails closed after explicit opt-in', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('run_live_kvm:');
    expect(workflow).toContain('default: false');
    expect(workflow).toContain('assertGithubHostedRunnerEligibility()');
    expect(workflow).toContain('cloud-hypervisor-enclave-live-smoke.js');
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && inputs.run_live_kvm");
    expect(workflow).not.toMatch(/continue-on-error|\|\| true|exit 0/);
  });

  it('invokes both executor tools over the public MCP HTTP route', () => {
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain('/mcp/awf-enclave');
    expect(source).toContain("name: 'enclave_run_script'");
    expect(source).toContain("name: 'enclave_run_agent'");
    expect(source).toContain("'tools/call'");
    expect(source).not.toContain('executor.sock');
    expect(source).not.toContain('host-executor-client');
  });
});
