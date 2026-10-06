'use strict';

// Script-only live run of examples/enclave-environment-probe through the public
// enclave MCP route. It reuses the release-attested live acceptance harness and
// needs no agent executor, API proxy, model, or Copilot credential.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');
const live = require('./cloud-hypervisor-enclave-live-smoke');

const PROBE_DIRECTORY = path.resolve(__dirname, '../../examples/enclave-environment-probe');
const PROBE_REPOSITORY = 'github/gh-aw-firewall';
const MAX_SCRIPT_BYTES = 16_384;
const MAX_RESULT_BYTES = 8192;
const MAX_SCHEMA_BYTES = 4096;
const RESULT_PREFIX = 'AWF_ENCLAVE_ENVIRONMENT_PROBE_RESULT ';
const EXPECTED_ENCLAVES = [{
  script: { maxScriptBytes: MAX_SCRIPT_BYTES },
  runtime: 'cloud-hypervisor',
  timeout: 30,
  maxOutputBytes: MAX_RESULT_BYTES,
  maxInvocations: 1,
  repos: [{ repo: PROBE_REPOSITORY, sensitivity: 'public' }],
}];

function finiteSchema() {
  return require('../../dist/bounded-execution/finite-schema');
}

// Generates tools/call parameters only; the probe source is never executed on the host.
function buildProbeRequest(generate = defaultGenerate, schemas = finiteSchema()) {
  let request;
  try {
    request = JSON.parse(generate());
  } catch {
    throw new Error('Environment probe request generation did not produce bounded JSON');
  }
  const source = fs.readFileSync(path.join(PROBE_DIRECTORY, 'probe.py'), 'utf8');
  if (!request || request.name !== 'enclave_run_script'
      || JSON.stringify(Object.keys(request).sort()) !== '["arguments","name"]'
      || JSON.stringify(Object.keys(request.arguments || {}).sort())
        !== '["privateRepo","schema","script"]'
      || request.arguments.privateRepo !== PROBE_REPOSITORY
      || request.arguments.script !== source
      || Buffer.byteLength(source, 'utf8') > MAX_SCRIPT_BYTES
      || Buffer.byteLength(JSON.stringify(request.arguments.schema), 'utf8') > MAX_SCHEMA_BYTES) {
    throw new Error('Environment probe request did not match the reviewed public probe contract');
  }
  if (containsStringNode(request.arguments.schema)) {
    throw new Error('Environment probe schema must remain finite metadata without free-form strings');
  }
  const validation = schemas.validateSchema(request.arguments.schema);
  if (!validation.valid) throw new Error('Environment probe schema is not a valid finite schema');
  return { request, schema: validation.schema };
}

function containsStringNode(node, depth = 0) {
  if (depth > 16 || node === null || typeof node !== 'object') return depth > 16;
  if (!Array.isArray(node) && node.type === 'string') return true;
  return Object.values(node).some((child) => containsStringNode(child, depth + 1));
}

