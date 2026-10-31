import importlib.util
import io
import os
from pathlib import Path
import shutil
import types
import unittest
from unittest.mock import patch
from uuid import uuid4

spec = importlib.util.spec_from_file_location("storage", Path(__file__).with_name("enclave-storage-helper.py"))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)
real_mount_at = storage.mount_at
real_trusted = storage.trusted
real_fstat = os.fstat


class HelperPolicy(unittest.TestCase):
    def setUp(self):
        self.root = Path.cwd() / (".helper-test-" + uuid4().hex)
        self.root.mkdir(mode=0o700)
        self.state_path = self.root / ".state"
        self.state_path.mkdir(mode=0o700)
        self.base = os.open(self.root, storage.DIRECTORY)
        self.state = os.open(self.state_path, storage.DIRECTORY)
        self.uid = os.getuid()
        self.allocation = "a" * 32 + "-agent/" + "b" * 32
        self.source = "awf-enclave-" + self.allocation.replace("/", "-")
        self.target = str(self.root / str(self.uid) / self.allocation)
        self.identity = {"mountId": "42", "device": "0:42", "root": "/", "source": self.source,
                         "target": self.target, "bytes": 65536}
        self.mounted = False
        self.owners = {}
        self.patches = [
            patch.object(storage, "BASE", str(self.root)),
            patch.object(storage, "trusted"),
            patch.object(storage, "mount_at", side_effect=lambda *args: self.identity if self.mounted else None),
            patch.object(storage.libc, "mount", side_effect=self.mount),
            patch.object(storage.libc, "umount2", side_effect=self.unmount),
            patch.object(storage.libc, "fstatfs", side_effect=self.statfs),
            patch.object(storage.os, "fchown", side_effect=self.chown),
            patch.object(storage.os, "fstat", side_effect=self.stat),
            patch.object(storage.os, "fstatvfs", return_value=types.SimpleNamespace(f_blocks=16, f_frsize=4096)),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        os.close(self.state)
        os.close(self.base)
        shutil.rmtree(self.root)

    def mount(self, *args):
        self.assertEqual(args[3], 2 | 4 | 8)
        self.assertIn(b"size=65536,mode=0700,uid=", args[4])
        self.assertTrue(args[1].startswith(b"/proc/self/fd/"))
        self.mounted = True
        return 0

    def statfs(self, fd, buffer):
        storage.ctypes.c_long.from_buffer(buffer).value = 0x01021994
        return 0

    def stat(self, fd):
        info = real_fstat(fd)
        if info.st_ino in self.owners:
            fields = list(info)
            fields[4] = self.owners[info.st_ino]
            return os.stat_result(fields)
        return info

    def chown(self, fd, uid, gid):
        if uid != -1:
            self.owners[real_fstat(fd).st_ino] = uid

    def unmount(self, *args):
        self.assertEqual(args[1], 0)  # No lazy or force unmount.
        self.assertEqual(args[0], self.target.encode())
        self.mounted = False
        for item in Path(self.target).iterdir():
            item.rmdir() if item.is_dir() else item.unlink()
        return 0

    def invoke(self, operation, *tail):
        return storage.allocation_operation(self.base, self.state, self.uid,
                                            [operation, self.allocation, self.source, "65536", *tail])

    def test_setup_ownership_reclaim_and_cleanup(self):
        self.assertEqual(self.invoke("mount"), self.identity)
        out = Path(self.target) / "out"
        out.write_text("true")
        out.chmod(0o600)
        self.assertEqual(self.invoke("own", "out", "65534", "65534"), {"owned": True})
        out.chmod(0o400)
        self.assertEqual(self.invoke("reclaim", "out"), {"owned": True})
        self.assertEqual(out.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.invoke("unmount"), {"clean": True})
        self.assertFalse(Path(self.target).exists())
        self.assertEqual(list(self.state_path.iterdir()), [])
        self.assertEqual(self.invoke("unmount"), {"clean": True})

    def test_public_capture_files_are_fixed_and_reclaim_is_restartable(self):
        self.invoke("mount")
        for name in ("stdout.log", "stderr.log"):
            with self.subTest(name=name):
                target = Path(self.target) / name
                target.write_text("raw fixture evidence")
                target.chmod(0o600)
                self.assertEqual(self.invoke("own", name, "65534", "65534"), {"owned": True})
                self.assertEqual(self.invoke("reclaim", name), {"owned": True})
                self.assertEqual(self.invoke("reclaim", name), {"owned": True})
                self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(ValueError):
            self.invoke("reclaim", "agent/credential")
        self.assertEqual(self.invoke("unmount"), {"clean": True})
        self.assertEqual(os.listdir(self.state), [])

    def test_public_capture_reclaim_denies_replaced_inode_and_links(self):
        self.invoke("mount")
        target = Path(self.target) / "stdout.log"
        target.write_text("")
        target.chmod(0o600)
        self.invoke("own", "stdout.log", "65534", "65534")
        target.rename(Path(self.target) / "original")
        target.write_text("")
        target.chmod(0o600)
        with self.assertRaises(ValueError):
            self.invoke("reclaim", "stdout.log")
        target.unlink()
        target.symlink_to(Path(self.target) / "original")
        with self.assertRaises(OSError):
            self.invoke("reclaim", "stdout.log")
        target.unlink()
        os.link(Path(self.target) / "original", target)
        with self.assertRaises(ValueError):
            self.invoke("reclaim", "stdout.log")

    def test_state_publication_is_exclusive_and_reconciles_abandoned_staging(self):
        storage.write_json(self.state, "entry", {"bytes": 65536})
        with self.assertRaises(FileExistsError):
            storage.write_json(self.state, "entry", {"bytes": 1})
        self.assertEqual(storage.read_json(self.state, "entry"), {"bytes": 65536})
        abandoned = ".awf-stage-" + "a" * 32
        for directory in (self.base, self.state):
            fd = os.open(abandoned, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
            os.close(fd)
            storage.reconcile_staging(directory)
            self.assertNotIn(abandoned, os.listdir(directory))
        self.assertEqual(os.listdir(self.state), ["entry"])

    def test_state_publication_reconciles_interruption_after_atomic_link(self):
        real_unlink = os.unlink

        def interrupt(name, *args, **kwargs):
            if name.startswith(".awf-stage-"):
                raise OSError("injected interruption after publication")
            return real_unlink(name, *args, **kwargs)

        with patch.object(storage.os, "unlink", side_effect=interrupt):
            with self.assertRaises(OSError):
                storage.write_json(self.state, "published", {"bytes": 65536})
        self.assertEqual(len(os.listdir(self.state)), 2)
        storage.reconcile_staging(self.state)
        self.assertEqual(storage.read_json(self.state, "published"), {"bytes": 65536})
        self.assertEqual(os.listdir(self.state), ["published"])

    def test_cleanup_retries_after_interruption_at_every_record_removal(self):
        for interrupted_at in range(4):
            with self.subTest(interrupted_at=interrupted_at):
                self.invoke("mount")
                key = str(self.uid) + "-" + self.allocation.replace("/", "-") + ".json"
                storage.write_json(self.state, key + ".own-out", {"uid": 65534, "inode": 1})
                storage.write_json(self.state, key + ".own-agent", {"uid": 65534, "inode": 2})
                real_unlink = os.unlink
                removed = 0

                def interrupt(name, *args, **kwargs):
                    nonlocal removed
                    if name in {key + ".mounted", key + ".own-out", key + ".own-agent", key}:
                        if removed == interrupted_at:
                            raise OSError("injected cleanup interruption")
                        removed += 1
                    return real_unlink(name, *args, **kwargs)

                with patch.object(storage.os, "unlink", side_effect=interrupt):
                    with self.assertRaises(OSError):
                        self.invoke("unmount")
                self.assertFalse(Path(self.target).exists())
                self.assertEqual(self.invoke("unmount"), {"clean": True})
                self.assertFalse(Path(self.target).exists())
                self.assertEqual(os.listdir(self.state), [])

    def test_rejects_paths_sizes_and_arbitrary_operations(self):
        valid = ["mount", self.allocation, self.source, "65536"]
        for index, value in [(0, "exec"), (1, "../../etc/passwd"), (1, "/etc"),
                             (2, "foreign"), (3, str(storage.MAX_BYTES + 4096)),
                             (3, "4097"), (3, "-1"), (3, "0")]:
            args = valid.copy()
            args[index] = value
            with self.assertRaises(ValueError):
                storage.validate_request(args, self.uid)
        with self.assertRaises(ValueError):
            self.invoke("own", "seccomp.json", "65534", "65534")
        with self.assertRaises(ValueError):
            self.invoke("own", "out", "1001", "1001")
        with self.assertRaises(ValueError):
            self.invoke("reclaim", "task.txt")

    def test_symlink_hardlink_and_nonempty_agent_denied(self):
        self.invoke("mount")
        out = Path(self.target) / "out"
        out.symlink_to(self.root / "outside")
        with self.assertRaises(OSError):
            self.invoke("own", "out", "65534", "65534")
        out.unlink()
        out.write_text("")
        out.chmod(0o600)
        os.link(out, self.root / "alias")
        with self.assertRaises(ValueError):
            self.invoke("own", "out", "65534", "65534")
        agent = Path(self.target) / "agent"
        agent.mkdir(mode=0o700)
        (agent / "child").touch()
        with self.assertRaises(ValueError):
            self.invoke("own", "agent", "65534", "65534")

    def test_failed_mount_intent_recovers_without_unmounting_foreign_storage(self):
        with patch.object(storage.libc, "mount", return_value=-1):
            with self.assertRaises(OSError):
                self.invoke("mount")
        self.assertTrue(any(self.state_path.iterdir()))
        self.assertEqual(self.invoke("unmount"), {"clean": True})
        self.assertFalse(Path(self.target).exists())

    def test_committed_mount_identity_change_preserves_state(self):
        self.invoke("mount")
        self.identity = {**self.identity, "mountId": "43"}
        with self.assertRaises(ValueError):
            self.invoke("unmount")
        self.assertTrue(any(self.state_path.iterdir()))
        self.assertTrue(Path(self.target).exists())

    def test_aggregate_admission_counts_only_allocation_intents(self):
        with patch.object(storage, "MAX_ALLOCATIONS", 1):
            self.invoke("mount")
            self.allocation = "c" * 32 + "-agent/" + "d" * 32
            self.source = "awf-enclave-" + self.allocation.replace("/", "-")
            self.mounted = False
            with self.assertRaises(ValueError):
                self.invoke("mount")

    def test_namespace_denial_precedes_storage_operations(self):
        with patch.object(storage.os, "getuid", return_value=0), \
             patch.object(storage.os, "geteuid", return_value=0), \
             patch.object(storage.os, "stat", side_effect=[
                 types.SimpleNamespace(st_ino=1), types.SimpleNamespace(st_ino=2)]):
            with self.assertRaises(ValueError):
                storage.namespace_check()

    def test_bootstraps_only_fixed_private_caller_state(self):
        state_root = storage.prepare_host_state(self.base, self.uid)
        info = os.stat(state_root)
        self.assertEqual((info.st_uid, info.st_mode & 0o777), (self.uid, 0o700))
        self.assertEqual(storage.prepare_host_state(self.base, self.uid), state_root)
        os.rmdir(state_root)
        os.symlink(self.root, state_root)
        with self.assertRaises(OSError):
            storage.prepare_host_state(self.base, self.uid)

    def test_nofollow_directory_walk_denies_symlinked_ancestors(self):
        (self.root / "alias").symlink_to(self.root, target_is_directory=True)
        with patch.object(storage, "BASE", str(self.root / "alias")):
            with self.assertRaises(OSError):
                storage.walk_root()

    def test_mount_identity_parser_rejects_relaxed_flags_and_wrong_capacity(self):
        line = f"53 24 0:34 / {self.target} rw,nosuid,nodev,noexec - tmpfs {self.source} rw,size=64k\n"
        with patch("builtins.open", return_value=io.StringIO(line)):
            self.assertEqual(real_mount_at(self.target, self.source, 65536)["mountId"], "53")
        for invalid in [line.replace("noexec", "exec"), line.replace("64k", "128k"),
                        line.replace("tmpfs", "ext4"), line + line]:
            with patch("builtins.open", return_value=io.StringIO(invalid)):
                with self.assertRaises(ValueError):
                    real_mount_at(self.target, self.source, 65536)

    def test_root_ownership_check_rejects_writable_or_caller_owned_state(self):
        for uid, mode in [(0, 0o777), (1001, 0o700)]:
            with patch.object(storage.os, "fstat", return_value=types.SimpleNamespace(st_uid=uid, st_mode=mode)):
                with self.assertRaises(ValueError):
                    real_trusted(0)

    def test_private_allocation_parent_is_pinned_before_private_propagation(self):
        before = "27 2 259:1 / / rw shared:1 - ext4 /dev/root rw\n"
        after = f"53 27 259:1 /private {self.root} rw - ext4 /dev/root rw\n"
        replacement = os.dup(self.base)
        try:
            with patch("builtins.open", side_effect=[io.StringIO(before), io.StringIO(after)]), \
                 patch.object(storage, "walk_root", return_value=replacement), \
                 patch.object(storage.libc, "mount", return_value=0) as mount:
                self.assertEqual(storage.private_base(self.base), replacement)
                self.assertEqual([call.args[3] for call in mount.call_args_list], [4096, (1 << 18) | 16384])
                self.assertEqual(mount.call_args_list[1].args[1], f"/proc/self/fd/{replacement}".encode())
        finally:
            os.close(replacement)

    def test_unexpected_submount_before_private_bootstrap_fails_closed(self):
        line = f"53 27 0:42 / {self.root}/unexpected rw - tmpfs foreign rw\n"
        with patch("builtins.open", return_value=io.StringIO(line)), \
             patch.object(storage.libc, "mount", return_value=0) as mount:
            with self.assertRaises(ValueError):
                storage.private_base(self.base)
            mount.assert_not_called()

    def test_preflight_requires_actual_mount_and_ownership_capabilities(self):
        for capabilities in (0, 0x200003, 0x20000b):
            def contents(filename, **kwargs):
                return io.StringIO("0 0 4294967295\n" if filename.endswith("uid_map")
                                   else f"CapEff:\t{capabilities:016x}\n")
            with patch.object(storage.os, "getuid", return_value=0), \
                 patch.object(storage.os, "geteuid", return_value=0), \
                 patch.object(storage.os, "stat", return_value=types.SimpleNamespace(st_ino=1, st_dev=1)), \
                 patch("builtins.open", side_effect=contents):
                if capabilities == 0x20000b:
                    storage.namespace_check()
                else:
                    with self.assertRaises(ValueError):
                        storage.namespace_check()


if __name__ == "__main__":
    unittest.main()
