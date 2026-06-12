import { Command } from 'commander';
import {
  validateSkipPullWithBuildLocal,
  buildRateLimitConfig,
  validateRateLimitFlags,
  validateEnableTokenSteeringFlag,
  parseMemoryLimit,
  applyAgentTimeout,
  collectRulesetFile,
  checkDockerHost,
  resolveDockerHostPathPrefix,
  formatItem,
  parseModelMultipliersCli,
} from './option-parsers';

describe('validateSkipPullWithBuildLocal', () => {
  it('should return valid when both flags are false', () => {
    const result = validateSkipPullWithBuildLocal(false, false);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when both flags are undefined', () => {
    const result = validateSkipPullWithBuildLocal(undefined, undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when only skipPull is true', () => {
    const result = validateSkipPullWithBuildLocal(true, false);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when only buildLocal is true', () => {
    const result = validateSkipPullWithBuildLocal(false, true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return invalid when both skipPull and buildLocal are true', () => {
    const result = validateSkipPullWithBuildLocal(true, true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--skip-pull cannot be used with --build-local');
  });

  it('should return valid when skipPull is true and buildLocal is undefined', () => {
    const result = validateSkipPullWithBuildLocal(true, undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when skipPull is undefined and buildLocal is true', () => {
    const result = validateSkipPullWithBuildLocal(undefined, true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('buildRateLimitConfig', () => {
  it('should return defaults when no options provided', () => {
    const r = buildRateLimitConfig({});
    expect('config' in r).toBe(true);
    if ('config' in r) { expect(r.config).toEqual({ enabled: false, rpm: 0, rph: 0, bytesPm: 0 }); }
  });
  it('should disable with rateLimit=false even if limits provided', () => {
    const r = buildRateLimitConfig({ rateLimit: false, rateLimitRpm: '30' });
    if ('config' in r) { expect(r.config.enabled).toBe(false); }
  });
  it('should enable and parse custom RPM', () => {
    const r = buildRateLimitConfig({ rateLimitRpm: '30' });
    if ('config' in r) { expect(r.config.enabled).toBe(true); expect(r.config.rpm).toBe(30); }
  });
  it('should enable and parse custom RPH', () => {
    const r = buildRateLimitConfig({ rateLimitRph: '500' });
    if ('config' in r) { expect(r.config.enabled).toBe(true); expect(r.config.rph).toBe(500); }
  });
  it('should enable and parse custom bytes-pm', () => {
    const r = buildRateLimitConfig({ rateLimitBytesPm: '1000000' });
    if ('config' in r) { expect(r.config.enabled).toBe(true); expect(r.config.bytesPm).toBe(1000000); }
  });
  it('should error on negative RPM', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRpm: '-5' })).toBe(true);
  });
  it('should error on zero RPM', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRpm: '0' })).toBe(true);
  });
  it('should error on non-integer RPM', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRpm: 'abc' })).toBe(true);
  });
  it('should error on negative RPH', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRph: '-1' })).toBe(true);
  });
  it('should error on negative bytes-pm', () => {
    expect('error' in buildRateLimitConfig({ rateLimitBytesPm: '-100' })).toBe(true);
  });
  it('should ignore custom values when disabled via --no-rate-limit', () => {
    const r = buildRateLimitConfig({ rateLimit: false, rateLimitRpm: '999' });
    if ('config' in r) { expect(r.config.enabled).toBe(false); expect(r.config.rpm).toBe(0); }
  });
  it('should accept all custom values', () => {
    const r = buildRateLimitConfig({ rateLimitRpm: '10', rateLimitRph: '100', rateLimitBytesPm: '5000000' });
    if ('config' in r) { expect(r.config).toEqual({ enabled: true, rpm: 10, rph: 100, bytesPm: 5000000 }); }
  });
});

describe('validateRateLimitFlags', () => {
  it('should pass when api proxy is enabled', () => {
    expect(validateRateLimitFlags(true, { rateLimitRpm: '30' })).toEqual({ valid: true });
  });
  it('should pass when no rate limit flags used', () => {
    expect(validateRateLimitFlags(false, {})).toEqual({ valid: true });
  });
  it('should fail when --rate-limit-rpm used without api proxy', () => {
    const r = validateRateLimitFlags(false, { rateLimitRpm: '30' });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('--enable-api-proxy');
  });
  it('should fail when --rate-limit-rph used without api proxy', () => {
    expect(validateRateLimitFlags(false, { rateLimitRph: '100' }).valid).toBe(false);
  });
  it('should fail when --rate-limit-bytes-pm used without api proxy', () => {
    expect(validateRateLimitFlags(false, { rateLimitBytesPm: '1000' }).valid).toBe(false);
  });
  it('should fail when --no-rate-limit used without api proxy', () => {
    expect(validateRateLimitFlags(false, { rateLimit: false }).valid).toBe(false);
  });
  it('should pass when all flags used with api proxy enabled', () => {
    const r = validateRateLimitFlags(true, { rateLimitRpm: '10', rateLimitRph: '100', rateLimit: false });
    expect(r.valid).toBe(true);
  });
});

