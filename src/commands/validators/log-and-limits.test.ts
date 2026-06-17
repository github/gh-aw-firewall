/**
 * Tests for log-and-limits.ts – validateLogAndLimits function.
 * Covers validation success paths and all error branches.
 */

jest.mock('../../logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    setLevel: jest.fn(),
  },
}));

jest.mock('../../api-proxy-config', () => ({
  validateAnthropicCacheTailTtl: jest.fn(),
}));

// parseMemoryLimit crashes on undefined input (pre-existing behaviour); mock it
// so tests can control the success/error return independently of memoryLimit.
jest.mock('../../option-parsers', () => {
  const actual = jest.requireActual<typeof import('../../option-parsers')>('../../option-parsers');
  return {
    ...actual,
    parseMemoryLimit: jest.fn().mockReturnValue({ value: '6g' }),
  };
});

// processAgentImageOption is mocked to decouple agentImage validation from tests
// that don't need it; individual tests override this as needed.
jest.mock('../../domain-utils', () => {
  const actual = jest.requireActual<typeof import('../../domain-utils')>('../../domain-utils');
  return {
    ...actual,
    processAgentImageOption: jest.fn().mockReturnValue({ agentImage: 'default', isPreset: true }),
  };
});

import { validateLogAndLimits } from './log-and-limits';
import { logger } from '../../logger';
import { parseMemoryLimit } from '../../option-parsers';
import { processAgentImageOption } from '../../domain-utils';

function minimalOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    logLevel: 'info',
    buildLocal: false,
    agentImage: undefined,
    ...overrides,
  };
}

function spyExit(): jest.SpyInstance {
  return jest.spyOn(process, 'exit').mockImplementation((_code?: string | number | null | undefined) => {
    throw new Error('process.exit called');
  });
}

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  (parseMemoryLimit as jest.Mock).mockReturnValue({ value: undefined });
  (processAgentImageOption as jest.Mock).mockReturnValue({ agentImage: 'default', isPreset: true });
});

describe('validateLogAndLimits – success paths', () => {
  it('returns defaults for a minimal valid options object', () => {
    const result = validateLogAndLimits(minimalOptions());
    expect(result.logLevel).toBe('info');
    expect(result.maxEffectiveTokens).toBeUndefined();
    expect(result.maxRuns).toBeUndefined();
    expect(result.memoryLimit).toBeUndefined();
    expect(result.agentImage).toBe('default');
  });

  it('accepts all four valid log levels', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const result = validateLogAndLimits(minimalOptions({ logLevel: level }));
      expect(result.logLevel).toBe(level);
    }
  });

  it('returns valid maxEffectiveTokens as a number', () => {
    const result = validateLogAndLimits(minimalOptions({ maxEffectiveTokens: '1000' }));
    expect(result.maxEffectiveTokens).toBe(1000);
  });

  it('returns valid maxRuns as a number', () => {
    const result = validateLogAndLimits(minimalOptions({ maxRuns: 5 }));
    expect(result.maxRuns).toBe(5);
  });

  it('merges configFile and CLI model multipliers, CLI takes precedence', () => {
    const result = validateLogAndLimits(minimalOptions({
      effectiveTokenModelMultipliers: { 'gpt-4': 2 },
      maxModelMultiplier: 'claude-3:3',
    }));
    expect(result.effectiveTokenModelMultipliers).toEqual({ 'gpt-4': 2, 'claude-3': 3 });
  });

  it('returns CLI-only multipliers when no config-file multipliers are present', () => {
    const result = validateLogAndLimits(minimalOptions({ maxModelMultiplier: 'gpt-4:1.5' }));
    expect(result.effectiveTokenModelMultipliers).toEqual({ 'gpt-4': 1.5 });
  });

  it('returns undefined effectiveTokenModelMultipliers when neither source is set', () => {
    const result = validateLogAndLimits(minimalOptions());
    expect(result.effectiveTokenModelMultipliers).toBeUndefined();
  });

  it('returns valid memoryLimit string', () => {
    (parseMemoryLimit as jest.Mock).mockReturnValue({ value: '2g' });
    const result = validateLogAndLimits(minimalOptions());
    expect(result.memoryLimit).toBe('2g');
  });

  it('logs info message for custom agent image with buildLocal', () => {
    (processAgentImageOption as jest.Mock).mockReturnValue({
      agentImage: 'ghcr.io/catthehacker/ubuntu:runner-22.04',
      isPreset: false,
      infoMessage: 'Using custom agent base image: ghcr.io/catthehacker/ubuntu:runner-22.04',
    });
    const result = validateLogAndLimits(minimalOptions({ buildLocal: true }));
    expect(result.agentImage).toBe('ghcr.io/catthehacker/ubuntu:runner-22.04');
    expect((logger.info as jest.Mock).mock.calls.some(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('ghcr.io/catthehacker/ubuntu:runner-22.04')
    )).toBe(true);
  });

  it('passes maxPermissionDenied through', () => {
    const result = validateLogAndLimits(minimalOptions({ maxPermissionDenied: 3 }));
    expect(result.maxPermissionDenied).toBe(3);
  });

  it('passes modelAliases through', () => {
    const aliases = { 'fast': ['gpt-3.5-turbo'] };
    const result = validateLogAndLimits(minimalOptions({ modelAliases: aliases }));
    expect(result.modelAliases).toEqual(aliases);
  });
});

