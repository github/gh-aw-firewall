import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { spawnSync } from 'child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';
import { normalizeEnclavesConfig } from '../../src/parsers/enclave-parser';
import { validateRunSandboxBackend } from '../../src/enclave/run-backend';
import type { WrapperConfig } from '../../src/types';
import { removeWorkDirectories } from '../../src/artifact-preservation';
import { buildMinimalBuildConfigInput } from '../../src/test-helpers/build-config.test-utils';

/* eslint-disable @typescript-eslint/no-require-imports */
const { configuration, probe, assertAudit } = require('./run-enclave-agent-regression');
const live = require('./cloud-hypervisor-enclave-live-smoke');
const collector = require('./collect-enclave-smoke-debug.cjs');
const { createProtectedAuditLog } = require('../../containers/bounded-execution/protected-audit');
/* eslint-enable @typescript-eslint/no-require-imports */

const root = path.resolve(__dirname, '../..');
const source = 'a'.repeat(40);
const invocation = {
  ts: '2026-01-01T00:00:00.000Z', kind: 'invocation', invocationId: 'b'.repeat(24),
  repo: 'github/gh-aw-firewall', sensitivity: 'public', bits: 0, bucketMs: 30_000,
};
const agents = ['copilot', 'codex', 'claude'];
const runtimes = ['docker', 'cloud-hypervisor'];
const oidcKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const oidcJwk = {
  ...oidcKeys.publicKey.export({ format: 'jwk' }),
  kid: 'fixture-key', use: 'sig', alg: 'RS256',
};
let oidcClaimsOverride: Record<string, unknown> = {};
let oidcTokenOverride: string | undefined;
let oidcFailure: 'token' | 'jwks' | undefined;
function signedOidcToken(eventName: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key', typ: 'JWT' }))
    .toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'github/gh-aw-firewall',
    exp: Math.floor(Date.now() / 1000) + 60,
    nbf: Math.floor(Date.now() / 1000) - 1,
    repository: 'github/gh-aw-firewall', repository_owner: 'github',
    ref: 'refs/heads/main', event_name: eventName,
    workflow_ref: 'github/gh-aw-firewall/.github/workflows/daily-agent-runtime-regression.yml@refs/heads/main',
    workflow_sha: source,
    sha: source,
    ...oidcClaimsOverride,
  })).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), oidcKeys.privateKey).toString('base64url');
  return `${input}.${signature}`;
}
const ajv = new Ajv2020({ allErrors: true });
ajv.addKeyword({ keyword: 'version' });
const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(root, 'docs/awf-config.schema.json'), 'utf8')));
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
  expect(other.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  expect(job.permissions).toEqual({
    contents: 'read', 'copilot-requests': 'write', 'id-token': 'write',
  });
  expect(job.needs).toEqual(['build', 'build-cloud-hypervisor']);
  expect(job.if).toBe("${{ !cancelled() && needs.build.result == 'success' }}");
  expect(find('Checkout main').with?.ref).toBe('main');
  expect(find('Pin build source commit').run).toContain('git fetch --no-tags origin "$SOURCE_SHA"');
  expect(find('Pin build source commit').run).toContain('git checkout --detach FETCH_HEAD');
  for (const name of ['Download shared AWF build', 'Download Cloud Hypervisor artifacts']) {
    const original = workflow.jobs['regression-copilot'].steps.find(step => step.name === name);
    expect(find(name).with?.name).toBe(original?.with?.name);
  }
  const runs = job.steps.map(step => step.run ?? '').join('\n');
  expect(runs).not.toMatch(/docker (build|pull)|npm (ci|install|run build)/);
  expect(find('Load the shared CLI and images').run).toContain('docker tag "awf-regression/$image:$SOURCE_SHA"');
  const run = find('Run real coding agent inside enclave');
  expect(run.run).toContain('run-enclave-agent-regression.js');
  expect(run.run).toContain('ACTIONS_ID_TOKEN_REQUEST_URL,ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  expect(run.env?.SOURCE_SHA).toBe('${{ needs.build.outputs.source_sha }}');
  expect(run.env?.OPENAI_API_KEY).toContain("matrix.agent == 'codex'");
  expect(run.env?.ANTHROPIC_API_KEY).toContain("matrix.agent == 'claude'");
  expect(run.env?.COPILOT_GITHUB_TOKEN).toContain("matrix.agent == 'copilot'");
});

