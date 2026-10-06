import * as fs from 'fs';
import * as path from 'path';
import * as finiteSchema from '../../src/bounded-execution/finite-schema';
import { validateWithSchema } from '../../src/schema-validator';
import { CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS } from '../../src/types/runtime-options';

const root = path.resolve(__dirname, '../..');
const harnessPath = path.join(root, 'scripts/ci/cloud-hypervisor-enclave-environment-probe.js');
const probeDirectory = path.join(root, 'examples/enclave-environment-probe');
type Schemas = typeof finiteSchema;
const harness = require(harnessPath) as {
  EXPECTED_ENCLAVES: unknown[];
  RESULT_PREFIX: string;
  buildProbeRequest(generate?: () => string, schemas?: Schemas): {
    request: { name: string; arguments: { privateRepo: string; schema: unknown; script: string } };
    schema: unknown;
  };
  assertProbeResult(response: unknown, requestId: number, schema: unknown, schemas?: Schemas): string;
  loadExampleConfig(): Record<string, unknown>;
  makeProbeConfig(
    example: Record<string, unknown>,
    artifacts: { directory: string; tag: string },
    workDir: string,
    apiTimeoutMs?: number,
  ): Record<string, unknown> & { network: Record<string, unknown>; cloudHypervisor: Record<string, unknown> };
};
const source = fs.readFileSync(harnessPath, 'utf8');
const script = fs.readFileSync(path.join(probeDirectory, 'probe.py'), 'utf8');

function generated(override: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'enclave_run_script',
    arguments: { privateRepo: 'github/gh-aw-firewall', schema: probeSchema(), script, ...override },
  });
}

function probeSchema(): unknown {
  return harness.buildProbeRequest(undefined, finiteSchema).request.arguments.schema;
}

function canonical(structured: unknown, id = 3): unknown {
  return {
    jsonrpc: '2.0', id,
    result: { structuredContent: structured, content: [{ type: 'text', text: JSON.stringify(structured) }] },
  };
}

function observation(): { status: string; values: number[] } {
  return { status: 'ok', values: [1, 2, 3, -1, -1, -1, -1, -1] };
}

function probeResult(): Record<string, unknown> {
  const item = observation;
  return {
    schemaVersion: 1, system: 'Linux', architecture: 'x86_64', pythonImplementation: 'cpython',
    kernelVersion: item(), pythonVersion: item(), identity: item(), processSecurity: item(),
    limits: [item(), item(), item()], cgroupRootLimits: [item(), item(), item()],
    paths: Array.from({ length: 8 }, () => ({ metadata: item(), mount: item(), capacity: item() })),
  };
}

