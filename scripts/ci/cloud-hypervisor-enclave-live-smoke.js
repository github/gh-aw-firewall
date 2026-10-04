'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { isDeepStrictEqual } = require('util');

const RELEASE_ASSETS = [
  'cloud-hypervisor-test-x86_64.tar.gz',
  'cloud-hypervisor-test-x86_64.manifest.json',
  'cloud-hypervisor-test-x86_64.manifest.sigstore.jsonl',
  'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json',
  'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
  'enclave-script-rootfs.ext4',
  'enclave-agent-rootfs.ext4',
  'enclave-script-rootfs.sbom.spdx.json',
  'enclave-agent-rootfs.sbom.spdx.json',
  'enclave-script-rootfs.provenance.sigstore.jsonl',
  'enclave-agent-rootfs.provenance.sigstore.jsonl',
];
const GATEWAY_IMAGE = 'awf-cloud-hypervisor-enclave-live-gateway:test';
const GATEWAY_CONTAINER = 'awmg-mcpg';
const SENTINEL_PREFIX = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_';

function assertReleaseAssets(required, published) {
  const available = new Set(published);
  const missing = required.filter((asset) => !available.has(asset));
  if (missing.length) {
    throw new Error(
      `Package-matched AWF release is missing required release-attested Cloud Hypervisor assets: ${missing.join(', ')}. `
      + 'Publish a release for this package version with the attested Cloud Hypervisor and enclave artifact set; '
      + 'unattested build artifacts are not accepted.',
    );
  }
}

function parsePublicToolResult(response, requestId) {
  if (!response || response.jsonrpc !== '2.0' || response.id !== requestId
      || response.error || !response.result || response.result.isError === true) {
    throw new Error('Public enclave MCP call did not return a successful JSON-RPC result');
  }
  const structured = response.result.structuredContent;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)
      || !['ok', 'error'].includes(structured.status)) {
    throw new Error('Public enclave MCP result is not canonical structured content');
  }
  const keys = Object.keys(structured).sort();
  if (JSON.stringify(keys) !== JSON.stringify(
    structured.status === 'ok' ? ['result', 'status'] : ['status'],
  )) {
    throw new Error('Public enclave MCP result contains unexpected fields');
  }
  const content = response.result.content;
  if (!Array.isArray(content) || content.length !== 1
      || content[0]?.type !== 'text'
      || content[0].text !== JSON.stringify(structured)) {
    throw new Error('Public enclave MCP text and structured results do not match canonically');
  }
  return structured;
}

function scanTextDirectory(directory, sentinel, found) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Could not inspect live enclave diagnostic output');
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      scanTextDirectory(file, sentinel, found);
    } else if (entry.isFile() && /\.(?:json|jsonl|log|txt)$/i.test(entry.name)) {
      const stat = fs.statSync(file);
      if (stat.size > 16 * 1024 * 1024) {
        throw new Error('Live enclave diagnostic file exceeded the scan bound');
      }
      if (fs.readFileSync(file).includes(Buffer.from(sentinel, 'utf8'))) found.value = true;
    }
  }
}

