import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WrapperConfig } from './types';
import { copyEnvEntries, getConfigEnvValue, getLowerCaseProcessEnvValue, pickEnvVars } from './env-utils';

function makeWrapperConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    agentCommand: 'echo test',
    allowedDomains: [],
    keepContainers: false,
    logLevel: 'info',
    workDir: '/tmp/env-utils-test',
    ...overrides,
  };
}

describe('pickEnvVars', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
  });

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  function setEnv(key: string, value: string | undefined): void {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }

  it('returns an empty object when no names are provided', () => {
    expect(pickEnvVars()).toEqual({});
  });

  it('returns an empty object when none of the named vars are set', () => {
    setEnv('TEST_PICK_A', undefined);
    setEnv('TEST_PICK_B', undefined);
    expect(pickEnvVars('TEST_PICK_A', 'TEST_PICK_B')).toEqual({});
  });

  it('includes vars that are set', () => {
    setEnv('TEST_PICK_A', 'hello');
    setEnv('TEST_PICK_B', undefined);
    setEnv('TEST_PICK_C', 'world');
    expect(pickEnvVars('TEST_PICK_A', 'TEST_PICK_B', 'TEST_PICK_C')).toEqual({
      TEST_PICK_A: 'hello',
      TEST_PICK_C: 'world',
    });
  });

  it('omits vars that are set to empty string', () => {
    setEnv('TEST_PICK_EMPTY', '');
    expect(pickEnvVars('TEST_PICK_EMPTY')).toEqual({});
  });

  it('preserves the exact value of each var', () => {
    setEnv('TEST_PICK_VAL', '  spaced value  ');
    expect(pickEnvVars('TEST_PICK_VAL')).toEqual({ TEST_PICK_VAL: '  spaced value  ' });
  });

  it('handles a single var', () => {
    setEnv('TEST_PICK_SINGLE', 'only-one');
    expect(pickEnvVars('TEST_PICK_SINGLE')).toEqual({ TEST_PICK_SINGLE: 'only-one' });
  });
});

describe('getConfigEnvValue', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.TEST_CONFIG_ENV_VALUE;
    delete process.env.TEST_CONFIG_ENV_VALUE;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.TEST_CONFIG_ENV_VALUE = savedEnv;
    } else {
      delete process.env.TEST_CONFIG_ENV_VALUE;
    }
  });

  it('prefers additionalEnv over envFile and process.env, trimming the result', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-utils-'));
    const envFilePath = path.join(tempDir, '.env');
    fs.writeFileSync(envFilePath, 'TEST_CONFIG_ENV_VALUE= from-file \n');
    process.env.TEST_CONFIG_ENV_VALUE = ' from-process ';

    try {
      const config = makeWrapperConfig({
        additionalEnv: { TEST_CONFIG_ENV_VALUE: ' from-additional ' },
        envAll: true,
        envFile: envFilePath,
      });

      expect(getConfigEnvValue(config, 'TEST_CONFIG_ENV_VALUE')).toBe('from-additional');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to process.env only when envAll is enabled and omits blank values', () => {
    process.env.TEST_CONFIG_ENV_VALUE = '   ';
    const config = makeWrapperConfig({ envAll: true });
    expect(getConfigEnvValue(config, 'TEST_CONFIG_ENV_VALUE')).toBeUndefined();

    process.env.TEST_CONFIG_ENV_VALUE = ' from-process ';
    expect(getConfigEnvValue(config, 'TEST_CONFIG_ENV_VALUE')).toBe('from-process');
    expect(getConfigEnvValue(makeWrapperConfig({ envAll: false }), 'TEST_CONFIG_ENV_VALUE')).toBeUndefined();
  });
});

describe('getLowerCaseProcessEnvValue', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.TEST_LOWERCASE_ENV_VALUE;
    delete process.env.TEST_LOWERCASE_ENV_VALUE;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.TEST_LOWERCASE_ENV_VALUE = savedEnv;
    } else {
      delete process.env.TEST_LOWERCASE_ENV_VALUE;
    }
  });

  it('trims and lowercases process env values', () => {
    process.env.TEST_LOWERCASE_ENV_VALUE = '  GitHub-OIDC ';
    expect(getLowerCaseProcessEnvValue('TEST_LOWERCASE_ENV_VALUE')).toBe('github-oidc');
  });

  it('returns undefined for blank process env values', () => {
    process.env.TEST_LOWERCASE_ENV_VALUE = '   ';
    expect(getLowerCaseProcessEnvValue('TEST_LOWERCASE_ENV_VALUE')).toBeUndefined();
  });
});

