'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isIPv4 } = require('node:net');
const live = require('./cloud-hypervisor-enclave-live-smoke');
const collector = require('./collect-enclave-smoke-debug.cjs');
const PRIMARY_DOCKER_ADDRESS = '172.30.0.20';

const ENGINES = Object.freeze({
  copilot: { model: 'claude-sonnet-5', profile: 'anthropic', port: 10002, credential: 'COPILOT_GITHUB_TOKEN' },
  codex: { model: 'gpt-5.4', profile: 'openai', port: 10000, credential: 'OPENAI_API_KEY' },
  claude: { model: 'claude-haiku-4-5', profile: 'anthropic', port: 10001, credential: 'ANTHROPIC_API_KEY' },
});
const REPOSITORY = 'github/gh-aw-firewall';

function configuration(agent, runtime, source, workDir, artifacts) {
  const engine = ENGINES[agent];
  if (!engine || !['docker', 'cloud-hypervisor'].includes(runtime)
    || !/^[a-f0-9]{40}$/.test(source || '')) throw new Error('Invalid enclave regression selection');
  const config = {
    enclaveDebugPublic: true,
    network: {
      isolation: true, allowDomains: ['github.com', 'githubusercontent.com'],
      topologyAttach: [live.GATEWAY_CONTAINER],
    },
    container: { ...(runtime === 'cloud-hypervisor' ? { containerRuntime: runtime } : {}), imageTag: source },
    enclaves: [{
      agent: { engine: agent, profile: engine.profile, model: engine.model, maxTaskBytes: 16_384 },
      runtime, timeout: 360, maxInvocations: 1,
      repos: [{ repo: REPOSITORY, sensitivity: 'public' }],
    }],
    apiProxy: { enabled: true },
    logging: { auditDir: path.join(workDir, 'audit'), proxyLogsDir: path.join(workDir, 'proxy-logs') },
  };
  if (runtime === 'cloud-hypervisor') {
    config.cloudHypervisor = {
      previewEnabled: true,
      mountPolicy: 'workspace-only',
      artifactReleaseTag: `v0.0.0-regression.${source}`,
      cloudHypervisorBinary: path.join(artifacts, 'cloud-hypervisor'),
      kernelPath: path.join(artifacts, 'vmlinux.bin'),
      rootfsPath: path.join(artifacts, 'rootfs.ext4'),
      supervisorPath: path.join(artifacts, 'awf-supervisor'),
      artifactManifestPath: path.join(artifacts, 'cloud-hypervisor-test-x86_64.manifest.json'),
      artifactManifestBundlePath: path.join(artifacts, 'cloud-hypervisor-test-x86_64.manifest.sigstore.jsonl'),
      vcpuCount: 1,
      memoryMib: 768,
    };
  }
  return config;
}

function probe(agent, runtime, marker, primaryGuestAddress) {
  if (!ENGINES[agent] || !['docker', 'cloud-hypervisor'].includes(runtime)
    || !/^[a-f0-9]{48}$/.test(marker)
    || !isIPv4(primaryGuestAddress || '')) {
    throw new Error('Invalid enclave regression probe');
  }
  const port = ENGINES[agent].port;
  const expected = {
    proof: marker, seedReadable: true, seedReadOnly: true, nonRoot: true,
    noCapabilities: true, noNewPrivileges: true, credentialsIsolated: true,
    apiProxyReachable: true, primaryPeerBlocked: true, publicEgressBlocked: true,
    ...(runtime === 'cloud-hypervisor' ? { wrongProviderPortBlocked: true } : {}),
  };
  const python = [
    'import errno, json, os, re, socket',
    'def reachable(ip, port):',
    '    try:',
    '        with socket.create_connection((ip, port), timeout=0.75): return True',
    '    except OSError: return False',
    'seed = "/awf/seed/README.md"',
    'seed_readable = len(open(seed, "rb").read(1)) == 1',
    'try:',
    '    fd = os.open(seed, os.O_WRONLY | os.O_APPEND)',
    'except OSError as error:',
    '    read_only_mount = bool(os.statvfs(seed).f_flag & os.ST_RDONLY)',
    '    seed_read_only = error.errno in (errno.EROFS, errno.EACCES) and read_only_mount',
    'else:',
    '    os.close(fd)',
    '    seed_read_only = False',
    'status = open("/proc/self/status", encoding="ascii").read()',
    'names = ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "COPILOT_TOKEN", "COPILOT_PROVIDER_BEARER_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]',
    'def isolated(value):',
    '    return value in (None, "", "******")',
    'result = {',
    `    "proof": ${JSON.stringify(marker)},`,
    '    "seedReadable": seed_readable, "seedReadOnly": seed_read_only,',
    '    "nonRoot": os.geteuid() == 65534 and os.getegid() == 65534,',
    '    "noCapabilities": int(re.search(r"^CapEff:\\s+([0-9a-f]+)$", status, re.M).group(1), 16) == 0,',
    '    "noNewPrivileges": re.search(r"^NoNewPrivs:\\s+1$", status, re.M) is not None,',
    '    "credentialsIsolated": all(isolated(os.environ.get(name)) for name in names),',
    `    "apiProxyReachable": reachable("172.31.0.30", ${port}),`,
    `    "primaryPeerBlocked": not reachable(${JSON.stringify(primaryGuestAddress)}, 18080),`,
    '    "publicEgressBlocked": not reachable("1.1.1.1", 443),',
    ...(runtime === 'cloud-hypervisor'
      ? [`    "wrongProviderPortBlocked": not reachable("172.31.0.30", ${port === 10000 ? 10001 : 10000}),`]
      : []),
    '}',
    'with open("/awf/out", "w", encoding="utf8") as output: json.dump(result, output, separators=(",", ":"))',
  ].join('\n');
  return {
    expected, schema: live.buildConstantObjectSchema(expected),
    prompt: [
      'Use your shell tool to run this exact Python diagnostic. Do not invent the result.',
      'Do not inspect other files or make other network requests.',
      "```bash\npython3 - <<'PY'", python, 'PY\n```',
      'The script writes the required JSON result to /awf/out. Leave that file intact.',
    ].join('\n'),
  };
}

