'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// Release-published checksums and containers.txt, not candidate runtime code.
const RELEASE = Object.freeze({
  version: '0.28.75',
  binarySha256: '796e3c5d46f54f2c2c45a68afbbf5368dd70666341e08052cbefe7d8fd766946',
  images: Object.freeze({
    squid: 'ghcr.io/github/gh-aw-firewall/squid:0.28.75@sha256:acc55719d3816ebba2af7393d13bc72c690ddedf4e3ec74340104e3e0bda6b4d',
    agent: 'ghcr.io/github/gh-aw-firewall/agent:0.28.75@sha256:36ffe93f119df4dde5737e96fd5fe21e93f9ed8f0851bbb8344d685747fbbd40',
    apiProxy: 'ghcr.io/github/gh-aw-firewall/api-proxy:0.28.75@sha256:e2c27ef4403bda921331fd3be5da297fd2865fcf42e2b2aba7d6b4c34073acdd',
  }),
});
const CACHE = '/tmp/catalogue-smoke-private';
const COMMIT = /^[a-f0-9]{40}$/;
const REVISION = /^[a-f0-9]{64}$/;
const MODELS = ['claude-haiku-4.5', 'gpt-5-mini', 'claude-haiku-5.5'];
const DENIAL_RULE = [
  '# Test-injected catalogue denial; not normal AWF sidecar policy.',
  'acl catalogue_smoke_source src 172.30.0.30/32',
  'acl catalogue_smoke_connect method CONNECT',
  'acl catalogue_smoke_host dstdomain api.github.com',
  'acl catalogue_smoke_port port 443',
  'http_access deny catalogue_smoke_source catalogue_smoke_connect catalogue_smoke_host catalogue_smoke_port',
  '',
].join('\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PROBE_SCRIPT = `
(async () => {
  const [operation, serialized] = process.argv.slice(1);
  const params = JSON.parse(serialized || '{}');
  const fs = require('node:fs');
  switch (operation) {
    case 'publication': {
      const cache = '/tmp/catalogue-smoke-private';
      const files = fs.readdirSync(cache).filter(file => /^[a-f0-9]{64}\\.json$/.test(file));
      if (files.length !== 1) throw Error();
      const { candidate } = JSON.parse(fs.readFileSync(require('node:path').join(cache, files[0]), 'utf8'));
      const sha = candidate.dataCommit;
      if (!/^[a-f0-9]{40}$/.test(sha)) throw Error();
      const https = require('node:https');
      const { proxyAgent } = require('/app/http-client');
      const bytes = await new Promise((resolve, reject) => {
        const request = https.get('https://api.github.com/repos/github/gh-aw-firewall/contents/channels/v1/current.json?ref=' + sha, {
          agent: proxyAgent,
          headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'awf-catalogue-smoke' },
        }, response => {
          if (response.statusCode !== 200) { response.resume(); reject(Error()); return; }
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 16384) response.destroy(Error());
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => resolve(Buffer.concat(chunks)));
        });
        request.setTimeout(10000, () => request.destroy(Error()));
        request.on('error', reject);
      });
      const pointer = JSON.parse(bytes);
      if (JSON.stringify(pointer) !== JSON.stringify(candidate.pointer)) throw Error();
      const snapshot = JSON.parse(candidate.snapshot);
      const { resolveCentralPricing } = require('/app/catalogue-pricing');
      const capture = { snapshot, time: Date.now(), maxAge: 30 * 86400000,
        source: 'github/gh-aw-firewall', revision: snapshot.revision };
      const models = ['claude-haiku-4.5', 'gpt-5-mini', 'claude-haiku-5.5']
        .filter(id => resolveCentralPricing('copilot', id, 100, capture));
      process.stdout.write(JSON.stringify({ dataCommit: sha, revision: pointer.revision,
        sourceCommit: pointer.sourceCommit, models }));
      return;
    }
    case 'inference': {
      const models = ['claude-haiku-4.5', 'gpt-5-mini', 'claude-haiku-5.5'];
      if (!models.includes(params.model)) throw Error();
      const response = await fetch('http://172.30.0.30:10002/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: params.model,
          messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 16, stream: false }),
        signal: AbortSignal.timeout(90000),
      });
      if (response.status !== 200) throw Error();
      const body = await response.json();
      if (typeof body.choices?.[0]?.message?.content !== 'string') throw Error();
      return;
    }
    case 'accounting': {
      const file = '/var/log/api-proxy/token-usage.jsonl';
      const records = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\\n')
        .filter(Boolean).map(JSON.parse) : [];
      const fields = ['_schema', 'provider', 'model', 'status', 'input_tokens', 'output_tokens',
        'ai_credits_this_response', 'ai_credits_pricing_source', 'ai_credits_pricing_tier',
        'ai_credits_fallback_pricing_used', 'ai_credits_pricing_catalog_id',
        'ai_credits_pricing_catalog_version', 'ai_credits_pricing_observed_at'];
      process.stdout.write(JSON.stringify(records.map(record => Object.fromEntries(
        fields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]])))));
      return;
    }
    case 'bundled_pricing': {
      const { applyAiCreditsUsage } = require('/app/guards/ai-credits-guard');
      const value = applyAiCreditsUsage(
        { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 },
        'claude-haiku-4.5', 'copilot', { catalogue: null });
      process.stdout.write(JSON.stringify({ source: value.pricingSource, credits: value.aiCreditsThisResponse }));
      return;
    }
    default:
      throw Error();
  }
})().catch(() => process.exit(1))
`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...options,
  });
  // Subprocess output can contain credentials or payloads. Never relay it.
  assert.equal(result.status, 0, 'smoke_subprocess_failed');
  return result.stdout.trim();
}

function failureCode(error) {
  const firstLine = error?.message?.split('\n')[0];
  const allowed = new Set([
    'approved_actions_only', 'trusted_ref_only', 'trusted_event_only', 'trusted_event_metadata',
    'trusted_checkout_mismatch', 'reviewed_head_sha_required', 'reviewed_head_sha_mismatch',
    'approved_copilot_credential_missing', 'release_download', 'release_digest', 'release_version',
    'existing_awf_containers', 'existing_awf_networks', 'smoke_subprocess_failed', 'smoke_case_failed',
    'awf_exited_before_readiness', 'catalogue_readiness_timeout', 'catalogue_unexpected_fallback',
    'catalogue_revision_missing', 'catalogue_origin', 'catalogue_source', 'denial_failure',
    'publication_revision', 'publication_source', 'publication_no_applicable_tariff',
    'no_available_reviewed_smoke_model', 'copilot_not_configured', 'accounting_timeout',
    'accounting_record_count', 'accounting_precedence', 'accounting_revision',
    'accounting_release', 'accounting_model', 'accounting_usage_missing', 'accounting_token_bound',
    'accounting_credit_bound', 'bundled_pricing_changed', 'agent_readiness_timeout',
    'network_capture_start', 'network_capture_exited', 'network_capture_bound', 'network_capture_dropped',
    'network_capture_incomplete', 'unexpected_direct_network_attempt', 'offline_network_attempt',
    'offline_feed_request', 'denial_not_observed', 'unexpected_catalogue_failover',
    'proxy_network_count', 'proxy_ip', 'proxy_not_internal', 'unexpected_ipv6',
    'cache_shared_mount', 'unexpected_operator_pricing', 'running_image_reference',
    'running_image_id', 'agent_credential_exposed', 'fallback_credentials_present',
    'denial_policy_invalid', 'denial_policy_not_running',
  ]);
  return allowed.has(firstLine) ? firstLine : 'smoke_operation_failed';
}

function projectCatalogue(value) {
  assert.equal(value?.source, 'github/gh-aw-firewall', 'catalogue_source');
  assert.ok(['pending', 'active', 'offline_bundled', 'fallback_bundled'].includes(value.state),
    'catalogue_state');
  const result = { source: value.source, state: value.state };
  for (const [key, pattern] of [['revision', REVISION], ['sourceCommit', COMMIT]]) {
    if (value[key] != null) {
      assert.match(value[key], pattern, `catalogue_${key}`);
      result[key] = value[key];
    }
  }
  if (value.origin != null) {
    assert.equal(value.origin, 'network', 'catalogue_origin');
    result.origin = value.origin;
  }
  if (value.failure != null) {
    assert.match(value.failure, /^catalogue_[a-z0-9_]{1,80}$/, 'catalogue_failure');
    result.failure = value.failure;
  }
  return result;
}

async function waitForCatalogue(read, mode, { timeoutMs = 45000, delay = sleep, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const value = await read();
    if (value) {
      const catalogue = projectCatalogue(value.model_catalogue);
      if (catalogue.state !== 'pending') {
        assert.equal(catalogue.state,
          mode === 'online' ? 'active' : mode === 'offline' ? 'offline_bundled' : 'fallback_bundled',
          'catalogue_unexpected_fallback');
        if (mode === 'online') {
          assert.equal(catalogue.origin, 'network', 'catalogue_not_network');
          assert.match(catalogue.revision || '', REVISION, 'catalogue_revision_missing');
          assert.match(catalogue.sourceCommit || '', COMMIT, 'catalogue_source_missing');
          assert.equal(catalogue.failure, undefined, 'catalogue_failure_present');
          if (!value.models_fetch_complete) {
            await delay(250);
            continue;
          }
        } else {
          assert.equal(catalogue.revision, undefined, 'fallback_not_fresh');
          if (mode === 'denied') {
            assert.ok(['catalogue_http_403', 'catalogue_invalid_or_unavailable'].includes(catalogue.failure),
              'denial_failure');
          }
        }
        return { catalogue, reflection: value };
      }
    }
    await delay(250);
  }
  throw new Error('catalogue_readiness_timeout');
}

function selectModel(reflection, candidate, now = Date.now()) {
  const endpoint = reflection.endpoints?.find(entry => entry.provider === 'copilot');
  assert.equal(endpoint?.configured, true, 'copilot_not_configured');
  assert.ok(Array.isArray(endpoint.models), 'copilot_models_missing');
  const model = MODELS.find(id => endpoint.models.includes(id) && candidate.models.includes(id));
  assert.ok(model, 'no_available_reviewed_smoke_model');
  const metadata = endpoint.model_metadata?.find(entry => entry.id === model);
  const tier = metadata?.pricing?.default;
  const observed = Date.parse(metadata?.observed_at);
  const completeProvider = !!tier &&
    ['input', 'output', 'cachedInput', 'cacheWrite'].every(key =>
      Object.hasOwn(tier, key) && Number.isFinite(tier[key]) && tier[key] >= 0) &&
    observed <= now && now - observed <= 30 * 86400000;
  return { model, expectedSource: completeProvider ? 'provider' : 'central_feed' };
}

function assertAccounting(records, selection, catalogue) {
  assert.equal(records.length, 1, 'accounting_record_count');
  const record = records[0];
  assert.equal(record._schema, `token-usage/v${RELEASE.version}`, 'accounting_release');
  assert.equal(record.provider, 'copilot', 'accounting_provider');
  assert.equal(record.model, selection.model, 'accounting_model');
  assert.equal(record.status, 200, 'accounting_status');
  for (const field of ['input_tokens', 'output_tokens']) {
    assert.ok(Number.isSafeInteger(record[field]) && record[field] > 0, 'accounting_usage_missing');
  }
  assert.ok(record.output_tokens <= 16 && record.input_tokens <= 4096, 'accounting_token_bound');
  assert.ok(Number.isFinite(record.ai_credits_this_response) &&
    record.ai_credits_this_response >= 0 && record.ai_credits_this_response <= 1, 'accounting_credit_bound');
  assert.equal(record.ai_credits_pricing_source, selection.expectedSource, 'accounting_precedence');
  assert.equal(record.ai_credits_pricing_tier, 'default', 'accounting_tier');
  assert.equal(record.ai_credits_fallback_pricing_used, false, 'accounting_fallback');
  if (selection.expectedSource === 'central_feed') {
    assert.equal(record.ai_credits_pricing_catalog_id, catalogue.source, 'accounting_source');
    assert.equal(record.ai_credits_pricing_catalog_version, catalogue.revision, 'accounting_revision');
  } else {
    assert.equal(record.ai_credits_pricing_catalog_version, undefined, 'provider_not_central');
    assert.ok(Number.isFinite(Date.parse(record.ai_credits_pricing_observed_at)), 'provider_provenance');
  }
  return {
    model: selection.model, provider: 'copilot',
    input_tokens: record.input_tokens, output_tokens: record.output_tokens,
    ai_credits: record.ai_credits_this_response, pricing_source: selection.expectedSource,
    ...(selection.expectedSource === 'central_feed' ? { revision: catalogue.revision } : {}),
    central_accounting: selection.expectedSource === 'central_feed' ? 'exercised' : 'not_exercised_provider_precedence',
  };
}

function assertNetwork(mode, packets, captureSummary, squidLog) {
  assert.match(captureSummary, /\b0 packets dropped by kernel\b/, 'network_capture_dropped');
  const captured = captureSummary.match(/\b(\d+) packets? captured\b/);
  const received = captureSummary.match(/\b(\d+) packets? received by filter\b/);
  assert.ok(captured && received, 'network_capture_incomplete');
  const lines = packets.trim() ? packets.trim().split('\n') : [];
  assert.equal(Number(captured[1]), lines.length, 'network_capture_incomplete');
  assert.equal(Number(received[1]), lines.length, 'network_capture_incomplete');
  // tcpdump captures only initial outbound TCP SYNs; no payload or headers.
  for (const line of lines) {
    assert.match(line, / IP 172\.30\.0\.30\.\d+ > 172\.30\.0\.10\.3128: Flags \[S\]/,
      'unexpected_direct_network_attempt');
  }
  const requests = squidLog.split('\n').filter(line => /\s172\.30\.0\.30:\d+\s/.test(line));
  if (mode === 'offline') {
    assert.equal(lines.length, 0, 'offline_network_attempt');
    assert.equal(requests.length, 0, 'offline_feed_request');
  } else {
    assert.ok(lines.length > 0 && requests.length > 0, 'denial_not_observed');
    for (const request of requests) {
      assert.match(request, /\sCONNECT 403 TCP_DENIED:HIER_NONE api\.github\.com:443\s/,
        'unexpected_catalogue_failover');
    }
  }
  return { outbound_tcp_syns: lines.length, squid_requests: requests.length,
    denied_catalogue_requests: mode === 'denied' ? requests.length : 0,
    alternate_tcp_destinations: 0, kernel_drops: 0 };
}

function config(mode) {
  return {
    network: { isolation: true, allowDomains: mode === 'denied' ? ['example.invalid']
      : mode === 'offline' ? ['api.githubcopilot.com'] : ['api.github.com', 'api.githubcopilot.com'],
    ...(mode === 'denied' ? { blockDomains: ['api.github.com'] } : {}) },
    apiProxy: { enabled: true, maxAiCredits: 1, maxRuns: 1,
      modelCatalogue: { enabled: true, source: 'github', offline: mode === 'offline',
        timeoutMs: 30000, refreshSeconds: 3600, cacheDirectory: CACHE } },
    container: { images: RELEASE.images, agentTimeout: 5 },
  };
}

function deniedPolicy(encoded) {
  assert.ok(typeof encoded === 'string' && encoded.length <= 512 * 1024, 'denial_policy_invalid');
  const original = Buffer.from(encoded, 'base64').toString('utf8');
  assert.equal(Buffer.from(original).toString('base64'), encoded, 'denial_policy_invalid');
  assert.ok(original.includes('acl from_api_proxy src 172.30.0.30/32\n') &&
    original.includes('http_access allow from_api_proxy\n') &&
    !original.includes('catalogue_smoke_'), 'denial_policy_invalid');
  const injected = DENIAL_RULE + original;
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  return {
    encoded: Buffer.from(injected).toString('base64'),
    identity: {
      kind: 'test_injected_squid_deny', source: '172.30.0.30/32',
      method: 'CONNECT', authority: 'api.github.com:443',
      rule_sha256: digest(DENIAL_RULE), generated_config_sha256: digest(original),
      injected_config_sha256: digest(injected),
    },
  };
}

function generatedDeniedPolicy(workDir, docker) {
  const compose = JSON.parse(run(docker, ['compose', '-f', path.join(workDir, 'docker-compose.yml'),
    'config', '--format', 'json']));
  const squid = compose.services?.['squid-proxy'];
  assert.equal(squid?.image, RELEASE.images.squid, 'running_image_reference');
  return deniedPolicy(squid.environment?.AWF_SQUID_CONFIG_B64);
}

function prepareDeniedCompose(workDir, docker) {
  assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(workDir), 'denial_policy_invalid');
  const policy = generatedDeniedPolicy(workDir, docker);
  const override = JSON.stringify({ services: { 'squid-proxy': {
    environment: { AWF_SQUID_CONFIG_B64: policy.encoded },
  } } });
  const file = path.join(workDir, 'docker-compose.override.yml');
  if (fs.existsSync(file)) {
    assert.equal(fs.readFileSync(file, 'utf8'), override, 'denial_policy_invalid');
  } else {
    fs.writeFileSync(file, override, { mode: 0o600, flag: 'wx' });
  }
}

function installDeniedDockerWrapper(directory, workDir) {
  const docker = run('which', ['docker']);
  assert.ok(path.isAbsolute(docker), 'denial_policy_invalid');
  const bin = path.join(directory, 'deny-bin');
  fs.mkdirSync(bin, { mode: 0o700 });
  const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
  const prepare = `const h = require(${JSON.stringify(__filename)}); try { h.prepareDeniedCompose(` +
    `${JSON.stringify(workDir)}, ${JSON.stringify(docker)}); } catch (error) { ` +
    `console.error('Catalogue smoke denied-policy staging failed: ' + h.failureCode(error)); process.exit(1); }`;
  // Stage the deny-only override synchronously before forwarding the real startup.
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\n' +
    'if [ "$1" = compose ] && [ "$2" = up ]; then\n' +
    `  ${quote(process.execPath)} -e ${quote(prepare)} || exit "$?"\nfi\n` +
    `exec ${quote(docker)} "$@"\n`, { mode: 0o700, flag: 'wx' });
  return { docker, path: `${bin}${path.delimiter}${process.env.PATH}` };
}

function verifyDeniedPolicy(squidInfo, workDir, docker) {
  const policy = generatedDeniedPolicy(workDir, docker);
  const override = JSON.parse(fs.readFileSync(path.join(workDir, 'docker-compose.override.yml'), 'utf8'));
  assert.equal(override.services?.['squid-proxy']?.environment?.AWF_SQUID_CONFIG_B64,
    policy.encoded, 'denial_policy_not_running');
  assert.equal(squidInfo.Config.Env.find(entry => entry.startsWith('AWF_SQUID_CONFIG_B64=')),
    `AWF_SQUID_CONFIG_B64=${policy.encoded}`, 'denial_policy_not_running');
  assert.ok(run('docker', ['exec', squidInfo.Id, 'cat', '/etc/squid/squid.conf']).startsWith(DENIAL_RULE),
    'denial_policy_not_running');
  return { ...policy.identity, verified_running: true };
}

function proxyScript(container, operation, params = {}) {
  return run('docker', ['exec', container, 'node', '-e', PROBE_SCRIPT,
    operation, JSON.stringify(params)], { timeout: 120000 });
}

function reflection(container) {
  // A missing container/listener is retryable; a malformed 200 response is not.
  const result = spawnSync('docker', ['exec', container, 'node', '-e',
    "fetch('http://127.0.0.1:10000/reflect',{signal:AbortSignal.timeout(2000)})" +
    ".then(async r=>{if(r.status!==200)process.exit(1);process.stdout.write(await r.text())})" +
    '.catch(()=>process.exit(1))'], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout);
}

async function captureNetwork() {
  const child = spawn('tcpdump', ['-i', 'any', '--immediate-mode', '-nn', '-l', '-s', '96',
    'src host 172.30.0.30 and tcp[tcpflags] & (tcp-syn|tcp-ack) = tcp-syn'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let packets = '';
  let summary = '';
  let exited = false;
  child.on('error', () => { exited = true; });
  const closed = new Promise(resolve => child.on('close', () => { exited = true; resolve(); }));
  child.stdout.on('data', bytes => { packets += bytes; });
  child.stderr.on('data', bytes => { summary += bytes; });
  try {
    const deadline = Date.now() + 5000;
    while (!summary.includes('listening on any')) {
      assert.ok(!exited && Date.now() < deadline, 'network_capture_start');
      await sleep(50);
    }
  } catch (error) {
    child.kill('SIGINT');
    await closed;
    throw error;
  }
  let completion;
  return () => {
    if (!completion) completion = (async () => {
      assert.equal(exited, false, 'network_capture_exited');
      child.kill('SIGINT');
      await closed;
      assert.ok(packets.length < 1024 * 1024, 'network_capture_bound');
      return { packets, summary };
    })();
    return completion;
  };
}

function verifyTopology(proxy) {
  const info = JSON.parse(run('docker', ['inspect', proxy]))[0];
  const networks = Object.entries(info.NetworkSettings.Networks);
  assert.equal(networks.length, 1, 'proxy_network_count');
  assert.equal(networks[0][1].IPAddress, '172.30.0.30', 'proxy_ip');
  const network = JSON.parse(run('docker', ['network', 'inspect', networks[0][0]]))[0];
  assert.equal(network.Internal, true, 'proxy_not_internal');
  assert.equal(network.EnableIPv6, false, 'unexpected_ipv6');
  assert.ok(!info.Mounts.some(mount => CACHE.startsWith(`${mount.Destination}/`) ||
    mount.Destination === CACHE), 'cache_shared_mount');
  assert.ok(!info.Config.Env.some(entry => /^(AWF_MODEL_PRICING_CATALOG|AWF_API_PROXY_PROVIDERS|AWF_DEFAULT_AI_CREDITS_PRICING)=/.test(entry)),
    'unexpected_operator_pricing');
  return { internal: true, ipv6: false, private_cache: true };
}

function publication(proxy, catalogue) {
  const result = JSON.parse(proxyScript(proxy, 'publication'));
  assert.match(result.dataCommit, COMMIT, 'publication_commit');
  assert.equal(result.revision, catalogue.revision, 'publication_revision');
  assert.equal(result.sourceCommit, catalogue.sourceCommit, 'publication_source');
  assert.ok(result.models.length > 0, 'publication_no_applicable_tariff');
  return result;
}

async function inference(agent, proxy, selection, catalogue) {
  proxyScript(agent, 'inference', { model: selection.model });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const records = JSON.parse(proxyScript(proxy, 'accounting'));
    if (records.length) return assertAccounting(records, selection, catalogue);
    await sleep(250);
  }
  throw new Error('accounting_timeout');
}

function bundledPricing(proxy) {
  const usage = JSON.parse(proxyScript(proxy, 'bundled_pricing'));
  assert.deepEqual(usage, { source: 'curated', credits: 0.015 }, 'bundled_pricing_changed');
  return { model: 'claude-haiku-4.5', ...usage, kind: 'released_guard_synthetic_usage_not_inference' };
}

async function waitForAgent(compose) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const id = run('docker', [...compose, 'ps', '--all', '-q', 'agent']);
    if (id && JSON.parse(run('docker', ['inspect', id]))[0].State.Running) return id;
    await sleep(250);
  }
  throw new Error('agent_readiness_timeout');
}

function assertIsolatedHost() {
  assert.equal(run('docker', ['ps', '-aq', '--filter', 'name=^/awf-']), '', 'existing_awf_containers');
  assert.equal(run('docker', ['network', 'ls', '--filter', 'name=^awf-', '--format', '{{.Name}}']),
    '', 'existing_awf_networks');
}

function observeStartup(child) {
  const state = { state: 'starting', last_stage: 'spawn', reason: 'unknown' };
  let pending = '';
  const classify = line => {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (plain === '[INFO] Generating configuration files...') state.last_stage = 'configuration';
    if (plain === '[INFO] Starting containers...') state.last_stage = 'containers';
    if (plain.startsWith('[ERROR] Fatal error: Error: Refusing to use work directory accessible by group or other users:')) {
      state.reason = 'work_directory_permissions';
    } else if (plain.startsWith('[ERROR] Fatal error: Error: Refusing to use work directory not owned by the invoking user:')) {
      state.reason = 'work_directory_owner';
    } else if (plain === '[ERROR] \u274c --network-isolation requires a reachable Docker daemon, but none was found.') {
      state.reason = 'docker_unavailable';
    } else if (plain === 'Catalogue smoke denied-policy staging failed: denial_policy_invalid' ||
      plain === 'Catalogue smoke denied-policy staging failed: smoke_subprocess_failed') {
      state.reason = 'denial_policy_staging';
    }
  };
  child.stderr.on('data', bytes => {
    // Retain at most one bounded line in memory; never persist or relay raw stderr.
    for (const part of bytes.toString('utf8').split(/(?<=\n)/)) {
      if (pending.length < 4096) pending += part.slice(0, 4096 - pending.length);
      if (part.endsWith('\n')) {
        classify(pending.trimEnd());
        pending = '';
      }
    }
  });
  child.on('error', error => {
    state.state = 'exited';
    state.reason = 'spawn_failed';
    state.spawn_error = ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code) ? error.code : 'other';
  });
  child.on('close', (code, signal) => {
    if (pending) classify(pending);
    pending = '';
    state.state = 'exited';
    state.exit_code = Number.isSafeInteger(code) && code >= 0 && code <= 255 ? code : null;
    if (signal) state.signal = ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(signal) ? signal : 'other';
  });
  return () => ({ ...state });
}

async function exercise(binary, root, mode, evidence) {
  assertIsolatedHost();
  const directory = path.join(root, mode);
  fs.mkdirSync(directory, { mode: 0o700 });
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config(mode)), { mode: 0o600 });
  const workDir = path.join(directory, 'work');
  // The released filesystem probe creates absent explicit work dirs as 0755.
  // Create our new private directory before that probe, without relaxing AWF's check.
  fs.mkdirSync(workDir, { mode: 0o700 });
  const composeFile = path.join(workDir, 'docker-compose.yml');
  const compose = ['compose', '-f', composeFile];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const denial = mode === 'denied' ? installDeniedDockerWrapper(directory, workDir) : null;
  if (denial) env.PATH = denial.path;
  for (const key of ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW_REF']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (mode === 'online') env.COPILOT_GITHUB_TOKEN = process.env.COPILOT_GITHUB_TOKEN;
  const finishCapture = mode === 'online' ? null : await captureNetwork();
  let captured = false;
  let exited = false;
  const child = spawn(binary, ['--config', configFile, '--work-dir', workDir,
    '--keep-containers', '--', 'sleep', '240'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const startup = observeStartup(child);
  child.on('error', () => { exited = true; });
  const closed = new Promise(resolve => child.on('close', () => { exited = true; resolve(); }));
  try {
    evidence.phase = 'readiness';
    let proxy;
    const result = await waitForCatalogue(async () => {
      assert.equal(exited, false, 'awf_exited_before_readiness');
      if (!fs.existsSync(composeFile)) return null;
      const ids = spawnSync('docker', [...compose, 'ps', '-q', 'api-proxy'],
        { encoding: 'utf8', timeout: 5000 });
      proxy = ids.status === 0 ? ids.stdout.trim() : '';
      const value = proxy ? reflection(proxy) : null;
      if (value?.model_catalogue) evidence.catalogue = projectCatalogue(value.model_catalogue);
      return value;
    }, mode, { timeoutMs: 120000 });
    evidence.catalogue = result.catalogue;
    evidence.phase = 'topology_and_images';
    evidence.topology = verifyTopology(proxy);
    const agent = await waitForAgent(compose);
    for (const [service, key] of [['api-proxy', 'apiProxy'], ['agent', 'agent'], ['squid-proxy', 'squid']]) {
      const id = run('docker', [...compose, 'ps', '--all', '-q', service]);
      const info = JSON.parse(run('docker', ['inspect', id]))[0];
      if (service === 'squid-proxy' && denial) {
        evidence.denial_policy = verifyDeniedPolicy(info, workDir, denial.docker);
      }
      assert.equal(info.Config.Image, RELEASE.images[key], 'running_image_reference');
      assert.equal(info.Image, run('docker', ['image', 'inspect', '--format', '{{.Id}}', RELEASE.images[key]]),
        'running_image_id');
      if (service === 'agent' && process.env.COPILOT_GITHUB_TOKEN) {
        assert.ok(!info.Config.Env.some(entry => entry.includes(process.env.COPILOT_GITHUB_TOKEN)),
          'agent_credential_exposed');
      }
    }
    if (mode === 'online') {
      evidence.phase = 'publication';
      const candidate = publication(proxy, result.catalogue);
      evidence.publication = { dataCommit: candidate.dataCommit, revision: candidate.revision,
        sourceCommit: candidate.sourceCommit };
      const selection = selectModel(result.reflection, candidate);
      evidence.phase = 'inference_and_accounting';
      evidence.accounting = await inference(agent, proxy, selection, result.catalogue);
    } else {
      assert.ok(Array.isArray(result.reflection.endpoints) && result.reflection.endpoints.length > 0 &&
        result.reflection.endpoints.every(endpoint => endpoint.configured === false), 'fallback_credentials_present');
      evidence.phase = 'bundled_pricing';
      evidence.pricing = bundledPricing(proxy);
      evidence.phase = 'network_evidence';
      await sleep(1000);
      const network = await finishCapture();
      captured = true;
      const squid = run('docker', [...compose, 'ps', '-q', 'squid-proxy']);
      const log = run('docker', ['exec', squid, 'cat', '/var/log/squid/access.log']);
      evidence.network = assertNetwork(mode, network.packets, network.summary, log);
    }
    evidence.status = 'passed';
    evidence.phase = 'complete';
  } catch (error) {
    if (evidence.phase === 'readiness') evidence.startup = startup();
    throw error;
  } finally {
    // Signal only this AWF invocation; compose down addresses only its services.
    try {
      if (!exited) child.kill('SIGTERM');
      let timer;
      try {
        await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 15000); })]);
      } finally {
        clearTimeout(timer);
      }
      if (!exited) { child.kill('SIGKILL'); await closed; }
    } finally {
      try {
        if (finishCapture && !captured) await finishCapture();
      } finally {
        if (fs.existsSync(composeFile)) run('docker', [...compose, 'down', '--volumes']);
      }
    }
  }
}

function downloadRelease(binary, execute = run, expectedDigest = RELEASE.binarySha256) {
  const url = `https://github.com/github/gh-aw-firewall/releases/download/v${RELEASE.version}/awf-linux-x64`;
  try {
    execute('curl', ['--fail', '--silent', '--show-error', '--location',
      '--proto', '=https', '--max-time', '120', '--output', binary, url], { timeout: 130000 });
  } catch {
    throw new Error('release_download');
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  assert.equal(digest, expectedDigest, 'release_digest');
  fs.chmodSync(binary, 0o700);
}

