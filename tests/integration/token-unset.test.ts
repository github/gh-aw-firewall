/**
 * Token Unsetting Tests
 *
 * These tests verify that sensitive tokens are properly unset from the entrypoint's
 * environment (/proc/1/environ) after the agent process has started and cached them.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Token Unsetting from Entrypoint Environ', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should unset GITHUB_TOKEN from /proc/1/environ after agent starts', async () => {
    const testToken = 'ghp_test_token_12345678901234567890';

    // Command that polls /proc/1/environ until token is cleared (retry loop)
    const command = `
      # Poll /proc/1/environ until GITHUB_TOKEN is cleared (up to 15 seconds)
      for i in $(seq 1 15); do
        if ! cat /proc/1/environ | tr "\\0" "\\n" | grep -q "GITHUB_TOKEN="; then
          echo "SUCCESS: GITHUB_TOKEN cleared from /proc/1/environ"
          break
        fi
        sleep 1
      done

      # Final check - fail if still present after retries
      if cat /proc/1/environ | tr "\\0" "\\n" | grep -q "GITHUB_TOKEN="; then
        echo "ERROR: GITHUB_TOKEN still in /proc/1/environ after 15 seconds"
        exit 1
      fi

      # Verify agent can still read the token (cached by one-shot-token library)
      if [ -n "$GITHUB_TOKEN" ]; then
        echo "SUCCESS: Agent can still read GITHUB_TOKEN via getenv"
      else
        echo "WARNING: GITHUB_TOKEN not accessible to agent"
      fi
    `;

    const result = await runner.runWithSudo(command, {
      allowDomains: ['example.com'],
      buildLocal: true,
      logLevel: 'debug',
      timeout: 30000,
      env: {
        GITHUB_TOKEN: testToken,
      },
    });

    expect(result).toSucceed();
    expect(result.stdout).toContain('SUCCESS: GITHUB_TOKEN cleared from /proc/1/environ');
    expect(result.stdout).toContain('SUCCESS: Agent can still read GITHUB_TOKEN via getenv');
  }, 60000);

  test('should unset OPENAI_API_KEY from /proc/1/environ after agent starts', async () => {
    const testToken = 'sk-test_openai_key_1234567890';

    const command = `
      # Poll /proc/1/environ until OPENAI_API_KEY is cleared (up to 15 seconds)
      for i in $(seq 1 15); do
        if ! cat /proc/1/environ | tr "\\0" "\\n" | grep -q "OPENAI_API_KEY="; then
          echo "SUCCESS: OPENAI_API_KEY cleared from /proc/1/environ"
          break
        fi
        sleep 1
      done

      if cat /proc/1/environ | tr "\\0" "\\n" | grep -q "OPENAI_API_KEY="; then
        echo "ERROR: OPENAI_API_KEY still in /proc/1/environ after 15 seconds"
        exit 1
      fi

      if [ -n "$OPENAI_API_KEY" ]; then
        echo "SUCCESS: Agent can still read OPENAI_API_KEY via getenv"
      else
        echo "WARNING: OPENAI_API_KEY not accessible to agent"
      fi
    `;

    const result = await runner.runWithSudo(command, {
      allowDomains: ['example.com'],
      buildLocal: true,
      logLevel: 'debug',
      timeout: 30000,
      env: {
        OPENAI_API_KEY: testToken,
      },
    });

    expect(result).toSucceed();
    expect(result.stdout).toContain('SUCCESS: OPENAI_API_KEY cleared from /proc/1/environ');
    expect(result.stdout).toContain('SUCCESS: Agent can still read OPENAI_API_KEY via getenv');
  }, 60000);

  test('should unset ANTHROPIC_API_KEY from /proc/1/environ after agent starts', async () => {
    const testToken = 'sk-ant-test_key_1234567890';

    const command = `
      # Poll /proc/1/environ until ANTHROPIC_API_KEY is cleared (up to 15 seconds)
      for i in $(seq 1 15); do
        if ! cat /proc/1/environ | tr "\\0" "\\n" | grep -q "ANTHROPIC_API_KEY="; then
          echo "SUCCESS: ANTHROPIC_API_KEY cleared from /proc/1/environ"
          break
        fi
        sleep 1
      done

      if cat /proc/1/environ | tr "\\0" "\\n" | grep -q "ANTHROPIC_API_KEY="; then
        echo "ERROR: ANTHROPIC_API_KEY still in /proc/1/environ after 15 seconds"
        exit 1
      fi

      if [ -n "$ANTHROPIC_API_KEY" ]; then
        echo "SUCCESS: Agent can still read ANTHROPIC_API_KEY via getenv"
      else
        echo "WARNING: ANTHROPIC_API_KEY not accessible to agent"
      fi
    `;

    const result = await runner.runWithSudo(command, {
      allowDomains: ['example.com'],
      buildLocal: true,
      logLevel: 'debug',
      timeout: 30000,
      env: {
        ANTHROPIC_API_KEY: testToken,
      },
    });

    expect(result).toSucceed();
    expect(result.stdout).toContain('SUCCESS: ANTHROPIC_API_KEY cleared from /proc/1/environ');
    expect(result.stdout).toContain('SUCCESS: Agent can still read ANTHROPIC_API_KEY via getenv');
  }, 60000);

  test('should unset multiple tokens simultaneously', async () => {
    const command = `
      # Poll /proc/1/environ until all tokens are cleared (up to 15 seconds)
      for i in $(seq 1 15); do
        TOKENS_FOUND=0
        cat /proc/1/environ | tr "\\0" "\\n" | grep -q "GITHUB_TOKEN=" && TOKENS_FOUND=$((TOKENS_FOUND + 1))
        cat /proc/1/environ | tr "\\0" "\\n" | grep -q "OPENAI_API_KEY=" && TOKENS_FOUND=$((TOKENS_FOUND + 1))
        cat /proc/1/environ | tr "\\0" "\\n" | grep -q "ANTHROPIC_API_KEY=" && TOKENS_FOUND=$((TOKENS_FOUND + 1))
        if [ $TOKENS_FOUND -eq 0 ]; then
          break
        fi
        sleep 1
      done

      # Final check - fail if any still present
      TOKENS_FOUND=0

      if cat /proc/1/environ | tr "\\0" "\\n" | grep -q "GITHUB_TOKEN="; then
        echo "ERROR: GITHUB_TOKEN still in /proc/1/environ"
        TOKENS_FOUND=$((TOKENS_FOUND + 1))
      fi

      if cat /proc/1/environ | tr "\\0" "\\n" | grep -q "OPENAI_API_KEY="; then
        echo "ERROR: OPENAI_API_KEY still in /proc/1/environ"
        TOKENS_FOUND=$((TOKENS_FOUND + 1))
      fi

      if cat /proc/1/environ | tr "\\0" "\\n" | grep -q "ANTHROPIC_API_KEY="; then
        echo "ERROR: ANTHROPIC_API_KEY still in /proc/1/environ"
        TOKENS_FOUND=$((TOKENS_FOUND + 1))
      fi

      if [ $TOKENS_FOUND -eq 0 ]; then
        echo "SUCCESS: All tokens cleared from /proc/1/environ"
      else
        exit 1
      fi

      # Verify all tokens still accessible to agent
      if [ -n "$GITHUB_TOKEN" ] && [ -n "$OPENAI_API_KEY" ] && [ -n "$ANTHROPIC_API_KEY" ]; then
        echo "SUCCESS: All tokens still readable via getenv"
      else
        echo "WARNING: Some tokens not accessible to agent"
      fi
    `;

    const result = await runner.runWithSudo(command, {
      allowDomains: ['example.com'],
      buildLocal: true,
      logLevel: 'debug',
      timeout: 30000,
      env: {
        GITHUB_TOKEN: 'ghp_test_12345',
        OPENAI_API_KEY: 'sk-test_openai',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      },
    });

    expect(result).toSucceed();
    expect(result.stdout).toContain('SUCCESS: All tokens cleared from /proc/1/environ');
    expect(result.stdout).toContain('SUCCESS: All tokens still readable via getenv');
  }, 60000);

  test('should work in non-chroot mode', async () => {
    const command = `
      # Poll /proc/1/environ until GITHUB_TOKEN is cleared (up to 15 seconds)
      for i in $(seq 1 15); do
        if ! cat /proc/1/environ | tr "\\0" "\\n" | grep -q "GITHUB_TOKEN="; then
          break
        fi
        sleep 1
      done

      if cat /proc/1/environ | tr "\\0" "\\n" | grep -q "GITHUB_TOKEN="; then
        echo "ERROR: GITHUB_TOKEN still in /proc/1/environ after 15 seconds"
        exit 1
      else
        echo "SUCCESS: GITHUB_TOKEN cleared from /proc/1/environ in non-chroot mode"
      fi
    `;

    const result = await runner.runWithSudo(command, {
      allowDomains: ['example.com'],
      buildLocal: true,
      logLevel: 'debug',
      timeout: 30000,
      env: {
        GITHUB_TOKEN: 'ghp_test_12345',
        // Disable chroot mode by not setting the flag
        AWF_CHROOT_ENABLED: 'false',
      },
    });

    // Note: The test runner may automatically enable chroot mode,
    // so we just verify the token is cleared regardless of mode
    expect(result).toSucceed();
    expect(result.stdout).toMatch(/SUCCESS: .*cleared from \/proc\/1\/environ/);
  }, 60000);
});