it('waits for a real unprivileged primary HTTP listener before signaling readiness', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/ci/run-enclave-agent-regression.js'), 'utf8');
  expect(source).toContain('http.server.HTTPServer(("0.0.0.0", 18080)');
  const python = probe('copilot', 'docker', 'b'.repeat(48), '172.30.0.20').prompt;
  expect(python).toContain('"primaryPeerBlocked": not reachable("172.30.0.20", 18080)');
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
  expect(artifacts).not.toContain('.awf-regression/results');
  expect(find('Collect protected public enclave diagnostics').run).not.toContain('chown -R');
  expect(artifacts).not.toMatch(/awf\.(stdout|stderr)|work\/|gateway\.env/);
});

describe.each(agents)('%s enclave regression', agent => {
  it.each(runtimes)('executes inference inside %s with public sensitivity and no unsigned artifacts', runtime => {
    const config = configuration(agent, runtime, source, '/private/work', '/artifacts');
    expect(validate(config)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(config.container).toEqual({
      ...(runtime === 'cloud-hypervisor' ? { containerRuntime: runtime } : {}), imageTag: source,
    });
    expect(validateRunSandboxBackend(config.container.containerRuntime,
      normalizeEnclavesConfig(config.enclaves)!)).toEqual([]);
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
    const primaryAddress = runtime === 'cloud-hypervisor' ? '100.64.0.2' : '172.30.0.20';
    const task = probe(agent, runtime, 'b'.repeat(48), primaryAddress);
    const python = task.prompt.match(/python3 - <<'PY'\n([\s\S]*)\nPY\n/)[1];
    expect(task.schema.fields.proof).toEqual({ type: 'const', value: 'b'.repeat(48) });
    expect(task.expected.credentialsIsolated).toBe(true);
    expect(task.expected.proof).toBe('b'.repeat(48));
    expect(python).toContain('open("/awf/out"');
    expect(python).toContain('error.errno in (errno.EROFS, errno.EACCES) and read_only_mount');
    expect(python).toContain('os.statvfs(seed).f_flag & os.ST_RDONLY');
    const parsed = spawnSync('python3', ['-c', `
import errno, io, json, os, socket, sys
from unittest.mock import patch
from types import SimpleNamespace
task = json.load(sys.stdin)
status = "CapEff:\\t0000000000000000\\nNoNewPrivs:\\t1\\n"
def run(environment, readonly=True, uid=65534, process_status=status, peer=False):
    output = io.StringIO()
    def opened(file, *args, **kwargs):
        if file == "/awf/seed/README.md": return io.BytesIO(b"seed")
        if file == "/proc/self/status": return io.StringIO(process_status)
        if file == "/awf/out": return output
        raise AssertionError("Unexpected file")
    def write_open(file, flags):
        assert file == "/awf/seed/README.md"
        raise OSError(errno.EROFS, "read-only fixture")
    def connect(address, timeout):
        if address == ("172.31.0.30", task["port"]) or (peer and address == (task["primaryAddress"], 18080)):
            return io.BytesIO()
        raise OSError("blocked fixture")
    with patch.dict(os.environ, environment, clear=True), patch("builtins.open", opened), \\
         patch("os.open", write_open), patch("os.statvfs", return_value=SimpleNamespace(f_flag=os.ST_RDONLY if readonly else 0)), \\
         patch("os.geteuid", return_value=uid), patch("os.getegid", return_value=uid), \\
         patch("socket.create_connection", connect), patch.object(output, "close"):
        namespace = {}
        exec(compile(task["python"], "<generated-enclave-probe>", "exec"), namespace)
        return json.loads(output.getvalue())
assert run({}) == task["expected"]
for name in ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "COPILOT_TOKEN", "COPILOT_PROVIDER_BEARER_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]:
    for value in ["", "******"]:
        assert run({name: value}) == task["expected"]
    for value in ["host-only-credential-fixture", " ", "******extra", "prefix-placeholder", "fixture.payload"]:
        assert run({name: value}) == dict(task["expected"], credentialsIsolated=False)
assert run({}, readonly=False) == dict(task["expected"], seedReadOnly=False)
assert run({}, uid=0) == dict(task["expected"], nonRoot=False)
assert run({}, process_status="CapEff:\\t0000000000000001\\nNoNewPrivs:\\t0\\n") == dict(task["expected"], noCapabilities=False, noNewPrivileges=False)
assert run({}, peer=True) == dict(task["expected"], primaryPeerBlocked=False)
`], {
      input: JSON.stringify({ python, expected: task.expected, primaryAddress,
        port: { copilot: 10002, codex: 10000, claude: 10001 }[agent] }),
      encoding: 'utf8', timeout: 15_000,
    });
    expect(parsed.stderr).toBe('');
    expect(parsed.status).toBe(0);
    const structured = { status: 'ok', result: task.expected };
    expect(live.parsePublicToolResult({
      jsonrpc: '2.0', id: 3,
      result: { structuredContent: structured, content: [{ type: 'text', text: JSON.stringify(structured) }] },
    }, 3)).toEqual(structured);
  });

  it('waits for a real primary HTTP listener before signaling readiness and probes its port', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/ci/run-enclave-agent-regression.js'), 'utf8');
    expect(source).toMatch(/test "\$listening" = 1; printf/);
    expect(source).toContain('http.server.HTTPServer(("0.0.0.0", 18080)');
    expect(source).toContain('fs.mkdirSync(path.dirname(stop)');
    expect(probe('copilot', 'docker', 'b'.repeat(48), '172.30.0.20').prompt)
      .toContain('"primaryPeerBlocked": not reachable("172.30.0.20", 18080)');
  });
});

