/**
 * API Proxy Token Rate Limiting Integration Tests
 *
 * Tests that token-per-minute (TPM) rate limiting works end-to-end with
 * actual Docker containers. Uses the --rate-limit-tpm flag to enable
 * token-based rate limiting.
 *
 * Note: These tests require the token-extractor.js module to be present
 * in the api-proxy container. If the module is not yet merged, tests
 * that depend on actual token extraction from responses will be skipped.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

// The API proxy sidecar is at this fixed IP on the awf-net network
const API_PROXY_IP = '172.30.0.30';

describe('API Proxy Token Rate Limiting', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should not token-rate-limit by default (no --rate-limit-tpm)', async () => {
    // Without --rate-limit-tpm, no token-based 429s should occur
    const script = [
      'ALL_OK=true',
      'for i in 1 2 3 4 5; do',
      `  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}")`,
      '  if [ "$CODE" = "429" ]; then ALL_OK=false; fi',
      'done',
      'if [ "$ALL_OK" = "true" ]; then echo "NO_TPM_LIMITS"; else echo "GOT_429"; fi',
    ].join('\n');

    const result = await runner.runWithSudo(
      `bash -c '${script}'`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        // No rateLimitTpm — TPM is disabled by default
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('NO_TPM_LIMITS');
  }, 180000);

  test('should show TPM in /health when --rate-limit-tpm is set', async () => {
    // Set a TPM limit and verify it shows in the health endpoint
    const script = [
      // Make one request to create provider state
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -d '{"model":"test"}' > /dev/null`,
      // Check health for TPM config
      `curl -s http://${API_PROXY_IP}:10000/health`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c "${script}"`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        rateLimitTpm: 10000,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    // The health response should include rate_limits with TPM info
    expect(result.stdout).toContain('"rate_limits"');
    // TPM limit should appear in the health output
    expect(result.stdout).toContain('"tpm"');
  }, 180000);

  test('should not show TPM in /health when --rate-limit-tpm is not set', async () => {
    // Without TPM configured, health should not include TPM section
    const script = [
      // Make one request to create provider state
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -d '{"model":"test"}' > /dev/null`,
      // Check health
      `curl -s http://${API_PROXY_IP}:10000/health`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c "${script}"`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        rateLimitRpm: 100,
        // No rateLimitTpm
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('"rate_limits"');
    // TPM should NOT appear when not configured
    expect(result.stdout).not.toContain('"tpm"');
  }, 180000);

  test('should pass AWF_RATE_LIMIT_TPM env var to api-proxy container', async () => {
    // Verify the env var is passed by checking docker-compose config
    // The simplest way: set a TPM value and check the health endpoint
    // shows the correct limit value
    const script = [
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -d '{"model":"test"}' > /dev/null`,
      `curl -s http://${API_PROXY_IP}:10000/health`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c "${script}"`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        rateLimitTpm: 5000,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    // The TPM limit of 5000 should be reflected in the health endpoint
    expect(result.stdout).toContain('"limit":5000');
  }, 180000);

  test('--rate-limit-tpm alone should enable rate limiting', async () => {
    // Using only --rate-limit-tpm (without --rate-limit-rpm) should still
    // enable the rate limiter and show rate_limits in health
    const script = [
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -d '{"model":"test"}' > /dev/null`,
      `curl -s http://${API_PROXY_IP}:10000/health`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c "${script}"`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        rateLimitTpm: 10000,
        // No rateLimitRpm, rateLimitRph, or rateLimitBytesPm
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    // Rate limiting should be enabled even with only TPM set
    expect(result.stdout).toContain('"rate_limits"');
    expect(result.stdout).toContain('"tpm"');
    // Default RPM/RPH should also be active since rate limiting is enabled
    expect(result.stdout).toContain('"rpm"');
  }, 180000);
});
