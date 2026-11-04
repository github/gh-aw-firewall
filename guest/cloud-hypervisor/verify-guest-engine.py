#!/usr/bin/env python3
"""Build-only engine probe; launched as PID 1 by the builder's private unshare."""

import ctypes
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys


ENGINES = ("copilot", "codex", "claude")
UID = GID = 65534
LIBC = ctypes.CDLL(None, use_errno=True)
ENVIRONMENT = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/home/awf-enclave",
    "TMPDIR": "/tmp",
    "XDG_CACHE_HOME": "/home/awf-enclave/.cache",
    "XDG_CONFIG_HOME": "/home/awf-enclave/.config",
    "COPILOT_CLI_DIST_DIR": "/usr/local/lib/node_modules/@github/copilot/runtime",
    "COPILOT_OFFLINE": "true",
    "LANG": "C.UTF-8",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def validate_tree(tree):
    tree = Path(tree).resolve(strict=True)
    require(tree != Path("/"), "refusing to verify the host root")
    require(tree.is_dir(), "verification root must be a directory")
    metadata = tree.stat()
    require(metadata.st_uid == 0 and not metadata.st_mode & 0o022,
            "verification root must be root-owned and not group/world writable")
    for relative in ("proc", "tmp", "dev", "dev/shm", "home", "home/awf-enclave"):
        target = tree / relative
        require(target.resolve(strict=True) == target and target.is_dir(),
                f"verification mount target is not a real directory: {relative}")
    # Never package or later recursively remove a tree with pre-existing mounts.
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        target = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), line.split()[4])
        require(target != str(tree) and not target.startswith(str(tree) + "/"),
                f"verification root already contains a mount: {target}")
    return tree


def mount(*arguments):
    subprocess.run(["/usr/bin/mount", *map(str, arguments)], check=True,
                   stdin=subprocess.DEVNULL, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})


def prepare_mounts(tree):
    mount("--make-rprivate", "/")
    # Non-recursive bind: do not import any host submounts into the guest view.
    mount("--bind", tree, tree)
    mount("-o", "remount,bind,ro,nosuid,nodev", tree)
    mount("-t", "proc", "-o", "ro,nosuid,nodev,noexec", "proc", tree / "proc")
    for relative, options in (
        ("tmp", "size=64m,nr_inodes=4096,mode=1777,nodev"),
        ("home/awf-enclave", "size=32m,nr_inodes=4096,mode=0700,uid=65534,gid=65534,nodev"),
        ("dev", "size=64k,nr_inodes=32,mode=0755"),
    ):
        mount("-t", "tmpfs", "-o", f"nosuid,noexec,{options}", "tmpfs", tree / relative)
    # An empty exported /dev is not a runtime /dev. Supply only inert standard
    # devices, never a bind of the host's devices.
    for name, minor in (("null", 3), ("zero", 5), ("random", 8), ("urandom", 9)):
        os.mknod(tree / "dev" / name, stat.S_IFCHR | 0o666, os.makedev(1, minor))
        os.chmod(tree / "dev" / name, 0o666)
    (tree / "dev/shm").mkdir()
    mount("-t", "tmpfs", "-o",
          "nosuid,nodev,noexec,size=16m,nr_inodes=1024,mode=1777",
          "tmpfs", tree / "dev/shm")


def prctl(option, argument):
    if LIBC.prctl(option, argument, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), f"verifier prctl({option}) failed")


def drop_privileges(last_capability):
    prctl(38, 1)  # PR_SET_NO_NEW_PRIVS
    prctl(47, 4)  # PR_CAP_AMBIENT_CLEAR_ALL
    for capability in range(last_capability + 1):
        prctl(24, capability)  # PR_CAPBSET_DROP
    os.setgroups([])
    os.setresgid(GID, GID, GID)
    os.setresuid(UID, UID, UID)
    # Clear inheritable as well as effective/permitted sets, including when a
    # caller's securebits altered the normal setuid capability-clearing rules.
    header = (ctypes.c_uint32 * 2)(0x20080522, 0)
    data = (ctypes.c_uint32 * 6)()
    if LIBC.capset(ctypes.byref(header), ctypes.byref(data)) != 0:
        raise OSError(ctypes.get_errno(), "verifier capset failed")
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines()
                  if ":" in line)
    for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
        require(int(status[key].strip(), 16) == 0, f"verifier retained {key}")
    require(status["NoNewPrivs"].strip() == "1", "verifier lacks no_new_privs")
    require(os.getresuid() == (UID, UID, UID) and os.getresgid() == (GID, GID, GID)
            and os.getgroups() == [], "verifier retained privileged identity")


def verify(tree, engine):
    require(engine in ENGINES, "unsupported guest engine")
    require(sys.platform == "linux" and os.geteuid() == 0 and os.getpid() == 1,
            "verifier requires root in a fresh PID namespace")
    require(os.getppid() == 0, "verifier must be the new PID namespace init")
    tree = validate_tree(tree)
    last_capability = int(Path("/proc/sys/kernel/cap_last_cap").read_text())
    os.umask(0o077)
    os.closerange(3, os.sysconf("SC_OPEN_MAX"))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_NPROC, (47, 47))
    prepare_mounts(tree)
    os.chroot(tree)
    os.chdir("/")
    drop_privileges(last_capability)
    os.chdir("/tmp")
    os.execve(f"/usr/local/bin/{engine}", [engine, "--version"], ENVIRONMENT)


if __name__ == "__main__":
    require(len(sys.argv) == 3, "usage: verify-guest-engine.py ROOTFS {copilot,codex,claude}")
    verify(sys.argv[1], sys.argv[2])