describe('source-pinned Cloud Hypervisor regression admission', () => {
  const originalEnvironment = process.env;
  const signer = 'github/gh-aw-firewall/.github/workflows/daily-agent-runtime-regression.yml';
  beforeEach(() => {
    oidcClaimsOverride = {};
    oidcTokenOverride = undefined;
    process.env = {
      ...originalEnvironment, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'github/gh-aw-firewall',
      GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: source, GITHUB_WORKFLOW_SHA: source, GITHUB_WORKFLOW_REF: `${signer}@refs/heads/main`,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/fixture/_apis/oidc/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-request-token',
      RUNNER_ENVIRONMENT: 'github-hosted', ImageOS: 'ubuntu24',
      COPILOT_GITHUB_TOKEN: 'host-only-fixture', OPENAI_API_KEY: 'host-only-fixture',
      ANTHROPIC_API_KEY: 'host-only-fixture',
    };
    oidcFailure = undefined;
  });
  afterEach(() => {
    process.env = originalEnvironment;
    jest.dontMock('../../src/cloud-hypervisor/artifact-compatibility.json');
    jest.dontMock('node:child_process');
    jest.restoreAllMocks();
  });
  function check(agent: string, change: (config: WrapperConfig) => void = () => {},
    reason?: string) {
    let accepted = false;
    jest.isolateModules(() => {
      jest.doMock('node:child_process', () => ({
        ...jest.requireActual('node:child_process'),
        execFileSync: (_command: string, args: string[], options?: { input?: string; stdio?: string[] }) => {
          expect(args[0]).toBe('--disable');
          expect(options?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
          if (args.includes('https://token.actions.githubusercontent.com/.well-known/jwks')) {
            if (oidcFailure === 'jwks') throw new Error('PRIVATE_JWKS_STDERR');
            return JSON.stringify({ keys: [oidcJwk] });
          }
          if (options?.input?.includes('Authorization: bearer fixture-request-token')) {
            if (oidcFailure === 'token') throw new Error('PRIVATE_TOKEN_STDERR');
            return JSON.stringify({ value: oidcTokenOverride
              ?? signedOidcToken(process.env.GITHUB_EVENT_NAME ?? '') });
          }
          throw new Error('Unexpected OIDC request');
        },
      }));
      jest.doMock('../../src/cloud-hypervisor/artifact-compatibility.json', () => ({
        releaseTag: `v0.0.0-regression.${source}`, signerWorkflow: signer,
      }));
      const { validateEnclavesConfig } = jest.requireActual('../../src/enclave/preflight');
      const { assertCloudHypervisorPreSecurityCompatibility } =
        jest.requireActual('../../src/cloud-hypervisor/runtime-validation');
      const { cloudHypervisorDailyRegressionRejection } =
        jest.requireActual('../../src/enclave/cloud-hypervisor-conformance-acceptance');
      const { loadAwfFileConfig } = jest.requireActual('../../src/config-file');
      const { mapAwfFileConfigToCliOptions } = jest.requireActual('../../src/config-mapper');
      const { buildConfig } = jest.requireActual('../../src/commands/build-config');
      const { assembleAndValidateConfig } = jest.requireActual('../../src/commands/validators/config-assembly');
      const { program } = jest.requireActual('../../src/cli-options');
      const raw = configuration(agent, 'cloud-hypervisor', source, '/private/work', '/artifacts');
      program.parse(['node', 'awf', '--image-tag', source, '--skip-pull',
        '--work-dir', '/private/work', '--log-level', 'error',
        '--agent-timeout', '15', '--max-num-tool-calls', '1', '--', 'true']);
      const options = { ...program.opts(),
        ...Object.fromEntries(Object.entries(mapAwfFileConfigToCliOptions(
          loadAwfFileConfig('-', () => JSON.stringify(raw)))).filter(([, value]) => value !== undefined)),
        workDir: '/private/work' };
      const config = buildConfig(buildMinimalBuildConfigInput({ options })) as WrapperConfig;
      change(config);
      accepted = cloudHypervisorDailyRegressionRejection(config) === undefined;
      if (accepted) expect(() => assertCloudHypervisorPreSecurityCompatibility(config)).not.toThrow();
      else expect(() => assertCloudHypervisorPreSecurityCompatibility(config)).toThrow();
      expect(cloudHypervisorDailyRegressionRejection(config)).toBe(
        reason && `cloud-hypervisor-enclave-admission-${reason}`);
      const assemble = () => assembleAndValidateConfig(options, 'true', {
          logLevel: 'error', modelAliases: {}, modelMultipliers: {},
        }, {
          allowedDomains: raw.network.allowDomains, sensitiveAllowedDomains: [], blockedDomains: [],
          localhostResult: { localhostDetected: false }, dnsServers: ['8.8.8.8'],
          dockerHostPathPrefixResolution: {},
        }, { additionalEnv: {}, volumeMounts: [], allowedUrls: [] });
      if (accepted) {
        const assembled = assemble();
        expect(assembled.containerRuntime).toBe('cloud-hypervisor');
        expect(validateEnclavesConfig(assembled)).toEqual([]);
      } else if (reason !== 'configuration-profile') {
        const write = jest.spyOn(jest.requireActual<typeof fs>('fs'), 'writeSync').mockReturnValue(1);
        const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('Rejected'); });
        expect(assemble).toThrow('Rejected');
        expect(write).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(write.mock.calls[0][1]).split('AWF_EARLY_STARTUP_FAILURE ')[1]))
          .toEqual({ schemaVersion: 1, phase: 'backend-selection',
            reason: `cloud-hypervisor-enclave-admission-${reason}` });
        expect(JSON.stringify(write.mock.calls)).not.toContain('PRIVATE_');
        write.mockRestore();
        exit.mockRestore();
      }
    });
    return accepted;
  }
  it.each(agents)('admits only the matching public single-use %s profile', agent => {
    expect(check(agent)).toBe(true);
    process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    expect(check(agent)).toBe(true);
  });
  it.each(agents)('admits the production %s configuration with a regional hosted OIDC endpoint', agent => {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL =
      'https://run-actions-2-azure-eastus.actions.githubusercontent.com/fixture/idtoken/job?api-version=2.0';
    expect(check(agent)).toBe(true);
    process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    expect(check(agent)).toBe(true);
  });
  it.each([
    { GITHUB_REPOSITORY: 'fork/firewall' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/other' }, { GITHUB_SHA: 'b'.repeat(40) },
    { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }, { GITHUB_WORKFLOW_REF: 'other/workflow@refs/heads/main' },
  ])('rejects untrusted workflow identity %j', env => {
    Object.assign(process.env, env);
    expect(check('copilot', undefined, 'workflow-source')).toBe(false);
  });
  it('rejects a tampered GitHub-issued identity token', () => {
    const token = signedOidcToken('schedule');
    const [header, payload, encodedSignature] = token.split('.');
    const signature = Buffer.from(encodedSignature, 'base64url');
    signature[0] ^= 1;
    oidcTokenOverride = `${header}.${payload}.${signature.toString('base64url')}`;
    expect(check('copilot', undefined, 'signature')).toBe(false);
  });
  it('requires the full repository claim in the signed identity token', () => {
    oidcClaimsOverride = { repository: 'gh-aw-firewall' };
    expect(check('copilot', undefined, 'claims')).toBe(false);
  });
  it.each([
    { workflow_ref: undefined }, { workflow_ref: 'other/workflow@refs/heads/main' },
    { workflow_sha: undefined }, { workflow_sha: 'b'.repeat(40) },
    { job_workflow_ref: `${signer}@refs/heads/main` },
    { workflow_ref: undefined, job_workflow_ref: `${signer}@refs/heads/main` },
  ])('rejects missing, mismatched or reusable signed workflow identity (%#)', claims => {
    oidcClaimsOverride = claims;
    expect(check('copilot', undefined, 'claims')).toBe(false);
  });
  it.each([
    { iss: 'https://untrusted.invalid' }, { aud: 'other' }, { exp: 0 },
    { nbf: Math.floor(Date.now() / 1000) + 3600 }, { sha: 'b'.repeat(40) },
    { repository_owner: 'other' }, { ref: 'refs/heads/other' }, { event_name: 'pull_request' },
  ])('rejects invalid signed claims (%#)', claims => {
    oidcClaimsOverride = claims;
    expect(check('copilot', undefined, 'claims')).toBe(false);
  });
  it.each([
    undefined, 'http://pipelines.actions.githubusercontent.com/idtoken',
    'https://pipelines.actions.githubusercontent.com.evil.invalid/idtoken',
    'https://actions.githubusercontent.com/idtoken',
    'https://user@pipelines.actions.githubusercontent.com/idtoken',
    'https://pipelines.actions.githubusercontent.com:8443/idtoken',
    'https://pipelines.actions.githubusercontent.com/idtoken#fragment',
    'https://pipelines.actions.githubusercontent.com/idtoken\nheader = "PRIVATE"',
  ])('rejects unsafe or missing token request destinations (%#)', url => {
    if (url === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = url;
    expect(check('copilot', undefined, 'token-acquisition')).toBe(false);
  });
  it.each(['token', 'jwks'] as const)('classifies %s acquisition failures without provider text', stage => {
    oidcFailure = stage;
    expect(check('copilot', undefined, stage === 'token' ? 'token-acquisition' : 'signature')).toBe(false);
  });
  it('rejects malformed tokens before claims can be trusted', () => {
    oidcTokenOverride = 'malformed';
    expect(check('copilot', undefined, 'signature')).toBe(false);
  });
  it.each([
    (config: WrapperConfig) => { config.enclaves!.privateRepos[0].sensitivity = 'internal'; },
    (config: WrapperConfig) => { config.enclaves!.executors.agent.runtime = 'docker'; },
    (config: WrapperConfig) => { config.enclaves!.executors.agent.maxInvocations = 2; },
    (config: WrapperConfig) => { config.enclaves!.executors.agent.model = 'other'; },
    (config: WrapperConfig) => { config.enclaves!.executors.agent.image = 'custom'; },
    (config: WrapperConfig) => { config.enclaves!.executors.script.enabled = true; },
    (config: WrapperConfig) => { config.cloudHypervisor!.developmentAllowUnattestedArtifacts = true; },
    (config: WrapperConfig) => { config.imageTag = 'latest'; },
  ])('preserves fail-closed admission outside the exact profile (%#)', change => {
    expect(check('copilot', change, 'configuration-profile')).toBe(false);
  });
});