function defaultGenerate() {
  // -E/-s ignore host Python environment and user site; the probe directory stays importable.
  const result = spawnSync('python3', ['-B', '-E', '-s', 'build-request.py'], {
    cwd: PROBE_DIRECTORY,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' },
    maxBuffer: 64 * 1024,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Environment probe request generation failed');
  }
  return result.stdout;
}

function loadExampleConfig() {
  const yaml = require('js-yaml');
  const config = yaml.load(fs.readFileSync(path.join(PROBE_DIRECTORY, 'awf.yaml'), 'utf8'));
  if (!isDeepStrictEqual(config?.enclaves, EXPECTED_ENCLAVES)
      || config.cloudHypervisor?.previewEnabled !== true
      || config.network?.isolation !== true) {
    throw new Error('Environment probe example config does not match the reviewed script-only contract');
  }
  return config;
}

function defaultApiTimeoutMs() {
  return require('../../dist/types/runtime-options').CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS;
}

// Merges only compiler-owned gateway attachment, artifact paths, and private log dirs into the example.
function makeProbeConfig(example, artifacts, workDir, apiTimeoutMs = defaultApiTimeoutMs()) {
  const main = artifacts.directory;
  return {
    ...example,
    network: { ...example.network, topologyAttach: [live.GATEWAY_CONTAINER] },
    cloudHypervisor: {
      ...example.cloudHypervisor,
      artifactReleaseTag: artifacts.tag,
      cloudHypervisorBinary: path.join(main, 'cloud-hypervisor'),
      kernelPath: path.join(main, 'vmlinux.bin'),
      rootfsPath: path.join(main, 'rootfs.ext4'),
      supervisorPath: path.join(main, 'awf-supervisor'),
      artifactManifestPath: path.join(main, live.RELEASE_ASSETS[1]),
      artifactManifestBundlePath: path.join(main, live.RELEASE_ASSETS[2]),
      vcpuCount: 1,
      memoryMib: 768,
      apiTimeoutMs,
    },
    logging: {
      auditDir: path.join(workDir, 'audit'),
      proxyLogsDir: path.join(workDir, 'proxy-logs'),
    },
  };
}

// Returns canonical metadata only after status ok and finite-schema validation; errors never fall back.
function assertProbeResult(response, requestId, schema, schemas = finiteSchema()) {
  const result = live.parsePublicToolResult(response, requestId);
  if (result.status !== 'ok') {
    throw new Error('Environment probe enclave returned the canonical error result');
  }
  const encoded = JSON.stringify(result.result);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES
      || !schemas.validateValueAgainstSchema(schema, result.result)) {
    throw new Error('Environment probe result did not validate against its bounded finite schema');
  }
  return encoded;
}