function validateExecutionContext(env, event, checkoutSha) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'approved_actions_only');
  assert.ok(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'trusted_event_only');
  const main = env.GITHUB_REF === 'refs/heads/main';
  const repair = env.GITHUB_REF === 'refs/heads/lpcox-fix-catalogue-denial-smoke';
  assert.ok(main || repair, 'trusted_ref_only');
  assert.ok(main || env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'trusted_event_only');
  assert.match(env.GITHUB_SHA || '', COMMIT, 'trusted_event_metadata');
  assert.equal(env.GITHUB_REPOSITORY, 'github/gh-aw-firewall', 'trusted_event_metadata');
  assert.equal(event?.repository?.full_name, env.GITHUB_REPOSITORY, 'trusted_event_metadata');
  assert.ok(typeof env.GITHUB_ACTOR === 'string' && env.GITHUB_ACTOR.length > 0, 'trusted_event_metadata');
  assert.equal(event?.sender?.login, env.GITHUB_ACTOR, 'trusted_event_metadata');
  assert.equal(env.GITHUB_WORKFLOW_REF,
    `github/gh-aw-firewall/.github/workflows/smoke-model-catalogue.yml@${env.GITHUB_REF}`,
    'trusted_event_metadata');
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA, 'trusted_event_metadata');
  assert.equal(checkoutSha, env.GITHUB_SHA, 'trusted_checkout_mismatch');
  if (env.GITHUB_EVENT_NAME === 'push') {
    assert.equal(event.ref, env.GITHUB_REF, 'trusted_event_metadata');
    assert.equal(event.after, env.GITHUB_SHA, 'trusted_event_metadata');
    assert.equal(event.inputs, undefined, 'trusted_event_metadata');
  } else {
    // GitHub dispatch metadata can use a bare branch or a fully qualified ref.
    assert.ok([env.GITHUB_REF, env.GITHUB_REF.slice('refs/heads/'.length)].includes(event.ref),
      'trusted_event_metadata');
  }
  const reviewed = event.inputs?.reviewed_head_sha;
  if (repair) assert.ok(typeof reviewed === 'string' && reviewed.length > 0, 'reviewed_head_sha_required');
  if (reviewed !== undefined && reviewed !== '') {
    assert.ok(typeof reviewed === 'string' && COMMIT.test(reviewed), 'reviewed_head_sha_mismatch');
    assert.equal(reviewed, env.GITHUB_SHA, 'reviewed_head_sha_mismatch');
  }
  return { mode: repair ? 'reviewed_repair_branch' : 'main', ref: env.GITHUB_REF, sha: env.GITHUB_SHA };
}

