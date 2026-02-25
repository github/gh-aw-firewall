/**
 * API Proxy Rate Limiting Integration Tests
 *
 * Tests that per-provider rate limiting works end-to-end with actual Docker containers.
 * Uses very low RPM limits to trigger 429 responses within the test timeout.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

// The API proxy sidecar is at this fixed IP on the awf-net network
const API_PROXY_IP = '172.30.0.30';

describe('API Proxy Rate Limiting', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should return 429 when rate limit is exceeded', async () => {
    // Set RPM=2, then make 4 rapid requests — at least one should get 429
    const script = [
      'RESULTS=""',
      'for i in 1 2 3 4; do',
      `  RESP=$(curl -s -w "\\nHTTP_CODE:%{http_code}" -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}")`,
      '  RESULTS="$RESULTS $RESP"',
      'done',
      'echo "$RESULTS"',
    ].join('\n');

    const result = await runner.runWithSudo(
      `bash -c '${script}'`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        rateLimitRpm: 2,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    // At least one response should be rate limited
    expect(result.stdout).toMatch(/rate_limit_error|HTTP_CODE:429/);
  }, 180000);

  test('should include Retry-After header in 429 response', async () => {
    // Set RPM=1, make 2 requests quickly — second should get 429 with Retry-After
    const script = [
      // First request consumes the limit
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d '{"model":"test"}' > /dev/null`,
      // Second request should be rate limited — capture headers
      `curl -s -i -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d '{"model":"test"}'`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c "${script}"`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        rateLimitRpm: 1,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    // Response should include retry-after header (case insensitive)
    expect(result.stdout.toLowerCase()).toContain('retry-after');
  }, 180000);

  test('should include X-RateLimit headers in 429 response', async () => {
    // Set low RPM to guarantee 429, then check for X-RateLimit-* headers
    const script = [
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d '{"model":"test"}' > /dev/null`,
      `curl -s -i -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d '{"model":"test"}'`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c "${script}"`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        rateLimitRpm: 1,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    const lower = result.stdout.toLowerCase();
    expect(lower).toContain('x-ratelimit-limit');
    expect(lower).toContain('x-ratelimit-remaining');
    expect(lower).toContain('x-ratelimit-reset');
  }, 180000);

  test('should not rate limit when --no-rate-limit is set', async () => {
    // Make many rapid requests with noRateLimit — none should get 429
    const script = [
      'ALL_OK=true',
      'for i in 1 2 3 4 5 6 7 8 9 10; do',
      `  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}")`,
      '  if [ "$CODE" = "429" ]; then ALL_OK=false; fi',
      'done',
      'if [ "$ALL_OK" = "true" ]; then echo "NO_RATE_LIMITS_HIT"; else echo "RATE_LIMIT_429_DETECTED"; fi',
    ].join('\n');

    const result = await runner.runWithSudo(
      `bash -c '${script}'`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        noRateLimit: true,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('NO_RATE_LIMITS_HIT');
  }, 180000);

  test('should respect custom RPM limit shown in /health', async () => {
    // Set a custom RPM and verify it appears in the health endpoint rate_limits
    const script = [
      // Make one request to create provider state in the limiter
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d '{"model":"test"}' > /dev/null`,
      // Check health for rate limit config
      `curl -s http://${API_PROXY_IP}:10000/health`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c "${script}"`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        rateLimitRpm: 5,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    // The health response should show rate_limits with the configured RPM limit
    expect(result.stdout).toContain('"rate_limits"');
    // The limit value of 5 should appear in the response
    expect(result.stdout).toContain('"limit":5');
  }, 180000);

  test('should show rate limit metrics in /metrics after rate limiting occurs', async () => {
    // Trigger rate limiting, then check /metrics for rate_limit_rejected_total
    const script = [
      // Make 3 rapid requests with RPM=1 to trigger at least one 429
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d '{"model":"test"}' > /dev/null`,
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d '{"model":"test"}' > /dev/null`,
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d '{"model":"test"}' > /dev/null`,
      // Check metrics
      `curl -s http://${API_PROXY_IP}:10000/metrics`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c "${script}"`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        rateLimitRpm: 1,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    // Metrics should include rate_limit_rejected_total counter
    expect(result.stdout).toContain('rate_limit_rejected_total');
  }, 180000);
});
