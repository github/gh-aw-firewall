const AUDIT_ARCH_X86_64 = 0xc000003e;
export const X32_SYSCALL_BIT = 0x40000000;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050001;
const SECCOMP_RET_ALLOW = 0x7fff0000;
export const DENIED_X86_64_SYSCALLS = [
  105, // setuid
  106, // setgid
  113, // setreuid
  114, // setregid
  116, // setgroups
  117, // setresuid
  119, // setresgid
  101, // ptrace
  155, // pivot_root
  163, // acct
  165, // mount
  166, // umount2
  167, // swapon
  168, // swapoff
  169, // reboot
  172, // iopl
  173, // ioperm
  175, // init_module
  176, // delete_module
  179, // quotactl
  246, // kexec_load
  248, // add_key
  249, // request_key
  250, // keyctl
  272, // unshare
  298, // perf_event_open
  303, // name_to_handle_at
  304, // open_by_handle_at
  308, // setns
  310, // process_vm_readv
  311, // process_vm_writev
  313, // finit_module
  320, // kexec_file_load
  321, // bpf
  323, // userfaultfd
  429, // move_mount
  430, // fsopen
  431, // fsconfig
  432, // fsmount
  433, // fspick
  442, // mount_setattr
] as const;

export function buildOpenvmmSeccompFilter(allowCallerMount = false): Buffer {
  const instructions: Array<readonly [number, number, number, number]> = [
    [0x20, 0, 0, 4],
    [0x15, 1, 0, AUDIT_ARCH_X86_64],
    [0x06, 0, 0, SECCOMP_RET_KILL_PROCESS],
    [0x20, 0, 0, 0],
    [0x45, 0, 1, X32_SYSCALL_BIT],
    [0x06, 0, 0, SECCOMP_RET_ERRNO_EPERM],
  ];
  const deniedSyscalls = allowCallerMount
    ? DENIED_X86_64_SYSCALLS
    : [...DENIED_X86_64_SYSCALLS, 122, 123];
  for (const syscall of deniedSyscalls) {
    instructions.push(
      [0x15, 0, 1, syscall],
      [0x06, 0, 0, SECCOMP_RET_ERRNO_EPERM],
    );
  }
  instructions.push([0x06, 0, 0, SECCOMP_RET_ALLOW]);
  const filter = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jumpTrue, jumpFalse, value], index) => {
    const offset = index * 8;
    filter.writeUInt16LE(code, offset);
    filter.writeUInt8(jumpTrue, offset + 2);
    filter.writeUInt8(jumpFalse, offset + 3);
    filter.writeUInt32LE(value, offset + 4);
  });
  return filter;
}