function assertAudit(file) {
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const invocations = records.filter(record => record.kind === 'invocation');
  if (records.some(record => record.kind === 'failure') || invocations.length !== 1
    || invocations[0].repo !== REPOSITORY || invocations[0].sensitivity !== 'public') {
    throw new Error('Expected exactly one successful public-repository enclave invocation');
  }
}

async function main(environment = process.env) {
  const { AGENT: agent, RUNTIME: runtime, SOURCE_SHA: source } = environment;
  if (process.getuid() !== 0 || !ENGINES[agent] || !environment[ENGINES[agent].credential]
    || environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('Enclave regression requires a hosted Linux runner and the selected provider credential');
  }
  const workspace = environment.GITHUB_WORKSPACE;
  const directory = fs.mkdtempSync(path.join(environment.RUNNER_TEMP, 'awf-enclave-regression-'));
  fs.chmodSync(directory, 0o700);
  const workDir = path.join(directory, 'work');
  const stop = path.join(workspace, '.awf-enclave-regression-stop');
  fs.mkdirSync(workDir, { mode: 0o700 });
  fs.mkdirSync(path.dirname(stop), { recursive: true, mode: 0o700 });
  fs.rmSync(stop, { force: true });
  const identity = `gh-aw-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}-enclave-regression`;
  const capability = randomBytes(32).toString('hex');
  const gatewayKey = randomBytes(36).toString('base64url');
  const ready = `AWF_DOCKER_PRIMARY_READY_${randomBytes(24).toString('hex')}`;
  const stdout = path.join(directory, 'awf.stdout.log');
  const stderr = path.join(directory, 'awf.stderr.log');
  const startupErrorFile = path.join(workDir, 'proxy-logs', 'awf-startup-error.json');
  const guestStop = runtime === 'cloud-hypervisor' ? '/workspace/.awf-enclave-regression-stop' : stop;
  let stage = 'configuration';
  let gatewayStarted = false;
  let awf;
  let failure;
  let resultValidated = false;
  let primaryVmResidue;
  let primaryGuestAddress = runtime === 'cloud-hypervisor' ? undefined : PRIMARY_DOCKER_ADDRESS;
  const errors = [];
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
    if (head !== source) throw new Error('Enclave regression checkout does not match the shared main build');
    stage = 'gateway';
    const handoff = live.startGatewayFixture({
      gatewayEnv: path.join(directory, 'gateway.env'), gatewayKey, capability, identity,
      onStarted: () => { gatewayStarted = true; },
    });
    stage = 'configuration';
    const artifacts = path.join(environment.RUNNER_TEMP, 'agent-runtime-cloud-hypervisor');
    const config = configuration(agent, runtime, source, workDir, artifacts);
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    const artifactEnvironment = runtime === 'cloud-hypervisor' ? {
      AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS: path.join(artifacts, 'enclave-rootfs.ext4'),
      AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS: path.join(artifacts, 'enclave-rootfs.ext4'),
      AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST: path.join(artifacts, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json'),
      AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE: path.join(artifacts, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl'),
    } : {};
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    stage = 'launch';
    awf = live.spawnAwf([
      path.join(workspace, 'dist/cli.js'), '--config', configPath,
      '--image-tag', source, '--skip-pull', '--work-dir', workDir, '--log-level', 'error',
      '--agent-timeout', '15', '--max-num-tool-calls', '1', '--',
      'set -e; ' +
      `python3 -c 'import http.server; http.server.HTTPServer(("0.0.0.0", 18080), http.server.BaseHTTPRequestHandler).serve_forever()' >/dev/null 2>&1 & listener=$!; listening=0; for attempt in $(seq 1 50); do if python3 -c 'import socket; socket.create_connection(("127.0.0.1", 18080), timeout=0.2).close()' 2>/dev/null; then listening=1; break; fi; sleep 0.1; done; test "$listening" = 1; printf '%s\\n' ${quote(ready)}; while [ ! -f ${quote(guestStop)} ]; do sleep 1; done; kill "$listener"; wait "$listener" 2>/dev/null || true`,
    ], {
      ...environment, ...artifactEnvironment,
      AWF_ENCLAVE_MCP_CAPABILITY: capability,
      AWF_ENCLAVE_MCP_GATEWAY_CONTAINER: live.GATEWAY_CONTAINER,
      AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: handoff.endpoint,
      AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: identity,
      AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS: '120000',
      MCP_GATEWAY_API_KEY: gatewayKey,
    }, stdout, stderr, 'enclave-regression');
    const diagnostic = {
      stage: 'enclave-regression', stderrFile: stderr,
      startupErrorFile,
    };
    stage = 'broker';
    await live.waitForBroker(awf, 'awf-enclave-mcp-server', Date.now() + 10 * 60_000, diagnostic);
    stage = 'gateway-readiness';
    await live.waitForHostGatewayReadiness(awf, Date.now() + 150_000, diagnostic);
    stage = 'primary-readiness';
    if (runtime === 'cloud-hypervisor') {
      primaryVmResidue = await live.waitForPrimaryVmReadiness(
        awf, Date.now() + 5 * 60_000, diagnostic, {
          onReady: address => { primaryGuestAddress = address; },
        },
      );
    }
    await live.waitForDockerPrimaryReadiness(
      awf, Date.now() + 5 * 60_000, stdout, ready, primaryVmResidue,
    );
    stage = 'invocation';
    const initialized = await live.requestMcp(handoff.endpoint, gatewayKey, 1, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'awf-daily-enclave-regression', version: '1.0.0' },
    });
    live.assertProfileInitialize(initialized, 1);
    const tools = await live.requestMcp(handoff.endpoint, gatewayKey, 2, 'tools/list', {});
    live.assertProfileTools(tools, 'agent-only', 2);
    const task = probe(agent, runtime, randomBytes(24).toString('hex'), primaryGuestAddress);
    const response = await live.requestMcp(handoff.endpoint, gatewayKey, 3, 'tools/call', {
      name: 'enclave_run_agent',
      arguments: { privateRepo: REPOSITORY, schema: task.schema, prompt: task.prompt },
    });
    stage = 'result';
    const parsed = live.parsePublicToolResult(response, 3);
    if (parsed.status !== 'ok') throw new Error('Enclave agent did not produce an approved result');
    const result = parsed.result;
    require('node:assert/strict').deepEqual(result, task.expected);
    resultValidated = true;
  } catch (error) {
    failure = error;
    const reason = !awf || live.failedSpawns.has(awf) ? 'spawn-failure'
      : awf.signalCode ? 'signal' : awf.exitCode !== null ? 'exit'
        : ['broker', 'gateway-readiness', 'primary-readiness'].includes(stage) ? 'timeout' : 'unknown';
    live.emitStartupDiagnostic(awf, reason, 'initial', stderr, startupErrorFile);
    try {
      const key = `${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`;
      collector.retainStartup(path.join('/var/lib/awf-enclave-smoke-export', key), {
        agent, backend: runtime, failureStage: stage,
        ...live.startupSnapshot(awf, reason, 'initial', 'agent-only', stderr, startupErrorFile),
      });
    } catch {
      errors.push(new Error('Enclave regression startup diagnostic retention failed'));
    }
  } finally {
    if (awf) {
      try {
        fs.writeFileSync(stop, '');
        await live.stopAwf(awf);
        if (awf.exitCode !== 0) errors.push(new Error('Enclave regression AWF cleanup did not exit successfully'));
        else if (resultValidated) {
          assertAudit(path.join(workDir, 'audit/enclave.jsonl'));
        }
      } catch (error) { errors.push(error); }
    }
    if (gatewayStarted && !live.removeGatewayFixture(identity)) {
      errors.push(new Error('Enclave regression gateway cleanup failed'));
    }
    fs.rmSync(stop, { force: true });
  }
  if (failure) errors.unshift(failure);
  if (errors.length) throw new AggregateError(errors, 'Enclave regression failed; inspect protected public diagnostics');
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { ENGINES, configuration, probe, assertAudit, main };
