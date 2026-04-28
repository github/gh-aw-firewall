import * as fs from 'fs';
import * as path from 'path';

interface SeccompRule {
  names: string[];
  action: string;
  errnoRet?: number;
  comment?: string;
  args?: unknown[];
}

interface SeccompProfile {
  defaultAction: string;
  architectures: string[];
  syscalls: SeccompRule[];
}

describe('seccomp-profile', () => {
  let profile: SeccompProfile;

  beforeAll(() => {
    const profilePath = path.join(__dirname, '..', 'containers', 'agent', 'seccomp-profile.json');
    const content = fs.readFileSync(profilePath, 'utf-8');
    profile = JSON.parse(content);
  });

  test('should use deny-by-default action', () => {
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  });

  test('should support x86_64, x86, and aarch64 architectures', () => {
    expect(profile.architectures).toContain('SCMP_ARCH_X86_64');
    expect(profile.architectures).toContain('SCMP_ARCH_X86');
    expect(profile.architectures).toContain('SCMP_ARCH_AARCH64');
  });

  test('should have an explicit allowlist of standard syscalls', () => {
    const allowRules = profile.syscalls.filter(r => r.action === 'SCMP_ACT_ALLOW');
    expect(allowRules.length).toBeGreaterThan(0);

    const allowedSyscalls = allowRules.flatMap(r => r.names);

    // Essential syscalls that must be allowed for any workload
    const essentialSyscalls = [
      'read', 'write', 'open', 'openat', 'close', 'stat', 'fstat',
      'mmap', 'mprotect', 'munmap', 'brk', 'execve', 'fork', 'clone',
      'exit_group', 'getpid', 'getuid', 'socket', 'connect', 'bind',
      'listen', 'accept', 'sendto', 'recvfrom', 'pipe', 'dup2',
      'kill', 'wait4', 'mkdir', 'rmdir', 'unlink', 'chmod', 'chown',
    ];

    for (const syscall of essentialSyscalls) {
      expect(allowedSyscalls).toContain(syscall);
    }
  });

  test('should allow mount syscall (needed for procfs setup before capability drop)', () => {
    const allowedSyscalls = profile.syscalls
      .filter(r => r.action === 'SCMP_ACT_ALLOW')
      .flatMap(r => r.names);
    expect(allowedSyscalls).toContain('mount');
  });

  test('should allow chroot syscall (needed for chroot mode)', () => {
    const allowedSyscalls = profile.syscalls
      .filter(r => r.action === 'SCMP_ACT_ALLOW')
      .flatMap(r => r.names);
    expect(allowedSyscalls).toContain('chroot');
  });

  test('should explicitly block dangerous syscalls', () => {
    const denyRules = profile.syscalls.filter(r => r.action === 'SCMP_ACT_ERRNO');
    const blockedSyscalls = denyRules.flatMap(r => r.names);

    const dangerousSyscalls = [
      'ptrace', 'process_vm_readv', 'process_vm_writev',
      'kexec_load', 'kexec_file_load', 'reboot',
      'init_module', 'finit_module', 'delete_module',
      'pivot_root', 'umount', 'umount2',
      'swapon', 'swapoff', 'syslog',
      'add_key', 'request_key', 'keyctl',
      'name_to_handle_at', 'open_by_handle_at',
    ];

    for (const syscall of dangerousSyscalls) {
      expect(blockedSyscalls).toContain(syscall);
    }
  });

  test('should return EPERM (errno 1) for blocked syscalls', () => {
    const denyRules = profile.syscalls.filter(r => r.action === 'SCMP_ACT_ERRNO');
    for (const rule of denyRules) {
      expect(rule.errnoRet).toBe(1);
    }
  });

  test('should not have any duplicate syscall names across all rules', () => {
    const seen = new Map<string, string>();
    for (const rule of profile.syscalls) {
      for (const name of rule.names) {
        if (seen.has(name)) {
          fail(`Duplicate syscall "${name}" found in rules with actions: ${seen.get(name)} and ${rule.action}`);
        }
        seen.set(name, rule.action);
      }
    }
  });

  test('should not allow dangerous syscalls that are also in deny rules', () => {
    const allowedSyscalls = new Set(
      profile.syscalls
        .filter(r => r.action === 'SCMP_ACT_ALLOW')
        .flatMap(r => r.names)
    );

    const blockedSyscalls = profile.syscalls
      .filter(r => r.action === 'SCMP_ACT_ERRNO')
      .flatMap(r => r.names);

    for (const blocked of blockedSyscalls) {
      expect(allowedSyscalls.has(blocked)).toBe(false);
    }
  });

  test('should block Shocker container-escape syscalls (CVE-2014-9357)', () => {
    const allowedSyscalls = new Set(
      profile.syscalls
        .filter(r => r.action === 'SCMP_ACT_ALLOW')
        .flatMap(r => r.names)
    );

    const blockedSyscalls = profile.syscalls
      .filter(r => r.action === 'SCMP_ACT_ERRNO')
      .flatMap(r => r.names);

    // Both syscalls must be explicitly denied, not just absent from allow list
    expect(blockedSyscalls).toContain('name_to_handle_at');
    expect(blockedSyscalls).toContain('open_by_handle_at');
    expect(allowedSyscalls.has('name_to_handle_at')).toBe(false);
    expect(allowedSyscalls.has('open_by_handle_at')).toBe(false);
  });

  test('should have valid JSON structure', () => {
    expect(profile.defaultAction).toBeDefined();
    expect(profile.architectures).toBeDefined();
    expect(Array.isArray(profile.architectures)).toBe(true);
    expect(profile.syscalls).toBeDefined();
    expect(Array.isArray(profile.syscalls)).toBe(true);

    for (const rule of profile.syscalls) {
      expect(rule.names).toBeDefined();
      expect(Array.isArray(rule.names)).toBe(true);
      expect(rule.names.length).toBeGreaterThan(0);
      expect(['SCMP_ACT_ALLOW', 'SCMP_ACT_ERRNO', 'SCMP_ACT_LOG', 'SCMP_ACT_KILL']).toContain(rule.action);
    }
  });

  test('should allow networking syscalls needed by iptables setup', () => {
    const allowedSyscalls = profile.syscalls
      .filter(r => r.action === 'SCMP_ACT_ALLOW')
      .flatMap(r => r.names);

    const iptablesSyscalls = [
      'socket', 'connect', 'bind', 'getsockopt', 'setsockopt',
      'sendto', 'recvfrom', 'sendmsg', 'recvmsg',
    ];

    for (const syscall of iptablesSyscalls) {
      expect(allowedSyscalls).toContain(syscall);
    }
  });

  test('should allow io_uring syscalls needed by modern runtimes', () => {
    const allowedSyscalls = profile.syscalls
      .filter(r => r.action === 'SCMP_ACT_ALLOW')
      .flatMap(r => r.names);

    expect(allowedSyscalls).toContain('io_uring_setup');
    expect(allowedSyscalls).toContain('io_uring_enter');
    expect(allowedSyscalls).toContain('io_uring_register');
  });
});