describe('validateEnableTokenSteeringFlag', () => {
  it('should pass when both --enable-token-steering and --enable-api-proxy are set', () => {
    expect(validateEnableTokenSteeringFlag(true, true)).toEqual({ valid: true });
  });
  it('should pass when --enable-token-steering is false', () => {
    expect(validateEnableTokenSteeringFlag(false, false)).toEqual({ valid: true });
  });
  it('should pass when --enable-token-steering is false and --enable-api-proxy is true', () => {
    expect(validateEnableTokenSteeringFlag(true, false)).toEqual({ valid: true });
  });
  it('should fail when --enable-token-steering is true without --enable-api-proxy', () => {
    const r = validateEnableTokenSteeringFlag(false, true);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('--enable-api-proxy');
  });
});

describe('parseMemoryLimit', () => {
  it('accepts valid memory limits', () => {
    expect(parseMemoryLimit('2g')).toEqual({ value: '2g' });
    expect(parseMemoryLimit('4g')).toEqual({ value: '4g' });
    expect(parseMemoryLimit('512m')).toEqual({ value: '512m' });
    expect(parseMemoryLimit('1024k')).toEqual({ value: '1024k' });
    expect(parseMemoryLimit('8G')).toEqual({ value: '8g' });
  });

  it('rejects invalid formats', () => {
    expect(parseMemoryLimit('abc')).toHaveProperty('error');
    expect(parseMemoryLimit('-1g')).toHaveProperty('error');
    expect(parseMemoryLimit('2x')).toHaveProperty('error');
    expect(parseMemoryLimit('')).toHaveProperty('error');
    expect(parseMemoryLimit('g')).toHaveProperty('error');
  });

  it('rejects zero', () => {
    expect(parseMemoryLimit('0g')).toHaveProperty('error');
  });
});

