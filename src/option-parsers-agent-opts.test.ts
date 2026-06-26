import { Command } from 'commander';
import {
  parseMemoryLimit,
  applyAgentTimeout,
  collectRulesetFile,
  collectStringArray,
  formatItem,
  parseModelMultipliersCli,
} from './option-parsers';

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

describe('collectStringArray', () => {
  it('should accumulate multiple values into an array', () => {
    let result = collectStringArray('mcp-gateway');
    result = collectStringArray('difc-proxy', result);
    expect(result).toEqual(['mcp-gateway', 'difc-proxy']);
  });

  it('should default to empty array when no previous values', () => {
    expect(collectStringArray('first')).toEqual(['first']);
  });

  it('should work with Commander repeatable option parsing', () => {
    const testProgram = new Command();
    testProgram
      .option('--topology-attach <name>', 'attach container', collectStringArray, [])
      .action(() => {});

    testProgram.parse(['node', 'awf', '--topology-attach', 'a', '--topology-attach', 'b'], { from: 'node' });
    expect(testProgram.opts().topologyAttach).toEqual(['a', 'b']);
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
