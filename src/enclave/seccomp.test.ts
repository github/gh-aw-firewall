import * as fs from 'fs';
import * as path from 'path';

const CONTAINERS = path.join(__dirname, '..', '..', 'containers');

interface SeccompProfile {
  defaultAction: string;
  architectures: string[];
  syscalls: Array<{ names: string[]; action: string }>;
}

function load(file: string): SeccompProfile {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SeccompProfile;
}

function allowedNames(profile: SeccompProfile): Set<string> {
  return new Set(
    profile.syscalls
      .filter((block) => block.action === 'SCMP_ACT_ALLOW')
      .flatMap((block) => block.names),
  );
}

describe('enclave seccomp profile', () => {
  const enclaveProfile = load(path.join(CONTAINERS, 'enclave', 'seccomp.json'));
  const agentProfile = load(path.join(CONTAINERS, 'agent', 'seccomp-profile.json'));

  it('denies by default and covers the supported architectures', () => {
    expect(enclaveProfile.defaultAction).toBe('SCMP_ACT_ERRNO');
    expect(enclaveProfile.architectures).toEqual(agentProfile.architectures);
  });

  it('allows no syscall excluded by the primary-agent profile', () => {
    const agentAllowed = allowedNames(agentProfile);
    expect([...allowedNames(enclaveProfile)].filter((name) => !agentAllowed.has(name))).toEqual([]);
  });

  it.each([
    'chroot',
    'mount',
    'umount2',
    'pivot_root',
    'unshare',
    'setns',
    'ptrace',
    'process_vm_readv',
    'process_vm_writev',
    'bpf',
    'perf_event_open',
    'init_module',
    'finit_module',
    'delete_module',
    'kexec_load',
    'reboot',
    'add_key',
    'request_key',
    'keyctl',
    'mknod',
    'mknodat',
    'name_to_handle_at',
    'open_by_handle_at',
    'userfaultfd',
  ])('never allows %s', (syscall) => {
    expect(allowedNames(enclaveProfile).has(syscall)).toBe(false);
  });

  it('retains the syscalls needed by Python and Node executors', () => {
    const allowed = allowedNames(enclaveProfile);
    for (const syscall of ['execve', 'openat', 'read', 'write', 'mmap', 'brk', 'getdents64', 'exit_group']) {
      expect(allowed.has(syscall)).toBe(true);
    }
  });
});
