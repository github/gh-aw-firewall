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

  test('should start api-proxy sidecar with Anthropic key and pass healthcheck', async () => {
    const result = await runner.runWithSudo(
      `curl -s http://${API_PROXY_IP}:10001/health`,
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
    expect(result.stdout).toContain('"status":"healthy"');
    expect(result.stdout).toContain('anthropic-proxy');
  }, 180000);

  test('should start api-proxy sidecar with OpenAI key and pass healthcheck', async () => {
    const result = await runner.runWithSudo(
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
    const result = await runner.runWithSudo(
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
    const result = await runner.runWithSudo(
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
    expect(result.stdout).toContain('ANTHROPIC_AUTH_TOKEN=placeholder-token-for-credential-isolation');
  }, 180000);

  test('should set OPENAI_BASE_URL in agent when OpenAI key is provided', async () => {
    const result = await runner.runWithSudo(
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
    const result = await runner.runWithSudo(
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
    const result = await runner.runWithSudo(
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
    expect(result.stdout).toContain('anthropic-proxy');
  }, 180000);

  test('should start api-proxy sidecar with Copilot key and pass healthcheck', async () => {
    const result = await runner.runWithSudo(
      `curl -s http://${API_PROXY_IP}:10002/health`,
      {
        allowDomains: ['api.githubcopilot.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          COPILOT_API_KEY: 'ghu_fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('"status":"healthy"');
    expect(result.stdout).toContain('copilot-proxy');
  }, 180000);

  test('should set COPILOT_API_URL in agent when Copilot key is provided', async () => {
    const result = await runner.runWithSudo(
      'bash -c "echo COPILOT_API_URL=$COPILOT_API_URL"',
      {
        allowDomains: ['api.githubcopilot.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          COPILOT_API_KEY: 'ghu_fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain(`COPILOT_API_URL=http://${API_PROXY_IP}:10002`);
  }, 180000);

  test('should set COPILOT_TOKEN to placeholder in agent when Copilot key is provided', async () => {
    const result = await runner.runWithSudo(
      'bash -c "echo COPILOT_TOKEN=$COPILOT_TOKEN"',
      {
        allowDomains: ['api.githubcopilot.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          COPILOT_API_KEY: 'ghu_fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('COPILOT_TOKEN=placeholder-token-for-credential-isolation');
  }, 180000);

  test('should report copilot in health providers when Copilot key is provided', async () => {
    // When Copilot key is provided, the main health endpoint should report copilot: true
    const result = await runner.runWithSudo(
      `curl -s http://${API_PROXY_IP}:10000/health`,
      {
        allowDomains: ['api.githubcopilot.com'],
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          COPILOT_API_KEY: 'ghu_fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('"copilot":true');
  }, 180000);
});
