import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.resolve(__dirname, '../..');
const harnessPath = path.join(root, 'scripts/ci/cloud-hypervisor-enclave-live-smoke.js');
const workflowPath = path.join(root, '.github/workflows/test-cloud-hypervisor-enclaves.yml');
const harness = require(harnessPath) as {
  RELEASE_ASSETS: string[];
  assertReleaseAssets(required: string[], published: string[]): void;
  assertNoSentinelLeak(directories: string[], logs: string[], sentinel: string): void;
  parsePublicToolResult(response: unknown, requestId: number): { status: string; result?: unknown };
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