describe('validateLogAndLimits – validation failures', () => {
  it('exits with code 1 for an invalid log level', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ logLevel: 'verbose' }))).toThrow('process.exit called');
  });

  it('exits when maxEffectiveTokens is not a positive integer (non-integer)', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ maxEffectiveTokens: '1.5' }))).toThrow('process.exit called');
  });

  it('exits when maxEffectiveTokens is zero', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ maxEffectiveTokens: 0 }))).toThrow('process.exit called');
  });

  it('exits when maxEffectiveTokens is negative', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ maxEffectiveTokens: -1 }))).toThrow('process.exit called');
  });

  it('exits when maxAiCredits is zero', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ maxAiCredits: 0 }))).toThrow('process.exit called');
  });

  it('exits when maxAiCredits is negative', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ maxAiCredits: -5 }))).toThrow('process.exit called');
  });

  it('exits when effectiveTokenDefaultModelMultiplier is zero', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ effectiveTokenDefaultModelMultiplier: 0 }))).toThrow('process.exit called');
  });

  it('exits when effectiveTokenDefaultModelMultiplier is negative', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ effectiveTokenDefaultModelMultiplier: -1 }))).toThrow('process.exit called');
  });

  it('exits when maxModelMultiplierCap is zero', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ maxModelMultiplierCap: 0 }))).toThrow('process.exit called');
  });

  it('exits when maxModelMultiplierCap is negative', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ maxModelMultiplierCap: -2 }))).toThrow('process.exit called');
  });

  it('exits when maxRuns is zero', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ maxRuns: 0 }))).toThrow('process.exit called');
  });

  it('exits when maxRuns is a float', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ maxRuns: '2.5' }))).toThrow('process.exit called');
  });

  it('exits when maxPermissionDenied is zero', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ maxPermissionDenied: 0 }))).toThrow('process.exit called');
  });

  it('exits when maxPermissionDenied is negative', () => {
    spyExit();
    expect(() => validateLogAndLimits(minimalOptions({ maxPermissionDenied: -1 }))).toThrow('process.exit called');
  });

  it('exits when maxModelMultiplier string is malformed', () => {
    spyExit();
    // Colons-only, no valid model:number format
    expect(() => validateLogAndLimits(minimalOptions({ maxModelMultiplier: 'not-valid-format:xyz' }))).toThrow('process.exit called');
  });

  it('exits when memoryLimit has an invalid format', () => {
    spyExit();
    (parseMemoryLimit as jest.Mock).mockReturnValue({ error: 'Invalid --memory-limit value "invalid-memory".' });
    expect(() => validateLogAndLimits(minimalOptions())).toThrow('process.exit called');
  });

  it('exits when a custom agentImage is given without --build-local', () => {
    spyExit();
    (processAgentImageOption as jest.Mock).mockReturnValue({
      agentImage: 'ghcr.io/catthehacker/ubuntu:runner-22.04',
      isPreset: false,
      requiresBuildLocal: true,
      error: '❌ Custom agent images require --build-local flag',
    });
    expect(() => validateLogAndLimits(minimalOptions({ buildLocal: false }))).toThrow('process.exit called');
  });
});