describe('public enclave environment probe live harness (no KVM)', () => {
  it('builds the reviewed request from the real generator without executing the probe on the host', () => {
    const { request } = harness.buildProbeRequest(undefined, finiteSchema);
    expect(request.name).toBe('enclave_run_script');
    expect(Object.keys(request.arguments).sort()).toEqual(['privateRepo', 'schema', 'script']);
    expect(request.arguments.privateRepo).toBe('github/gh-aw-firewall');
    expect(request.arguments.script).toBe(script);
    expect(source).toContain("'build-request.py'");
    expect(source).not.toMatch(/['"]probe\.py['"]\s*\]/);
    expect(source).not.toMatch(/spawnSync\('python3', \[[^\]]*probe\.py/);
  });

  it('rejects any request deviating from the bounded public probe contract', () => {
    for (const override of [
      { privateRepo: 'github/other' },
      { script: 'print(1)' },
      { script: `${script}\n` },
      { schema: { type: 'string' } },
      { extra: true },
    ]) {
      expect(() => harness.buildProbeRequest(() => generated(override), finiteSchema)).toThrow();
    }
    expect(() => harness.buildProbeRequest(() => 'not json', finiteSchema)).toThrow(/bounded JSON/);
    expect(() => harness.buildProbeRequest(() => JSON.stringify({
      name: 'enclave_run_agent', arguments: JSON.parse(generated()).arguments,
    }), finiteSchema)).toThrow();
  });

  it('emits metadata only for a canonical ok result that validates against the finite schema', () => {
    const { schema } = harness.buildProbeRequest(undefined, finiteSchema);
    const value = probeResult();
    const encoded = harness.assertProbeResult(canonical({ status: 'ok', result: value }), 3, schema, finiteSchema);
    expect(JSON.parse(encoded)).toEqual(value);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(8192);
  });

  it('fails explicitly on canonical errors and invalid results, never falling back to success', () => {
    const { schema } = harness.buildProbeRequest(undefined, finiteSchema);
    expect(() => harness.assertProbeResult(canonical({ status: 'error' }), 3, schema, finiteSchema))
      .toThrow(/canonical error/);
    for (const result of [
      { ...probeResult(), schemaVersion: 2 },
      { ...probeResult(), hostname: 'runner' },
      { ...probeResult(), system: 'Windows' },
      { ...probeResult(), identity: { status: 'ok', values: [1] } },
      { ...probeResult(), identity: { status: 'ok', values: [2 ** 53, -1, -1, -1, -1, -1, -1, -1] } },
    ]) {
      expect(() => harness.assertProbeResult(canonical({ status: 'ok', result }), 3, schema, finiteSchema))
        .toThrow(/bounded finite schema/);
    }
    expect(() => harness.assertProbeResult(canonical({ status: 'ok', result: probeResult() }, 4), 3, schema, finiteSchema))
      .toThrow();
    expect(() => harness.assertProbeResult({ jsonrpc: '2.0', id: 3, error: { code: 1 } }, 3, schema, finiteSchema))
      .toThrow();
  });

  it('runs the shipped script-only example config, adding only compiler-owned wiring', () => {
    const example = harness.loadExampleConfig();
    expect(example.enclaves).toEqual(harness.EXPECTED_ENCLAVES);
    const config = harness.makeProbeConfig(
      example, { directory: '/opt/artifacts', tag: 'v1.2.3' }, '/tmp/w', CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS,
    );
    expect(validateWithSchema(config)).toEqual([]);
    expect(config.enclaves).toEqual(example.enclaves);
    expect(config.network).toEqual({ ...(example.network as object), topologyAttach: ['awmg-mcpg'] });
    expect(config.cloudHypervisor).toMatchObject({
      previewEnabled: true, mountPolicy: 'workspace-only', artifactReleaseTag: 'v1.2.3',
      artifactManifestPath: '/opt/artifacts/cloud-hypervisor-test-x86_64.manifest.json',
      artifactManifestBundlePath: '/opt/artifacts/cloud-hypervisor-test-x86_64.manifest.sigstore.jsonl',
    });
    expect(config).not.toHaveProperty('apiProxy');
    expect(JSON.stringify(config)).not.toMatch(/"agent"|copilot|api-proxy/i);
  });

  it('uses the release-attested public MCP route without agent, model, or Copilot credentials', () => {
    expect(source).toContain('verifyAcceptanceCheckout(process.env, gate.ENVIRONMENT_PROBE_REQUIRED_PATHS)');
    expect(source).toContain('live.prepareReleaseArtifacts(');
    expect(source).toContain('gate.assertManifestSource(');
    expect(source).toContain('live.waitForBroker(');
    expect(source).toContain('live.waitForHostGatewayReadiness(');
    expect(source.indexOf('live.waitForHostGatewayReadiness(')).toBeLessThan(source.indexOf("'tools/call'"));
    expect(source).toContain('\'["enclave_run_script"]\'');
    expect(source).not.toMatch(/enable-api-proxy|enclave_run_agent|COPILOT_GITHUB_TOKEN|executor\.sock|host-executor-client/);
    expect(source).not.toMatch(/DEVELOPMENT_ALLOW_UNATTESTED|allow-unattested|upload-artifact/i);
    expect(source).toContain('removePrivateAwfLogs(awfOut, awfErr');
    expect(source.indexOf('${RESULT_PREFIX}${assertProbeResult(')).toBeGreaterThan(0);
    expect(source).not.toMatch(/console\.(log|error)\([^)]*(gatewayKey|capability|GH_TOKEN)/);
  });
});
