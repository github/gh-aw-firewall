import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa = require('execa');
import * as yaml from 'js-yaml';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { parseImageTag } from '../../src/image-tag';
import { buildRouterService, ROUTER_HEALTHCHECK_TEST } from '../../src/services/router-service';
import { ROUTER_LOG_FILE, stopRouterAndSaveLogs } from '../../src/routing/router-log-capture';
import { cleanup } from '../fixtures/cleanup';

// The model-routing smoke workflow sets ROUTER_IMAGE to a digest-pinned build of containers/router.
// Without it, compose builds containers/router, as AWF's local build does.
const ROUTER_IMAGE = process.env.ROUTER_IMAGE;
const ROUTER_DIR = path.resolve(__dirname, '../../containers/router');
// The api-proxy image is only a Node.js runtime here, for the smoke client and the test collector.
// The pin is amd64-only, so hosts without amd64 emulation can override it.
const API_PROXY_IMAGE = process.env.ROUTING_TEST_API_PROXY_IMAGE
  || 'ghcr.io/github/gh-aw-firewall/api-proxy:latest@sha256:9569f2c75545c4af0583b433fa5e3c477089fd1300b109d2b2358f4aa9702c6b';
const ROUTER_SMOKE_SCRIPT = `
const assert = require('node:assert/strict');
const http = require('node:http');
const traceparents = JSON.parse(process.env.SMOKE_TRACEPARENTS || '{}');

function request(method, path, value) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    const headers = body ? {
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': String(body.length),
    } : { accept: 'application/json' };
    if (traceparents[path]) headers.traceparent = traceparents[path];
    const req = http.request({
      hostname: 'gh-aw-router',
      port: 8737,
      path,
      method,
      headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(60000, () => req.destroy(new Error(method + ' ' + path + ' timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function assertRankedChoices(response, offered, endpoint) {
  assert.equal(response.status, 200, endpoint + ' returned HTTP ' + response.status + ': ' + response.body);
  const parsed = JSON.parse(response.body);
  assert.ok(Array.isArray(parsed.ranked_choices) && parsed.ranked_choices.length > 0,
    endpoint + ' returned no ranked choices');
  const choiceKey = choice => JSON.stringify([
    choice.id,
    choice.model,
    Object.hasOwn(choice, 'effort') ? choice.effort : '<omitted>',
  ]);
  const allowed = new Set(offered.map(choiceKey));
  for (const choice of parsed.ranked_choices) {
    assert.ok(allowed.has(choiceKey(choice)), endpoint + ' returned an unoffered choice');
  }
  return parsed;
}

(async () => {
  const health = await request('GET', '/healthz');
  assert.equal(health.status, 204, 'router health endpoint did not return 204');
  assert.equal(health.body, '', 'router health endpoint returned a response body');

  const capabilitiesResponse = await request('GET', '/capabilities');
  assert.equal(capabilitiesResponse.status, 200,
    'router capabilities returned HTTP ' + capabilitiesResponse.status + ': ' + capabilitiesResponse.body);
  const capabilities = JSON.parse(capabilitiesResponse.body);
  assert.equal(capabilities.name, 'gh-aw-router');
  assert.ok(typeof capabilities.version === 'string' && capabilities.version.length > 0);
  assert.ok(capabilities.routing_profiles.some(profile =>
    profile.goal === 'cost' && profile.mode === 'balanced'),
  'router does not advertise cost/balanced routing');

  const conversation = [{ role: 'user', parts: [{ text: 'Proceed.' }] }];
  const executionModels = capabilities.execution_catalogue?.models;
  assert.ok(Array.isArray(executionModels) && executionModels.length > 0,
    'router capabilities omitted the execution catalogue');
  let nextChoice = 1;
  const offered = executionModels.flatMap(entry => {
    assert.ok(typeof entry.model === 'string' && entry.model.length > 0,
      'router execution catalogue contains an invalid model');
    assert.ok(Array.isArray(entry.efforts),
      'router execution catalogue contains invalid efforts');
    if (entry.efforts.length === 0) {
      return [{ id: 'advertised-' + nextChoice++, model: entry.model }];
    }
    return entry.efforts.map(effort => ({
      id: 'advertised-' + nextChoice++,
      model: entry.model,
      effort,
    }));
  });
  const classification = assertRankedChoices(await request('POST', '/classify', {
    conversation,
    models: offered,
  }), offered, 'classifier');
  assert.ok(typeof classification.system_prompt === 'string' && classification.system_prompt.length > 0,
    'classifier response omitted its system prompt');
  assert.ok(typeof classification.prompt === 'string', 'classifier response omitted its prompt');

  const route = assertRankedChoices(await request('POST', '/route', {
    objective: { goal: 'cost', mode: 'balanced' },
    conversation,
    models: offered,
    classification: null,
  }), offered, 'route');

  console.log('MODEL_ROUTING_SMOKE=' + JSON.stringify({
    router: capabilities.name,
    version: capabilities.version,
    checks: ['health', 'capabilities', 'classifier', 'route'],
    classifierChoices: classification.ranked_choices.length,
    selected: route.ranked_choices[0],
  }));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
`;