function assertNoSentinelLeak(directories, logContents, sentinel) {
  if (logContents.some((content) => content.includes(sentinel))) {
    throw new Error('Synthetic enclave output sentinel escaped into a captured log');
  }
  const found = { value: false };
  for (const directory of directories) scanTextDirectory(directory, sentinel, found);
  if (found.value) {
    throw new Error('Synthetic enclave output sentinel escaped into audit or diagnostic files');
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Required live enclave command failed: ${path.basename(command)}`);
  }
  return result.stdout;
}

function requestMcp(endpoint, apiKey, requestId, method, params, abortAfterMs) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }));
    const request = http.request(endpoint, {
      method: 'POST',
      headers: {
        authorization: apiKey,
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
      timeout: abortAfterMs ? abortAfterMs + 1000 : 4860_000,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 420 * 1024) request.destroy(new Error('MCP response exceeded its bound'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('Public enclave MCP response was not bounded JSON'));
        }
      });
    });
    let cancelled = false;
    const cancelTimer = abortAfterMs
      ? setTimeout(() => {
        cancelled = true;
        request.destroy();
        resolve(undefined);
      }, abortAfterMs)
      : undefined;
    request.on('error', () => {
      if (!cancelled) reject(new Error('Public enclave MCP request failed'));
    });
    request.on('close', () => {
      if (cancelTimer) clearTimeout(cancelTimer);
    });
    request.end(payload);
  });
}

async function waitForBroker(child, container, deadline) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`AWF exited before the public enclave broker became ready (exit ${child.exitCode})`);
    }
    const result = spawnSync('docker', [
      'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      container,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.status === 0 && ['healthy', 'running'].includes(result.stdout.trim())) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for the live enclave broker');
}

function assertNoVmResidue() {
  const namespaces = run('ip', ['netns', 'list']);
  if (/^awfvm-/m.test(namespaces)) throw new Error('Cloud Hypervisor namespace residue remains');
  const processes = spawnSync('pgrep', [
    '-f', '[c]loud-hypervisor --api-socket',
  ], { encoding: 'utf8' });
  if (processes.status === 0) throw new Error('Cloud Hypervisor process residue remains');
  if (processes.status !== 1) throw new Error('Could not inspect Cloud Hypervisor process state');
  const cgroupRoot = '/sys/fs/cgroup/awf-cloud-hypervisor';
  if (fs.existsSync(cgroupRoot)
      && fs.readdirSync(cgroupRoot, { withFileTypes: true }).some((entry) => entry.isDirectory())) {
    throw new Error('Cloud Hypervisor cgroup residue remains');
  }
}

async function waitForVmCleanup(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let residueError;
  while (Date.now() < deadline) {
    try {
      assertNoVmResidue();
      return;
    } catch (error) {
      if (!/residue remains/.test(error.message)) throw error;
      residueError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw residueError || new Error('Cloud Hypervisor VM cleanup did not complete');
}

function assertCanonicalToolError(response, requestId, label) {
  const result = parsePublicToolResult(response, requestId);
  if (result.status !== 'error') {
    throw new Error(`Live enclave ${label} did not return the canonical bounded error`);
  }
}

function releaseTag() {
  const version = require('../../package.json').version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('AWF package version cannot select a trusted release');
  }
  return `v${version}`;
}

function prepareReleaseArtifacts(tag, directory, environment) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let published;
  try {
    published = run('gh', [
      'release', 'view', tag, '--repo', 'github/gh-aw-firewall', '--json', 'assets',
      '--jq', '.assets[].name',
    ], { env: environment });
  } catch (error) {
    throw new Error(
      `Package-matched AWF release ${tag} is unavailable; publish its signed Cloud Hypervisor and enclave artifact set before opting into live acceptance.`,
      { cause: error },
    );
  }
  const assets = published.trim().split(/\r?\n/).filter(Boolean);
  assertReleaseAssets(RELEASE_ASSETS, assets);
  run('gh', [
    'release', 'download', tag, '--repo', 'github/gh-aw-firewall', '--dir', directory,
    '--pattern', RELEASE_ASSETS[0],
    '--pattern', RELEASE_ASSETS[1],
    '--pattern', RELEASE_ASSETS[2],
  ], { env: environment });
  run('tar', [
    '--extract', '--gzip', '--file', path.join(directory, RELEASE_ASSETS[0]),
    '--directory', directory,
  ]);
  const enclaveCache = path.join(directory, 'enclave-cache');
  const setup = run('bash', [
    path.join(__dirname, '../../guest/cloud-hypervisor/setup-enclave-artifacts.sh'),
    tag,
    enclaveCache,
  ], { env: environment });
  if (!setup.includes(`AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS=${path.join(enclaveCache, tag, 'x86_64', 'enclave-script-rootfs.ext4')}`)) {
    throw new Error('Release-attested enclave artifact setup did not resolve the script rootfs');
  }
  return {
    directory,
    enclaveDirectory: path.join(enclaveCache, tag, 'x86_64'),
    tag,
  };
}

function makeConfig(artifacts, workDir, workspace, handoff) {
  const enclaveRepository = { repo: 'github/gh-aw-firewall', sensitivity: 'public' };
  const main = artifacts.directory;
  return {
    network: {
      isolation: true,
      allowDomains: ['github.com', 'api.github.com', 'api.githubcopilot.com'],
      topologyAttach: [GATEWAY_CONTAINER],
    },
    cloudHypervisor: {
      previewEnabled: true,
      mountPolicy: 'workspace-only',
      artifactReleaseTag: artifacts.tag,
      cloudHypervisorBinary: path.join(main, 'cloud-hypervisor'),
      kernelPath: path.join(main, 'vmlinux.bin'),
      rootfsPath: path.join(main, 'rootfs.ext4'),
      supervisorPath: path.join(main, 'awf-supervisor'),
      artifactManifestPath: path.join(main, RELEASE_ASSETS[1]),
      artifactManifestBundlePath: path.join(main, RELEASE_ASSETS[2]),
      vcpuCount: 1,
      memoryMib: 768,
    },
    enclaves: [
      {
        script: { maxScriptBytes: 16_384 },
        runtime: 'cloud-hypervisor',
        timeout: 120,
        maxInvocations: 8,
        repos: [enclaveRepository],
      },
      {
        agent: {
          model: 'gpt-4.1',
          engine: 'copilot',
          profile: 'openai',
          maxModelRequests: 1,
          maxModelTokens: 256,
          maxTaskBytes: 4096,
        },
        runtime: 'cloud-hypervisor',
        timeout: 180,
        maxInvocations: 2,
        repos: [enclaveRepository],
      },
    ],
    container: { containerRuntime: 'docker' },
    apiProxy: { enabled: true },
    logging: {
      auditDir: path.join(workDir, 'audit'),
      proxyLogsDir: path.join(workDir, 'proxy-logs'),
    },
    testWorkspace: workspace,
    testGateway: handoff,
  };
}

function toAwfConfig(config) {
  const { testWorkspace, testGateway, ...awfConfig } = config;
  void testWorkspace;
  void testGateway;
  return awfConfig;
}

async function main() {
  if (process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== 'true'
      || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
      || !/^ubuntu/.test(process.env.ImageOS || '')) {
    throw new Error('Live enclave acceptance requires an opted-in GitHub-hosted Ubuntu runner as root');
  }
  if (!process.env.GH_TOKEN || !process.env.GITHUB_TOKEN) {
    throw new Error('Live enclave acceptance requires GH_TOKEN and GITHUB_TOKEN for public seed staging');
  }
  if (!process.env.COPILOT_GITHUB_TOKEN) {
    throw new Error('Live agent-enclave acceptance requires the COPILOT_GITHUB_TOKEN repository secret');
  }
  const environment = { ...process.env };
  const tag = releaseTag();
  const runnerTemp = environment.RUNNER_TEMP || os.tmpdir();
  const root = fs.mkdtempSync(path.join(runnerTemp, 'awf-enclave-live-'));
  fs.chmodSync(root, 0o700);
  const artifactsDir = path.join(root, 'release-artifacts');
  const workDir = path.join(root, 'awf-work');
  const workspace = path.join(root, 'workspace');
  const gatewayEnv = path.join(root, 'gateway.env');
  const awfOut = path.join(root, 'awf.stdout.log');
  const awfErr = path.join(root, 'awf.stderr.log');
  const gatewayKey = crypto.randomBytes(36).toString('base64url');
  const capability = crypto.randomBytes(32).toString('hex');
  const gatewayIdentity = `gh-aw-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}-enclave-live`;
  let awf;
  let gatewayStarted = false;
  let keepArtifacts = false;
  try {
    const artifacts = prepareReleaseArtifacts(tag, artifactsDir, environment);
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(workDir, 'audit'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(workDir, 'proxy-logs'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(gatewayEnv, [
      'MCP_GATEWAY_PORT=8080',
      `MCP_GATEWAY_API_KEY=${gatewayKey}`,
      `AWF_ENCLAVE_MCP_CAPABILITY=${capability}`,
      '',
    ].join('\n'), { mode: 0o600, flag: 'wx' });

    run('docker', [
      'run', '--detach', '--name', GATEWAY_CONTAINER,
      '--label', `com.github.gh-aw.mcpg.run=${gatewayIdentity}`,
      '--publish', '127.0.0.1::8080',
      '--env-file', gatewayEnv,
      GATEWAY_IMAGE,
    ]);
    gatewayStarted = true;
    const gatewayInspect = JSON.parse(run('docker', [
      'inspect', '--format', '{{json .NetworkSettings.Ports}}', GATEWAY_CONTAINER,
    ]));
    const mapping = gatewayInspect['8080/tcp']?.[0];
    if (!mapping?.HostPort) throw new Error('Live enclave gateway did not bind its loopback route');
    const endpoint = `http://127.0.0.1:${mapping.HostPort}/mcp/awf-enclave`;
    const configPath = path.join(root, 'awf-config.json');
    const config = toAwfConfig(makeConfig(artifacts, workDir, workspace, {
      capability,
      gatewayKey,
      endpoint,
      identity: gatewayIdentity,
    }));
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });

    const cliLogOut = fs.openSync(awfOut, 'wx', 0o600);
    const cliLogErr = fs.openSync(awfErr, 'wx', 0o600);
    awf = spawn(process.execPath, [
      path.resolve(__dirname, '../../dist/cli.js'),
      '--config', configPath,
      '--build-local',
      '--enable-api-proxy',
      '--max-num-tool-calls', '8',
      '--work-dir', workDir,
      '--log-level', 'error',
      '--agent-timeout', '45',
      '--',
      'while [ ! -f /workspace/.awf-enclave-live-stop ]; do sleep 1; done',
    ], {
      env: {
        ...environment,
        AWF_ENCLAVE_MCP_CAPABILITY: capability,
        AWF_ENCLAVE_MCP_GATEWAY_CONTAINER: GATEWAY_CONTAINER,
        AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: endpoint,
        AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: gatewayIdentity,
        AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS: '120000',
        MCP_GATEWAY_API_KEY: gatewayKey,
        GITHUB_WORKSPACE: workspace,
        GH_TOKEN: environment.GH_TOKEN,
        GITHUB_TOKEN: environment.GITHUB_TOKEN,
      },
      stdio: ['ignore', cliLogOut, cliLogErr],
    });
    fs.closeSync(cliLogOut);
    fs.closeSync(cliLogErr);
    await waitForBroker(awf, 'awf-enclave-mcp-server', Date.now() + 15 * 60_000);

    const initialized = await requestMcp(
      endpoint, gatewayKey, 1, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'awf-live-enclave-conformance', version: '1.0.0' },
      },
    );
    if (initialized?.result?.serverInfo?.name !== 'awmg-awf-enclave') {
      throw new Error('Public enclave MCP initialize did not route through the live broker');
    }
    const tools = await requestMcp(endpoint, gatewayKey, 2, 'tools/list', {});
    const toolNames = tools?.result?.tools?.map((tool) => tool.name).sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(['enclave_run_agent', 'enclave_run_script'])) {
      throw new Error('Public enclave MCP tool list did not expose exactly the static executors');
    }

    const sentinel = `${SENTINEL_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
    const probeSchema = {
      type: 'object',
      properties: {
        uid: { type: 'integer', const: 65534 },
        gid: { type: 'integer', const: 65534 },
        seedReadOnly: { type: 'boolean', const: true },
        noNetwork: { type: 'boolean', const: true },
        onlyLoopback: { type: 'boolean', const: true },
        privilegeDropDenied: { type: 'boolean', const: true },
        noNewPrivileges: { type: 'boolean', const: true },
        emptyEffectiveCapabilities: { type: 'boolean', const: true },
        processLimit: { type: 'integer', const: 47 },
        fileSizeLimit: { type: 'integer', const: 536870912 },
        openFileLimit: { type: 'integer', const: 1024 },
      },
      required: [
        'uid', 'gid', 'seedReadOnly', 'noNetwork', 'onlyLoopback',
        'privilegeDropDenied', 'noNewPrivileges', 'emptyEffectiveCapabilities',
        'processLimit', 'fileSizeLimit', 'openFileLimit',
      ],
      additionalProperties: false,
    };
    const python = [
      'import errno, json, os, re, resource, socket, sys',
      `print(${JSON.stringify(sentinel)})`,
      `print(${JSON.stringify(sentinel)}, file=sys.stderr)`,
      'status = open("/proc/self/status", encoding="ascii").read()',
      'effective = int(re.search(r"^CapEff:\\s+([0-9a-f]+)$", status, re.M).group(1), 16)',
      'no_new_privileges = re.search(r"^NoNewPrivs:\\s+1$", status, re.M) is not None',
      'seed = "/awf/seed/README.md"',
      'os.stat(seed)',
      'try:',
      '    fd = os.open(seed, os.O_WRONLY | os.O_APPEND)',
      'except OSError as error:',
      '    seed_read_only = error.errno == errno.EROFS',
      'else:',
      '    os.close(fd)',
      '    seed_read_only = False',
      'try:',
      '    socket.create_connection(("1.1.1.1", 443), timeout=2)',
      'except OSError:',
      '    no_network = True',
      'else:',
      '    no_network = False',
      '    raise SystemExit(1)',
      'try:',
      '    os.setuid(0)',
      'except PermissionError:',
      '    privilege_drop_denied = True',
      'else:',
      '    privilege_drop_denied = False',
      '    raise SystemExit(1)',
      'result = {',
      '    "uid": os.geteuid(), "gid": os.getegid(), "seedReadOnly": seed_read_only,',
      '    "noNetwork": no_network, "onlyLoopback": [n for _, n in socket.if_nameindex()] == ["lo"],',
      '    "privilegeDropDenied": privilege_drop_denied, "noNewPrivileges": no_new_privileges,',
      '    "emptyEffectiveCapabilities": effective == 0,',
      '    "processLimit": resource.getrlimit(resource.RLIMIT_NPROC)[0],',
      '    "fileSizeLimit": resource.getrlimit(resource.RLIMIT_FSIZE)[0],',
      '    "openFileLimit": resource.getrlimit(resource.RLIMIT_NOFILE)[0],',
      '}',
      'open("out", "w", encoding="utf8").write(json.dumps(result, separators=(",", ":")))',
    ].join('\n');
    const scriptResponse = await requestMcp(endpoint, gatewayKey, 3, 'tools/call', {
      name: 'enclave_run_script',
      arguments: { privateRepo: 'github/gh-aw-firewall', schema: probeSchema, script: python },
    });
    const scriptResult = parsePublicToolResult(scriptResponse, 3);
    if (scriptResult.status !== 'ok'
        || !isDeepStrictEqual(scriptResult.result, {
          uid: 65534,
          gid: 65534,
          seedReadOnly: true,
          noNetwork: true,
          onlyLoopback: true,
          privilegeDropDenied: true,
          noNewPrivileges: true,
          emptyEffectiveCapabilities: true,
          processLimit: 47,
          fileSizeLimit: 536870912,
          openFileLimit: 1024,
        })) {
      throw new Error('Live script enclave guest identity, filesystem, network, or resource assertion failed');
    }
    await waitForVmCleanup(15_000);

    const agentResultValue = 'AWF_ENCLAVE_LIVE_AGENT_RESULT';
    const agentResponse = await requestMcp(endpoint, gatewayKey, 4, 'tools/call', {
      name: 'enclave_run_agent',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: { type: 'string', enum: [agentResultValue] },
        prompt: `Return exactly the string ${JSON.stringify(agentResultValue)}. Do not inspect or quote repository files.`,
      },
    });
    const agentResult = parsePublicToolResult(agentResponse, 4);
    if (agentResult.status !== 'ok' || agentResult.result !== agentResultValue) {
      throw new Error('Live agent enclave did not return the bounded canonical result');
    }
    await waitForVmCleanup(15_000);

    const errorSchema = { type: 'boolean', const: true };
    const guestFailure = await requestMcp(endpoint, gatewayKey, 5, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: errorSchema,
        script: 'raise SystemExit(23)',
      },
    });
    assertCanonicalToolError(guestFailure, 5, 'guest failure');
    await waitForVmCleanup(15_000);

    const timeout = await requestMcp(endpoint, gatewayKey, 6, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: errorSchema,
        script: 'import time; time.sleep(150)',
      },
    });
    assertCanonicalToolError(timeout, 6, 'timeout');
    await waitForVmCleanup(15_000);

    const cancelled = await requestMcp(endpoint, gatewayKey, 7, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: errorSchema,
        script: 'while True: pass',
      },
    }, 30_000);
    if (cancelled !== undefined) {
      throw new Error('Public MCP disconnect did not cancel the live enclave request');
    }
    await waitForVmCleanup(15_000);

    const logContents = [
      fs.readFileSync(awfOut, 'utf8'),
      fs.readFileSync(awfErr, 'utf8'),
      run('docker', ['logs', GATEWAY_CONTAINER], { maxBuffer: 1024 * 1024 }),
      run('docker', ['logs', 'awf-enclave-mcp-server'], { maxBuffer: 1024 * 1024 }),
    ];
    const privateRoot = path.join('/var/tmp', `awf-enclave-private-0-${crypto.createHash('sha256')
      .update(path.resolve(workDir), 'utf8').digest('hex').slice(0, 20)}`);
    const journalRoot = '/var/lib/awf-cloud-hypervisor/host-executor-journal';
    assertNoSentinelLeak([
      path.join(workDir, 'audit'),
      path.join(workDir, 'proxy-logs'),
      path.join(privateRoot, 'audit'),
      path.join(privateRoot, 'api-proxy-logs'),
      journalRoot,
    ], [
      ...logContents,
      run('docker', ['logs', 'awf-api-proxy'], { maxBuffer: 1024 * 1024 }),
      run('docker', ['logs', 'awf-enclave-agent-api-proxy'], { maxBuffer: 1024 * 1024 }),
      run('docker', ['logs', 'awf-squid'], { maxBuffer: 1024 * 1024 }),
    ], sentinel);
    console.log('Live script and agent broker calls, guest failure, timeout, cancellation, cleanup, and output redaction checks passed.');
  } finally {
    if (awf && awf.exitCode === null) {
      fs.writeFileSync(path.join(workspace, '.awf-enclave-live-stop'), 'done\n', { mode: 0o600 });
      const timeout = setTimeout(() => {
        if (awf.exitCode === null) awf.kill('SIGTERM');
      }, 60_000);
      await new Promise((resolve) => awf.once('exit', resolve));
      clearTimeout(timeout);
    }
    if (gatewayStarted) {
      spawnSync('docker', ['rm', '--force', GATEWAY_CONTAINER], { encoding: 'utf8' });
    }
    try {
      assertNoVmResidue();
    } catch (error) {
      console.error(error.message);
      keepArtifacts = true;
    }
    if (keepArtifacts) {
      console.error('Live enclave private diagnostics were retained on the ephemeral runner for failure triage.');
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Live enclave acceptance failed');
    process.exitCode = 1;
  });
}

module.exports = {
  RELEASE_ASSETS,
  assertReleaseAssets,
  assertNoSentinelLeak,
  parsePublicToolResult,
  requestMcp,
};
