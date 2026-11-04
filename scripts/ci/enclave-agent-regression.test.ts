import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { spawnSync } from 'child_process';

/* eslint-disable @typescript-eslint/no-require-imports */
const { configuration, probe, assertAudit } = require('./run-enclave-agent-regression');
const live = require('./cloud-hypervisor-enclave-live-smoke');
/* eslint-enable @typescript-eslint/no-require-imports */

const root = path.resolve(__dirname, '../..');
const source = 'a'.repeat(40);
const agents = ['copilot', 'codex', 'claude'];
const runtimes = ['docker', 'cloud-hypervisor'];
interface Step { name: string; run?: string; if?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string> }
interface Job { steps: Step[]; needs: string[]; if?: string; strategy: unknown; permissions?: Record<string, string> }
const workflow = yaml.load(fs.readFileSync(path.join(root,
  '.github/workflows/daily-agent-runtime-regression.yml'), 'utf8')) as { jobs: Record<string, Job> };
const job = workflow.jobs['enclave-regression-copilot'];
const find = (name: string) => {
  const found = job.steps.find(step => step.name === name);
  if (!found) throw new Error(`Missing step: ${name}`);
  return found;
};

it('fans out six real enclave agents from exactly the broader matrix shared builds', () => {
  expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { agent: ['copilot'], runtime: runtimes } });
  const other = workflow.jobs['enclave-regression-non-copilot'];
  expect(other.strategy).toEqual({ 'fail-fast': false, matrix: { agent: ['codex', 'claude'], runtime: runtimes } });
  expect(other.steps).toEqual(job.steps);
  expect(other.permissions).toEqual({ contents: 'read' });
  expect(job.permissions).toEqual({ contents: 'read', 'copilot-requests': 'write' });
  expect(job.needs).toEqual(['build', 'build-cloud-hypervisor']);
  expect(job.if).toBe("${{ !cancelled() && needs.build.result == 'success' }}");
  expect(find('Checkout main').with?.ref).toBe('main');
  for (const name of ['Download shared AWF build', 'Download Cloud Hypervisor artifacts']) {
    const original = workflow.jobs['regression-copilot'].steps.find(step => step.name === name);
    expect(find(name).with?.name).toBe(original?.with?.name);
  }
  const runs = job.steps.map(step => step.run ?? '').join('\n');
  expect(runs).not.toMatch(/docker (build|pull)|npm (ci|install|run build)/);
  expect(find('Load the shared CLI and images').run).toContain('docker tag "awf-regression/$image:$SOURCE_SHA"');
  const run = find('Run real coding agent inside enclave');
  expect(run.run).toContain('run-enclave-agent-regression.js');
  expect(run.env?.SOURCE_SHA).toBe('${{ needs.build.outputs.source_sha }}');
  expect(run.env?.OPENAI_API_KEY).toContain("matrix.agent == 'codex'");
  expect(run.env?.ANTHROPIC_API_KEY).toContain("matrix.agent == 'claude'");
  expect(run.env?.COPILOT_GITHUB_TOKEN).toContain("matrix.agent == 'copilot'");
});

