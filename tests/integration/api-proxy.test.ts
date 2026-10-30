/**
 * API Proxy Sidecar Integration Tests
 *
 * Tests that the --enable-api-proxy flag correctly starts the API proxy sidecar
 * and routes requests through Squid.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa = require('execa');

// The API proxy sidecar is at this fixed IP on the awf-net network
const API_PROXY_IP = '172.30.0.30';

describe('API Proxy Sidecar', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('routes BYOK models and chat to HTTP :11434 without opening that port to the agent', async () => {
    const requests: string[] = [];
    const upstream = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'awf-port-test', object: 'model' }] }));
      } else if (req.url === '/v1/chat/completions') {
        req.resume();
        req.on('end', () => res.end(JSON.stringify({
          id: 'awf-port-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'custom-port-ok' }, finish_reason: 'stop' }],
        })));
      } else {
        res.writeHead(404).end();
      }
    });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-byok-port-'));
    try {
      await new Promise<void>((resolve, reject) => {
        upstream.once('error', reject);
        upstream.listen(11434, '0.0.0.0', resolve);
      });
      const configFile = path.join(tempDir, 'config.json');
      fs.writeFileSync(configFile, JSON.stringify({
        network: { allowDomains: ['host.docker.internal'], isolation: true },
        security: { enableHostAccess: true },
        apiProxy: { enabled: true },
      }));
      const result = await runner.run(
        `set -eu; curl -fsS http://${API_PROXY_IP}:10002/v1/models; ` +
        `curl -fsS http://${API_PROXY_IP}:10002/chat/completions -H 'Content-Type: application/json' ` +
        `-d '{"model":"awf-port-test","messages":[{"role":"user","content":"hi"}]}'; ` +
        `test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --noproxy '' --proxy http://172.30.0.10:3128 ` +
        `http://host.docker.internal:11434/v1/models || true)" = 403`,
        {
          configFile,
          buildLocal: true,
          keepContainers: true,
          logLevel: 'debug',
          timeout: 300000,
          env: {
            COPILOT_PROVIDER_API_KEY: 'awf-test-placeholder',
            COPILOT_PROVIDER_BASE_URL: 'http://host.docker.internal:11434/v1',
          },
        }
      );
      expect(result).toSucceed();
      expect(result.stdout).toContain('awf-port-test');
      expect(result.stdout).toContain('custom-port-ok');
      expect(requests).toContain('GET /v1/models');
      expect(requests).toContain('POST /v1/chat/completions');
      for (const authority of [
        'host.docker.internal:11435',
        'unconfigured.invalid:11434',
        '127.0.0.1:11434',
      ]) {
        const probe = await execa('docker', [
          'exec', 'awf-api-proxy', 'node', '-e',
          `const req = require('http').request({
            hostname: '172.30.0.10', port: 3128, method: 'GET',
            path: ${JSON.stringify(`http://${authority}/v1/models`)}
          }, res => { console.log(res.statusCode); res.resume(); });
          req.on('error', () => process.exit(1));
          req.setTimeout(10000, () => { req.destroy(); process.exit(1); });
          req.end();`,
        ]);
        expect(probe.stdout.trim()).toBe('403');
      }
    } finally {
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      await cleanup(false);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 360000);

  test('should start api-proxy sidecar with Anthropic key and pass healthcheck', async () => {
    // This is the first test to run and may trigger a cold Docker build for the
    // api-proxy / iptables-init images (not pre-built in the CI "Build local containers"
    // step). Allow up to 5 minutes for the build + startup + run + teardown.
    const result = await runner.run(
      `curl -s http://${API_PROXY_IP}:10001/health`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 300000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('"status":"healthy"');
    expect(result.stdout).toContain('awf-api-proxy-anthropic');
  }, 360000);

  test('should start api-proxy sidecar with OpenAI key and pass healthcheck', async () => {
    const result = await runner.run(
      `curl -s http://${API_PROXY_IP}:10000/health`,
      {
        allowDomains: ['api.openai.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          OPENAI_API_KEY: 'sk-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('"status":"healthy"');
    expect(result.stdout).toContain('awf-api-proxy');
  }, 180000);

  test('should set ANTHROPIC_BASE_URL in agent when Anthropic key is provided', async () => {
    const result = await runner.run(
      'bash -c "echo ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"',
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain(`ANTHROPIC_BASE_URL=http://${API_PROXY_IP}:10001`);
  }, 180000);

  test('should set ANTHROPIC_AUTH_TOKEN to placeholder in agent when Anthropic key is provided', async () => {
    const result = await runner.run(
      'bash -c "echo ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN"',
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('ANTHROPIC_AUTH_TOKEN=sk-ant-placeholder-key-for-credential-isolation');
  }, 180000);

  test('should set OPENAI_BASE_URL in agent when OpenAI key is provided', async () => {
    const result = await runner.run(
      'bash -c "echo OPENAI_BASE_URL=$OPENAI_BASE_URL"',
      {
        allowDomains: ['api.openai.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          OPENAI_API_KEY: 'sk-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain(`OPENAI_BASE_URL=http://${API_PROXY_IP}:10000`);
  }, 180000);

  test('should route Anthropic API requests through Squid', async () => {
    // Use a fake API key — the request will reach api.anthropic.com via Squid
    // and get an auth error (401), but that proves the proxy routes through Squid.
    const result = await runner.run(
      `bash -c "curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -d '{\"model\":\"claude-3-haiku-20240307\",\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    // The request should succeed (curl exits 0) even though Anthropic rejects the fake key.
    // The response will contain an authentication error from Anthropic, proving the
    // request was routed through Squid to api.anthropic.com.
    expect(result).toSucceed();
    // Anthropic returns an error about the invalid API key — this proves end-to-end routing works
    expect(result.stdout).toMatch(/authentication_error|invalid.*api.key|invalid_api_key|error/i);
  }, 180000);

  test('should set both health and Anthropic endpoints with Anthropic key only', async () => {
    // When only Anthropic key is provided, port 10000 should still serve /health
    // (needed for Docker healthcheck) and port 10001 should serve the Anthropic proxy
    const result = await runner.run(
      `bash -c "curl -s http://${API_PROXY_IP}:10000/health && echo && curl -s http://${API_PROXY_IP}:10001/health"`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    // Port 10000 health should report openai: false, anthropic: true
    expect(result.stdout).toContain('"openai":false');
    expect(result.stdout).toContain('"anthropic":true');
    // Port 10001 should also be healthy
    expect(result.stdout).toContain('awf-api-proxy-anthropic');
  }, 180000);

  test('should start api-proxy sidecar with Copilot key and pass healthcheck', async () => {
    const result = await runner.run(
      `curl -s http://${API_PROXY_IP}:10002/health`,
      {
        allowDomains: ['api.githubcopilot.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          COPILOT_GITHUB_TOKEN: 'ghp_fake-test-token-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('"status":"healthy"');
    expect(result.stdout).toContain('awf-api-proxy-copilot');
  }, 180000);

  test('should set COPILOT_API_URL in agent when Copilot token is provided', async () => {
    const result = await runner.run(
      'bash -c "echo COPILOT_API_URL=$COPILOT_API_URL"',
      {
        allowDomains: ['api.githubcopilot.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          COPILOT_GITHUB_TOKEN: 'ghp_fake-test-token-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain(`COPILOT_API_URL=http://${API_PROXY_IP}:10002`);
  }, 180000);

  test('should set COPILOT_TOKEN to placeholder in agent when Copilot token is provided', async () => {
    const result = await runner.run(
      'bash -c "echo COPILOT_TOKEN=$COPILOT_TOKEN"',
      {
        allowDomains: ['api.githubcopilot.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          COPILOT_GITHUB_TOKEN: 'ghp_fake-test-token-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('COPILOT_TOKEN=ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  }, 180000);

  test('should report copilot in health providers when Copilot token is provided', async () => {
    // When Copilot token is provided, the main health endpoint should report copilot: true
    const result = await runner.run(
      `curl -s http://${API_PROXY_IP}:10000/health`,
      {
        allowDomains: ['api.githubcopilot.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          COPILOT_GITHUB_TOKEN: 'ghp_fake-test-token-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('"copilot":true');
  }, 180000);

  test('should preserve GITHUB_API_URL while routing Copilot through api-proxy', async () => {
    // On GHES, workflows set GITHUB_API_URL to the GHES API endpoint (e.g., https://api.ghes-host).
    // The agent still needs that endpoint for GitHub API operations. Copilot-specific calls
    // use COPILOT_API_URL, which points to the proxy and routes to the Copilot API.
    // See: github/gh-aw#20875
    const result = await runner.run(
      'bash -c "echo GITHUB_API_URL=$GITHUB_API_URL; echo COPILOT_API_URL=$COPILOT_API_URL"',
      {
        allowDomains: ['api.githubcopilot.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          COPILOT_GITHUB_TOKEN: 'ghp_fake-test-token-12345',
          // Simulate GHES workflow passing GITHUB_API_URL
          GITHUB_API_URL: 'https://api.ghes-host.example.com',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('GITHUB_API_URL=https://api.ghes-host.example.com');
    expect(result.stdout).toContain(`COPILOT_API_URL=http://${API_PROXY_IP}:10002`);
  }, 180000);

  test('should pass GITHUB_API_URL to agent when api-proxy is NOT enabled', async () => {
    // When api-proxy is disabled, GITHUB_API_URL should be passed through normally
    const result = await runner.run(
      'bash -c "echo GITHUB_API_URL=$GITHUB_API_URL"',
      {
        allowDomains: ['api.githubcopilot.com'],
        enableApiProxy: false,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          GITHUB_API_URL: 'https://api.github.com',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('GITHUB_API_URL=https://api.github.com');
  }, 180000);
});