function readExecutionContext(env = process.env) {
  assert.ok(typeof env.GITHUB_EVENT_PATH === 'string' && path.isAbsolute(env.GITHUB_EVENT_PATH),
    'trusted_event_metadata');
  const descriptor = fs.openSync(env.GITHUB_EVENT_PATH, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    assert.ok(stat.isFile() && stat.size <= 1024 * 1024, 'trusted_event_metadata');
    const event = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    return validateExecutionContext(env, event, run('git', ['rev-parse', 'HEAD']));
  } finally {
    fs.closeSync(descriptor);
  }
}

async function main() {
  const execution = readExecutionContext();
  assert.ok(process.env.COPILOT_GITHUB_TOKEN, 'approved_copilot_credential_missing');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-catalogue-smoke-'));
  const evidence = { schemaVersion: 1, release: RELEASE, execution, cases: {} };
  const output = path.resolve(process.env.CATALOGUE_SMOKE_EVIDENCE);
  let stage = 'release';
  try {
    const binary = path.join(root, 'awf');
    downloadRelease(binary);
    assert.equal(run(binary, ['--version']), RELEASE.version, 'release_version');
    for (const image of Object.values(RELEASE.images)) run('docker', ['pull', image], { timeout: 180000 });
    for (const mode of ['online', 'offline', 'denied']) {
      stage = mode;
      evidence.cases[mode] = { status: 'failed' };
      try {
        await exercise(binary, root, mode, evidence.cases[mode]);
      } catch (error) {
        evidence.cases[mode].status = 'failed';
        evidence.cases[mode].failure = failureCode(error);
        evidence.failed_stage ??= mode;
        // Still exercise independent fallback cases if live activation/inference failed.
      }
    }
    assert.ok(Object.values(evidence.cases).every(value => value.status === 'passed'), 'smoke_case_failed');
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failed_stage ??= stage;
    evidence.failure = failureCode(error);
    process.exitCode = 1;
  } finally {
    if (Object.values(evidence.cases).some(value => value.status === 'failed')) {
      evidence.status = 'failed';
      process.exitCode = 1;
    }
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = Object.entries(evidence.cases).map(([mode, value]) =>
        `| ${mode} | ${value.status} | ${value.accounting?.central_accounting || 'not exercised'} |`);
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `## Released model catalogue smoke (${RELEASE.version})\n\nStatus: **${evidence.status}**\n\n` +
        '| Case | Result | Central accounting |\n| --- | --- | --- |\n' + rows.join('\n') + '\n');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { RELEASE, config, failureCode, projectCatalogue, waitForCatalogue, selectModel,
  assertAccounting, assertNetwork, publication, inference, bundledPricing, downloadRelease, exercise, observeStartup,
  validateExecutionContext, readExecutionContext, DENIAL_RULE, deniedPolicy, prepareDeniedCompose,
  installDeniedDockerWrapper, verifyDeniedPolicy };
if (require.main === module) main().catch(error => {
  console.error(`Model catalogue smoke failed: ${failureCode(error)}; raw diagnostics suppressed.`);
  process.exitCode = 1;
});
