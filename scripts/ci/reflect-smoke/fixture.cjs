'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomInt, createHash } = require('node:crypto');

async function start({ directory, proxyDirectory, scenario, port = 8080, host = '0.0.0.0' }) {
  if (!['recover', 'deny'].includes(scenario)) throw new Error('Unknown scenario');
  // This process has no inference credentials and never boots production discovery.
  process.env.COPILOT_PROVIDER_API_KEY = 'reflect-smoke-no-credential';
  if (scenario === 'deny') process.env.AWF_DISALLOWED_MODELS = JSON.stringify(['*']);
  else delete process.env.AWF_DISALLOWED_MODELS;
  const model = 'gpt-5.4';
  const effort = ['low', 'high'][randomInt(2)];
  const nonce = randomBytes(24).toString('hex');
  const result = createHash('sha256').update(nonce).digest('hex');
  const state = { version: 1, scenario, model, effort, nonce, result, events: [], upstream: [], complete: false };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const persist = () => {
    fs.writeFileSync(path.join(directory, 'evidence.tmp'), JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(path.join(directory, 'evidence.tmp'), path.join(directory, 'evidence.json'));
  };
  process.env.AWF_TOKEN_LOG_DIR = path.join(directory, 'proxy-logs');
  const backend = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    const valid = req.method === 'POST' && req.url === '/responses' &&
      parsed.model === model && parsed.reasoning?.effort === effort &&
      parsed.input === nonce && parsed.stream === false;
    state.upstream.push({ sequence: state.upstream.length, method: req.method, path: req.url, body: parsed,
      status: valid ? 200 : 422, error: valid ? null : 'fixture_task_mismatch' });
    persist();
    res.writeHead(valid ? 200 : 422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(valid
      ? { id: 'fixture-response', object: 'response', model, status: 'completed',
        output: [{ type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: result }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      : { error: { code: 'fixture_task_mismatch' } }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const target = `127.0.0.1:${backend.address().port}`;
  const production = require(path.join(proxyDirectory, 'server.js'));
  production.cachedModels.copilot = [model];
  require(path.join(proxyDirectory, 'runtime-model-catalog.js')).replaceRuntimeModels('copilot', [{
    id: model, supportedEndpoints: ['/responses'], supportedReasoningEfforts: [effort],
    scope: { provider: 'copilot', channel: 'copilot-api', deployment: `http://${target}` },
    capabilities: { supports: { reasoning_effort: [effort] } },
  }]);
  require(path.join(proxyDirectory, 'key-validation.js')).setModelFetchComplete(true);
  const server = production.createProviderServer({
    name: 'copilot', isEnabled: () => true, isManagementPort: true,
    getTargetHost: () => target, getTargetScheme: () => 'http',
    getAuthHeaders: () => ({}), getBasePath: () => '',
    getBodyTransform: () => production.makeModelBodyTransform('copilot'),
  }, Promise.resolve());
  server.prependListener('request', (req, res) => {
    const event = { sequence: state.events.length, method: req.method, path: req.url };
    state.events.push(event);
    res.once('finish', () => {
      event.finished = true;
      persist();
    });
    let body = '';
    const emit = req.emit;
    req.emit = function (name, ...args) {
      if (name === 'data') {
        body += args[0];
        if (body.length > 16384) req.destroy();
      }
      return emit.call(this, name, ...args);
    };
    const end = res.end;
    res.end = function (data, ...args) {
      event.status = res.statusCode;
      if (body) {
        try { event.body = JSON.parse(body); } catch { event.malformed = true; }
      }
      if (data) {
        try {
          const response = JSON.parse(data.toString());
          event.error = response.error?.code || response.error?.type || null;
          if (req.method === 'GET' && req.url === '/reflect') {
            event.reflection = response.model_decision_diagnostics;
          }
        } catch { event.nonJson = true; }
      }
      persist();
      return end.call(this, data, ...args);
    };
    if (state.events.length > 12) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'fixture_request_limit' } }));
      req.destroy();
      server.close();
      server.closeAllConnections();
    }
  });
  server.prependListener('upgrade', (req, socket) => {
    state.events.push({ sequence: state.events.length, method: 'UPGRADE', path: req.url });
    persist();
    socket.destroy();
  });
  server.on('connect', (req, socket) => {
    state.events.push({ sequence: state.events.length, method: 'CONNECT', path: req.url });
    persist();
    socket.destroy();
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  const task = { scenario, request: { model, reasoning: { effort: 'max' }, input: nonce, stream: false } };
  fs.writeFileSync(path.join(directory, 'initial-request.json'), JSON.stringify(task.request));
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(task));
  persist();
  return {
    port: server.address().port,
    async close() {
      await server.shutdownConnections();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      backend.closeAllConnections();
      await new Promise(resolve => backend.close(resolve));
      await require(path.join(proxyDirectory, 'otel.js')).shutdown();
      state.complete = true;
      persist();
    },
  };
}

if (require.main === module) {
  start({
    directory: process.env.FIXTURE_DIRECTORY || '/evidence',
    proxyDirectory: process.env.PROXY_DIRECTORY || '/app',
    scenario: process.env.SCENARIO,
    port: Number(process.env.FIXTURE_PORT || 8080),
  }).then(fixture => {
    if (process.send) process.send({ port: fixture.port });
    process.once('SIGTERM', () => fixture.close().then(() => process.exit(0)));
  }).catch(error => { console.error(error); process.exit(1); });
}

module.exports = { start };