describe.each(agents)('%s launch orchestration', agent => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-regression-launch-')); });
  afterEach(() => {
    jest.dontMock('node:child_process');
    jest.dontMock('./cloud-hypervisor-enclave-live-smoke');
    jest.dontMock('./collect-enclave-smoke-debug.cjs');
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function launch(runtime: string, failure?: Error, options: {
    audit?: string; missingAudit?: boolean; incomplete?: boolean; keepWork?: boolean; keepChrootHome?: boolean;
    stopFailure?: boolean; exitCode?: number | null; signal?: string;
    gatewayFailure?: boolean; gatewayThrow?: boolean; retentionFailure?: boolean;
    stopFileFailure?: boolean; stopRequestFailure?: boolean; preStart?: boolean;
  } = {}) {
    const child = { exitCode: failure ? 1 : null as number | null, signalCode: null };
    const primaryVm = {
      namespaces: ['awfvm-0123456789ab'], processes: [{ pid: '123', startTime: '456' }],
      cgroups: [{ name: 'primary', device: 1, inode: 789 }],
    };
    const retained = jest.fn();
    const finalized = jest.fn((_directory: string, _record: ReturnType<typeof JSON.parse>) => {
      if (options.retentionFailure) throw new Error('PRIVATE_RETENTION');
    });
    let config: ReturnType<typeof configuration>;
    let workDirectory: string;
    const fixture = {
      ...live,
      startGatewayFixture: jest.fn(({ onStarted }) => { onStarted(); return { endpoint: 'fixture-only' }; }),
      spawnAwf: jest.fn((args: string[]) => {
        config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
        workDirectory = args[args.indexOf('--work-dir') + 1];
        expect(fs.existsSync(workDirectory)).toBe(false);
        if (!options.preStart) fs.mkdirSync(workDirectory, { mode: 0o700 });
        return child;
      }),
      waitForBroker: jest.fn(async () => { if (failure) throw failure; }),
      waitForHostGatewayReadiness: jest.fn(),
      waitForPrimaryVmReadiness: jest.fn(async (_awf, _deadline, _diagnostics, readiness) => {
        readiness.onReady('100.64.0.2');
        return primaryVm;
      }),
      waitForDockerPrimaryReadiness: jest.fn(),
      requestMcp: jest.fn(async (_endpoint, _key, id, _method, params) => id !== 3 ? {} : {
        jsonrpc: '2.0', id, result: {
          structuredContent: { status: 'ok', result: Object.fromEntries(
            Object.entries(params.arguments.schema.fields).map(([name, field]) =>
              [name, (field as { value: unknown }).value])) },
          content: [],
        },
      }),
      assertProfileInitialize: jest.fn(), assertProfileTools: jest.fn(),
      parsePublicToolResult: jest.fn(response => response.result.structuredContent),
      emitStartupDiagnostic: jest.fn(),
      stopAwf: jest.fn(async () => {
        if (options.stopFailure) throw new Error('PRIVATE_STOP');
        child.exitCode = options.exitCode === undefined ? 0 : options.exitCode;
        if (options.signal) (child as { signalCode: string | null }).signalCode = options.signal;
        if (options.preStart) return;
        fs.mkdirSync(config.logging.auditDir, { recursive: true, mode: 0o700 });
        if (!options.missingAudit) {
          const audit = createProtectedAuditLog(config.logging.auditDir);
          audit.lifecycle('listening', { executors: ['agent'] });
          audit.invocation(invocation);
          const file = path.join(config.logging.auditDir, 'enclave.jsonl');
          if (options.audit !== undefined) fs.writeFileSync(file, options.audit);
          fs.chmodSync(file, 0o644);
        }
        if (options.incomplete) fs.writeFileSync(
          path.join(config.logging.auditDir, 'enclave-audit-incomplete.txt'), 'PRIVATE_CLEANUP');
        if (!options.keepWork) removeWorkDirectories(workDirectory);
        if (options.stopFileFailure) {
          const stop = path.join(directory, '.awf-enclave-regression-stop');
          fs.rmSync(stop, { force: true });
          fs.mkdirSync(stop);
        }
        if (options.keepChrootHome) fs.mkdirSync(`${workDirectory}-chroot-home`, { mode: 0o700 });
      }),
      removeGatewayFixture: jest.fn(() => {
        if (options.gatewayThrow) throw new Error('PRIVATE_GATEWAY');
        return !options.gatewayFailure;
      }),
    };
    let main: (environment: Record<string, string>) => Promise<void>;
    jest.spyOn(process, 'getuid').mockReturnValueOnce(0);
    if (options.stopRequestFailure) {
      const request = fixture.requestMcp;
      request.mockImplementation(async (...args: unknown[]) => {
        const id = args[2];
        const params = args[4] as { arguments: { schema: { fields: Record<string, { value: unknown }> } } };
        if (id !== 3) return {};
        fs.mkdirSync(path.join(directory, '.awf-enclave-regression-stop'));
        return { result: { structuredContent: { status: 'ok', result: Object.fromEntries(
          Object.entries(params.arguments.schema.fields).map(([name, field]) =>
            [name, (field as { value: unknown }).value])) } } };
      });
    }
    jest.isolateModules(() => {
      jest.doMock('node:child_process', () => ({
        ...jest.requireActual('node:child_process'), execFileSync: () => source,
      }));
      jest.doMock('./cloud-hypervisor-enclave-live-smoke', () => fixture);
      jest.doMock('./collect-enclave-smoke-debug.cjs', () => ({
        ...collector, retainStartup: retained, retainFinalization: finalized,
      }));
      main = require('./run-enclave-agent-regression').main;
    });
    let error: (Error & { errors: unknown[] }) | undefined;
    try {
      await main!({
        AGENT: agent, RUNTIME: runtime, SOURCE_SHA: source,
        GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
        GITHUB_WORKSPACE: directory, RUNNER_TEMP: directory, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
        COPILOT_GITHUB_TOKEN: 'fixture-only', OPENAI_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: 'fixture-only',
      });
    } catch (caught) { error = caught as Error & { errors: unknown[] }; }
    return { fixture, retained, finalized, error };
  }
  it.each(runtimes)('reaches readiness and validates exactly one %s invocation before cleanup', async runtime => {
    const { fixture, retained, finalized, error } = await launch(runtime);
    expect(error).toBeUndefined();
    expect(fixture.waitForBroker).toHaveBeenCalledTimes(1);
    expect(fixture.waitForHostGatewayReadiness).toHaveBeenCalledTimes(1);
    expect(fixture.waitForPrimaryVmReadiness).toHaveBeenCalledTimes(runtime === 'cloud-hypervisor' ? 1 : 0);
    expect(fixture.waitForDockerPrimaryReadiness).toHaveBeenCalledTimes(1);
    expect(fixture.waitForDockerPrimaryReadiness.mock.calls[0][4])
      .toEqual(runtime === 'cloud-hypervisor' ? {
        namespaces: ['awfvm-0123456789ab'], processes: [{ pid: '123', startTime: '456' }],
        cgroups: [{ name: 'primary', device: 1, inode: 789 }],
      } : undefined);
    const args = fixture.spawnAwf.mock.calls[0][0];
    expect(args[args.length - 1]).toMatch(/^set -e;/);
    expect(args[args.length - 1]).toContain(runtime === 'cloud-hypervisor'
      ? '/workspace/.awf-enclave-regression-stop' : path.join(directory, '.awf-enclave-regression-stop'));
    expect(fixture.requestMcp.mock.calls.map((call: unknown[]) => call[3])).toEqual(['initialize', 'tools/list', 'tools/call']);
    expect(fixture.requestMcp.mock.calls[2][4].arguments.prompt)
      .toContain(runtime === 'cloud-hypervisor' ? '100.64.0.2' : '172.30.0.20');
    expect(fixture.stopAwf).toHaveBeenCalledTimes(1);
    expect(fixture.removeGatewayFixture).toHaveBeenCalledTimes(1);
    expect(retained).not.toHaveBeenCalled();
    expect(finalized).toHaveBeenCalledWith('/var/lib/awf-enclave-smoke-export/123-1',
      expect.objectContaining({ resultValidated: true, primaryFailure: null, secondaryFailures: [] }));
    expect(Object.values(finalized.mock.calls[0][1].checks)).toEqual(
      Object.keys(collector.FINALIZATION_REASONS).map(() => ['passed', 'none']));
    const audit = path.join(path.dirname(fixture.spawnAwf.mock.calls[0][0][
      fixture.spawnAwf.mock.calls[0][0].indexOf('--config') + 1]), 'audit', 'enclave.jsonl');
    expect(fs.existsSync(audit)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(path.dirname(audit)), 'work'))).toBe(false);
  });
  it('leaves no harness-created work state when admission rejects before startup', async () => {
    const { fixture, finalized, error } = await launch('cloud-hypervisor',
      new Error('Admission rejected'), { preStart: true, exitCode: 1 });
    expect(error).toBeDefined();
    expect(fixture.requestMcp).not.toHaveBeenCalled();
    expect(finalized.mock.calls[0][1].checks['awf-cleanup']).toEqual(['passed', 'none']);
    expect(finalized.mock.calls[0][1].checks['awf-exit']).toEqual(['failed', 'nonzero-exit']);
    const args = fixture.spawnAwf.mock.calls[0][0];
    expect(fs.existsSync(args[args.indexOf('--work-dir') + 1])).toBe(false);
  });
  it('keeps the original launch failure and captures its startup record before cleanup', async () => {
    const failure = new Error('private original launch failure');
    const { fixture, retained, error } = await launch('docker', failure);
    expect(error!.errors[0]).toBe(failure);
    expect(retained).toHaveBeenCalledWith('/var/lib/awf-enclave-smoke-export/123-1', expect.objectContaining({
      failureStage: 'broker', diagnostic: expect.objectContaining({ reason: 'exit', exitCode: 1 }),
    }));
    expect(fixture.emitStartupDiagnostic.mock.calls[0][4]).toMatch(/proxy-logs\/awf-startup-error.json$/);
    expect(fixture.requestMcp).not.toHaveBeenCalled();
    expect(fixture.stopAwf).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ stopFailure: true }, 'awf-stop', 'stop-failed'],
    [{ exitCode: 1 }, 'awf-exit', 'nonzero-exit'],
    [{ exitCode: null }, 'awf-exit', 'not-exited'],
    [{ exitCode: null, signal: 'SIGTERM' }, 'awf-exit', 'signal'],
    [{ missingAudit: true }, 'audit-presence', 'missing'],
    [{ audit: '{"PRIVATE_INVALID":' }, 'audit-schema', 'invalid'],
    [{ audit: JSON.stringify({ ...invocation, invocationId: 1234567890123456 }) }, 'audit-schema', 'invalid'],
    [{ audit: JSON.stringify(invocation) + '\n' + JSON.stringify(invocation) }, 'audit-invocation', 'count'],
    [{ audit: JSON.stringify({ ...invocation, sensitivity: 'internal' }) }, 'audit-invocation', 'sensitivity'],
    [{ audit: JSON.stringify({ ...invocation, repo: 'private/repository' }) }, 'audit-invocation', 'repository'],
    [{ audit: JSON.stringify(invocation) + '\n' + JSON.stringify({
      ts: invocation.ts, kind: 'failure', reason: 'PRIVATE_FAILURE',
    }) }, 'audit-invocation', 'failure-record'],
    [{ incomplete: true }, 'awf-cleanup', 'incomplete-audit'],
    [{ keepWork: true }, 'awf-cleanup', 'work-dir-present'],
    [{ keepChrootHome: true }, 'awf-cleanup', 'work-dir-present'],
    [{ gatewayFailure: true }, 'gateway-cleanup', 'remove-failed'],
    [{ gatewayThrow: true }, 'gateway-cleanup', 'remove-failed'],
    [{ stopFileFailure: true }, 'stop-file-cleanup', 'remove-failed'],
    [{ stopRequestFailure: true }, 'awf-stop', 'stop-request-failed'],
    [{ retentionFailure: true }, 'diagnostic-retention', 'retention-failed'],
  ] as const)('rejects post-result gate %s', async (options, gate, reason) => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { fixture, finalized, error } = await launch('docker', undefined, options);
    expect(error).toBeDefined();
    expect(fixture.requestMcp).toHaveBeenCalledTimes(3);
    expect(fixture.removeGatewayFixture).toHaveBeenCalledTimes(1);
    const record = finalized.mock.calls[0][1];
    expect(record.resultValidated).toBe(true);
    expect(record.checks[gate]).toEqual(['failed', reason]);
    expect(record.primaryFailure).toEqual({ gate, reason });
    expect(stderr.mock.calls.map(call => call[0]).join('')).not.toMatch(/PRIVATE_|private\/repository/);
    expect(record.primaryFailure.gate).not.toBe('primary');
  });
  it('keeps primary invocation failure separate from all subsequent cleanup failures', async () => {
    const failure = new Error('PRIVATE_PRIMARY');
    const { finalized, error } = await launch('docker', failure, { exitCode: 1, gatewayFailure: true });
    expect(error!.errors[0]).toBe(failure);
    expect(finalized.mock.calls[0][1]).toMatchObject({
      primaryFailure: { gate: 'primary', reason: 'broker' },
      secondaryFailures: [
        { gate: 'awf-exit', reason: 'nonzero-exit' }, { gate: 'gateway-cleanup', reason: 'remove-failed' },
      ],
    });
  });
  it('keeps the first post-result failure separate from later gateway cleanup failure', async () => {
    const { finalized, error } = await launch('docker', undefined, { missingAudit: true, gatewayFailure: true });
    expect(error).toBeDefined();
    expect(finalized.mock.calls[0][1]).toMatchObject({
      resultValidated: true, primaryFailure: { gate: 'audit-presence', reason: 'missing' },
      secondaryFailures: [{ gate: 'gateway-cleanup', reason: 'remove-failed' }],
    });
  });
});

