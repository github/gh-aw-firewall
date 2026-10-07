"""Local fixture tests, not Cloud Hypervisor/KVM acceptance."""

import contextlib
import errno
import io
import json
from pathlib import Path
import runpy
import sys
import unittest
from unittest.mock import patch

import probe

SECURITY = """CapInh: 0000000000000000
CapPrm: 0000000000000000
CapEff: 0000000000000000
CapBnd: 000001ffffffffff
CapAmb: 0000000000000000
NoNewPrivs: 1
Name: PRIVATE_SENTINEL
"""
MOUNTS = """1 0 8:0 / / ro,relatime - ext4 /PRIVATE_SENTINEL ro
2 1 0:42 / /input-seed ro,nosuid,nodev,noexec - virtiofs PRIVATE_SENTINEL ro
"""


class ProbeTests(unittest.TestCase):
    def text(self, value):
        return patch("builtins.open", return_value=io.BytesIO(value.encode("ascii")))

    def test_security_and_mounts_discard_unapproved_text(self):
        with self.text(SECURITY):
            result = probe.process_security()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["values"][2], 0)
        self.assertEqual(result["values"][5], 1)
        with self.text(MOUNTS):
            status, mounts = probe.mount_table()
        self.assertEqual(status["status"], "ok")
        with patch("probe.os.stat") as stat_mock, patch("probe.os.statvfs") as vfs:
            stat_mock.return_value.st_uid = 65534
            stat_mock.return_value.st_gid = 65534
            stat_mock.return_value.st_mode = 0o40500
            for key in ("f_frsize", "f_blocks", "f_bavail", "f_files", "f_favail"):
                setattr(vfs.return_value, key, 1)
            vfs.return_value.f_flag = 1
            with patch("probe.os.path.realpath", return_value="/input-seed"):
                path_result = probe.path_observation("/input-seed", status, mounts)
        self.assertEqual(path_result["mount"]["values"][:5], [1, 1, 1, 1, 1])
        self.assertNotIn("PRIVATE_SENTINEL", probe.encode(path_result))

    def test_missing_denied_unsupported_and_unexpected_errors(self):
        for code, status in ((errno.ENOENT, "absent"), (errno.EACCES, "permission_denied"),
                             (errno.ENOTSUP, "unsupported")):
            with patch("builtins.open", side_effect=OSError(code, "PRIVATE_SENTINEL")):
                self.assertEqual(probe.process_security(), probe.observation(status))
                self.assertEqual(probe.cgroup_limit("memory.max", 1), probe.observation(status))
                self.assertEqual(probe.mount_table(), (probe.observation(status), None))
            with patch("probe.os.stat", side_effect=OSError(code, "PRIVATE_SENTINEL")):
                result = probe.path_observation("/runtime", probe.observation("ok"), [])
                self.assertTrue(all(item["status"] == status for item in result.values()))
        with patch("builtins.open", side_effect=OSError(errno.EIO, "PRIVATE_SENTINEL")):
            with self.assertRaises(OSError):
                probe.process_security()

    def test_truncated_malformed_and_bounds(self):
        for method, content, expected in (
            (probe.process_security, "x" * 16385, "truncated"),
            (probe.process_security, SECURITY.replace("NoNewPrivs: 1", "NoNewPrivs: 9"), "malformed"),
            (probe.process_security, SECURITY + "CapEff: 0\n", "malformed"),
        ):
            with self.text(content):
                self.assertEqual(method()["status"], expected)
        for content, expected in (("x" * 65537, "truncated"), ("bad line", "malformed"),
                                  ("", "malformed")):
            with self.text(content):
                self.assertEqual(probe.mount_table()[0]["status"], expected)
        for content, expected in (("max\n", "unlimited"), ("1024\n", "ok"),
                                  ("secret", "malformed"), ("9" * 129, "truncated"),
                                  ("99999999999999999999", "out_of_range")):
            with self.text(content):
                self.assertEqual(probe.cgroup_limit("memory.max", 1)["status"], expected)
        with self.text("100000 100000\n"):
            self.assertEqual(probe.cgroup_limit("cpu.max", 2)["values"][:2], [100000, 100000])
        with self.text("max max"):
            self.assertEqual(probe.cgroup_limit("cpu.max", 2)["status"], "malformed")
        with patch("builtins.open", return_value=io.BytesIO(b"\xff")):
            self.assertEqual(probe.process_security()["status"], "malformed")
        self.assertEqual(probe.version("6.1.141-private")["values"][:3], [6, 1, 141])
        self.assertEqual(probe.version("PRIVATE_SENTINEL")["status"], "malformed")
        self.assertEqual(probe.observation("ok", [1 << 60])["status"], "out_of_range")
        with self.assertRaises(ValueError):
            probe.encode({"oversized": "x" * 8192})

    def test_rlimits_and_capacity_errors(self):
        with patch("probe.resource.getrlimit", return_value=(probe.resource.RLIM_INFINITY, 1024)):
            self.assertEqual(probe.limits()[0]["values"][:2], [-1, 1024])
        with patch("probe.os.stat", return_value=Path(__file__).stat()), \
                patch("probe.os.statvfs", side_effect=PermissionError(errno.EACCES, "secret")):
            result = probe.path_observation("/runtime", probe.observation("truncated"), None)
            self.assertEqual(result["capacity"]["status"], "permission_denied")
            self.assertEqual(result["mount"]["status"], "truncated")

    def test_actual_source_execution_uses_only_contract_output(self):
        source = Path(__file__).with_name("probe.py")
        real_open = open
        output = io.StringIO()
        reads = []

        class ResultFile(io.StringIO):
            def close(self):
                output.write(self.getvalue())
                super().close()

        def restricted_open(path, mode="r", **kwargs):
            if str(path) == "/awf/out":
                self.assertEqual(mode, "w")
                return ResultFile()
            reads.append(str(path))
            self.assertEqual(mode, "rb")
            self.assertIn(str(path), (
                "/proc/self/status", "/proc/self/mountinfo",
                "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/pids.max",
                "/sys/fs/cgroup/cpu.max",
            ))
            return real_open(path, mode, **kwargs)

        with patch("builtins.open", side_effect=restricted_open), \
                patch.object(sys, "argv", [str(source)]), \
                contextlib.redirect_stdout(io.StringIO()) as stdout, \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            runpy.run_path(str(source), run_name="__main__")
        result = json.loads(output.getvalue())
        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(len(result["paths"]), len(probe.PATHS))
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(len(reads), 5)
        self.assertLessEqual(len(output.getvalue().encode("utf8")), 8192)

    def test_unexpected_execution_failure_is_sanitized(self):
        source = Path(__file__).with_name("probe.py")
        with patch("builtins.open", side_effect=OSError(errno.EIO, "PRIVATE_SENTINEL")), \
                patch.object(sys, "argv", [str(source)]):
            with self.assertRaises(SystemExit) as failure:
                runpy.run_path(str(source), run_name="__main__")
        self.assertEqual(str(failure.exception), "environment probe failed")

    def test_worst_case_result_size_and_deterministic_encoding(self):
        maximum = probe.observation("permission_denied", [probe.MAX_INTEGER] * 8)
        with patch("probe.mount_table", return_value=(maximum, None)), \
                patch("probe.version", return_value=maximum), \
                patch("probe.observation", return_value=maximum), \
                patch("probe.process_security", return_value=maximum), \
                patch("probe.limits", return_value=[maximum] * 3), \
                patch("probe.cgroup_limit", return_value=maximum), \
                patch("probe.path_observation", return_value={
                    "metadata": maximum, "mount": maximum, "capacity": maximum,
                }):
            result = probe.collect()
        encoded = probe.encode(result)
        self.assertLessEqual(len(encoded.encode("utf8")), 8192)
        self.assertEqual(encoded, probe.encode(json.loads(encoded)))


if __name__ == "__main__":
    unittest.main()
