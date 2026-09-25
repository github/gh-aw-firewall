import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa = require('execa');
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { cleanup } from '../fixtures/cleanup';

const ROUTER_IMAGE = 'ghcr.io/githubnext/gh-aw-router:latest@sha256:d1612d0eaec3fa8f14c38bbd0a6a0682732fc9f83b7fec94219d3e757a048270';
const API_PROXY_IMAGE = 'ghcr.io/github/gh-aw-firewall/api-proxy:latest@sha256:9569f2c75545c4af0583b433fa5e3c477089fd1300b109d2b2358f4aa9702c6b';

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
      `      test: [CMD, python, -c, "import urllib.request; urllib.request.urlopen('http://localhost:8737/healthz', timeout=1).close()"]`,
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

  test('starts the pinned router and reaches it from the API proxy', async () => {
    await execa('docker', ['compose', '-f', composeFile, 'up', '-d']);
    const result = await execa('docker', [
      'compose', '-f', composeFile, 'exec', '-T', 'api-proxy',
      'node', '-e',
      "let attempts = 0; const probe = () => require('http').get('http://gh-aw-router:8737/healthz', response => process.exit(response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1)).on('error', () => ++attempts < 3 ? setTimeout(probe, 200) : process.exit(1)); probe()",
    ], {
      reject: false,
    });

    expect(result.exitCode).toBe(0);
  }, 360000);
});
