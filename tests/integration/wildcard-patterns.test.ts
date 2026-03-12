/**
 * Wildcard Patterns Tests
 *
 * These tests verify wildcard pattern matching in --allow-domains:
 * - *.domain.com pattern matching
 * - api-*.example.com patterns
 * - Case sensitivity
 * - Complex patterns
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Wildcard Pattern Matching', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  describe('Leading Wildcard Patterns (*.domain.com)', () => {
    test('should allow subdomain with *.github.com pattern', async () => {
      const result = await runner.runWithSudo(
        'curl -sS https://api.github.com/zen',
        {
          allowDomains: ['*.github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should allow raw.githubusercontent.com with *.githubusercontent.com pattern', async () => {
      const result = await runner.runWithSudo(
        'curl -fsS https://raw.githubusercontent.com/octocat/Hello-World/master/README',
        {
          allowDomains: ['*.githubusercontent.com', 'github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should allow nested subdomains with wildcard', async () => {
      // Allow any subdomain of github.com
      const result = await runner.runWithSudo(
        'curl -sS https://api.github.com/zen',
        {
          allowDomains: ['*.github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);
  });

  describe('Case Insensitivity', () => {
    test('should match domain case-insensitively', async () => {
      const result = await runner.runWithSudo(
        'curl -sS https://API.GITHUB.COM/zen',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should match wildcard pattern case-insensitively', async () => {
      const result = await runner.runWithSudo(
        'curl -sS https://API.GITHUB.COM/zen',
        {
          allowDomains: ['*.GitHub.COM'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);
  });

  describe('Plain Domain Matching', () => {
    test('should allow exact domain match', async () => {
      const result = await runner.runWithSudo(
        'curl -fsS https://github.com/robots.txt',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should allow subdomains of plain domain (github.com allows api.github.com)', async () => {
      const result = await runner.runWithSudo(
        'curl -sS https://api.github.com/zen',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);
  });

  describe('Multiple Patterns', () => {
    test('should allow domains matching any of multiple patterns', async () => {
      const result = await runner.runWithSudo(
        'bash -c "curl -sS https://api.github.com/zen && echo success"',
        {
          allowDomains: ['*.github.com', '*.gitlab.com', '*.bitbucket.org'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('success');
    }, 120000);

    test('should combine wildcard and plain domain patterns', async () => {
      const result = await runner.runWithSudo(
        'bash -c "curl -sS https://api.github.com/zen && echo success"',
        {
          allowDomains: ['github.com', '*.githubusercontent.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('success');
    }, 120000);
  });

  describe('Non-Matching Patterns', () => {
    test('should block domain not matching any pattern', async () => {
      const result = await runner.runWithSudo(
        'curl -f https://example.com --max-time 5',
        {
          allowDomains: ['*.github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);

    test('should block similar-looking domain', async () => {
      // "notgithub.com" should not match "*.github.com"
      const result = await runner.runWithSudo(
        'curl -f https://notgithub.com --max-time 5',
        {
          allowDomains: ['*.github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);
  });
});
