import { resolveAndValidateVmmAccount } from './vmm-account-validation';

function parsePositiveInteger(value: string, label: string): number {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`invalid ${label}: ${trimmed}`);
  }
  return Number(trimmed);
}

function makeRun(overrides: Record<string, { stdout: string; stderr: string }> = {}) {
  const defaults: Record<string, { stdout: string; stderr: string }> = {
    'id -u': { stdout: '23001\n', stderr: '' },
    'id -g': { stdout: '23002\n', stderr: '' },
    'id -G': { stdout: '23002\n', stderr: '' },
    'getent passwd': {
      stdout: 'name:x:23001:23002:AWF:/nonexistent:/usr/sbin/nologin\n',
      stderr: '',
    },
  };
  const responses = { ...defaults, ...overrides };
  return jest.fn(async (command: string, args: readonly string[]) => {
    const key = command === 'getent' ? `getent ${args[0]}` : `id ${args[0]}`;
    return responses[key];
  });
}

describe('resolveAndValidateVmmAccount', () => {
  const tools = { id: 'id', getent: 'getent' };

  it('resolves a well-formed account', async () => {
    const run = makeRun();
    await expect(resolveAndValidateVmmAccount({
      name: 'name',
      accountLabel: 'Test VMM',
      tools,
      run,
      parsePositiveInteger,
    })).resolves.toEqual({ name: 'name', uid: 23001, gid: 23002 });
  });

  it('rejects inherited supplementary groups', async () => {
    const run = makeRun({ 'id -G': { stdout: '23002 27\n', stderr: '' } });
    await expect(resolveAndValidateVmmAccount({
      name: 'name',
      accountLabel: 'Test VMM',
      tools,
      run,
      parsePositiveInteger,
    })).rejects.toThrow(/Test VMM account name inherited supplementary groups: 23002 27/);
  });

  it('rejects unsafe passwd state', async () => {
    const run = makeRun({
      'getent passwd': { stdout: 'name:x:23001:23002:AWF:/home/unsafe:/bin/bash\n', stderr: '' },
    });
    await expect(resolveAndValidateVmmAccount({
      name: 'name',
      accountLabel: 'Test VMM',
      tools,
      run,
      parsePositiveInteger,
    })).rejects.toThrow(/Test VMM account name has unsafe passwd state/);
  });

  it('applies a caller-supplied extra passwd assertion', async () => {
    const run = makeRun();
    await expect(resolveAndValidateVmmAccount({
      name: 'name',
      accountLabel: 'Test VMM',
      tools,
      run,
      parsePositiveInteger,
      assertPasswdState: () => {
        throw new Error('extra assertion failed');
      },
    })).rejects.toThrow(/Test VMM account name has unsafe passwd state/);
  });

  it('accepts an extra passwd assertion that passes', async () => {
    const run = makeRun();
    await expect(resolveAndValidateVmmAccount({
      name: 'name',
      accountLabel: 'Test VMM',
      tools,
      run,
      parsePositiveInteger,
      assertPasswdState: (passwd, identity) => {
        expect(passwd[0]).toBe('name');
        expect(identity).toEqual({ uid: 23001, gid: 23002 });
      },
    })).resolves.toEqual({ name: 'name', uid: 23001, gid: 23002 });
  });
});
