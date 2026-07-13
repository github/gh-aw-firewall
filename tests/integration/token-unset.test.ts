/**
 * Token Isolation Tests
 *
 * These tests verify that sensitive tokens are NEVER present in the agent
 * container's process environment (/proc/1/environ). In strict security mode,
 * all credentials are isolated in the API proxy sidecar — the agent container
 * never receives real tokens.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Token Isolation from Agent Environment', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should never expose GITHUB_TOKEN in /proc/1/environ', async () => {
    const testToken = 'ghp_test_token_12345678901234567890';

    const command = `
      # Check that the real token value never appears in /proc/1/environ
      if cat /proc/1/environ 2>/dev/null | tr "\\0" "\\n" | grep -q "${testToken}"; then
        echo "FAIL: Real GITHUB_TOKEN found in /proc/1/environ"
        exit 1
      else
        echo "SUCCESS: Real GITHUB_TOKEN not in /proc/1/environ"
      fi

      # Also check printenv doesn't show the real token
      TOKEN_VALUE=$(printenv GITHUB_TOKEN 2>/dev/null || echo "")
      if [ "$TOKEN_VALUE" = "${testToken}" ]; then
        echo "FAIL: Real GITHUB_TOKEN visible via printenv"
        exit 1
      else
        echo "SUCCESS: Real GITHUB_TOKEN not visible via printenv"
      fi
    `;

    const result = await runner.run(command, {
      allowDomains: ['example.com'],
      buildLocal: true,
      logLevel: 'debug',
      timeout: 60000,
      env: {
        GITHUB_TOKEN: testToken,
      },
    });

    expect(result).toSucceed();
    expect(result.stdout).toContain('SUCCESS: Real GITHUB_TOKEN not in /proc/1/environ');
    expect(result.stdout).toContain('SUCCESS: Real GITHUB_TOKEN not visible via printenv');
    // The real token must never appear in any output
    expect(result.stdout).not.toContain(testToken);
  }, 120000);

  test('should never expose OPENAI_API_KEY in /proc/1/environ', async () => {
    const testToken = 'sk-test_openai_key_1234567890';

    const command = `
      if cat /proc/1/environ 2>/dev/null | tr "\\0" "\\n" | grep -q "${testToken}"; then
        echo "FAIL: Real OPENAI_API_KEY found in /proc/1/environ"
        exit 1
      else
        echo "SUCCESS: Real OPENAI_API_KEY not in /proc/1/environ"
      fi

      TOKEN_VALUE=$(printenv OPENAI_API_KEY 2>/dev/null || echo "")
      if [ "$TOKEN_VALUE" = "${testToken}" ]; then
        echo "FAIL: Real OPENAI_API_KEY visible via printenv"
        exit 1
      else
        echo "SUCCESS: Real OPENAI_API_KEY not visible via printenv"
      fi
    `;

    const result = await runner.run(command, {
      allowDomains: ['example.com'],
      buildLocal: true,
      logLevel: 'debug',
      timeout: 60000,
      env: {
        OPENAI_API_KEY: testToken,
      },
    });

    expect(result).toSucceed();
    expect(result.stdout).toContain('SUCCESS: Real OPENAI_API_KEY not in /proc/1/environ');
    expect(result.stdout).toContain('SUCCESS: Real OPENAI_API_KEY not visible via printenv');
    expect(result.stdout).not.toContain(testToken);
  }, 120000);

  test('should never expose ANTHROPIC_API_KEY in /proc/1/environ', async () => {
    const testToken = 'sk-ant-test_key_1234567890';

    const command = `
      if cat /proc/1/environ 2>/dev/null | tr "\\0" "\\n" | grep -q "${testToken}"; then
        echo "FAIL: Real ANTHROPIC_API_KEY found in /proc/1/environ"
        exit 1
      else
        echo "SUCCESS: Real ANTHROPIC_API_KEY not in /proc/1/environ"
      fi

      TOKEN_VALUE=$(printenv ANTHROPIC_API_KEY 2>/dev/null || echo "")
      if [ "$TOKEN_VALUE" = "${testToken}" ]; then
        echo "FAIL: Real ANTHROPIC_API_KEY visible via printenv"
        exit 1
      else
        echo "SUCCESS: Real ANTHROPIC_API_KEY not visible via printenv"
      fi
    `;

    const result = await runner.run(command, {
      allowDomains: ['example.com'],
      buildLocal: true,
      logLevel: 'debug',
      timeout: 60000,
      env: {
        ANTHROPIC_API_KEY: testToken,
      },
    });

    expect(result).toSucceed();
    expect(result.stdout).toContain('SUCCESS: Real ANTHROPIC_API_KEY not in /proc/1/environ');
    expect(result.stdout).toContain('SUCCESS: Real ANTHROPIC_API_KEY not visible via printenv');
    expect(result.stdout).not.toContain(testToken);
  }, 120000);

  test('should never expose any real tokens when multiple are provided', async () => {
    const ghToken = 'ghp_multi_test_12345';
    const openaiKey = 'sk-multi_openai_test';
    const anthropicKey = 'sk-ant-multi_test';

    const command = `
      FAIL=0

      # Check /proc/1/environ for any real token values
      ENVIRON=$(cat /proc/1/environ 2>/dev/null | tr "\\0" "\\n")

      echo "$ENVIRON" | grep -q "${ghToken}" && echo "FAIL: GITHUB_TOKEN in environ" && FAIL=1
      echo "$ENVIRON" | grep -q "${openaiKey}" && echo "FAIL: OPENAI_API_KEY in environ" && FAIL=1
      echo "$ENVIRON" | grep -q "${anthropicKey}" && echo "FAIL: ANTHROPIC_API_KEY in environ" && FAIL=1

      if [ $FAIL -eq 0 ]; then
        echo "SUCCESS: No real tokens found in /proc/1/environ"
      else
        exit 1
      fi

      # Verify printenv doesn't return real values
      [ "$(printenv GITHUB_TOKEN 2>/dev/null)" = "${ghToken}" ] && echo "FAIL: GITHUB_TOKEN via printenv" && exit 1
      [ "$(printenv OPENAI_API_KEY 2>/dev/null)" = "${openaiKey}" ] && echo "FAIL: OPENAI_API_KEY via printenv" && exit 1
      [ "$(printenv ANTHROPIC_API_KEY 2>/dev/null)" = "${anthropicKey}" ] && echo "FAIL: ANTHROPIC_API_KEY via printenv" && exit 1

      echo "SUCCESS: No real tokens visible via printenv"
    `;

    const result = await runner.run(command, {
      allowDomains: ['example.com'],
      buildLocal: true,
      logLevel: 'debug',
      timeout: 60000,
      env: {
        GITHUB_TOKEN: ghToken,
        OPENAI_API_KEY: openaiKey,
        ANTHROPIC_API_KEY: anthropicKey,
      },
    });

    expect(result).toSucceed();
    expect(result.stdout).toContain('SUCCESS: No real tokens found in /proc/1/environ');
    expect(result.stdout).toContain('SUCCESS: No real tokens visible via printenv');
    expect(result.stdout).not.toContain(ghToken);
    expect(result.stdout).not.toContain(openaiKey);
    expect(result.stdout).not.toContain(anthropicKey);
  }, 120000);

  test('should never expose COPILOT_GITHUB_TOKEN in /proc/1/environ', async () => {
    const testToken = 'copilot_test_token_never_exposed';

    const command = `
      if cat /proc/1/environ 2>/dev/null | tr "\\0" "\\n" | grep -q "${testToken}"; then
        echo "FAIL: Real COPILOT_GITHUB_TOKEN found in /proc/1/environ"
        exit 1
      else
        echo "SUCCESS: Real COPILOT_GITHUB_TOKEN not in /proc/1/environ"
      fi

      TOKEN_VALUE=$(printenv COPILOT_GITHUB_TOKEN 2>/dev/null || echo "")
      if [ "$TOKEN_VALUE" = "${testToken}" ]; then
        echo "FAIL: Real COPILOT_GITHUB_TOKEN visible via printenv"
        exit 1
      else
        echo "SUCCESS: Real COPILOT_GITHUB_TOKEN not visible via printenv"
      fi
    `;

    const result = await runner.run(command, {
      allowDomains: ['example.com'],
      buildLocal: true,
      logLevel: 'debug',
      timeout: 60000,
      env: {
        COPILOT_GITHUB_TOKEN: testToken,
      },
    });

    expect(result).toSucceed();
    expect(result.stdout).toContain('SUCCESS: Real COPILOT_GITHUB_TOKEN not in /proc/1/environ');
    expect(result.stdout).toContain('SUCCESS: Real COPILOT_GITHUB_TOKEN not visible via printenv');
    expect(result.stdout).not.toContain(testToken);
  }, 120000);
});
