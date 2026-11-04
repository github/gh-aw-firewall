#!/usr/bin/env python3
"""Portable contract tests; these do not substitute for Linux mount execution."""

from contextlib import ExitStack
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, call, patch


SOURCE = Path(__file__).resolve().parents[2] / "guest/cloud-hypervisor/verify-guest-engine.py"
SPEC = importlib.util.spec_from_file_location("guest_verifier", SOURCE)
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)

STATUS = "\n".join(f"{key}:\t0" for key in
                   ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")) + "\nNoNewPrivs:\t1"


class VerifierTests(unittest.TestCase):
    def test_mounts_are_private_readonly_and_bounded_without_host_proc_or_devices(self):
        tree = Path("/guest")
        with patch.object(verifier, "mount") as mount, \
                patch.object(verifier.os, "mknod", create=True) as mknod, \
                patch.object(verifier.os, "chmod"), patch.object(Path, "mkdir"):
            verifier.prepare_mounts(tree)
        self.assertEqual(mount.call_args_list[:4], [
            call("--make-rprivate", "/"),
            call("--bind", tree, tree),
            call("-o", "remount,bind,ro,nosuid,nodev", tree),
            call("-t", "proc", "-o", "ro,nosuid,nodev,noexec", "proc", tree / "proc"),
        ])
        self.assertEqual(len(mount.call_args_list), 8)
        for invocation in mount.call_args_list[4:]:
            args = invocation.args
            self.assertEqual(args[:3], ("-t", "tmpfs", "-o"))
            self.assertIn("size=", args[3])
            self.assertIn("nr_inodes=", args[3])
            self.assertIn("nosuid", args[3])
            self.assertIn("noexec", args[3])
        self.assertEqual(mknod.call_args_list, [
            call(tree / "dev" / name, stat.S_IFCHR | 0o666, os.makedev(1, minor))
            for name, minor in (("null", 3), ("zero", 5), ("random", 8), ("urandom", 9))
        ])

    def test_mount_command_has_no_inherited_environment_or_input_and_fails_closed(self):
        error = subprocess.CalledProcessError(1, "mount")
        with patch.object(verifier.subprocess, "run", side_effect=error) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                verifier.mount("--make-rprivate", "/")
        run.assert_called_once_with(
            ["/usr/bin/mount", "--make-rprivate", "/"], check=True,
            stdin=subprocess.DEVNULL, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})

    def test_tree_rejects_host_root_symlinks_writable_roots_and_existing_mounts(self):
        with self.assertRaisesRegex(RuntimeError, "host root"):
            verifier.validate_tree("/")
        with tempfile.TemporaryDirectory() as directory:
            tree = Path(directory).resolve()
            for relative in ("proc", "tmp", "dev/shm", "home/awf-enclave"):
                (tree / relative).mkdir(parents=True)
            original_stat = Path.stat

            def root_owned(path, *args, **kwargs):
                metadata = original_stat(path, *args, **kwargs)
                if path == tree:
                    fields = list(metadata)
                    fields[4] = 0
                    return os.stat_result(fields)
                return metadata

            with patch.object(Path, "stat", root_owned), patch.object(Path, "read_text") as read:
                read.return_value = "1 0 0:1 / / rw - ext4 root rw"
                self.assertEqual(verifier.validate_tree(tree), tree)
                (tree / "proc").rmdir()
                (tree / "proc").symlink_to(tree / "tmp", target_is_directory=True)
                with self.assertRaisesRegex(RuntimeError, "real directory"):
                    verifier.validate_tree(tree)
                (tree / "proc").unlink()
                (tree / "proc").mkdir()
                for target in (str(tree), str(tree / "proc")):
                    escaped = target.replace(" ", r"\040")
                    read.return_value = f"1 0 0:1 / {escaped} rw - proc proc rw"
                    with self.assertRaisesRegex(RuntimeError, "already contains a mount"):
                        verifier.validate_tree(tree)
                tree.chmod(0o777)
                with self.assertRaisesRegex(RuntimeError, "not group/world writable"):
                    verifier.validate_tree(tree)

    def test_chroot_precedes_privilege_drop_and_only_then_executes_fixed_engine(self):
        events = Mock()
        with ExitStack() as stack:
            stack.enter_context(patch.object(verifier.sys, "platform", "linux"))
            for name, value in (("geteuid", 0), ("getpid", 1), ("getppid", 0), ("sysconf", 1024)):
                stack.enter_context(patch.object(verifier.os, name, return_value=value))
            stack.enter_context(patch.object(Path, "read_text", return_value="40"))
            stack.enter_context(patch.object(verifier, "validate_tree", return_value=Path("/guest")))
            for owner, names in (
                (verifier.os, ("umask", "closerange", "chroot", "chdir", "execve")),
                (verifier.resource, ("setrlimit",)),
                (verifier, ("prepare_mounts", "drop_privileges")),
            ):
                for name in names:
                    events.attach_mock(stack.enter_context(patch.object(owner, name, create=True)), name)
            stack.enter_context(patch.dict(os.environ, {"SECRET_TOKEN": "must-not-escape"}))
            verifier.verify("/guest", "claude")
        events.closerange.assert_called_once_with(3, 1024)
        self.assertEqual(events.setrlimit.call_args_list, [
            call(verifier.resource.RLIMIT_CORE, (0, 0)),
            call(verifier.resource.RLIMIT_FSIZE, (16 * 1024 * 1024,) * 2),
            call(verifier.resource.RLIMIT_NOFILE, (256, 256)),
            call(verifier.resource.RLIMIT_NPROC, (47, 47)),
        ])
        self.assertEqual(events.mock_calls[-6:], [
            call.prepare_mounts(Path("/guest")), call.chroot(Path("/guest")), call.chdir("/"),
            call.drop_privileges(40), call.chdir("/tmp"),
            call.execve("/usr/local/bin/claude", ["claude", "--version"], verifier.ENVIRONMENT),
        ])
        self.assertNotIn("SECRET_TOKEN", events.execve.call_args.args[2])
        self.assertEqual(events.execve.call_args.args[2]["HOME"], "/home/awf-enclave")

    def test_setup_failure_never_executes_an_engine(self):
        for failing_step in ("validate_tree", "prepare_mounts", "drop_privileges"):
            with self.subTest(failing_step=failing_step), ExitStack() as stack:
                stack.enter_context(patch.object(verifier.sys, "platform", "linux"))
                for name, value in (("geteuid", 0), ("getpid", 1), ("getppid", 0),
                                    ("sysconf", 1024)):
                    stack.enter_context(patch.object(verifier.os, name, return_value=value))
                stack.enter_context(patch.object(Path, "read_text", return_value="40"))
                for name in ("umask", "closerange", "chroot", "chdir"):
                    stack.enter_context(patch.object(verifier.os, name, create=True))
                stack.enter_context(patch.object(verifier.resource, "setrlimit"))
                execute = stack.enter_context(patch.object(verifier.os, "execve"))
                for name in ("validate_tree", "prepare_mounts", "drop_privileges"):
                    stack.enter_context(patch.object(
                        verifier, name, return_value=Path("/guest"),
                        side_effect=RuntimeError("setup failed") if name == failing_step else None))
                with self.assertRaisesRegex(RuntimeError, "setup failed"):
                    verifier.verify("/guest", "copilot")
                execute.assert_not_called()

    def test_rejects_non_root_or_non_namespace_init_before_mounting(self):
        for uid, pid, parent in ((65534, 1, 0), (0, 2, 1), (0, 1, 2)):
            with self.subTest(uid=uid, pid=pid, parent=parent), ExitStack() as stack:
                stack.enter_context(patch.object(verifier.sys, "platform", "linux"))
                for name, value in (("geteuid", uid), ("getpid", pid), ("getppid", parent)):
                    stack.enter_context(patch.object(verifier.os, name, return_value=value))
                mount = stack.enter_context(patch.object(verifier, "prepare_mounts"))
                with self.assertRaisesRegex(RuntimeError, "namespace"):
                    verifier.verify("/guest", "copilot")
                mount.assert_not_called()

    def test_privilege_drop_clears_all_capability_sets_and_uses_runtime_identity(self):
        events = Mock()
        with ExitStack() as stack:
            libc = stack.enter_context(patch.object(verifier, "LIBC"))
            libc.capset.return_value = 0
            events.attach_mock(stack.enter_context(patch.object(verifier, "prctl")), "prctl")
            for name in ("setgroups", "setresgid", "setresuid"):
                events.attach_mock(stack.enter_context(
                    patch.object(verifier.os, name, create=True)), name)
            for name, value in (("getresuid", (65534,) * 3), ("getresgid", (65534,) * 3),
                                ("getgroups", [])):
                stack.enter_context(patch.object(verifier.os, name, return_value=value, create=True))
            read = stack.enter_context(patch.object(Path, "read_text", return_value=STATUS))
            verifier.drop_privileges(40)
            self.assertEqual(events.mock_calls, [
                call.prctl(38, 1), call.prctl(47, 4),
                *[call.prctl(24, capability) for capability in range(41)],
                call.setgroups([]), call.setresgid(65534, 65534, 65534),
                call.setresuid(65534, 65534, 65534),
            ])
            libc.capset.assert_called_once()
            for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"):
                read.return_value = STATUS.replace(f"{key}:\t0", f"{key}:\t1") \
                    if key != "NoNewPrivs" else STATUS.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0")
                with self.assertRaisesRegex(RuntimeError, "retained|no_new_privs"):
                    verifier.drop_privileges(40)
            libc.capset.return_value = -1
            with self.assertRaisesRegex(OSError, "capset failed"):
                verifier.drop_privileges(40)

    def test_unknown_engines_and_privilege_syscall_errors_are_rejected(self):
        with patch.object(verifier, "validate_tree") as validate:
            with self.assertRaisesRegex(RuntimeError, "unsupported guest engine"):
                verifier.verify("/guest", "../../bin/sh")
            validate.assert_not_called()
        with patch.object(verifier, "LIBC") as libc:
            libc.prctl.return_value = -1
            with self.assertRaisesRegex(OSError, "prctl"):
                verifier.prctl(38, 1)


if __name__ == "__main__":
    unittest.main()