// A test-only OTLP/HTTP protobuf collector. It records each export with its decoded spans or
// metric names, and answers every export with COLLECTOR_STATUS.
const OTLP_COLLECTOR_SCRIPT = `
const http = require('node:http');
const status = Number(process.env.COLLECTOR_STATUS || '200');
const exportsReceived = [];

function fields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buf[i++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ field, value: varint() });
    else if (wire === 1) { out.push({ field, value: buf.subarray(i, i + 8) }); i += 8; }
    else if (wire === 2) { const n = Number(varint()); out.push({ field, value: buf.subarray(i, i + n) }); i += n; }
    else if (wire === 5) { out.push({ field, value: buf.subarray(i, i + 4) }); i += 4; }
    else throw new Error('unsupported wire type ' + wire);
  }
  return out;
}
const sub = (buf, field) => fields(buf).filter(f => f.field === field).map(f => f.value);
const text = buf => Buffer.from(buf || []).toString('utf8');
const hex = buf => Buffer.from(buf || []).toString('hex');

function attributes(buf, field) {
  const result = {};
  for (const kv of sub(buf, field)) {
    const value = sub(kv, 2)[0];
    const v = value ? fields(value)[0] : undefined;
    result[text(sub(kv, 1)[0])] = !v ? null
      : v.field === 1 ? text(v.value)
      : v.field === 2 ? v.value !== 0n
      : v.field === 3 ? Number(v.value)
      : null;
  }
  return result;
}

function resourceOf(buf) {
  const resource = sub(buf, 1)[0];
  return resource ? attributes(resource, 1) : {};
}

function decodeTraces(body) {
  return sub(body, 1).flatMap(rs => sub(rs, 2).flatMap(ss => sub(ss, 2).map(span => ({
    resource: resourceOf(rs),
    traceId: hex(sub(span, 1)[0]),
    spanId: hex(sub(span, 2)[0]),
    parentSpanId: hex(sub(span, 4)[0]),
    name: text(sub(span, 5)[0]),
    kind: Number(sub(span, 6)[0] || 0n),
    attributes: attributes(span, 9),
  }))));
}

function decodeMetrics(body) {
  return sub(body, 1).flatMap(rm => sub(rm, 2).flatMap(sm => sub(sm, 2).map(metric => ({
    resource: resourceOf(rm),
    name: text(sub(metric, 1)[0]),
  }))));
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'GET' && req.url === '/received') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(exportsReceived));
      return;
    }
    if (req.method === 'POST' && (req.url === '/v1/traces' || req.url === '/v1/metrics')) {
      const signal = req.url.slice('/v1/'.length);
      const record = {
        signal,
        contentType: req.headers['content-type'] || null,
        authorization: req.headers.authorization || null,
        literal: req.headers['x-awf-literal'] || null,
        status,
      };
      try {
        record.items = signal === 'traces' ? decodeTraces(body) : decodeMetrics(body);
      } catch (error) {
        record.error = String(error);
      }
      exportsReceived.push(record);
      res.writeHead(status, { 'content-type': 'application/x-protobuf' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
}).listen(4318, '0.0.0.0');
`;

const COLLECTOR_QUERY_SCRIPT = `
fetch('http://127.0.0.1:4318/received')
  .then(response => response.text())
  .then(body => console.log('OTLP_RECEIVED=' + body))
  .catch(error => { console.error(error); process.exitCode = 1; });
`;

const SERVER_SPAN_KIND = 2;
const INTERNAL_SPAN_KIND = 1;

interface CollectedSpan {
  resource: Record<string, unknown>;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  attributes: Record<string, unknown>;
}

interface CollectedExport {
  signal: 'traces' | 'metrics';
  contentType: string | null;
  authorization: string | null;
  literal: string | null;
  status: number;
  items?: Array<CollectedSpan | { resource: Record<string, unknown>; name: string }>;
  error?: string;
}

