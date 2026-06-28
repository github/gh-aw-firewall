/**
 * Coverage for security-critical low-coverage modules:
 *   - src/squid/ssl-bump.ts          (generateSslBumpSection)
 *   - src/squid/upstream-proxy.ts    (generateUpstreamProxySection)
 *   - src/squid/validation.ts        (validateApiProxyIp, validateAndSanitizeHostAccessPort, validateApiProxyPort)
 *   - src/services/credentials/anthropic-credential-env.ts
 *   - src/services/credentials/copilot-credential-env.ts
 *   - src/services/credentials/gemini-credential-env.ts
 *   - src/services/credentials/openai-credential-env.ts
 */

jest.mock('./logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('./env-utils', () => ({
  getLowerCaseProcessEnvValue: jest.fn(),
  getConfigEnvValue: jest.fn(),
}));

import { generateSslBumpSection } from './squid/ssl-bump';
import { generateUpstreamProxySection } from './squid/upstream-proxy';
import {
  validateApiProxyIp,
  validateAndSanitizeHostAccessPort,
  validateApiProxyPort,
} from './squid/validation';
import { buildAnthropicCredentialEnv } from './services/credentials/anthropic-credential-env';
import { buildCopilotCredentialEnv } from './services/credentials/copilot-credential-env';
import { buildGeminiCredentialEnv } from './services/credentials/gemini-credential-env';
import { buildOpenAiCredentialEnv } from './services/credentials/openai-credential-env';
import type { WrapperConfig } from './types';
import { getLowerCaseProcessEnvValue, getConfigEnvValue } from './env-utils';

const mockGetLowerCaseProcessEnvValue = getLowerCaseProcessEnvValue as jest.MockedFunction<
  typeof getLowerCaseProcessEnvValue
>;
const mockGetConfigEnvValue = getConfigEnvValue as jest.MockedFunction<typeof getConfigEnvValue>;

const baseConfig = {} as WrapperConfig;
const proxyIp = '172.30.0.30';

// ====================================================
// src/squid/ssl-bump.ts
// ====================================================
describe('generateSslBumpSection', () => {
  const caFiles = { certPath: '/tmp/test/cert.pem', keyPath: '/tmp/test/key.pem' };
  const sslDbPath = '/var/lib/squid/ssl_db';

  it('includes both ACL directives when hasPlainDomains and hasPatterns are true', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, true);
    expect(result).toContain('ssl_bump bump allowed_domains\nssl_bump bump allowed_domains_regex');
  });

  it('includes only plain domain directive when hasPlainDomains=true, hasPatterns=false', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain('ssl_bump bump allowed_domains');
    expect(result).not.toContain('allowed_domains_regex');
  });

  it('includes only regex directive when hasPlainDomains=false, hasPatterns=true', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, false, true);
    expect(result).toContain('ssl_bump bump allowed_domains_regex');
    expect(result).not.toContain('ssl_bump bump allowed_domains\n');
  });

  it('uses terminate-all comment when no domains configured', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, false, false);
    expect(result).toContain('# No domains configured - terminate all SSL connections');
  });

  it('embeds cert and key paths in http_port directives', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain(`cert=${caFiles.certPath}`);
    expect(result).toContain(`key=${caFiles.keyPath}`);
  });

  it('embeds sslDbPath in sslcrtd_program directive', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain(`-s ${sslDbPath}`);
  });

  it('includes both IPv4 and IPv6 http_port directives for dual-stack defense-in-depth', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain('http_port 3128 ssl-bump');
    expect(result).toContain('http_port [::]:3128 ssl-bump');
  });

  it('includes peek, stare, and terminate directives', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain('ssl_bump peek step1');
    expect(result).toContain('ssl_bump stare step2');
    expect(result).toContain('ssl_bump terminate all');
  });

  it('generates indexed URL ACL lines when urlPatterns provided', () => {
    const urlPatterns = ['.*\\.example\\.com', 'github\\.com'];
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false, urlPatterns);
    expect(result).toContain('acl allowed_url_0 url_regex .*\\.example\\.com');
    expect(result).toContain('acl allowed_url_1 url_regex github\\.com');
    expect(result).toContain('# URL pattern ACLs for HTTPS content inspection');
  });

  it('omits URL ACL section when urlPatterns is undefined', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).not.toContain('URL pattern ACLs');
  });

  it('omits URL ACL section when urlPatterns is empty array', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false, []);
    expect(result).not.toContain('URL pattern ACLs');
  });

  it('disables weak TLS protocols (NO_SSLv3, NO_TLSv1, NO_TLSv1_1)', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain('options=NO_SSLv3,NO_TLSv1,NO_TLSv1_1');
  });

  it('rejects newline injection in URL patterns via assertSafeForSquidConfig', () => {
    expect(() =>
      generateSslBumpSection(caFiles, sslDbPath, true, false, ['safe\nevil_directive'])
    ).toThrow();
  });

  it('includes step ACL declarations for SslBump phases', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain('acl step1 at_step SslBump1');
    expect(result).toContain('acl step2 at_step SslBump2');
    expect(result).toContain('acl step3 at_step SslBump3');
  });
});

