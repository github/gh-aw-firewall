/**
 * Tests for compose-sanitizer.ts
 *
 * compose-sanitizer redacts sensitive environment variable values
 * (TOKEN, KEY, SECRET) from Docker Compose YAML before logging.
 * This is security-critical: accidental logging of secrets must be prevented.
 */

import { sanitizeDockerComposeYaml } from './compose-sanitizer';

describe('sanitizeDockerComposeYaml', () => {
  // ─── Object-format environment ──────────────────────────────────────────────

  describe('object-format environment', () => {
    it('redacts values for keys containing TOKEN', () => {
      const raw = `
services:
  agent:
    environment:
      GITHUB_TOKEN: ghp_supersecret
      NORMAL_VAR: hello
`.trim();
      const result = sanitizeDockerComposeYaml(raw);
      expect(result).not.toContain('ghp_supersecret');
      expect(result).toContain('[REDACTED]');
      expect(result).toContain('hello');
    });

    it('redacts values for keys containing KEY', () => {
      const raw = `
services:
  agent:
    environment:
      OPENAI_API_KEY: sk-proj-secret
      OTHER_VAR: visible
`.trim();
      const result = sanitizeDockerComposeYaml(raw);
      expect(result).not.toContain('sk-proj-secret');
      expect(result).toContain('[REDACTED]');
      expect(result).toContain('visible');
    });

    it('redacts values for keys containing SECRET', () => {
      const raw = `
services:
  agent:
    environment:
      CLIENT_SECRET: my-secret-value
`.trim();
      const result = sanitizeDockerComposeYaml(raw);
      expect(result).not.toContain('my-secret-value');
      expect(result).toContain('[REDACTED]');
    });

    it('is case-insensitive when detecting sensitive keys', () => {
      const raw = `
services:
  agent:
    environment:
      api_key: lowercase-sensitive
      Api_Token: mixed-case
      ANTHROPIC_SECRET: anthropic-value
`.trim();
      const result = sanitizeDockerComposeYaml(raw);
      expect(result).not.toContain('lowercase-sensitive');
      expect(result).not.toContain('mixed-case');
      expect(result).not.toContain('anthropic-value');
    });

    it('leaves non-sensitive keys untouched', () => {
      const raw = `
services:
  agent:
    environment:
      LOG_LEVEL: debug
      WORKDIR: /tmp/awf
      PROXY_HOST: 172.30.0.10
`.trim();
      const result = sanitizeDockerComposeYaml(raw);
      expect(result).toContain('debug');
      expect(result).toContain('/tmp/awf');
      expect(result).toContain('172.30.0.10');
    });

    it('handles multiple services independently', () => {
      const raw = `
services:
  squid:
    environment:
      SQUID_CONFIG: somevalue
  agent:
    environment:
      API_KEY: should-be-redacted
      LOG_LEVEL: info
`.trim();
      const result = sanitizeDockerComposeYaml(raw);
      expect(result).not.toContain('should-be-redacted');
      expect(result).toContain('[REDACTED]');
      expect(result).toContain('info');
    });
  });

  // ─── Array-format environment ────────────────────────────────────────────────

  describe('array-format environment', () => {
    it('redacts TOKEN values in array format', () => {
      const raw = `
services:
  agent:
    environment:
      - GITHUB_TOKEN=ghp_arraysecret
      - LOG_LEVEL=debug
`.trim();
      const result = sanitizeDockerComposeYaml(raw);
      expect(result).not.toContain('ghp_arraysecret');
      expect(result).toContain('[REDACTED]');
      expect(result).toContain('debug');
    });

    it('redacts KEY values in array format', () => {
      const raw = `
services:
  agent:
    environment:
      - OPENAI_API_KEY=sk-secretvalue
      - SAFE_VAR=safe
`.trim();
      const result = sanitizeDockerComposeYaml(raw);
      expect(result).not.toContain('sk-secretvalue');
      expect(result).toContain('[REDACTED]');
      expect(result).toContain('safe');
    });

    it('skips array entries without an equals sign', () => {
      const raw = `
services:
  agent:
    environment:
      - GITHUB_TOKEN
      - LOG_LEVEL=debug
`.trim();
      // entries without '=' are left as-is (no-op)
      const result = sanitizeDockerComposeYaml(raw);
      expect(result).toContain('GITHUB_TOKEN');
      expect(result).toContain('debug');
    });

    it('handles VALUE=with=equals=in=it correctly', () => {
      const raw = `
services:
  agent:
    environment:
      - API_KEY=a=b=c
`.trim();
      const result = sanitizeDockerComposeYaml(raw);
      // Only the key matters; the whole value after '=' should be redacted
      expect(result).not.toContain('a=b=c');
      expect(result).toContain('[REDACTED]');
    });
  });

  // ─── Edge cases / invalid input ──────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns raw string when YAML is not an object', () => {
      const raw = 'just a plain string';
      const result = sanitizeDockerComposeYaml(raw);
      expect(result).toBe(raw);
    });

    it('handles missing services section gracefully', () => {
      const raw = `
version: '3'
networks:
  mynet: {}
`.trim();
      const result = sanitizeDockerComposeYaml(raw);
      // Should round-trip without throwing
      expect(result).toBeTruthy();
    });

    it('handles a service with no environment section', () => {
      const raw = `
services:
  agent:
    image: ubuntu:22.04
    command: echo hello
`.trim();
      expect(() => sanitizeDockerComposeYaml(raw)).not.toThrow();
    });

    it('handles null-valued service entries without throwing', () => {
      const raw = `
services:
  agent: ~
`.trim();
      expect(() => sanitizeDockerComposeYaml(raw)).not.toThrow();
    });

    it('handles service entries that are arrays without throwing', () => {
      // malformed but shouldn't crash
      const raw = `
services:
  agent:
    - item1
    - item2
`.trim();
      expect(() => sanitizeDockerComposeYaml(raw)).not.toThrow();
    });

    it('handles empty environment object', () => {
      const raw = `
services:
  agent:
    environment: {}
`.trim();
      expect(() => sanitizeDockerComposeYaml(raw)).not.toThrow();
    });

    it('handles empty environment array', () => {
      const raw = `
services:
  agent:
    environment: []
`.trim();
      expect(() => sanitizeDockerComposeYaml(raw)).not.toThrow();
    });
  });
});
