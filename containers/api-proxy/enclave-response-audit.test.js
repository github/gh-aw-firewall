'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

describe('dedicated enclave proxy response audit', () => {
  let directory;
  let savedLogDir;
  let savedBudget;
  let savedDiagnostics;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(process.cwd(), '.enclave-response-test-'));
    savedLogDir = process.env.AWF_TOKEN_LOG_DIR;
    savedBudget = process.env.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET;
    savedDiagnostics = process.env.AWF_ENCLAVE_PROXY_DIAGNOSTICS;
    process.env.AWF_TOKEN_LOG_DIR = directory;
    process.env.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET = 'PRIVATE_BUDGET_SECRET';
    process.env.AWF_ENCLAVE_PROXY_DIAGNOSTICS = '1';
  });

  afterEach(async () => {
    if (savedLogDir === undefined) delete process.env.AWF_TOKEN_LOG_DIR;
    else process.env.AWF_TOKEN_LOG_DIR = savedLogDir;
    if (savedBudget === undefined) delete process.env.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET;
    else process.env.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET = savedBudget;
    if (savedDiagnostics === undefined) delete process.env.AWF_ENCLAVE_PROXY_DIAGNOSTICS;
    else process.env.AWF_ENCLAVE_PROXY_DIAGNOSTICS = savedDiagnostics;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('classifies client responses but excludes health, reflect and management probes', async () => {
    delete process.env.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET;
    let persistence;
    let createProviderServer;
    jest.isolateModules(() => {
      persistence = require('./token-persistence');
      ({ createProviderServer } = require('./server-factory'));
    });
    let configured = true;
    const adapter = {
      name: 'copilot', isEnabled: () => configured, isManagementPort: true,
      getTargetHost: () => 'example.com', getAuthHeaders: () => ({}),
      getBasePath: () => '', getBodyTransform: () => null,
    };
    const server = createProviderServer(adapter, {
      handleManagementEndpoint: (req, res) => {
        if (req.url !== '/management') return false;
        res.writeHead(200);
        res.end('OK');
        return true;
      },
      reflectEndpoints: () => [],
      checkRateLimit: () => false,
      proxyRequest: (_req, res) => {
        res.awfUpstreamResponse = true;
        res.writeHead(401);
        res.end('PRIVATE_RESPONSE');
      },
      proxyWebSocket: () => {},
    });
    server.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const request = (pathname) => new Promise((resolve, reject) => {
      http.get({
        host: '127.0.0.1', port: server.address().port,
        path: pathname, headers: { authorization: 'PRIVATE_CREDENTIAL' },
      }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    try {
      expect(await request('/health')).toBe(200);
      expect(await request('/reflect')).toBe(200);
      expect(await request('/management')).toBe(200);
      configured = false;
      expect(await request('/v1/messages?token=PRIVATE_LOCAL_QUERY')).toBe(503);
      configured = true;
      expect(await request('/v1/messages?token=PRIVATE_QUERY')).toBe(401);
      await persistence.closeLogStream();
      const name = path.join(directory, 'enclave-proxy-events.jsonl');
      const content = fs.readFileSync(name, 'utf8');
      expect(content).toBe('{"schemaVersion":1,"origin":"local","status":503}\n' +
        '{"schemaVersion":1,"origin":"upstream","status":401}\n');
      expect(content).not.toMatch(/PRIVATE|token|authorization|request/);
      expect(fs.statSync(name).mode & 0o777).toBe(0o600);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('retains one overflow record after 4096 successes rather than hiding a later rejection', async () => {
    let persistence;
    jest.isolateModules(() => {
      persistence = require('./token-persistence');
    });
    for (let i = 0; i < 4096; i++) {
      persistence.auditEnclaveResponse(200, 'upstream');
    }
    persistence.auditEnclaveResponse(403, 'local');
    persistence.auditEnclaveResponse(401, 'upstream');
    await persistence.closeLogStream();
    const lines = fs.readFileSync(path.join(directory, 'enclave-proxy-events.jsonl'), 'utf8')
      .trimEnd().split('\n');
    expect(lines).toHaveLength(4097);
    expect(JSON.parse(lines[0])).toEqual({ schemaVersion: 1, origin: 'upstream', status: 200 });
    expect(JSON.parse(lines[4096])).toEqual({ schemaVersion: 1, origin: 'local', status: 403 });
  });

  test('audits WebSocket budget-policy rejections before destroying the socket', async () => {
    let persistence;
    let createWebSocketUpgradeHandler;
    jest.isolateModules(() => {
      persistence = require('./token-persistence');
      ({ createWebSocketUpgradeHandler } = require('./server-factory'));
    });
    const socket = { write: jest.fn(), destroy: jest.fn() };
    const upstream = jest.fn();
    createWebSocketUpgradeHandler({}, upstream, { modelBudgetEnabled: true })({}, socket, Buffer.alloc(0));
    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(upstream).not.toHaveBeenCalled();
    await persistence.closeLogStream();
    expect(fs.readFileSync(path.join(directory, 'enclave-proxy-events.jsonl'), 'utf8'))
      .toBe('{"schemaVersion":1,"origin":"local","status":403}\n');
  });

  test('does not enable dedicated diagnostics on the primary proxy even with a budget secret', async () => {
    delete process.env.AWF_ENCLAVE_PROXY_DIAGNOSTICS;
    let persistence;
    jest.isolateModules(() => { persistence = require('./token-persistence'); });
    persistence.auditEnclaveResponse(403, 'local');
    await persistence.closeLogStream();
    expect(fs.existsSync(path.join(directory, 'enclave-proxy-events.jsonl'))).toBe(false);
  });
});
