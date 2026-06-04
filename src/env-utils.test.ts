import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WrapperConfig } from './types';
import { getConfigEnvValue, getLowerCaseProcessEnvValue, pickEnvVars } from './env-utils';

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
