"""Bound only diagnostic streams; never change workload file or storage limits."""

import json
import os
import stat
import sys
import threading
import time
from pathlib import Path

MAX_BYTES = 1024 * 1024
METADATA_BYTES = 512
ERRORS = {1: "operation-not-permitted", 2: "not-found", 5: "io-error",
          13: "permission-denied", 27: "file-too-large", 28: "no-space",
          30: "read-only-filesystem", 122: "quota-exceeded"}


class PublicDebugCapture:
    def __init__(self, directory=Path("/awf")):
        self.streams = {}
        self.threads = []
        self.closed = False
        saved = {}
        pipes = []
        try:
            for number in (1, 2):
                saved[number] = os.dup(number)
            self._initialize(directory, pipes)
        except BaseException:
            for number, fd in saved.items():
                os.dup2(fd, number)
            for read_fd, write_fd, thread in pipes:
                os.close(write_fd)
                if thread.ident is not None:
                    thread.join()
                else:
                    os.close(read_fd)
            for stream in self.streams.values():
                os.close(stream["fd"])
            raise
        finally:
            for fd in saved.values():
                os.close(fd)
        for _, write_fd, _ in pipes:
            os.close(write_fd)

    def _initialize(self, directory, pipes):
        for number, name in ((1, "stdout"), (2, "stderr")):
            fd = os.open(directory / (name + ".log"), os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 \
                        or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                    raise ValueError("unsafe public diagnostic file")
            except BaseException:
                os.close(fd)
                raise
            reserve = METADATA_BYTES if name == "stderr" else 0
            self.streams[name] = {"fd": fd, "lock": threading.Lock(),
                                  "offset": reserve, "oversized": False, "error": None}
            if reserve:
                os.write(fd, b" " * (reserve - 1) + b"\n")
            read_fd, write_fd = os.pipe()
            thread = threading.Thread(target=self._drain, args=(name, read_fd), daemon=True)
            pipes.append((read_fd, write_fd, thread))
            self.threads.append(thread)
            thread.start()
            os.dup2(write_fd, number)

    def append(self, name, contents):
        stream = self.streams[name]
        with stream["lock"]:
            remaining = max(0, MAX_BYTES - stream["offset"])
            if len(contents) > remaining:
                stream["oversized"] = True
            if stream["error"] is not None:
                return
            try:
                bounded = memoryview(contents)[:remaining]
                while bounded:
                    written = os.pwrite(stream["fd"], bounded, stream["offset"])
                    if written == 0:
                        raise OSError(5, "diagnostic write failed")
                    stream["offset"] += written
                    bounded = bounded[written:]
            except OSError as error:
                stream["error"] = ERRORS.get(error.errno, "io-error")

    def _drain(self, name, read_fd):
        try:
            while True:
                contents = os.read(read_fd, 16 * 1024)
                if not contents:
                    break
                self.append(name, contents)
        except OSError:
            self.streams[name]["error"] = "io-error"
        finally:
            os.close(read_fd)

    def close(self):
        if self.closed:
            return
        self.closed = True
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except (OSError, ValueError):
                # A workload-owned stream may already be closed.
                pass
        null = os.open("/dev/null", os.O_WRONLY)
        try:
            os.dup2(null, 1)
            os.dup2(null, 2)
        finally:
            os.close(null)
        deadline = time.monotonic() + 1
        for thread in self.threads:
            thread.join(max(0, deadline - time.monotonic()))
        events = []
        for name, stream in self.streams.items():
            if stream["oversized"]:
                events.append({"event": "capture-bound", "stream": name, "status": "oversized"})
            if stream["error"]:
                events.append({"event": "capture-io", "stream": name, "category": stream["error"]})
        if any(thread.is_alive() for thread in self.threads):
            events.append({"event": "capture-drain", "status": "unavailable"})
        metadata = b"".join(json.dumps(event, separators=(",", ":")).encode() + b"\n" for event in events)
        try:
            os.pwrite(self.streams["stderr"]["fd"], metadata.ljust(METADATA_BYTES - 1, b" ") + b"\n", 0)
        except OSError:
            # Capture failures must never change the workload's canonical exit.
            pass
        if not any(thread.is_alive() for thread in self.threads):
            for stream in self.streams.values():
                os.close(stream["fd"])


def enable_public_capture():
    if os.environ.get("AWF_ENCLAVE_DEBUG_PUBLIC") != "true":
        return None
    try:
        return PublicDebugCapture()
    except (OSError, ValueError, RuntimeError) as error:
        category = ERRORS.get(getattr(error, "errno", None), "io-error")
        fd = None
        try:
            fd = os.open("/awf/stderr.log", os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            info = os.fstat(fd)
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 \
                    and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600:
                events = b"".join(json.dumps({
                    "event": "capture-io", "stream": name, "category": category,
                }, separators=(",", ":")).encode() + b"\n" for name in ("stdout", "stderr"))
                os.pwrite(fd, events, 0)
        except OSError:
            # Failure to record unavailable capture must not affect workload startup.
            pass
        finally:
            if fd is not None:
                os.close(fd)
        return None
