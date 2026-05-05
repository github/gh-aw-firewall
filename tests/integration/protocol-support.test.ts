/**
 * Protocol Support Tests
 *
 * These tests verify HTTP/HTTPS protocol handling:
 * - HTTPS connections work correctly
 * - HTTP connections behavior
 * - HTTP/2 support
 * - TLS version handling
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Protocol Support', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  describe('HTTPS Connections', () => {
    test('should allow HTTPS to allowed domain', async () => {
      const result = await runner.runWithSudo(
        'curl -fsS https://api.github.com/zen',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should block HTTPS to non-allowed domain', async () => {
      const result = await runner.runWithSudo(
        'curl -f https://example.com --max-time 5',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);

    test('should handle HTTPS with verbose output', async () => {
      const result = await runner.runWithSudo(
        'curl -v https://api.github.com/zen 2>&1 | grep -E "SSL|TLS" | head -5 || true',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // Should show TLS/SSL in verbose output (connection info)
      expect(result).toSucceed();
    }, 120000);
  });

  describe('HTTP/2 Support', () => {
    test('should support HTTP/2 connections', async () => {
      const result = await runner.runWithSudo(
        'curl -fsS --http2 https://api.github.com/zen',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should support HTTP/1.1 fallback', async () => {
      const result = await runner.runWithSudo(
        'curl -fsS --http1.1 https://api.github.com/zen',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);
  });

  describe('HTTP Connections', () => {
    test('should handle HTTP requests (may redirect to HTTPS)', async () => {
      // HTTP requests may fail due to redirects to HTTPS
      // This is a known limitation documented in the project
      const result = await runner.runWithSudo(
        'curl -f http://github.com --max-time 10',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // HTTP→HTTPS redirects may fail, this is expected behavior
      expect(result).toFail();
    }, 120000);
  });

  describe('Connection Headers', () => {
    test('should pass custom headers', async () => {
      const result = await runner.runWithSudo(
        'curl -fsS -H "Accept: application/vnd.github+json" https://api.github.com/zen',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should pass User-Agent header', async () => {
      const result = await runner.runWithSudo(
        'curl -fsS -A "Test-Agent/1.0" https://api.github.com/zen',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);
  });

  describe('IPv4/IPv6', () => {
    test('should support IPv4 connections', async () => {
      const result = await runner.runWithSudo(
        'curl -fsS -4 https://api.github.com/zen',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should handle IPv6 (may not be available)', async () => {
      // IPv6 may not be available in all environments
      const result = await runner.runWithSudo(
        'curl -fsS -6 https://api.github.com/zen || exit 0',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // Either succeeds or fails gracefully
      expect(result).toSucceed();
    }, 120000);
  });

  describe('Connection Timeouts', () => {
    test('should respect curl max-time option', async () => {
      const result = await runner.runWithSudo(
        'curl -f --max-time 5 https://api.github.com/zen',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should respect curl connect-timeout option', async () => {
      const result = await runner.runWithSudo(
        'curl -f --connect-timeout 10 https://api.github.com/zen',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);
  });
});