async function main() {
  if (process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== 'true'
      || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
      || !/^ubuntu/.test(process.env.ImageOS || '')) {
    throw new Error('Environment probe requires an opted-in GitHub-hosted Ubuntu runner as root');
  }
  const gate = require('./cloud-hypervisor-enclave-release-gate');
  const checkout = gate.verifyAcceptanceCheckout(process.env, gate.ENVIRONMENT_PROBE_REQUIRED_PATHS);
  if (!process.env.GH_TOKEN || !process.env.GITHUB_TOKEN) {
    throw new Error('Environment probe requires GH_TOKEN and GITHUB_TOKEN for public seed staging');
  }
  const { request, schema } = buildProbeRequest();
  const example = loadExampleConfig();
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/^(COPILOT_|OPENAI_|ANTHROPIC_|GEMINI_)/.test(name)) delete environment[name];
  }
  const tag = live.releaseTag();
  const root = fs.mkdtempSync(path.join(environment.RUNNER_TEMP || os.tmpdir(), 'awf-enclave-probe-'));
  fs.chmodSync(root, 0o700);
  const workDir = path.join(root, 'awf-work');
  const workspace = path.join(root, 'workspace');
  const awfOut = path.join(root, 'awf.stdout.log');
  const awfErr = path.join(root, 'awf.stderr.log');
  const configPath = path.join(root, 'awf-config.json');
  const startupErrorFile = path.join(workDir, 'proxy-logs', 'awf-startup-error.json');
  const gatewayIdentity = `gh-aw-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}-enclave-probe`;
  let awf;
  let gatewayStarted = false;
  let keepArtifacts = false;
  try {
    const artifacts = live.prepareReleaseArtifacts(tag, path.join(root, 'release-artifacts'), environment);
    for (const manifestPath of [
      path.join(artifacts.directory, live.RELEASE_ASSETS[1]),
      artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST,
    ]) {
      gate.assertManifestSource(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), checkout.tag, checkout.commit);
    }
    for (const directory of [workDir, path.join(workDir, 'audit'), path.join(workDir, 'proxy-logs')]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    fs.mkdirSync(workspace, { recursive: true, mode: 0o755 });
    fs.chmodSync(workspace, 0o755);
    const handoff = live.startGatewayFixture({
      gatewayEnv: path.join(root, 'gateway.env'),
      gatewayKey: crypto.randomBytes(36).toString('base64url'),
      capability: crypto.randomBytes(32).toString('hex'),
      identity: gatewayIdentity,
      onStarted: () => { gatewayStarted = true; },
    });
    fs.writeFileSync(configPath, `${JSON.stringify(makeProbeConfig(example, artifacts, workDir), null, 2)}\n`, {
      mode: 0o600, flag: 'wx',
    });
    awf = live.spawnAwf([
      path.resolve(__dirname, '../../dist/cli.js'),
      '--config', configPath,
      '--build-local',
      '--max-num-tool-calls', '1',
      '--work-dir', workDir,
      '--log-level', 'error',
      '--agent-timeout', '30',
      '--',
      'while [ ! -f /workspace/.awf-enclave-probe-stop ]; do sleep 1; done',
    ], {
      ...environment,
      ...artifacts.enclaveArtifactEnvironment,
      AWF_ENCLAVE_MCP_CAPABILITY: handoff.capability,
      AWF_ENCLAVE_MCP_GATEWAY_CONTAINER: live.GATEWAY_CONTAINER,
      AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: handoff.endpoint,
      AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: gatewayIdentity,
      AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS: '120000',
      MCP_GATEWAY_API_KEY: handoff.gatewayKey,
      GITHUB_WORKSPACE: workspace,
    }, awfOut, awfErr, 'initial');
    const diagnostics = { stage: 'initial', stderrFile: awfErr, startupErrorFile };
    await live.waitForBroker(awf, 'awf-enclave-mcp-server', Date.now() + 15 * 60_000, diagnostics);
    await live.waitForHostGatewayReadiness(awf, Date.now() + 150_000, diagnostics);

    const initialized = await live.requestMcp(handoff.endpoint, handoff.gatewayKey, 1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'awf-enclave-environment-probe', version: '1.0.0' },
    });
    if (initialized?.result?.serverInfo?.name !== 'awmg-awf-enclave') {
      throw new Error('Public enclave MCP initialize did not route through the live broker');
    }
    const tools = await live.requestMcp(handoff.endpoint, handoff.gatewayKey, 2, 'tools/list', {});
    const toolNames = tools?.result?.tools?.map((tool) => tool.name);
    if (JSON.stringify(toolNames) !== '["enclave_run_script"]') {
      throw new Error('Public enclave MCP tool list did not expose exactly the script executor');
    }
    const response = await live.requestMcp(
      handoff.endpoint, handoff.gatewayKey, 3, 'tools/call', request,
    );
    console.log(`${RESULT_PREFIX}${assertProbeResult(response, 3, schema)}`);
    await live.waitForVmCleanup(15_000);
  } finally {
    try {
      if (awf && awf.exitCode === null && awf.signalCode === null && !live.failedSpawns.has(awf)) {
        try {
          fs.writeFileSync(path.join(workspace, '.awf-enclave-probe-stop'), 'done\n', { mode: 0o644 });
          await live.stopAwf(awf);
        } catch {
          console.error('Could not stop AWF within environment probe cleanup');
          keepArtifacts = true;
          process.exitCode = 1;
        }
      }
      if (gatewayStarted && !live.removeGatewayFixture(gatewayIdentity)) {
        keepArtifacts = true;
        process.exitCode = 1;
      }
      try {
        live.assertNoVmResidue();
      } catch (error) {
        console.error(error.message);
        keepArtifacts = true;
        process.exitCode = 1;
      }
    } catch {
      console.error('Environment probe cleanup failed; private recovery state was preserved');
      keepArtifacts = true;
      process.exitCode = 1;
    } finally {
      try {
        live.removePrivateAwfLogs(awfOut, awfErr, [startupErrorFile]);
        if (keepArtifacts) {
          console.error('Environment probe private recovery state was retained on the ephemeral runner; AWF stdout/stderr and startup error records were removed.');
        } else {
          fs.rmSync(root, { recursive: true, force: true });
        }
      } catch {
        console.error('Could not remove environment probe private diagnostic files');
        process.exitCode = 1;
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Environment probe failed');
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_ENCLAVES,
  RESULT_PREFIX,
  assertProbeResult,
  buildProbeRequest,
  loadExampleConfig,
  makeProbeConfig,
};