describe('applyAgentTimeout', () => {
  it.each(['abc', '0', '-5', '', '1.5', '030', '30m'])('should call process.exit for invalid value: %s', (value) => {
    const config: any = {};
    const logger = { error: jest.fn(), info: jest.fn() };
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as any);

    try {
      expect(() => applyAgentTimeout(value, config, logger)).toThrow('process.exit:1');
      expect(logger.error).toHaveBeenCalledWith('--agent-timeout must be a positive integer (minutes)');
      expect(logger.info).not.toHaveBeenCalled();
      expect(config.agentTimeout).toBeUndefined();
    } finally {
      mockExit.mockRestore();
    }
  });

  it('should do nothing when agentTimeout is undefined', () => {
    const config: any = {};
    const logger = { error: jest.fn(), info: jest.fn() };
    applyAgentTimeout(undefined, config, logger);
    expect(config.agentTimeout).toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('should set agentTimeout on config for valid value', () => {
    const config: any = {};
    const logger = { error: jest.fn(), info: jest.fn() };
    applyAgentTimeout('30', config, logger);
    expect(config.agentTimeout).toBe(30);
    expect(logger.info).toHaveBeenCalledWith('Agent timeout set to 30 minutes');
  });

  it('should call process.exit for invalid value', () => {
    const config: any = {};
    const logger = { error: jest.fn(), info: jest.fn() };
    const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    applyAgentTimeout('abc', config, logger);
    expect(logger.error).toHaveBeenCalledWith('--agent-timeout must be a positive integer (minutes)');
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });
});

describe('collectRulesetFile', () => {
  it('should accumulate multiple values into an array', () => {
    let result = collectRulesetFile('a.yml');
    result = collectRulesetFile('b.yml', result);
    expect(result).toEqual(['a.yml', 'b.yml']);
  });

  it('should default to empty array when no previous values', () => {
    const result = collectRulesetFile('first.yml');
    expect(result).toEqual(['first.yml']);
  });

  it('should work with Commander option parsing', () => {
    const testProgram = new Command();
    testProgram
      .option('--ruleset-file <path>', 'YAML rule file', collectRulesetFile, [])
      .action(() => {});

    testProgram.parse(['node', 'awf', '--ruleset-file', 'a.yml', '--ruleset-file', 'b.yml'], { from: 'node' });
    const opts = testProgram.opts();
    expect(opts.rulesetFile).toEqual(['a.yml', 'b.yml']);
  });

  it('should default to empty array when not provided', () => {
    const testProgram = new Command();
    testProgram
      .option('--ruleset-file <path>', 'YAML rule file', collectRulesetFile, [])
      .action(() => {});

    testProgram.parse(['node', 'awf'], { from: 'node' });
    const opts = testProgram.opts();
    expect(opts.rulesetFile).toEqual([]);
  });
});

describe('checkDockerHost', () => {
  it('should return valid when DOCKER_HOST is not set', () => {
    const result = checkDockerHost({});
    expect(result.valid).toBe(true);
  });

  it('should return valid when DOCKER_HOST is undefined', () => {
    const result = checkDockerHost({ DOCKER_HOST: undefined });
    expect(result.valid).toBe(true);
  });

  it('should return valid for the default /var/run/docker.sock socket', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'unix:///var/run/docker.sock' });
    expect(result.valid).toBe(true);
  });

  it('should return valid for the /run/docker.sock socket', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'unix:///run/docker.sock' });
    expect(result.valid).toBe(true);
  });

  it('should return valid for tcp://localhost (ARC/DinD standard endpoint)', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost:2375' });
    expect(result.valid).toBe(true);
  });

  it('should return valid for tcp://localhost on a non-default port', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost:2376' });
    expect(result.valid).toBe(true);
  });

  it('should return valid for tcp://127.0.0.1', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://127.0.0.1:2375' });
    expect(result.valid).toBe(true);
  });

  it('should return invalid for a non-loopback TCP daemon (workflow-scope DinD)', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://192.168.1.100:2375' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('tcp://192.168.1.100:2375');
      expect(result.error).toContain('external daemon');
      expect(result.error).toContain('network isolation model');
    }
  });

  it('should return invalid for a remote TCP daemon', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://docker.example.com:2375' });
    expect(result.valid).toBe(false);
  });

  it('should return invalid for tcp://localhost without a port', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost' });
    expect(result.valid).toBe(false);
  });

  it('should return invalid for tcp://localhost with a path component', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost:2375/some/path' });
    expect(result.valid).toBe(false);
  });

  it('should return invalid for tcp://localhost with auth components', () => {
    const result = checkDockerHost({ DOCKER_HOST: '******localhost:2375' });
    expect(result.valid).toBe(false);
  });

  it('should return invalid for tcp://localhost with a non-numeric port', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost:abc' });
    expect(result.valid).toBe(false);
  });

  it('should return valid for a non-standard unix socket', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'unix:///tmp/custom-docker.sock' });
    expect(result.valid).toBe(true);
  });
});

describe('resolveDockerHostPathPrefix', () => {
  it('returns explicit prefix when provided', () => {
    const result = resolveDockerHostPathPrefix({ valid: false, error: 'external DOCKER_HOST' }, '/daemon-root');
    expect(result).toEqual({ dockerHostPathPrefix: '/daemon-root', autoApplied: false, dindHint: false });
  });

  it('does not auto-apply a prefix for external DOCKER_HOST when none is provided', () => {
    const result = resolveDockerHostPathPrefix({ valid: false, error: 'external DOCKER_HOST' }, undefined);
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('returns undefined when DOCKER_HOST is local and no prefix is provided', () => {
    const result = resolveDockerHostPathPrefix({ valid: true }, undefined);
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('sets dindHint when DOCKER_HOST is a non-standard unix socket', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { DOCKER_HOST: 'unix:///tmp/docker-sibling.sock' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: true });
  });

  it('does not set dindHint for the default /var/run/docker.sock socket', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { DOCKER_HOST: 'unix:///var/run/docker.sock' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('does not set dindHint for the /run/docker.sock socket', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { DOCKER_HOST: 'unix:///run/docker.sock' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('sets dindHint when AWF_DIND=1 is set', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { AWF_DIND: '1' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: true });
  });

  it('does not set dindHint when AWF_DIND is not 1', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { AWF_DIND: '0' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('sets dindHint for tcp://localhost (ARC/DinD sidecar endpoint)', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { DOCKER_HOST: 'tcp://localhost:2375' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: true });
  });

  it('sets dindHint for tcp://127.0.0.1 (ARC/DinD sidecar endpoint)', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { DOCKER_HOST: 'tcp://127.0.0.1:2375' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: true });
  });

  it('does not set dindHint for non-loopback TCP DOCKER_HOST', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: false, error: 'external' },
      undefined,
      { DOCKER_HOST: 'tcp://192.168.1.100:2375' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('explicit prefix wins and suppresses dindHint even when non-standard socket is set', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      '/tmp/gh-aw',
      { DOCKER_HOST: 'unix:///tmp/docker-sibling.sock' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: '/tmp/gh-aw', autoApplied: false, dindHint: false });
  });

  it('explicit prefix wins and suppresses dindHint when AWF_DIND=1', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      '/host',
      { AWF_DIND: '1' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: '/host', autoApplied: false, dindHint: false });
  });
});

