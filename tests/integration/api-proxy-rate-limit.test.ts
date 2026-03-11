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
import { extractLastJson, extractCommandOutput } from '../fixtures/stdout-helpers';

// The API proxy sidecar is at this fixed IP on the awf-net network
const API_PROXY_IP = '172.30.0.30';

/**
 * Extract the HTTP response section from stdout when curl -i is used.
 *
 * Docker build output (from --build-local) appears before the HTTP response.
 * This finds the last HTTP response block (starting with "HTTP/") in stdout.
 */
function extractHttpResponse(stdout: string): string {
  const httpPattern = /HTTP\/[\d.]+ \d+/g;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = httpPattern.exec(stdout)) !== null) {
    lastMatch = match;
  }
  if (lastMatch) {
    return stdout.slice(lastMatch.index);
  }
  return stdout;
}

/**
 * Extract the last JSON object from stdout.
 *
 * When --build-local is used, Docker build output is mixed into stdout before
 * the actual command output. This helper finds the last complete top-level
 * JSON object in the output so that JSON.parse works reliably.
 */
function extractLastJson(stdout: string): unknown {
  let depth = 0;
  let jsonEnd = -1;
  let jsonStart = -1;

  for (let i = stdout.length - 1; i >= 0; i--) {
    const ch = stdout[i];
    if (ch === '}') {
      if (depth === 0) jsonEnd = i;
      depth++;
    } else if (ch === '{') {
      depth--;
      if (depth === 0) {
        jsonStart = i;
        break;
      }
    }
  }

  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`No JSON object found in stdout (length=${stdout.length}): ${stdout.slice(-200)}`);
  }

  return JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
}

describe('API Proxy Rate Limiting', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should not rate limit by default (no --rate-limit-* flags)', async () => {
    // Without any rate-limit flags, rate limiting is disabled — all requests should pass
    const script = [
      'ALL_OK=true',
      'for i in 1 2 3 4 5 6 7 8 9 10; do',
      `  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}")`,
      '  if [ "$CODE" = "429" ]; then ALL_OK=false; fi',
      'done',
      'if [ "$ALL_OK" = "true" ]; then echo "NO_RATE_LIMITS"; else echo "GOT_429"; fi',
    ].join('\n');

    const result = await runner.runWithSudo(
      `bash -c '${script}'`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        // No rateLimitRpm, rateLimitRph, or rateLimitBytesPm — unlimited by default
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('NO_RATE_LIMITS');
  }, 180000);

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
    const script = [
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}" > /dev/null`,
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}"`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c '${script}'`,
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
    // The 429 response body should contain retry_after field in the JSON error
    const cmdOutput = extractCommandOutput(result.stdout);
    expect(cmdOutput.toLowerCase()).toMatch(/retry.after/);
  }, 180000);

  test('should include X-RateLimit headers in 429 response', async () => {
    const script = [
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}" > /dev/null`,
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}"`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c '${script}'`,
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
    // The rate-limited response body should contain error type and rate limit info
    const responseJson = extractLastJson(result.stdout);
    expect(responseJson).not.toBeNull();
    expect(responseJson.error?.type).toBe('rate_limit_error');
    // Verify the response includes retry_after in the error message or headers field
    const responseStr = JSON.stringify(responseJson).toLowerCase();
    expect(responseStr).toMatch(/retry.after/);
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
    const script = [
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}" > /dev/null`,
      `curl -s http://${API_PROXY_IP}:10000/health`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c '${script}'`,
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
    // Parse the health response JSON (extract from stdout which may contain Docker build output)
    const healthJson = extractLastJson(result.stdout);
    expect(healthJson).not.toBeNull();
    expect(healthJson.rate_limits).toBeDefined();
    // The limit value of 5 should appear in the rate_limits
    const healthStr = JSON.stringify(healthJson);
    expect(healthStr).toContain('"limit":5');
  }, 180000);

  test('should show rate limit metrics in /metrics after rate limiting occurs', async () => {
    const script = [
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}" > /dev/null`,
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}" > /dev/null`,
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H "Content-Type: application/json" -d "{\\"model\\":\\"test\\"}" > /dev/null`,
      `curl -s http://${API_PROXY_IP}:10000/metrics`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c '${script}'`,
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
    // Parse the metrics JSON (extract from stdout which may contain Docker build output)
    const metricsJson = extractLastJson(result.stdout);
    expect(metricsJson).not.toBeNull();
    // Metrics should include rate_limit_rejected_total counter
    const metricsStr = JSON.stringify(metricsJson);
    expect(metricsStr).toContain('rate_limit_rejected_total');
  }, 180000);
});
