'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

describe('dedicated enclave proxy response audit', () => {
  let directory;
  let savedLogDir;
  let savedBudget;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(process.cwd(), '.enclave-response-test-'));
    savedLogDir = process.env.AWF_TOKEN_LOG_DIR;
    savedBudget = process.env.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET;
    process.env.AWF_TOKEN_LOG_DIR = directory;
    process.env.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET = 'PRIVATE_BUDGET_SECRET';
  });

  afterEach(async () => {
    if (savedLogDir === undefined) delete process.env.AWF_TOKEN_LOG_DIR;
    else process.env.AWF_TOKEN_LOG_DIR = savedLogDir;
    if (savedBudget === undefined) delete process.env.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET;
    else process.env.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET = savedBudget;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('classifies client responses but excludes health, reflect and management probes', async () => {
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

  test('bounds the audit at exactly 4096 complete schema-valid records', async () => {
    let persistence;
    jest.isolateModules(() => {
      persistence = require('./token-persistence');
    });
    for (let i = 0; i < 4097; i++) {
      persistence.auditEnclaveResponse(401, 'upstream');
    }
    await persistence.closeLogStream();
    const lines = fs.readFileSync(path.join(directory, 'enclave-proxy-events.jsonl'), 'utf8')
      .trimEnd().split('\n');
    expect(lines).toHaveLength(4096);
    expect(JSON.parse(lines[0])).toEqual({ schemaVersion: 1, origin: 'upstream', status: 401 });
    expect(JSON.parse(lines[4095])).toEqual({ schemaVersion: 1, origin: 'upstream', status: 401 });
  });
});
