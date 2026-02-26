/**
 * API Proxy Observability Integration Tests
 *
 * Tests that the observability features (structured logging, metrics, enhanced health)
 * work end-to-end with actual Docker containers.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

// The API proxy sidecar is at this fixed IP on the awf-net network
const API_PROXY_IP = '172.30.0.30';

describe('API Proxy Observability', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should return valid JSON metrics from /metrics endpoint', async () => {
    const result = await runner.runWithSudo(
      `curl -s http://${API_PROXY_IP}:10000/metrics`,
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
    // /metrics returns JSON with counters, histograms, gauges structure
    expect(result.stdout).toContain('"counters"');
    expect(result.stdout).toContain('"histograms"');
    expect(result.stdout).toContain('"gauges"');
    // gauges includes uptime_seconds
    expect(result.stdout).toContain('"uptime_seconds"');
  }, 180000);

  test('should include metrics_summary in /health response', async () => {
    const result = await runner.runWithSudo(
      `curl -s http://${API_PROXY_IP}:10000/health`,
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
    expect(result.stdout).toContain('"metrics_summary"');
    expect(result.stdout).toContain('"total_requests"');
    expect(result.stdout).toContain('"active_requests"');
  }, 180000);

  test('should return X-Request-ID header in proxy responses', async () => {
    // Make a request to the Anthropic proxy and check for x-request-id in response headers
    const result = await runner.runWithSudo(
      `bash -c "curl -s -i -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -d '{\"model\":\"test\"}'"`,
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
    // Response headers should include x-request-id (case insensitive check)
    expect(result.stdout.toLowerCase()).toContain('x-request-id');
  }, 180000);

  test('should increment metrics after making API requests', async () => {
    // Make a request to the Anthropic proxy, then check /metrics for non-zero counts
    const script = [
      // First, make an API request to generate metrics
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -d '{"model":"test"}' > /dev/null`,
      // Then fetch metrics
      `curl -s http://${API_PROXY_IP}:10000/metrics`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c "${script}"`,
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
    // After at least one request, counters should have requests_total entries
    expect(result.stdout).toContain('requests_total');
  }, 180000);

  test('should include rate_limits in /health when rate limiting is active', async () => {
    const result = await runner.runWithSudo(
      `bash -c "curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -d '{\"model\":\"test\"}' > /dev/null && curl -s http://${API_PROXY_IP}:10000/health"`,
      {
        allowDomains: ['api.anthropic.com'],
        enableApiProxy: true,
        buildLocal: true,
        rateLimitRpm: 100,
        logLevel: 'debug',
        timeout: 120000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key-12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('"rate_limits"');
  }, 180000);

  test('should preserve custom X-Request-ID when valid', async () => {
    const result = await runner.runWithSudo(
      `bash -c "curl -s -i -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -H 'X-Request-ID: my-custom-trace-abc123' -d '{\"model\":\"test\"}'"`,
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
    // The exact custom ID should be echoed back, not a generated UUID
    expect(result.stdout).toContain('my-custom-trace-abc123');
  }, 180000);

  test('should reject invalid X-Request-ID and generate a new one', async () => {
    const result = await runner.runWithSudo(
      `bash -c "curl -s -i -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -H 'X-Request-ID: <script>alert(1)</script>' -d '{\"model\":\"test\"}'"`,
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
    const lower = result.stdout.toLowerCase();
    expect(lower).toContain('x-request-id');
    // The injected ID should NOT appear — proxy should have generated a UUID instead
    expect(result.stdout).not.toContain('<script>');
  }, 180000);

  test('should show active_requests gauge at 0 after request completes', async () => {
    const script = [
      // Make a request and wait for it to complete
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -d '{"model":"test"}' > /dev/null`,
      // Small delay to ensure metrics are recorded
      'sleep 1',
      // Check metrics — active_requests should be 0
      `curl -s http://${API_PROXY_IP}:10000/metrics`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c "${script}"`,
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
    // Parse the metrics JSON and check active_requests
    const metricsJson = JSON.parse(result.stdout);
    const activeRequests = metricsJson.gauges?.active_requests || {};
    // All provider gauges should be 0 or absent
    for (const count of Object.values(activeRequests)) {
      expect(count).toBe(0);
    }
  }, 180000);

  test('should record latency histogram entries after requests', async () => {
    const script = [
      `curl -s -X POST http://${API_PROXY_IP}:10001/v1/messages -H 'Content-Type: application/json' -d '{"model":"test"}' > /dev/null`,
      `curl -s http://${API_PROXY_IP}:10000/metrics`,
    ].join(' && ');

    const result = await runner.runWithSudo(
      `bash -c "${script}"`,
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
    // Histogram should have request_duration_ms entries with count > 0
    expect(result.stdout).toContain('request_duration_ms');
    const metricsJson = JSON.parse(result.stdout);
    const durationHist = metricsJson.histograms?.request_duration_ms;
    expect(durationHist).toBeDefined();
    // At least one provider should have a count > 0
    const counts = Object.values(durationHist || {}).map((h: any) => h.count);
    expect(counts.some((c: number) => c > 0)).toBe(true);
  }, 180000);
});
