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

function readDiagnosticFile(file) {
  const maxBytes = 16 * 1024 * 1024;
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY
      | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('Live enclave diagnostic is not a regular file');
    if (stat.size > maxBytes) {
      throw new Error('Live enclave diagnostic file exceeded the scan bound');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const bytes = fs.readSync(descriptor, buffer, size, buffer.length - size, null);
      if (bytes === 0) break;
      size += bytes;
    }
    if (size > maxBytes) {
      throw new Error('Live enclave diagnostic file exceeded the scan bound');
    }
    return buffer.subarray(0, size);
  } catch (error) {
    if (error.code) throw new Error('Could not inspect live enclave diagnostic file');
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
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
      if (readDiagnosticFile(file).includes(Buffer.from(sentinel, 'utf8'))) found.value = true;
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

function requestMcp(endpoint, apiKey, requestId, method, params, signal) {
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
      timeout: 4860_000,
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
    const cancel = () => {
      cancelled = true;
      request.destroy();
      resolve(undefined);
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    request.on('error', () => {
      if (!cancelled) reject(new Error('Public enclave MCP request failed'));
    });
    request.on('close', () => signal?.removeEventListener('abort', cancel));
    if (!cancelled) request.end(payload);
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

function assertExpectedToolResult(response, requestId, expected, label) {
  const result = parsePublicToolResult(response, requestId);
  if (result.status !== 'ok' || !isDeepStrictEqual(result.result, expected)) {
    throw new Error(`Live enclave ${label} guest assertion failed`);
  }
}

function buildAgentGuestProbe() {
  const expected = {
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
  };
  const properties = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [
      key,
      { const: value, type: typeof value === 'number' ? 'integer' : typeof value },
    ]),
  );
  const schema = {
    type: 'object',
    properties,
    required: Object.keys(expected),
    additionalProperties: false,
  };
  const python = [
    'import json, os, re, resource, socket',
    'status = open("/proc/self/status", encoding="ascii").read()',
    'effective = int(re.search(r"^CapEff:\\s+([0-9a-f]+)$", status, re.M).group(1), 16)',
    'no_new_privileges = re.search(r"^NoNewPrivs:\\s+1$", status, re.M) is not None',
    'interfaces = [name for _, name in socket.if_nameindex()]',
    'def reachable(ip, port):',
    '    try:',
    '        with socket.create_connection((ip, port), timeout=0.75):',
    '            return True',
    '    except OSError:',
    '        return False',
    'result = {',
    '    "uid": os.geteuid(), "gid": os.getegid(),',
    '    "onlyExpectedInterfaces": len(interfaces) == 2 and interfaces.count("lo") == 1,',
    '    "emptyEffectiveCapabilities": effective == 0, "noNewPrivileges": no_new_privileges,',
    '    "processLimit": resource.getrlimit(resource.RLIMIT_NPROC)[0],',
    '    "fileSizeLimit": resource.getrlimit(resource.RLIMIT_FSIZE)[0],',
    '    "openFileLimit": resource.getrlimit(resource.RLIMIT_NOFILE)[0],',
    '    "apiProxyReachable": reachable("172.31.0.30", 10002),',
    '    "wrongPortBlocked": not reachable("172.31.0.30", 10000),',
    '    "wrongPeerBlocked": not reachable("172.31.0.99", 10002),',
    '    "githubPeerBlocked": not reachable("172.31.0.40", 8080),',
    '    "publicEgressBlocked": not reachable("1.1.1.1", 443),',
    '}',
    'encoded = json.dumps(result, separators=(",", ":"))',
    'print(encoded)',
    'open("/awf/out", "w", encoding="utf8").write(encoded)',
  ].join('\n');
  return {
    expected,
    schema,
    prompt: [
      'Run this exact diagnostic with your shell tool using python3. Do not inspect repository files or make network requests other than those in the script.',
      '```bash',
      "python3 - <<'PY'",
      python,
      'PY',
      '```',
      'Return exactly the JSON object printed by the diagnostic, with no extra fields. Write that exact object to /awf/out as required by your result contract.',
    ].join('\n'),
  };
}

function buildEnospcProbeScript(maxStorageMib = 1024) {
  if (maxStorageMib !== 512 && maxStorageMib !== 1024) {
    throw new Error('Live enclave storage probe requires a supported role ceiling');
  }
  const maximumFiles = maxStorageMib / 64;
  return [
    'import errno, json, os',
    'directory = "/output"',
    'chunk = b"x" * (8 * 1024 * 1024)',
    'created = []',
    'observed = False',
    'try:',
    `    for index in range(${maximumFiles}):`,
    '        name = os.path.join(directory, ".awf-live-enospc-" + str(index))',
    '        try:',
    '            fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)',
    '        except OSError as error:',
    '            if error.errno != errno.ENOSPC:',
    '                raise',
    '            observed = True',
    '            break',
    '        created.append(name)',
    '        try:',
    '            for _ in range(8):',
    '                remaining = memoryview(chunk)',
    '                while remaining:',
    '                    try:',
    '                        written = os.write(fd, remaining)',
    '                    except OSError as error:',
    '                        if error.errno != errno.ENOSPC:',
    '                            raise',
    '                        observed = True',
    '                        break',
    '                    if written < 1:',
    '                        raise OSError(errno.EIO, "zero-byte write during bounded storage probe")',
    '                    remaining = remaining[written:]',
    '                if observed:',
    '                    break',
    '        finally:',
    '            os.close(fd)',
    '        if observed:',
    '            break',
    '    result = {"enospcObserved": observed, "probeFilesRemoved": False}',
    'finally:',
    '    for name in created:',
    '        os.unlink(name)',
    'result["probeFilesRemoved"] = all(not os.path.exists(name) for name in created)',
    'encoded = json.dumps(result, separators=(",", ":"))',
    'print(encoded)',
    'with open("/output/out", "w", encoding="utf8") as output:',
    '    output.write(encoded)',
  ].join('\n');
}

function buildAgentEnospcProbe() {
  const expected = { enospcObserved: true, probeFilesRemoved: true };
  return {
    expected,
    schema: {
      type: 'object',
      properties: {
        enospcObserved: { type: 'boolean', const: true },
        probeFilesRemoved: { type: 'boolean', const: true },
      },
      required: Object.keys(expected),
      additionalProperties: false,
    },
    prompt: [
      'Run this exact Python diagnostic in your shell. Do not inspect repository files or make network requests.',
      '```bash',
      "python3 - <<'PY'",
      buildEnospcProbeScript(512),
      'PY',
      '```',
      'Return exactly the JSON object printed by the diagnostic, with no extra fields. Write that exact object to /awf/out as required by your result contract.',
    ].join('\n'),
  };
}

function buildOomProbeScript() {
  return [
    'import json, os, subprocess, sys',
    'def oom_kills():',
    '    with open("/proc/vmstat", encoding="ascii") as status:',
    '        for line in status:',
    '            name, _, value = line.partition(" ")',
    '            if name == "oom_kill":',
    '                return int(value)',
    '    return -1',
    'before = oom_kills()',
    'child = subprocess.Popen([',
    '    sys.executable, "-c",',
    '    "blocks=[]\\nwhile True:\\n b=bytearray(32*1024*1024)\\n for i in range(0,len(b),4096): b[i]=1\\n blocks.append(b)",',
    '], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
    'signal = child.wait()',
    'after = oom_kills()',
    'result = {',
    '    "childKilledByOom": signal == -9 and before >= 0 and after > before,',
    '    "oomKillCounterIncreased": before >= 0 and after > before,',
    '}',
    'with open("/awf/out", "w", encoding="utf8") as output:',
    '    json.dump(result, output, separators=(",", ":"))',
  ].join('\n');
}

function resourceRecords(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink()
      && /^[0-9a-f]{32}-[0-9a-f]{32}\.resources\.json$/.test(entry.name))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return { file, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
    });
}