// ====================================================
// src/squid/upstream-proxy.ts
// ====================================================
describe('generateUpstreamProxySection', () => {
  it('generates cache_peer directive with host and port', () => {
    const result = generateUpstreamProxySection({ host: 'proxy.corp.com', port: 3128 });
    expect(result).toContain('cache_peer proxy.corp.com parent 3128 0 no-query default');
  });

  it('always includes never_direct allow all directive', () => {
    const result = generateUpstreamProxySection({ host: 'proxy.corp.com', port: 8080 });
    expect(result).toContain('never_direct allow all');
  });

  it('does not include bypass ACL when noProxy is empty', () => {
    const result = generateUpstreamProxySection({ host: 'proxy.corp.com', port: 3128, noProxy: [] });
    expect(result).not.toContain('upstream_bypass');
    expect(result).not.toContain('always_direct');
  });

  it('does not include bypass ACL when noProxy is undefined', () => {
    const result = generateUpstreamProxySection({ host: 'proxy.corp.com', port: 3128 });
    expect(result).not.toContain('upstream_bypass');
  });

  it('adds subdomain dstdomain ACL and exact match for plain domain noProxy entry', () => {
    const result = generateUpstreamProxySection({
      host: 'proxy.corp.com',
      port: 3128,
      noProxy: ['internal.corp.com'],
    });
    // Subdomain match
    expect(result).toContain('acl upstream_bypass dstdomain .internal.corp.com');
    // Exact domain match (non-dot entry gets both)
    expect(result).toContain('acl upstream_bypass dstdomain internal.corp.com');
    expect(result).toContain('always_direct allow upstream_bypass');
  });

  it('adds only subdomain dstdomain ACL for already-dotted noProxy entry', () => {
    const result = generateUpstreamProxySection({
      host: 'proxy.corp.com',
      port: 3128,
      noProxy: ['.corp.com'],
    });
    expect(result).toContain('acl upstream_bypass dstdomain .corp.com');
    // Should NOT add exact match for already-dotted domain
    const exactMatchLine = 'acl upstream_bypass dstdomain corp.com\n';
    expect(result).not.toContain(exactMatchLine);
  });

  it('handles multiple noProxy domains and adds always_direct once', () => {
    const result = generateUpstreamProxySection({
      host: 'proxy.corp.com',
      port: 3128,
      noProxy: ['internal.corp.com', '.other.corp.com'],
    });
    expect(result).toContain('acl upstream_bypass dstdomain .internal.corp.com');
    expect(result).toContain('acl upstream_bypass dstdomain .other.corp.com');
    expect(result).toContain('always_direct allow upstream_bypass');
  });

  it('includes Bypass comment when noProxy entries present', () => {
    const result = generateUpstreamProxySection({
      host: 'proxy.corp.com',
      port: 3128,
      noProxy: ['internal.corp.com'],
    });
    expect(result).toContain('# Bypass upstream proxy for these domains (from host no_proxy)');
  });

  it('rejects newline injection in proxy host via assertSafeForSquidConfig', () => {
    expect(() =>
      generateUpstreamProxySection({ host: 'proxy.corp.com\nevil', port: 3128 })
    ).toThrow();
  });

  it('rejects newline injection in noProxy domain', () => {
    expect(() =>
      generateUpstreamProxySection({
        host: 'proxy.corp.com',
        port: 3128,
        noProxy: ['legit.com\nevil_directive'],
      })
    ).toThrow();
  });
});

