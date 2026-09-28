import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa = require('execa');
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { ROUTER_HEALTHCHECK_TEST } from '../../src/services/router-service';
import { cleanup } from '../fixtures/cleanup';

const ROUTER_IMAGE = 'ghcr.io/githubnext/gh-aw-router:latest@sha256:d1612d0eaec3fa8f14c38bbd0a6a0682732fc9f83b7fec94219d3e757a048270';
const API_PROXY_IMAGE = 'ghcr.io/github/gh-aw-firewall/api-proxy:latest@sha256:9569f2c75545c4af0583b433fa5e3c477089fd1300b109d2b2358f4aa9702c6b';
const ROUTER_SMOKE_SCRIPT = `
const assert = require('node:assert/strict');
const http = require('node:http');

function request(method, path, value) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    const req = http.request({
      hostname: 'gh-aw-router',
      port: 8737,
      path,
      method,
      headers: body ? {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(body.length),
      } : { accept: 'application/json' },
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
  const offered = [
    { id: 'fast', model: 'github-copilot/router-fast' },
    { id: 'reasoning-medium', model: 'github-copilot/router-reasoning', effort: 'medium' },
  ];
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

describe('Model routing', () => {
  let tempDir: string;
  let composeFile: string;

  beforeAll(async () => {
    await cleanup(false);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routing-integration-'));
    composeFile = path.join(tempDir, 'docker-compose.yml');
    fs.writeFileSync(composeFile, [
      'services:',
      '  router:',
      `    image: ${ROUTER_IMAGE}`,
      '    networks:',
      '      routing:',
      '        aliases: [gh-aw-router]',
      '    healthcheck:',
      `      test: ${JSON.stringify(ROUTER_HEALTHCHECK_TEST)}`,
      '      interval: 2s',
      '      timeout: 3s',
      '      retries: 15',
      '  api-proxy:',
      `    image: ${API_PROXY_IMAGE}`,
      '    networks: [routing, egress]',
      '    depends_on:',
      '      router:',
      '        condition: service_healthy',
      'networks:',
      '  routing:',
      '    internal: true',
      '  egress: {}',
      '',
    ].join('\n'), { mode: 0o600 });
  });

  afterAll(async () => {
    await execa('docker', ['compose', '-f', composeFile, 'down', '-v'], { reject: false });
    fs.rmSync(tempDir, { recursive: true, force: true });
    await cleanup(false);
  });

  test('runs the router planning contract from the API proxy network', async () => {
    await execa('docker', ['compose', '-f', composeFile, 'up', '-d']);
    const result = await execa('docker', [
      'compose', '-f', composeFile, 'exec', '-T', 'api-proxy',
      'node', '-e',
      ROUTER_SMOKE_SCRIPT,
    ], {
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('MODEL_ROUTING_SMOKE=');
    expect(result.stdout).toContain('"checks":["health","capabilities","classifier","route"]');
  }, 360000);
});