interface Scenario {
  name: string;
  // AWF_ROUTER_OTEL_* host settings, which AWF's router service turns into the router's environment.
  hostSettings?: Record<string, string>;
  // The collector's response status, or undefined for no collector.
  collectorStatus?: number;
}

interface ScenarioResult {
  selected: { model: string; effort?: string };
  received: CollectedExport[];
  // The router's records as AWF saved them at teardown, one parsed object per line.
  routerLogs: Array<Record<string, unknown>>;
}

// Only the router's environment is taken from this service; the image comes from routerSource().
const ROUTER_IMAGE_CONFIG = {
  useGHCR: true,
  registry: 'ghcr.io/github/gh-aw-firewall',
  parsedTag: parseImageTag('latest'),
  projectRoot: path.resolve(__dirname, '../..'),
};
const COLLECTOR_HEADER_TOKEN = 'test-collector-token';
// Compose would interpolate these `$` sequences unless AWF escapes them.
const LITERAL_HEADER_VALUE = 'a$HOME${HOME}$$';
const BASE_EXPORT_SETTINGS = {
  AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
  AWF_ROUTER_OTEL_EXPORTER_OTLP_HEADERS:
    `authorization=Bearer%20${COLLECTOR_HEADER_TOKEN},x-awf-literal=${LITERAL_HEADER_VALUE}`,
  AWF_ROUTER_OTEL_SERVICE_NAME: 'gh-aw-router-integration',
  AWF_ROUTER_OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=awf,deployment.environment.name=integration,host.name=ignored',
};