describe('formatItem', () => {
  it('should format item with description on same line when term fits', () => {
    const result = formatItem('-v', 'verbose output', 20, 2, 2, 80);
    expect(result).toBe('  -v                    verbose output');
  });

  it('should format item with description on next line when term is long', () => {
    const result = formatItem('--very-long-option-name-here', 'desc', 10, 2, 2, 80);
    expect(result).toContain('--very-long-option-name-here');
    expect(result).toContain('\n');
    expect(result).toContain('desc');
  });

  it('should format item without description', () => {
    const result = formatItem('--flag', '', 20, 2, 2, 80);
    expect(result).toBe('  --flag');
  });

  it('should format term with description when term fits within width', () => {
    const result = formatItem('--flag', 'Description text', 20, 2, 2, 80);
    expect(result).toBe('  --flag                Description text');
  });

  it('should wrap description to next line when term exceeds width', () => {
    const result = formatItem('--very-long-flag-name-that-exceeds-width', 'Description', 10, 2, 2, 80);
    expect(result).toContain('--very-long-flag-name-that-exceeds-width\n');
    expect(result).toContain('Description');
  });
});

describe('parseModelMultipliersCli', () => {
  it('returns empty object for undefined input', () => {
    const result = parseModelMultipliersCli(undefined);
    expect('multipliers' in result).toBe(true);
    if ('multipliers' in result) expect(result.multipliers).toEqual({});
  });

  it('returns empty object for empty string', () => {
    const result = parseModelMultipliersCli('');
    expect('multipliers' in result).toBe(true);
    if ('multipliers' in result) expect(result.multipliers).toEqual({});
  });

  it('parses a single model:multiplier pair', () => {
    const result = parseModelMultipliersCli('claude-opus-4-5-1m:10');
    expect('multipliers' in result).toBe(true);
    if ('multipliers' in result) {
      expect(result.multipliers).toEqual({ 'claude-opus-4-5-1m': 10 });
    }
  });

  it('parses multiple model:multiplier pairs', () => {
    const result = parseModelMultipliersCli('claude-opus-4-5-200k:2.5,claude-opus-4-5-1m:10,gpt-4o-mini:0.5');
    expect('multipliers' in result).toBe(true);
    if ('multipliers' in result) {
      expect(result.multipliers).toEqual({
        'claude-opus-4-5-200k': 2.5,
        'claude-opus-4-5-1m': 10,
        'gpt-4o-mini': 0.5,
      });
    }
  });

  it('uses the last colon as separator (model names may contain colons)', () => {
    // e.g. namespaced model IDs
    const result = parseModelMultipliersCli('provider:model:3');
    expect('multipliers' in result).toBe(true);
    if ('multipliers' in result) {
      expect(result.multipliers).toEqual({ 'provider:model': 3 });
    }
  });

  it('returns error for entry without a colon', () => {
    const result = parseModelMultipliersCli('gpt-4o');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('--max-model-multiplier');
      expect(result.error).toContain('gpt-4o');
    }
  });

  it('returns error for non-numeric multiplier', () => {
    const result = parseModelMultipliersCli('gpt-4o:fast');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('positive number');
    }
  });

  it('returns error for zero multiplier', () => {
    const result = parseModelMultipliersCli('gpt-4o:0');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('positive number');
    }
  });

  it('returns error for negative multiplier', () => {
    const result = parseModelMultipliersCli('gpt-4o:-1');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('positive number');
    }
  });

  it('ignores surrounding whitespace in entries', () => {
    const result = parseModelMultipliersCli(' gpt-4o : 2 ');
    // Note: the key is trimmed, so 'gpt-4o ' might fail - let's check actual behavior
    // The parser does entry.slice(0, lastColon).trim()
    expect('multipliers' in result).toBe(true);
    if ('multipliers' in result) {
      expect(result.multipliers['gpt-4o']).toBe(2);
    }
  });
});
