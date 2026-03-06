/**
 * Tests for API Proxy Server functions
 */

const { deriveCopilotApiTarget } = require('./server');

describe('deriveCopilotApiTarget', () => {
  let originalEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  test('should return default api.githubcopilot.com when no env vars set', () => {
    delete process.env.COPILOT_API_TARGET;
    delete process.env.GITHUB_SERVER_URL;

    const target = deriveCopilotApiTarget();
    expect(target).toBe('api.githubcopilot.com');
  });

  test('should use COPILOT_API_TARGET when explicitly set', () => {
    process.env.COPILOT_API_TARGET = 'custom.api.example.com';
    const target = deriveCopilotApiTarget();
    expect(target).toBe('custom.api.example.com');
  });

  test('should prioritize COPILOT_API_TARGET over GITHUB_SERVER_URL', () => {
    process.env.COPILOT_API_TARGET = 'custom.api.example.com';
    process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com';
    const target = deriveCopilotApiTarget();
    expect(target).toBe('custom.api.example.com');
  });

  test('should return api.githubcopilot.com for github.com', () => {
    process.env.GITHUB_SERVER_URL = 'https://github.com';
    const target = deriveCopilotApiTarget();
    expect(target).toBe('api.githubcopilot.com');
  });

  test('should derive api.SUBDOMAIN.ghe.com for *.ghe.com domains', () => {
    process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com';
    const target = deriveCopilotApiTarget();
    expect(target).toBe('api.mycompany.ghe.com');
  });

  test('should derive api.SUBDOMAIN.ghe.com for different *.ghe.com subdomain', () => {
    process.env.GITHUB_SERVER_URL = 'https://acme-corp.ghe.com';
    const target = deriveCopilotApiTarget();
    expect(target).toBe('api.acme-corp.ghe.com');
  });

  test('should use api.enterprise.githubcopilot.com for GHES (non-.ghe.com enterprise)', () => {
    process.env.GITHUB_SERVER_URL = 'https://github.enterprise.com';
    const target = deriveCopilotApiTarget();
    expect(target).toBe('api.enterprise.githubcopilot.com');
  });

  test('should use api.enterprise.githubcopilot.com for custom GHES domain', () => {
    process.env.GITHUB_SERVER_URL = 'https://git.mycompany.com';
    const target = deriveCopilotApiTarget();
    expect(target).toBe('api.enterprise.githubcopilot.com');
  });

  test('should handle GITHUB_SERVER_URL without protocol gracefully', () => {
    process.env.GITHUB_SERVER_URL = 'mycompany.ghe.com';
    const target = deriveCopilotApiTarget();
    // Invalid URL, should fall back to default
    expect(target).toBe('api.githubcopilot.com');
  });

  test('should handle invalid GITHUB_SERVER_URL gracefully', () => {
    process.env.GITHUB_SERVER_URL = 'not-a-valid-url';
    const target = deriveCopilotApiTarget();
    expect(target).toBe('api.githubcopilot.com');
  });

  test('should handle GITHUB_SERVER_URL with port', () => {
    process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com:443';
    const target = deriveCopilotApiTarget();
    expect(target).toBe('api.mycompany.ghe.com');
  });

  test('should handle GITHUB_SERVER_URL with path', () => {
    process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com/some/path';
    const target = deriveCopilotApiTarget();
    expect(target).toBe('api.mycompany.ghe.com');
  });
});
