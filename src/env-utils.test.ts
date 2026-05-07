import { pickEnvVars } from './env-utils';

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