// ====================================================
// src/squid/validation.ts
// ====================================================
describe('validateApiProxyIp', () => {
  it('passes when apiProxyIp is undefined', () => {
    expect(() => validateApiProxyIp(undefined)).not.toThrow();
  });

  it('passes for valid IPv4 addresses', () => {
    expect(() => validateApiProxyIp('172.30.0.30')).not.toThrow();
    expect(() => validateApiProxyIp('10.0.0.1')).not.toThrow();
    expect(() => validateApiProxyIp('255.255.255.255')).not.toThrow();
    expect(() => validateApiProxyIp('0.0.0.0')).not.toThrow();
  });

  it('throws SECURITY error for empty string', () => {
    expect(() => validateApiProxyIp('')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for hostname (non-IP)', () => {
    expect(() => validateApiProxyIp('proxy.corp.com')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for IPv6 address', () => {
    expect(() => validateApiProxyIp('::1')).toThrow(/SECURITY/);
    expect(() => validateApiProxyIp('2001:db8::1')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for out-of-range octet', () => {
    expect(() => validateApiProxyIp('256.0.0.1')).toThrow(/SECURITY/);
    expect(() => validateApiProxyIp('192.168.1.300')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for partial IP address', () => {
    expect(() => validateApiProxyIp('192.168.1')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for IP with trailing dot', () => {
    expect(() => validateApiProxyIp('192.168.1.1.')).toThrow(/SECURITY/);
  });

  it('throws SECURITY error for IP with newline injection', () => {
    expect(() => validateApiProxyIp('172.30.0.30\nevil')).toThrow(/SECURITY/);
  });
});

describe('validateAndSanitizeHostAccessPort', () => {
  it('returns trimmed port number for valid port', () => {
    expect(validateAndSanitizeHostAccessPort('8080')).toBe('8080');
    expect(validateAndSanitizeHostAccessPort(' 8080 ')).toBe('8080');
  });

  it('returns port range for valid range', () => {
    expect(validateAndSanitizeHostAccessPort('9000-9100')).toBe('9000-9100');
  });

  it('allows safe non-dangerous ports', () => {
    expect(validateAndSanitizeHostAccessPort('9000')).toBe('9000');
    expect(validateAndSanitizeHostAccessPort('443')).toBe('443');
    expect(validateAndSanitizeHostAccessPort('8443')).toBe('8443');
  });

  it('throws for non-numeric input', () => {
    expect(() => validateAndSanitizeHostAccessPort('abc')).toThrow(/Invalid port/);
  });

  it('throws for empty string', () => {
    expect(() => validateAndSanitizeHostAccessPort('')).toThrow(/Invalid port/);
  });

  it('throws for port 0 (below minimum)', () => {
    expect(() => validateAndSanitizeHostAccessPort('0')).toThrow(/Invalid port/);
  });

  it('throws for port above 65535', () => {
    expect(() => validateAndSanitizeHostAccessPort('65536')).toThrow(/Invalid port/);
  });

  it('throws for dangerous port 22 (SSH)', () => {
    expect(() => validateAndSanitizeHostAccessPort('22')).toThrow(/dangerous port/i);
  });

  it('throws for dangerous port 3306 (MySQL)', () => {
    expect(() => validateAndSanitizeHostAccessPort('3306')).toThrow(/dangerous port/i);
  });

  it('throws for port range that includes dangerous SSH port', () => {
    expect(() => validateAndSanitizeHostAccessPort('20-25')).toThrow(/dangerous port/i);
  });

  it('throws for invalid range where start > end', () => {
    expect(() => validateAndSanitizeHostAccessPort('9000-8000')).toThrow(/Invalid port range/i);
  });

  it('throws for port range with start below minimum', () => {
    expect(() => validateAndSanitizeHostAccessPort('0-8080')).toThrow(/Invalid port range/i);
  });
});

describe('validateApiProxyPort', () => {
  it('passes for valid port numbers', () => {
    expect(() => validateApiProxyPort(8080)).not.toThrow();
    expect(() => validateApiProxyPort(1)).not.toThrow();
    expect(() => validateApiProxyPort(65535)).not.toThrow();
    expect(() => validateApiProxyPort(9000)).not.toThrow();
  });

  it('throws for non-integer (float)', () => {
    expect(() => validateApiProxyPort(8080.5)).toThrow(/Invalid api-proxy port/);
  });

  it('throws for port 0', () => {
    expect(() => validateApiProxyPort(0)).toThrow(/Invalid api-proxy port/);
  });

  it('throws for port above 65535', () => {
    expect(() => validateApiProxyPort(65536)).toThrow(/Invalid api-proxy port/);
  });

  it('throws for negative port', () => {
    expect(() => validateApiProxyPort(-1)).toThrow(/Invalid api-proxy port/);
  });

  it('throws for NaN', () => {
    expect(() => validateApiProxyPort(NaN)).toThrow(/Invalid api-proxy port/);
  });

  it('throws for dangerous port 22 (SSH)', () => {
    expect(() => validateApiProxyPort(22)).toThrow(/dangerous port/i);
  });

  it('throws for dangerous port 5432 (PostgreSQL)', () => {
    expect(() => validateApiProxyPort(5432)).toThrow(/dangerous port/i);
  });
});

// ====================================================
// src/services/credentials/anthropic-credential-env.ts
// ====================================================
describe('buildAnthropicCredentialEnv', () => {
  beforeEach(() => {
    mockGetLowerCaseProcessEnvValue.mockReturnValue('');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty object when no anthropic credentials configured', () => {
    const result = buildAnthropicCredentialEnv({ config: baseConfig, proxyIp });
    expect(result).toEqual({});
  });

  it('returns env additions when anthropicApiKey is set', () => {
    const config = { ...baseConfig, anthropicApiKey: 'sk-ant-real-key' } as WrapperConfig;
    const result = buildAnthropicCredentialEnv({ config, proxyIp });
    expect(result.ANTHROPIC_BASE_URL).toBe(`http://${proxyIp}:10001`);
    // Placeholder must pass Claude Code's sk-ant- prefix validation
    expect(result.ANTHROPIC_AUTH_TOKEN).toMatch(/^sk-ant-/);
    expect(result.CLAUDE_CODE_API_KEY_HELPER).toBe('/usr/local/bin/get-claude-key.sh');
  });

  it('returns env additions when auth type is github-oidc with anthropic provider', () => {
    mockGetLowerCaseProcessEnvValue.mockImplementation((key: string) => {
      if (key === 'AWF_AUTH_TYPE') return 'github-oidc';
      if (key === 'AWF_AUTH_PROVIDER') return 'anthropic';
      return '';
    });
    const result = buildAnthropicCredentialEnv({ config: baseConfig, proxyIp });
    expect(result.ANTHROPIC_BASE_URL).toContain(proxyIp);
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeDefined();
  });

  it('returns empty object when auth type is github-oidc but provider is not anthropic', () => {
    mockGetLowerCaseProcessEnvValue.mockImplementation((key: string) => {
      if (key === 'AWF_AUTH_TYPE') return 'github-oidc';
      if (key === 'AWF_AUTH_PROVIDER') return 'openai';
      return '';
    });
    const result = buildAnthropicCredentialEnv({ config: baseConfig, proxyIp });
    expect(result).toEqual({});
  });

  it('ANTHROPIC_AUTH_TOKEN placeholder has sk-ant- prefix for Claude Code key-format validation', () => {
    const config = { ...baseConfig, anthropicApiKey: 'sk-ant-test' } as WrapperConfig;
    const result = buildAnthropicCredentialEnv({ config, proxyIp });
    expect(result.ANTHROPIC_AUTH_TOKEN).toMatch(/^sk-ant-/);
  });

  it('real anthropicApiKey is NOT present in agent env (credential isolation)', () => {
    const realKey = 'sk-ant-real-secret-key';
    const config = { ...baseConfig, anthropicApiKey: realKey } as WrapperConfig;
    const result = buildAnthropicCredentialEnv({ config, proxyIp });
    expect(Object.values(result)).not.toContain(realKey);
  });

  it('ANTHROPIC_API_KEY is NOT set in returned env (excluded for credential isolation)', () => {
    const config = { ...baseConfig, anthropicApiKey: 'sk-ant-test' } as WrapperConfig;
    const result = buildAnthropicCredentialEnv({ config, proxyIp });
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('routes to Anthropic port 10001 specifically', () => {
    const config = { ...baseConfig, anthropicApiKey: 'sk-ant-test' } as WrapperConfig;
    const result = buildAnthropicCredentialEnv({ config, proxyIp });
    expect(result.ANTHROPIC_BASE_URL).toMatch(/:10001$/);
  });
});

// ====================================================
// src/services/credentials/copilot-credential-env.ts
// ====================================================
describe('buildCopilotCredentialEnv', () => {
  beforeEach(() => {
    mockGetConfigEnvValue.mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty object when no copilot credentials configured', () => {
    const result = buildCopilotCredentialEnv({ config: baseConfig, proxyIp });
    expect(result).toEqual({});
  });

  it('returns env additions when copilotGithubToken is set', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_API_URL).toBe(`http://${proxyIp}:10002`);
    expect(result.COPILOT_OFFLINE).toBe('true');
    expect(result.COPILOT_TOKEN).toBe('ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result.COPILOT_GITHUB_TOKEN).toBe('ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('returns env additions when copilotProviderApiKey is set', () => {
    const config = { ...baseConfig, copilotProviderApiKey: 'provider-key' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_API_URL).toBeDefined();
    expect(result.COPILOT_PROVIDER_API_KEY).toBe('ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('returns env additions when copilotProviderBaseUrl is set', () => {
    const config = { ...baseConfig, copilotProviderBaseUrl: 'https://openrouter.ai/api' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_API_URL).toBeDefined();
    // Agent always sees the sidecar URL, never the real provider URL
    expect(result.COPILOT_PROVIDER_BASE_URL).toBe(`http://${proxyIp}:10002`);
  });

  it('does NOT set COPILOT_GITHUB_TOKEN placeholder when only providerApiKey is given', () => {
    const config = { ...baseConfig, copilotProviderApiKey: 'provider-key' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  it('does NOT set COPILOT_PROVIDER_API_KEY placeholder when no provider key given', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_PROVIDER_API_KEY).toBeUndefined();
  });

  it('sets COPILOT_PROVIDER_WIRE_API=responses for gpt-5 model', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    mockGetConfigEnvValue.mockImplementation((_: unknown, key: string) =>
      key === 'COPILOT_MODEL' ? 'gpt-5' : undefined
    );
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_PROVIDER_WIRE_API).toBe('responses');
  });

  it('sets COPILOT_PROVIDER_WIRE_API=responses for o3 model', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    mockGetConfigEnvValue.mockImplementation((_: unknown, key: string) =>
      key === 'COPILOT_MODEL' ? 'o3-mini' : undefined
    );
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_PROVIDER_WIRE_API).toBe('responses');
  });

  it('sets COPILOT_PROVIDER_WIRE_API=responses for openai/gpt-5 prefixed model', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    mockGetConfigEnvValue.mockImplementation((_: unknown, key: string) =>
      key === 'COPILOT_MODEL' ? 'openai/gpt-5' : undefined
    );
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_PROVIDER_WIRE_API).toBe('responses');
  });

  it('does not set COPILOT_PROVIDER_WIRE_API for non-gpt5/o3 models', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    mockGetConfigEnvValue.mockImplementation((_: unknown, key: string) =>
      key === 'COPILOT_MODEL' ? 'claude-3-5-sonnet' : undefined
    );
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_PROVIDER_WIRE_API).toBeUndefined();
  });

  it('real copilotGithubToken is NOT present in agent env (credential isolation)', () => {
    const realToken = 'ghu_real_secret_token';
    const config = { ...baseConfig, copilotGithubToken: realToken } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(Object.values(result)).not.toContain(realToken);
  });

  it('routes to Copilot port 10002 specifically', () => {
    const config = { ...baseConfig, copilotGithubToken: 'ghu_token' } as WrapperConfig;
    const result = buildCopilotCredentialEnv({ config, proxyIp });
    expect(result.COPILOT_API_URL).toMatch(/:10002$/);
  });
});

// ====================================================
// src/services/credentials/gemini-credential-env.ts
// ====================================================
describe('buildGeminiCredentialEnv', () => {
  it('returns empty object when geminiApiKey is not set', () => {
    const result = buildGeminiCredentialEnv({ config: baseConfig, proxyIp });
    expect(result).toEqual({});
  });

  it('returns env additions when geminiApiKey is set', () => {
    const config = { ...baseConfig, geminiApiKey: 'AIza-test-key' } as WrapperConfig;
    const result = buildGeminiCredentialEnv({ config, proxyIp });
    expect(result.GOOGLE_GEMINI_BASE_URL).toBe(`http://${proxyIp}:10003`);
    expect(result.GEMINI_API_BASE_URL).toBe(`http://${proxyIp}:10003`);
    expect(result.GEMINI_API_KEY).toBe('gemini-api-key-placeholder-for-credential-isolation');
  });

  it('real geminiApiKey is NOT present in agent env (credential isolation)', () => {
    const realKey = 'AIza-real-secret-key';
    const config = { ...baseConfig, geminiApiKey: realKey } as WrapperConfig;
    const result = buildGeminiCredentialEnv({ config, proxyIp });
    expect(Object.values(result)).not.toContain(realKey);
  });

  it('sets both GOOGLE_GEMINI_BASE_URL and GEMINI_API_BASE_URL for backward compatibility', () => {
    const config = { ...baseConfig, geminiApiKey: 'AIza-test' } as WrapperConfig;
    const result = buildGeminiCredentialEnv({ config, proxyIp });
    expect(result.GOOGLE_GEMINI_BASE_URL).toBeDefined();
    expect(result.GEMINI_API_BASE_URL).toBeDefined();
    expect(result.GOOGLE_GEMINI_BASE_URL).toBe(result.GEMINI_API_BASE_URL);
  });

  it('routes to Gemini port 10003 specifically', () => {
    const config = { ...baseConfig, geminiApiKey: 'AIza-test' } as WrapperConfig;
    const result = buildGeminiCredentialEnv({ config, proxyIp });
    expect(result.GOOGLE_GEMINI_BASE_URL).toMatch(/:10003$/);
  });
});

// ====================================================
// src/services/credentials/openai-credential-env.ts
// ====================================================
describe('buildOpenAiCredentialEnv', () => {
  it('returns empty object when openaiApiKey is not set', () => {
    const result = buildOpenAiCredentialEnv({ config: baseConfig, proxyIp });
    expect(result).toEqual({});
  });

  it('returns env additions when openaiApiKey is set', () => {
    const config = { ...baseConfig, openaiApiKey: 'sk-real-key' } as WrapperConfig;
    const result = buildOpenAiCredentialEnv({ config, proxyIp });
    expect(result.OPENAI_BASE_URL).toBe(`http://${proxyIp}:10000`);
    expect(result.OPENAI_API_KEY).toBe('sk-placeholder-for-api-proxy');
    expect(result.CODEX_API_KEY).toBe('sk-placeholder-for-api-proxy');
  });

  it('real openaiApiKey is NOT present in agent env (credential isolation)', () => {
    const realKey = 'sk-real-secret-key';
    const config = { ...baseConfig, openaiApiKey: realKey } as WrapperConfig;
    const result = buildOpenAiCredentialEnv({ config, proxyIp });
    expect(Object.values(result)).not.toContain(realKey);
  });

  it('sets both OPENAI_API_KEY and CODEX_API_KEY for Codex WebSocket auth support', () => {
    const config = { ...baseConfig, openaiApiKey: 'sk-test' } as WrapperConfig;
    const result = buildOpenAiCredentialEnv({ config, proxyIp });
    expect(result.OPENAI_API_KEY).toBeDefined();
    expect(result.CODEX_API_KEY).toBeDefined();
  });

  it('routes to OpenAI port 10000 specifically', () => {
    const config = { ...baseConfig, openaiApiKey: 'sk-test' } as WrapperConfig;
    const result = buildOpenAiCredentialEnv({ config, proxyIp });
    expect(result.OPENAI_BASE_URL).toMatch(/:10000$/);
  });
});