async function waitForInvocationRecord(directory, existing, ownerPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = resourceRecords(directory).find(({ file, record: value }) =>
      !existing.has(file)
      && value.state === 'pending'
      && value.owner?.pid === ownerPid
      && value.storage?.directory
      && value.directoryIdentity
      && value.snapshot);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Live enclave crash probe did not persist its pending resource identity');
}

function findProcessForSocket(apiSocketPath) {
  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let commandLine;
    try {
      commandLine = fs.readFileSync(path.join('/proc', entry.name, 'cmdline'));
    } catch {
      continue;
    }
    if (commandLine.includes(Buffer.from(apiSocketPath, 'utf8'))) return Number(entry.name);
  }
  return undefined;
}

async function waitForPath(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink()) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Live enclave guest did not reach its bounded crash-probe marker');
}

function assertNoSuccessfulResult(response) {
  if (response?.result?.structuredContent?.status === 'ok') {
    throw new Error('Interrupted live enclave invocation returned a successful result');
  }
}

function assertRecoveredInvocation(before, after, records) {
  const matches = records.filter(({ record }) =>
    record.runId === before.runId && record.invocationId === before.invocationId);
  const identityMetadata = (record) => ({
    directory: record.directory,
    directoryIdentity: record.directoryIdentity,
    ancestors: record.ancestors,
    mount: record.mount,
    snapshot: record.snapshot,
    storage: record.storage && {
      directory: record.storage.directory,
      parentIdentity: record.storage.parentIdentity,
      ancestors: record.storage.ancestors,
      directoryIdentity: record.storage.directoryIdentity,
      mountedIdentity: record.storage.mountedIdentity,
      mounts: record.storage.mounts,
    },
  });
  if (matches.length !== 1 || after.state !== 'cleaned'
      || after.runId !== before.runId
      || after.invocationId !== before.invocationId
      || !before.directoryIdentity
      || !before.storage?.directoryIdentity
      || !before.storage?.mountedIdentity
      || !before.snapshot
      || !isDeepStrictEqual(identityMetadata(after), identityMetadata(before))) {
    throw new Error('Live VMM crash recovery did not clean the exact interrupted invocation');
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
        maxInvocations: 3,
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
  const awfConfigPath = path.join(root, 'awf-config.json');
  const awfArguments = [
    path.resolve(__dirname, '../../dist/cli.js'),
    '--config', awfConfigPath,
    '--build-local',
    '--enable-api-proxy',
    '--max-num-tool-calls', '16',
    '--work-dir', workDir,
    '--log-level', 'error',
    '--agent-timeout', '45',
    '--',
    'while [ ! -f /workspace/.awf-enclave-live-stop ]; do sleep 1; done',
  ];
  let awfEnvironment;
  const launchAwf = () => {
    const stdout = fs.openSync(awfOut, 'a', 0o600);
    const stderr = fs.openSync(awfErr, 'a', 0o600);
    try {
      return spawn(process.execPath, awfArguments, {
        env: awfEnvironment,
        stdio: ['ignore', stdout, stderr],
      });
    } finally {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    }
  };
  const stopComposeAfterCrash = () => run('docker', [
    'compose',
    '--project-directory', workDir,
    '--file', path.join(workDir, 'docker-compose.yml'),
    'down', '--volumes', '--remove-orphans', '--timeout', '5',
  ]);
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
    const config = toAwfConfig(makeConfig(artifacts, workDir, workspace, {
      capability,
      gatewayKey,
      endpoint,
      identity: gatewayIdentity,
    }));
    fs.writeFileSync(awfConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    awfEnvironment = {
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
    };
    awf = launchAwf();
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

    const agentProbe = buildAgentGuestProbe();
    const agentProbeResponse = await requestMcp(endpoint, gatewayKey, 5, 'tools/call', {
      name: 'enclave_run_agent',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: agentProbe.schema,
        prompt: agentProbe.prompt,
      },
    });
    assertExpectedToolResult(agentProbeResponse, 5, agentProbe.expected, 'agent identity and network');
    await waitForVmCleanup(15_000);

    const agentEnospcProbe = buildAgentEnospcProbe();
    const agentEnospcResponse = await requestMcp(endpoint, gatewayKey, 6, 'tools/call', {
      name: 'enclave_run_agent',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: agentEnospcProbe.schema,
        prompt: agentEnospcProbe.prompt,
      },
    });
    assertExpectedToolResult(agentEnospcResponse, 6, agentEnospcProbe.expected, 'agent aggregate ENOSPC');
    await waitForVmCleanup(15_000);

    const enospcExpected = { enospcObserved: true, probeFilesRemoved: true };
    const enospcResponse = await requestMcp(endpoint, gatewayKey, 7, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: {
          type: 'object',
          properties: {
            enospcObserved: { type: 'boolean', const: true },
            probeFilesRemoved: { type: 'boolean', const: true },
          },
          required: ['enospcObserved', 'probeFilesRemoved'],
          additionalProperties: false,
        },
        script: buildEnospcProbeScript(),
      },
    });
    assertExpectedToolResult(enospcResponse, 7, enospcExpected, 'script aggregate ENOSPC');
    await waitForVmCleanup(15_000);

    const oomExpected = { childKilledByOom: true, oomKillCounterIncreased: true };
    const oomResponse = await requestMcp(endpoint, gatewayKey, 8, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: {
          type: 'object',
          properties: {
            childKilledByOom: { type: 'boolean', const: true },
            oomKillCounterIncreased: { type: 'boolean', const: true },
          },
          required: ['childKilledByOom', 'oomKillCounterIncreased'],
          additionalProperties: false,
        },
        script: buildOomProbeScript(),
      },
    });
    assertExpectedToolResult(oomResponse, 8, oomExpected, 'guest OOM');
    await waitForVmCleanup(15_000);

    const errorSchema = { type: 'boolean', const: true };
    const guestFailure = await requestMcp(endpoint, gatewayKey, 9, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: errorSchema,
        script: 'raise SystemExit(23)',
      },
    });
    assertCanonicalToolError(guestFailure, 9, 'guest failure');
    await waitForVmCleanup(15_000);

    const timeout = await requestMcp(endpoint, gatewayKey, 10, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: errorSchema,
        script: 'import time; time.sleep(150)',
      },
    });
    assertCanonicalToolError(timeout, 10, 'timeout');
    await waitForVmCleanup(15_000);

    const journalRoot = '/var/lib/awf-cloud-hypervisor/host-executor-journal';
    const existingCancellationResources = new Set(resourceRecords(journalRoot).map(({ file }) => file));
    const cancellationMarker = [
      'import time',
      'open("/output/cancel-probe-started", "w", encoding="ascii").write("started")',
      'while True: time.sleep(1)',
    ].join('\n');
    const cancellationController = new AbortController();
    const cancellationRequest = requestMcp(endpoint, gatewayKey, 11, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: errorSchema,
        script: cancellationMarker,
      },
    }, cancellationController.signal);
    const cancellationActive = await waitForInvocationRecord(
      journalRoot, existingCancellationResources, awf.pid, 90_000,
    );
    await waitForPath(path.join(cancellationActive.record.directory, 'output', 'cancel-probe-started'), 90_000);
    cancellationController.abort();
    const cancelled = await cancellationRequest;
    if (cancelled !== undefined) {
      throw new Error('Public MCP disconnect did not cancel the live enclave request');
    }
    await waitForVmCleanup(15_000);

    const existingResources = new Set(resourceRecords(journalRoot).map(({ file }) => file));
    const crashProbe = [
      'import time',
      'open("/output/crash-probe-started", "w", encoding="ascii").write("started")',
      'while True: time.sleep(1)',
    ].join('\n');
    const crashRequest = requestMcp(endpoint, gatewayKey, 12, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: errorSchema,
        script: crashProbe,
      },
    });
    const crashResponse = crashRequest.then(
      (response) => ({ response }),
      () => ({ disconnected: true }),
    );
    const active = await waitForInvocationRecord(journalRoot, existingResources, awf.pid, 90_000);
    const apiSocket = path.join(active.record.storage.directory, 'runs', 'vm', 'api.socket');
    await waitForPath(path.join(active.record.directory, 'output', 'crash-probe-started'), 90_000);
    const vmmPid = findProcessForSocket(apiSocket);
    if (!vmmPid) throw new Error('Live VM crash probe could not identify its exact VMM process');

    try {
      process.kill(vmmPid, 'SIGKILL');
      awf.kill('SIGKILL');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('AWF host process did not die for recovery probe')), 15_000);
        awf.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      awf = undefined;
      run('docker', [
        'compose',
        '--project-directory', workDir,
        '--file', path.join(workDir, 'docker-compose.yml'),
        'down', '--volumes', '--remove-orphans', '--timeout', '5',
      ]);
      awf = launchAwf();
      await waitForBroker(awf, 'awf-enclave-mcp-server', Date.now() + 15 * 60_000);
      const recoveryTools = await requestMcp(endpoint, gatewayKey, 13, 'tools/list', {});
      if (!Array.isArray(recoveryTools?.result?.tools)) {
        throw new Error('Live broker did not become ready after host-executor recovery');
      }
      const afterCrash = JSON.parse(fs.readFileSync(active.file, 'utf8'));
      assertRecoveredInvocation(active.record, afterCrash, resourceRecords(journalRoot));
      assertNoSuccessfulResult((await crashResponse).response);
      await waitForVmCleanup(15_000);
    } catch (error) {
      if (awf && awf.exitCode === null) awf.kill('SIGKILL');
      try {
        stopComposeAfterCrash();
      } catch {
        keepArtifacts = true;
      }
      throw error;
    }

    const logContents = [
      fs.readFileSync(awfOut, 'utf8'),
      fs.readFileSync(awfErr, 'utf8'),
      run('docker', ['logs', GATEWAY_CONTAINER], { maxBuffer: 1024 * 1024 }),
      run('docker', ['logs', 'awf-enclave-mcp-server'], { maxBuffer: 1024 * 1024 }),
    ];
    const privateRoot = path.join('/var/tmp', `awf-enclave-private-0-${crypto.createHash('sha256')
      .update(path.resolve(workDir), 'utf8').digest('hex').slice(0, 20)}`);
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
    console.log('Live script and agent identity/network, aggregate ENOSPC, guest OOM, failure/timeout/cancellation, VMM crash recovery, cleanup, and output redaction checks passed.');
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
      const gateway = spawnSync('docker', [
        'inspect', '--format', '{{ index .Config.Labels "com.github.gh-aw.mcpg.run" }}',
        GATEWAY_CONTAINER,
      ], { encoding: 'utf8' });
      if (gateway.status === 0 && gateway.stdout.trim() === gatewayIdentity) {
        const removed = spawnSync('docker', ['rm', '--force', GATEWAY_CONTAINER], { encoding: 'utf8' });
        if (removed.error || removed.status !== 0) {
          console.error('Could not remove the identity-checked live gateway fixture');
          keepArtifacts = true;
        }
      } else if (gateway.status !== 1 || gateway.stdout.trim() !== '') {
        console.error('Could not verify the live gateway fixture identity; it was not removed');
        keepArtifacts = true;
      }
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
  assertExpectedToolResult,
  assertRecoveredInvocation,
  assertNoSuccessfulResult,
  buildAgentGuestProbe,
  buildAgentEnospcProbe,
  buildEnospcProbeScript,
  buildOomProbeScript,
  parsePublicToolResult,
  requestMcp,
};