it('builds enclave images once and attests the same shared guest before fan-out', () => {
  const build = workflow.jobs.build.steps.map(step => step.run ?? '').join('\n');
  expect(build).toContain('for image in enclave-script enclave-agent enclave-mcp-server; do');
  expect(build).toContain('configure-agent-regression-build.js');
  expect(build).toContain('--build-arg "CODEX_VERSION=$CODEX_VERSION"');
  expect(build).toContain('--build-arg "CLAUDE_VERSION=$CLAUDE_VERSION"');
  expect(build).not.toContain('COPILOT_CLI_VERSION=');
  const guest = workflow.jobs['build-cloud-hypervisor'];
  const guestBuild = guest.steps.find(step => step.name === 'Build and verify guest artifacts')?.run;
  expect(guestBuild).toContain('export VERSION="v0.0.0-regression.$SOURCE_SHA"');
  expect(guestBuild).toContain('export ARTIFACT_SIGNER_WORKFLOW=github/gh-aw-firewall/.github/workflows/daily-agent-runtime-regression.yml');
  expect(guest.permissions).toMatchObject({ 'id-token': 'write', attestations: 'write' });
  const attestation = guest.steps.find(step => step.name === 'Attest shared microVM manifests and enclave rootfs');
  expect(attestation?.with?.['subject-path']).toContain('enclave-rootfs.ext4');
  expect(attestation?.with?.['subject-path']).toContain('cloud-hypervisor-enclave-rootfs-x86_64.manifest.json');
  expect(guest.steps.find(step => step.name === 'Restore shared enclave source images')).toBeDefined();
  const uploaded = guest.steps.find(step => step.name === 'Upload shared guest artifacts')?.with?.path;
  for (const file of ['enclave-rootfs.ext4', 'enclave-rootfs.sbom.spdx.json',
    'enclave-rootfs.provenance.sigstore.jsonl', 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl']) {
    expect(uploaded).toContain(file);
  }
});

it('always collects protected public-only diagnostics with short retention, never raw AWF host logs', () => {
  expect(find('Collect protected public enclave diagnostics').if).toBe('always()');
  expect(find('Upload enclave regression evidence').if).toBe('always()');
  expect(find('Upload enclave regression evidence').with?.['retention-days']).toBe(1);
  const artifacts = find('Upload enclave regression evidence').with?.path;
  expect(artifacts).toContain('/upload/');
  expect(artifacts).not.toMatch(/awf\.(stdout|stderr)|work\/|gateway\.env/);
});

describe.each(agents)('%s enclave regression', agent => {
  it.each(runtimes)('executes inference inside %s with public sensitivity and no unsigned artifacts', runtime => {
    const config = configuration(agent, runtime, source, '/private/work', '/artifacts');
    expect(config.container).toEqual({ containerRuntime: 'docker', imageTag: source });
    expect(config.enclaveDebugPublic).toBe(true);
    expect(config.enclaves).toHaveLength(1);
    expect(config.enclaves[0]).toMatchObject({
      agent: { engine: agent }, runtime, timeout: 360, maxInvocations: 1,
      repos: [{ repo: 'github/gh-aw-firewall', sensitivity: 'public' }],
    });
    expect(config.cloudHypervisor?.developmentAllowUnattestedArtifacts).toBeUndefined();
    if (runtime === 'cloud-hypervisor') {
      expect(config.cloudHypervisor.artifactReleaseTag).toBe(`v0.0.0-regression.${source}`);
      expect(config.cloudHypervisor.artifactManifestBundlePath).toMatch(/manifest.sigstore.jsonl$/);
    }
    const task = probe(agent, runtime, 'b'.repeat(48));
    const python = task.prompt.match(/python3 - <<'PY'\n([\s\S]*)\nPY\n/)[1];
    expect(task.schema.fields.proof).toEqual({ type: 'const', value: 'b'.repeat(48) });
    expect(task.expected.credentialsIsolated).toBe(true);
    expect(task.expected.proof).toBe('b'.repeat(48));
    expect(python).toContain('open("/awf/out"');
    expect(python).toContain('seed_read_only = error.errno == errno.EROFS');
    const parsed = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
      input: python, encoding: 'utf8',
    });
    expect(parsed.stderr).toBe('');
    expect(parsed.status).toBe(0);
    const structured = { status: 'ok', result: task.expected };
    expect(live.parsePublicToolResult({
      jsonrpc: '2.0', id: 3,
      result: { structuredContent: structured, content: [{ type: 'text', text: JSON.stringify(structured) }] },
    }, 3)).toEqual(structured);
  });
});

it('fails unless exactly one audited public invocation succeeds', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-regression-test-'));
  const file = path.join(directory, 'audit.jsonl');
  const invocation = { kind: 'invocation', repo: 'github/gh-aw-firewall', sensitivity: 'public' };
  try {
    fs.writeFileSync(file, JSON.stringify(invocation));
    expect(() => assertAudit(file)).not.toThrow();
    for (const records of [[], [invocation, invocation], [invocation, { kind: 'failure' }],
      [{ ...invocation, sensitivity: 'internal' }]]) {
      fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n'));
      expect(() => assertAudit(file)).toThrow();
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
