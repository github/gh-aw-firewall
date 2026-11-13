import { resolveTemporaryVmmAclUids } from './vmm-identity';
import { tools } from './vmm-identity.test-utils';

describe('temporary VMM ACL identity classification', () => {
  const entry = ['user::rw-', 'user:2001:rw-', 'group::rw-', 'mask::rw-', 'other::---'];

  it('ignores similarly prefixed accounts that are not exact AWF VMM identities', async () => {
    const run = jest.fn().mockResolvedValue({
      stdout: 'awfvmm-backup:x:2001:2002:AWF Cloud Hypervisor backup:' +
        '/nonexistent:/usr/sbin/nologin\n',
      stderr: '',
    });

    await expect(resolveTemporaryVmmAclUids(entry, tools, run)).resolves.toEqual([]);
  });

  it.each([
    ['returned not found', async () => ({ exitCode: 2, stdout: '', stderr: '' })],
    ['threw not found', async () => {
      throw Object.assign(new Error('missing'), { exitCode: 2 });
    }],
  ])('ignores an ACL uid whose passwd lookup %s', async (_name, run) => {
    await expect(resolveTemporaryVmmAclUids(entry, tools, run)).resolves.toEqual([]);
  });

  it.each([
    ['returns an error', async () => ({ exitCode: 1, stdout: '', stderr: 'denied' })],
    ['throws an error', async () => {
      throw new Error('lookup failed');
    }],
  ])('fails closed when passwd lookup %s', async (_name, run) => {
    await expect(resolveTemporaryVmmAclUids(entry, tools, run)).rejects.toThrow(
      /denied|lookup failed/,
    );
  });

  it('rejects an exact VMM account whose numeric passwd identity changed', async () => {
    const run = jest.fn().mockResolvedValue({
      stdout: 'awfvmm-0123456789abcdef0123:x:2002:2003:' +
        'AWF Cloud Hypervisor run:/nonexistent:/usr/sbin/nologin\n',
      stderr: '',
    });

    await expect(resolveTemporaryVmmAclUids(entry, tools, run))
      .rejects.toThrow(/account uid changed/);
  });

  it('fails closed when exact VMM account validation fails', async () => {
    const name = 'awfvmm-0123456789abcdef0123';
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (command === tools.getent && args[1] === '2001') {
        return {
          stdout: `${name}:x:2001:2002:invalid:/nonexistent:/usr/sbin/nologin\n`,
          stderr: '',
        };
      }
      if (command === tools.id && args[0] === '-u') {
        return { exitCode: 1, stdout: '', stderr: 'id denied' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(resolveTemporaryVmmAclUids(entry, tools, run))
      .rejects.toThrow(/id denied/);
  });

  it('rejects an exact VMM account without the AWF comment marker', async () => {
    const name = 'awfvmm-0123456789abcdef0123';
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (command === tools.getent) {
        return {
          stdout: `${name}:x:2001:2002:invalid:/nonexistent:/usr/sbin/nologin\n`,
          stderr: '',
        };
      }
      if (command === tools.id && args[0] === '-u') return { stdout: '2001\n', stderr: '' };
      if (command === tools.id && args[0] === '-g') return { stdout: '2002\n', stderr: '' };
      if (command === tools.id && args[0] === '-G') return { stdout: '2002\n', stderr: '' };
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(resolveTemporaryVmmAclUids(entry, tools, run))
      .rejects.toThrow(/unsafe passwd state/);
  });

  it('rejects an exact VMM account whose resolved uid differs from its ACL uid', async () => {
    const name = 'awfvmm-0123456789abcdef0123';
    const run = jest.fn(async (command: string, args: readonly string[]) => {
      if (command === tools.getent && args[1] === '2001') {
        return {
          stdout: `${name}:x:2001:2002:AWF Cloud Hypervisor run:` +
            '/nonexistent:/usr/sbin/nologin\n',
          stderr: '',
        };
      }
      if (command === tools.id && args[0] === '-u') {
        return { stdout: '2002\n', stderr: '' };
      }
      if (command === tools.id && args[0] === '-g') {
        return { stdout: '2003\n', stderr: '' };
      }
      if (command === tools.id && args[0] === '-G') {
        return { stdout: '2003\n', stderr: '' };
      }
      if (command === tools.getent && args[1] === name) {
        return {
          stdout: `${name}:x:2002:2003:AWF Cloud Hypervisor run:` +
            '/nonexistent:/usr/sbin/nologin\n',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(resolveTemporaryVmmAclUids(entry, tools, run))
      .rejects.toThrow(/account uid changed/);
  });

  it('does not classify similarly prefixed non-AWF accounts as temporary VMM identities', async () => {
    const run = jest.fn(async () => ({
      stdout: 'awfvmm-backup:x:23003:23002:AWF Cloud Hypervisor:/nonexistent:/usr/sbin/nologin\n',
      stderr: '',
    }));

    await expect(resolveTemporaryVmmAclUids(
      ['user:23003:rw-'],
      tools,
      run,
    )).resolves.toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
