import {
  validateApiProxyConfig,
  validateAnthropicCacheTailTtl,
} from './api-proxy-config-validation';
import { emitApiProxyTargetWarnings } from './api-proxy-config-warnings';

describe('validateApiProxyConfig', () => {
  it('should return disabled when enableApiProxy is false', () => {
    const result = validateApiProxyConfig(false);
    expect(result.enabled).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toEqual([]);
  });

  it('should warn when enabled but no API keys provided', () => {
    const result = validateApiProxyConfig(true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('no API keys found');
    expect(result.warnings[1]).toContain('OPENAI_API_KEY');
    expect(result.warnings[1]).toContain('ANTHROPIC_API_KEY');
    expect(result.warnings[1]).toContain('COPILOT_GITHUB_TOKEN');
    expect(result.warnings[1]).toContain('COPILOT_PROVIDER_API_KEY');
    expect(result.warnings[1]).toContain('GEMINI_API_KEY');
    expect(result.debugMessages).toEqual([]);
  });

  it('should warn when enabled with undefined keys', () => {
    const result = validateApiProxyConfig(true, undefined, undefined);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });

  it('should detect OpenAI key', () => {
    const result = validateApiProxyConfig(true, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(1);
    expect(result.debugMessages[0]).toContain('OpenAI');
  });

  it('should detect Anthropic key', () => {
    const result = validateApiProxyConfig(true, false, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(1);
    expect(result.debugMessages[0]).toContain('Anthropic');
  });

  it('should detect Copilot key', () => {
    const result = validateApiProxyConfig(true, false, false, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(1);
    expect(result.debugMessages[0]).toContain('Copilot');
  });

  it('should detect Gemini key', () => {
    const result = validateApiProxyConfig(true, false, false, false, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(1);
    expect(result.debugMessages[0]).toContain('Gemini');
  });

  it('should detect all four keys', () => {
    const result = validateApiProxyConfig(true, true, true, true, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(4);
    expect(result.debugMessages[0]).toContain('OpenAI');
    expect(result.debugMessages[1]).toContain('Anthropic');
    expect(result.debugMessages[2]).toContain('Copilot');
    expect(result.debugMessages[3]).toContain('Gemini');
  });

  it('should not warn when Anthropic WIF auth is configured (no static key)', () => {
    const result = validateApiProxyConfig(true, false, false, false, false, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(1);
    expect(result.debugMessages[0]).toContain('WIF');
  });

  it('should emit WIF debug message alongside static key debug message when both present', () => {
    const result = validateApiProxyConfig(true, false, true, false, false, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    // Both Anthropic key and WIF debug messages appear
    expect(result.debugMessages.some(m => m.includes('Anthropic API key'))).toBe(true);
    expect(result.debugMessages.some(m => m.includes('WIF'))).toBe(true);
  });

  it('should not warn when disabled even with keys', () => {
    const result = validateApiProxyConfig(false, true, true);
    expect(result.enabled).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toEqual([]);
  });

  it('should detect mixed key combination (OpenAI + Gemini)', () => {
    const result = validateApiProxyConfig(true, true, false, false, true);
    expect(result.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.debugMessages).toHaveLength(2);
    expect(result.debugMessages[0]).toContain('OpenAI');
    expect(result.debugMessages[1]).toContain('Gemini');
  });
});

describe('validateApiTargetInAllowedDomains (via emitApiProxyTargetWarnings)', () => {
  it('should not warn when using the default host', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, openaiApiTarget: 'api.openai.com' },
      ['example.com'],
      (msg) => warnings.push(msg)
    );
    // No warning for openai since it's the default target
    expect(warnings.filter(w => w.includes('openai-api-target'))).toEqual([]);
  });

  it('should not warn when custom host is in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, openaiApiTarget: 'custom.example.com' },
      ['custom.example.com', 'other.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings.filter(w => w.includes('openai-api-target'))).toEqual([]);
  });

  it('should not warn when custom host matches a parent domain in allowed list', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, openaiApiTarget: 'llm-router.internal.example.com' },
      ['example.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings.filter(w => w.includes('openai-api-target'))).toEqual([]);
  });

  it('should not warn when custom host matches a dotted parent domain in allowed list', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, openaiApiTarget: 'api.example.com' },
      ['.example.com'],
      (msg) => warnings.push(msg)
    );
    expect(warnings.filter(w => w.includes('openai-api-target'))).toEqual([]);
  });

  it('should warn when custom host is not in allowed domains', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, openaiApiTarget: 'custom.llm-router.internal' },
      ['github.com', 'api.openai.com'],
      (msg) => warnings.push(msg)
    );
    const openaiWarnings = warnings.filter(w => w.includes('openai-api-target'));
    expect(openaiWarnings).toHaveLength(1);
    expect(openaiWarnings[0]).toContain('custom.llm-router.internal');
    expect(openaiWarnings[0]).toContain('--allow-domains');
  });

  it('should warn with the correct flag name and host for anthropic', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, anthropicApiTarget: 'custom.anthropic-router.com' },
      [],
      (msg) => warnings.push(msg)
    );
    const anthropicWarnings = warnings.filter(w => w.includes('anthropic-api-target'));
    expect(anthropicWarnings).toHaveLength(1);
    expect(anthropicWarnings[0]).toContain('custom.anthropic-router.com');
  });

  it('should not warn when allowed domains list is empty and using default host', () => {
    const warnings: string[] = [];
    emitApiProxyTargetWarnings(
      { enableApiProxy: true, anthropicApiTarget: 'api.anthropic.com' },
      [],
      (msg) => warnings.push(msg)
    );
    expect(warnings.filter(w => w.includes('anthropic-api-target'))).toEqual([]);
  });
});

describe('validateAnthropicCacheTailTtl', () => {
  it('should not call process.exit when value is undefined', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    validateAnthropicCacheTailTtl(undefined);
    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('should not call process.exit for valid value "5m"', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    validateAnthropicCacheTailTtl('5m');
    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('should not call process.exit for valid value "1h"', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    validateAnthropicCacheTailTtl('1h');
    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('should call process.exit(1) for an invalid value', () => {
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockError = jest.spyOn(console, 'error').mockImplementation(() => {});
    validateAnthropicCacheTailTtl('10m');
    expect(mockError).toHaveBeenCalledWith('Invalid --anthropic-cache-tail-ttl value: "10m". Must be "5m" or "1h".');
    expect(mockExit).toHaveBeenCalledWith(1);
    mockError.mockRestore();
    mockExit.mockRestore();
  });
});