describe('copyEnvEntries', () => {
  it('copies all defined entries from source to target', () => {
    const source: Record<string, string | undefined> = { A: 'a', B: 'b' };
    const target: Record<string, string> = {};
    copyEnvEntries(source, target);
    expect(target).toEqual({ A: 'a', B: 'b' });
  });

  it('skips entries with undefined values', () => {
    const source: Record<string, string | undefined> = { A: 'a', B: undefined };
    const target: Record<string, string> = {};
    copyEnvEntries(source, target);
    expect(target).toEqual({ A: 'a' });
  });

  it('skips keys in excludedKeys', () => {
    const source: Record<string, string | undefined> = { A: 'a', B: 'b', C: 'c' };
    const target: Record<string, string> = {};
    copyEnvEntries(source, target, { excludedKeys: new Set(['B']) });
    expect(target).toEqual({ A: 'a', C: 'c' });
  });

  it('allows keys in allowKeys even when they are also in excludedKeys', () => {
    const source: Record<string, string | undefined> = { A: 'a', B: 'b' };
    const target: Record<string, string> = {};
    copyEnvEntries(source, target, {
      excludedKeys: new Set(['A', 'B']),
      allowKeys: new Set(['B']),
    });
    expect(target).toEqual({ B: 'b' });
  });

  it('does not overwrite existing keys when noOverwrite is true', () => {
    const source: Record<string, string | undefined> = { A: 'new', B: 'new' };
    const target: Record<string, string> = { A: 'original' };
    copyEnvEntries(source, target, { noOverwrite: true });
    expect(target).toEqual({ A: 'original', B: 'new' });
  });

  it('overwrites existing keys when noOverwrite is false (default)', () => {
    const source: Record<string, string | undefined> = { A: 'new' };
    const target: Record<string, string> = { A: 'original' };
    copyEnvEntries(source, target);
    expect(target).toEqual({ A: 'new' });
  });

  it('only copies keys matching keyPredicate', () => {
    const source: Record<string, string | undefined> = { OTEL_FOO: 'x', OTHER: 'y' };
    const target: Record<string, string> = {};
    copyEnvEntries(source, target, { keyPredicate: (k) => k.startsWith('OTEL_') });
    expect(target).toEqual({ OTEL_FOO: 'x' });
  });

  it('skips entries exceeding maxValueSizeBytes and calls onSkippedOversized', () => {
    const bigValue = 'x'.repeat(200);
    const source: Record<string, string | undefined> = { SMALL: 'hi', BIG: bigValue };
    const target: Record<string, string> = {};
    const skipped: Array<{ key: string; sizeBytes: number }> = [];
    copyEnvEntries(source, target, {
      maxValueSizeBytes: 10,
      onSkippedOversized: (key, sizeBytes) => skipped.push({ key, sizeBytes }),
    });
    expect(target).toEqual({ SMALL: 'hi' });
    expect(skipped).toHaveLength(1);
    expect(skipped[0].key).toBe('BIG');
    expect(skipped[0].sizeBytes).toBe(200);
  });

  it('copies entries at exactly maxValueSizeBytes (boundary is exclusive)', () => {
    const value = 'x'.repeat(10);
    const source: Record<string, string | undefined> = { V: value };
    const target: Record<string, string> = {};
    copyEnvEntries(source, target, { maxValueSizeBytes: 10 });
    expect(target).toEqual({ V: value });
  });

  it('skips entries one byte over maxValueSizeBytes', () => {
    const value = 'x'.repeat(11);
    const source: Record<string, string | undefined> = { V: value };
    const target: Record<string, string> = {};
    copyEnvEntries(source, target, { maxValueSizeBytes: 10 });
    expect(target).toEqual({});
  });

  it('applies all filters together', () => {
    const source: Record<string, string | undefined> = {
      OTEL_KEEP: 'ok',
      OTEL_EXCLUDED: 'no',
      OTEL_BIG: 'x'.repeat(200),
      OTEL_EXISTING: 'old',
      OTHER: 'ignored',
    };
    const target: Record<string, string> = { OTEL_EXISTING: 'original' };
    const skipped: string[] = [];
    copyEnvEntries(source, target, {
      excludedKeys: new Set(['OTEL_EXCLUDED']),
      noOverwrite: true,
      keyPredicate: (k) => k.startsWith('OTEL_'),
      maxValueSizeBytes: 10,
      onSkippedOversized: (key) => skipped.push(key),
    });
    expect(target).toEqual({ OTEL_EXISTING: 'original', OTEL_KEEP: 'ok' });
    expect(skipped).toEqual(['OTEL_BIG']);
  });
});