it('fails unless exactly one audited public invocation succeeds', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-regression-test-'));
  const file = path.join(directory, 'audit.jsonl');
  try {
    fs.writeFileSync(file, JSON.stringify(invocation), { mode: 0o600 });
    expect(() => assertAudit(file)).not.toThrow();
    for (const records of [[], [invocation, invocation], [invocation, { ts: invocation.ts, kind: 'failure', reason: 'failed' }],
      [{ ...invocation, sensitivity: 'internal' }], [{ kind: 'invocation', repo: invocation.repo, sensitivity: 'public' }],
      [{ ...invocation, invocationId: 1234567890123456 }],
      [{ ...invocation, invocationId: ['b'.repeat(24)] }],
      [null], ['invalid'], [{ ...invocation, bits: -1 }], [{ ...invocation, bucketMs: 0 }]]) {
      fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n'));
      expect(() => assertAudit(file)).toThrow();
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it.each(['symlink', 'hardlink', 'permissions', 'oversize', 'ancestor-symlink', 'owner', 'replacement'])(
  'rejects unsafe audit %s', kind => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-audit-safety-'));
    const file = path.join(directory, 'audit.jsonl');
    try {
      fs.writeFileSync(file, JSON.stringify(invocation), { mode: 0o600 });
      let target = file;
      if (kind === 'symlink') { fs.renameSync(file, file + '.real'); fs.symlinkSync(file + '.real', file); }
      else if (kind === 'hardlink') fs.linkSync(file, file + '.link');
      else if (kind === 'permissions') fs.chmodSync(file, 0o666);
      else if (kind === 'oversize') fs.truncateSync(file, 1024 * 1024 + 1);
      else if (kind === 'ancestor-symlink') {
        fs.symlinkSync(directory, directory + '-alias');
        target = path.join(directory + '-alias', 'audit.jsonl');
      } else {
        const mutableFs = require('node:fs');
        const fstat = mutableFs.fstatSync;
        jest.spyOn(mutableFs, 'fstatSync').mockImplementation((...args: unknown[]) => {
          const stat = fstat(...args);
          return kind === 'owner' ? Object.assign(stat, { uid: stat.uid + 1 }) : stat;
        });
        if (kind === 'replacement') {
          const read = mutableFs.readSync;
          jest.spyOn(mutableFs, 'readSync').mockImplementation((...args: unknown[]) => {
            const size = read(...args);
            fs.renameSync(file, file + '.old');
            fs.writeFileSync(file, JSON.stringify(invocation), { mode: 0o600 });
            return size;
          });
        }
      }
      expect(() => assertAudit(target)).toThrow(expect.objectContaining({
        gate: 'audit-presence', reason: 'unsafe',
      }));
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(directory + '-alias', { force: true });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