describe('Model routing', () => {
  let tempDir: string;
  let collectorDir: string;
  const projects: Array<{ project: string; file: string }> = [];

  function routerSource(): Record<string, unknown> {
    if (ROUTER_IMAGE) return { image: ROUTER_IMAGE };
    return {
      build: {
        context: ROUTER_DIR,
        args: {
          OPENAPI_SHA256: crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(ROUTER_DIR, 'openapi.yaml'))).digest('hex'),
        },
      },
    };
  }

  function writeCompose(scenario: Scenario, workDir: string): string {
    const routerEnvironment: Record<string, string> | undefined = buildRouterService({
      imageConfig: ROUTER_IMAGE_CONFIG,
      hostEnv: scenario.hostSettings ?? {},
    }).environment;
    const services: Record<string, unknown> = {
      router: {
        ...routerSource(),
        ...(routerEnvironment && { environment: routerEnvironment }),
        networks: { routing: { aliases: ['gh-aw-router'] } },
        healthcheck: {
          test: ROUTER_HEALTHCHECK_TEST,
          interval: '2s',
          timeout: '3s',
          retries: 15,
        },
      },
      'api-proxy': {
        image: API_PROXY_IMAGE,
        networks: ['routing', 'egress'],
        depends_on: { router: { condition: 'service_healthy' } },
      },
    };
    if (scenario.collectorStatus !== undefined) {
      // Only on the internal network, like the router, and independent of the api-proxy's
      // dependency on router health.
      services['otel-collector'] = {
        image: API_PROXY_IMAGE,
        entrypoint: ['node', '/collector/collector.js'],
        environment: { COLLECTOR_STATUS: String(scenario.collectorStatus) },
        volumes: [`${collectorDir}:/collector:ro`],
        networks: ['routing'],
      };
    }
    const file = path.join(workDir, 'docker-compose.yml');
    fs.writeFileSync(file, yaml.dump({
      services,
      networks: { routing: { internal: true }, egress: {} },
    }, { lineWidth: -1 }), { mode: 0o600 });
    return file;
  }

  async function compose(file: string, project: string, args: string[]): Promise<execa.ExecaReturnValue> {
    return execa('docker', ['compose', '-p', project, '-f', file, ...args], { reject: false });
  }

  async function failWithLogs(file: string, project: string, message: string): Promise<never> {
    const logs = await compose(file, project, ['logs', '--no-color', 'router']);
    throw new Error(`${message}\nrouter logs:\n${logs.stdout}\n${logs.stderr}`);
  }

  async function runScenario(scenario: Scenario, traceparents: Record<string, string> = {}): Promise<ScenarioResult> {
    const project = `awf-routing-it-${scenario.name}`;
    // Like AWF's work directory, the compose file's directory names the project.
    const workDir = path.join(tempDir, project);
    fs.mkdirSync(workDir);
    const file = writeCompose(scenario, workDir);
    projects.push({ project, file });

    const up = await compose(file, project, ['up', '-d']);
    if (up.exitCode !== 0) await failWithLogs(file, project, `compose up failed:\n${up.stderr}`);
    const smoke = await compose(file, project, [
      'exec', '-T', '-e', `SMOKE_TRACEPARENTS=${JSON.stringify(traceparents)}`, 'api-proxy',
      'node', '-e', ROUTER_SMOKE_SCRIPT,
    ]);
    if (smoke.exitCode !== 0) {
      await failWithLogs(file, project,
        `Router smoke exited ${smoke.exitCode}\nstdout:\n${smoke.stdout}\nstderr:\n${smoke.stderr}`);
    }
    expect(smoke.stdout).toContain('"checks":["health","capabilities","classifier","route"]');
    const summary = JSON.parse(smoke.stdout.split('\n')
      .find(line => line.startsWith('MODEL_ROUTING_SMOKE='))!.slice('MODEL_ROUTING_SMOKE='.length));

    // AWF's teardown step: stop the router alone, which flushes its telemetry while the
    // collector stays up, and save its logs before compose down would remove them.
    const routerLogsDir = path.join(workDir, 'router-logs');
    const capture = await stopRouterAndSaveLogs(workDir, routerLogsDir);
    if (capture !== 'saved') await failWithLogs(file, project, `router log capture was ${capture}`);
    const routerLogs = fs.readFileSync(path.join(routerLogsDir, ROUTER_LOG_FILE), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);

    let received: CollectedExport[] = [];
    if (scenario.collectorStatus !== undefined) {
      const query = await compose(file, project, ['exec', '-T', 'otel-collector', 'node', '-e', COLLECTOR_QUERY_SCRIPT]);
      if (query.exitCode !== 0) await failWithLogs(file, project, `collector query failed:\n${query.stderr}`);
      received = JSON.parse(query.stdout.split('\n')
        .find(line => line.startsWith('OTLP_RECEIVED='))!.slice('OTLP_RECEIVED='.length));
    }
    return { selected: summary.selected, received, routerLogs };
  }

  function traceContext(): { traceId: string; parents: Record<string, string>; traceparents: Record<string, string> } {
    const traceId = crypto.randomBytes(16).toString('hex');
    const parents: Record<string, string> = {};
    const traceparents: Record<string, string> = {};
    for (const route of ['/capabilities', '/classify', '/route']) {
      parents[route] = crypto.randomBytes(8).toString('hex');
      traceparents[route] = `00-${traceId}-${parents[route]}-01`;
    }
    return { traceId, parents, traceparents };
  }

  const spansOf = (received: CollectedExport[]): CollectedSpan[] =>
    received.filter(e => e.signal === 'traces').flatMap(e => (e.items ?? []) as CollectedSpan[]);
  const metricNamesOf = (received: CollectedExport[]): string[] =>
    received.filter(e => e.signal === 'metrics').flatMap(e => (e.items ?? []).map(item => item.name));

  beforeAll(async () => {
    await cleanup(false);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routing-integration-'));
    collectorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routing-collector-'));
    fs.writeFileSync(path.join(collectorDir, 'collector.js'), OTLP_COLLECTOR_SCRIPT, { mode: 0o644 });
    fs.chmodSync(collectorDir, 0o755);
  });

  afterAll(async () => {
    for (const { project, file } of projects) {
      await compose(file, project, ['down', '-v']);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(collectorDir, { recursive: true, force: true });
    await cleanup(false);
  });

  test('runs the router planning contract from the API proxy network', async () => {
    // A collector is on the network, but with no AWF_ROUTER_OTEL_* settings nothing is sent to it.
    const { received, routerLogs } = await runScenario({ name: 'plain', collectorStatus: 200 });
    expect(received).toEqual([]);

    // The saved log runs from startup to the shutdown records written after the stop.
    const messages = routerLogs.map(record => record.msg);
    expect(messages[0]).toBe('starting');
    expect(messages).toEqual(expect.arrayContaining(['routing tables loaded', 'listening', 'request', 'shutting down']));
    expect(messages[messages.length - 1]).toBe('stopped');
  }, 360000);

  test('exports router traces and metrics to a collector on the internal network', async () => {
    const { traceId, parents, traceparents } = traceContext();
    const { selected, received, routerLogs } = await runScenario(
      { name: 'export', hostSettings: BASE_EXPORT_SETTINGS, collectorStatus: 200 },
      traceparents,
    );

    expect(received.filter(e => e.error)).toEqual([]);
    for (const signal of ['traces', 'metrics']) {
      expect(received.some(e => e.signal === signal)).toBe(true);
    }
    for (const exported of received) {
      expect(exported.contentType).toBe('application/x-protobuf');
      expect(exported.authorization).toBe(`Bearer ${COLLECTOR_HEADER_TOKEN}`);
      for (const item of exported.items ?? []) {
        expect(item.resource).toMatchObject({
          'service.name': 'gh-aw-router-integration',
          'service.namespace': 'awf',
          'deployment.environment.name': 'integration',
        });
        // An array key path, so that Jest checks the literal dotted attribute name.
        expect(item.resource).not.toHaveProperty(['host.name']);
      }
      // The `$` sequences reach the collector literally, after Compose interpolation.
      expect(exported.literal).toBe(LITERAL_HEADER_VALUE);
    }

    const spans = spansOf(received);
    const serverSpans: Record<string, CollectedSpan> = {};
    for (const [route, name] of [['/capabilities', 'GET /capabilities'], ['/classify', 'POST /classify'], ['/route', 'POST /route']]) {
      const span = spans.find(s => s.kind === SERVER_SPAN_KIND && s.name === name);
      expect(span).toBeDefined();
      // The caller's client span is the parent, as the api-proxy's router-call span is in AWF.
      expect(span!.traceId).toBe(traceId);
      expect(span!.parentSpanId).toBe(parents[route]);
      serverSpans[route] = span!;
    }
    expect(spans.some(s => s.name === 'GET /healthz')).toBe(false);
    for (const [route, name] of [['/classify', 'gh_aw_router.classify'], ['/route', 'gh_aw_router.route']]) {
      const span = spans.find(s => s.kind === INTERNAL_SPAN_KIND && s.name === name);
      expect(span).toBeDefined();
      expect(span!.traceId).toBe(traceId);
      expect(span!.parentSpanId).toBe(serverSpans[route].spanId);
    }
    const routeSpan = spans.find(s => s.name === 'gh_aw_router.route')!;
    expect(routeSpan.attributes).toMatchObject({
      'gh_aw_router.goal': 'cost',
      'gh_aw_router.mode': 'balanced',
      'gh_aw_router.outcome': 'ok',
      'gh_aw_router.selected.model': selected.model,
    });
    expect(JSON.stringify(spans)).not.toContain(COLLECTOR_HEADER_TOKEN);
    expect(JSON.stringify(spans)).not.toContain('Proceed.');

    // Each saved request record names the span that served it.
    for (const route of ['/capabilities', '/classify', '/route']) {
      expect(routerLogs.find(record => record.msg === 'request' && record.route === route)).toMatchObject({
        trace_id: traceId,
        span_id: serverSpans[route].spanId,
      });
    }
    expect(JSON.stringify(routerLogs)).not.toContain(COLLECTOR_HEADER_TOKEN);
    expect(JSON.stringify(routerLogs)).not.toContain('Proceed.');

    const metricNames = metricNamesOf(received);
    expect(metricNames).toEqual(expect.arrayContaining([
      'http.server.request.duration',
      'gh_aw_router.planning.outcomes',
    ]));
  }, 360000);

  test('exports only the signals that are left on', async () => {
    const { traceparents } = traceContext();
    const { received } = await runScenario({
      name: 'traces-only',
      hostSettings: { ...BASE_EXPORT_SETTINGS, AWF_ROUTER_OTEL_METRICS_EXPORTER: 'none' },
      collectorStatus: 200,
    }, traceparents);

    expect(spansOf(received).length).toBeGreaterThan(0);
    expect(received.filter(e => e.signal === 'metrics')).toEqual([]);
  }, 360000);

  test('exports nothing when the SDK is disabled, and routing still works', async () => {
    const { traceparents } = traceContext();
    const { received } = await runScenario({
      name: 'sdk-disabled',
      hostSettings: { ...BASE_EXPORT_SETTINGS, AWF_ROUTER_OTEL_SDK_DISABLED: 'true' },
      collectorStatus: 200,
    }, traceparents);

    expect(received).toEqual([]);
  }, 360000);

  test('keeps routing when the collector rejects every export', async () => {
    const { traceparents } = traceContext();
    const { received } = await runScenario({
      name: 'failing-collector',
      hostSettings: { ...BASE_EXPORT_SETTINGS, AWF_ROUTER_OTEL_EXPORTER_OTLP_TIMEOUT: '2000' },
      collectorStatus: 503,
    }, traceparents);

    // The router tried to export and the smoke contract still passed.
    expect(received.some(e => e.signal === 'traces' && e.status === 503)).toBe(true);
  }, 360000);
});

