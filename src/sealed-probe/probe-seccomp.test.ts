import * as fs from 'fs';
import * as path from 'path';

/**
 * Invariants for the probe sandbox seccomp profile.
 *
 * `containers/sealed-probe/probe-seccomp.json` is derived from the agent
 * profile minus the syscalls a stdlib-only python3 probe never needs. These
 * assertions keep the derivation honest if either profile is regenerated.
 */

const CONTAINERS = path.join(__dirname, '..', '..', 'containers');

interface SeccompProfile {
  defaultAction: string;
  architectures: string[];
  syscalls: Array<{ names: string[]; action: string }>;
}

function load(file: string): SeccompProfile {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SeccompProfile;
}

const probeProfile = load(path.join(CONTAINERS, 'sealed-probe', 'probe-seccomp.json'));
const agentProfile = load(path.join(CONTAINERS, 'agent', 'seccomp-profile.json'));

function allowedNames(profile: SeccompProfile): Set<string> {
  const names = new Set<string>();
  for (const block of profile.syscalls) {
    if (block.action !== 'SCMP_ACT_ALLOW') continue;
    for (const name of block.names) names.add(name);
  }
  return names;
}

describe('probe seccomp profile', () => {
  it('denies by default', () => {
    expect(probeProfile.defaultAction).toBe('SCMP_ACT_ERRNO');
  });

  it('covers the same architectures as the agent profile', () => {
    expect(probeProfile.architectures).toEqual(agentProfile.architectures);
  });

  it('allows no syscall the agent profile does not already allow', () => {
    const agentAllowed = allowedNames(agentProfile);
    const extra = [...allowedNames(probeProfile)].filter((name) => !agentAllowed.has(name));
    expect(extra).toEqual([]);
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
    expect(allowedNames(probeProfile).has(syscall)).toBe(false);
  });

  it('explicitly denies those syscalls in addition to the default action', () => {
    const denied = new Set(
      probeProfile.syscalls
        .filter((block) => block.action === 'SCMP_ACT_ERRNO')
        .flatMap((block) => block.names),
    );
    expect(denied.has('chroot')).toBe(true);
    expect(denied.has('ptrace')).toBe(true);
    expect(denied.has('open_by_handle_at')).toBe(true);
  });

  it('still allows the syscalls a python3 interpreter needs to start and read files', () => {
    const allowed = allowedNames(probeProfile);
    for (const syscall of ['execve', 'openat', 'read', 'write', 'mmap', 'brk', 'getdents64', 'exit_group']) {
      expect(allowed.has(syscall)).toBe(true);
    }
  });
});
