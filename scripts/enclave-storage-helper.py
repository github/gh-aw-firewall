#!/usr/bin/python3 -I
"""Narrow host-only tmpfs/ownership service. Installed by the authenticated installer."""
import ctypes
import errno
import fcntl
import json
import os
import re
import stat
import sys

VERSION = "0.23.1"
BASE = "/var/lib/awf/enclave-storage"
MAX_BYTES = 4 * 1024**3
MAX_USER_BYTES = 8 * 1024**3
MAX_ALLOCATIONS = 32
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
FILES = {
    "out": 0o600, "session.jsonl": 0o600,
    "github-agent-id": 0o400, "github-bearer": 0o400,
}
libc = ctypes.CDLL(None, use_errno=True)
libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p,
                       ctypes.c_ulong, ctypes.c_char_p]
libc.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
libc.fstatfs.argtypes = [ctypes.c_int, ctypes.c_void_p]


def require(condition):
    if not condition:
        raise ValueError("enclave storage policy denied")


def trusted(fd, mode=None):
    info = os.fstat(fd)
    require(info.st_uid == 0 and not info.st_mode & 0o022)
    if mode is not None:
        require(stat.S_IMODE(info.st_mode) == mode)


def walk_root(create=False):
    fd = os.open("/", DIRECTORY)
    try:
        trusted(fd)
        for component in BASE.strip("/").split("/"):
            if create:
                try:
                    os.mkdir(component, 0o711, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(component, DIRECTORY, dir_fd=fd)
            trusted(child)
            os.close(fd)
            fd = child
        if create:
            os.fchmod(fd, 0o711)
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_json(fd, name):
    child = os.open(name, FILE, dir_fd=fd)
    try:
        trusted(child, 0o600)
        info = os.fstat(child)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 4096)
        return json.loads(os.read(child, 4097))
    finally:
        os.close(child)


def write_json(fd, name, value):
    staging = ".awf-stage-" + os.urandom(16).hex()
    child = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        data = json.dumps(value, separators=(",", ":")).encode()
        require(os.write(child, data) == len(data))
        os.fsync(child)
    finally:
        os.close(child)
    try:
        os.link(staging, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        os.unlink(staging, dir_fd=fd)
    finally:
        try:
            os.unlink(staging, dir_fd=fd)
        except FileNotFoundError:
            pass
    os.fsync(fd)


def reconcile_staging(fd):
    removed = False
    for name in os.listdir(fd):
        if not re.fullmatch(r"\.awf-stage-[0-9a-f]{32}", name):
            continue
        child = os.open(name, FILE, dir_fd=fd)
        try:
            info = os.fstat(child)
            trusted(child, 0o600)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 4096)
        finally:
            os.close(child)
        os.unlink(name, dir_fd=fd)
        removed = True
    if removed:
        os.fsync(fd)


def namespace_check(marker=None):
    require(os.getuid() == 0 and os.geteuid() == 0)
    for kind in ("mnt", "pid", "user"):
        require(os.stat("/proc/self/ns/" + kind).st_ino == os.stat("/proc/1/ns/" + kind).st_ino)
    require(open("/proc/self/uid_map", encoding="ascii").read().split() == ["0", "0", "4294967295"])
    status = open("/proc/self/status", encoding="ascii").read()
    capabilities = re.search(r"^CapEff:\s*([0-9a-f]+)$", status, re.MULTILINE)
    required = (1 << 21) | 11  # SYS_ADMIN, CHOWN, DAC_OVERRIDE and FOWNER.
    require(capabilities is not None and int(capabilities[1], 16) & required == required)
    root = os.stat("/")
    init_root = os.stat("/proc/1/root")
    require((root.st_dev, root.st_ino) == (init_root.st_dev, init_root.st_ino))
    if marker is not None:
        require(marker == {"version": VERSION, "rootDevice": root.st_dev, "rootInode": root.st_ino})


def decode(value):
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), value)


def mount_at(target, source, size):
    rows = [line.split() for line in open("/proc/self/mountinfo", encoding="ascii")]
    matches = [row for row in rows if decode(row[4]) == target]
    require(len(matches) <= 1)
    if not matches:
        return None
    row = matches[0]
    split = row.index("-")
    options = set((row[5] + "," + row[split + 3]).split(","))
    require(row[3] == "/" and row[split + 1] == "tmpfs" and decode(row[split + 2]) == source)
    require({"rw", "nosuid", "nodev", "noexec"} <= options)
    capacity = [option[5:] for option in options if option.startswith("size=")]
    require(len(capacity) == 1 and re.fullmatch(r"[0-9]+[kmg]?", capacity[0]))
    match = re.fullmatch(r"([0-9]+)([kmg]?)", capacity[0])
    require(int(match[1]) * {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3}[match[2]] == size)
    return {"mountId": row[0], "device": row[2], "root": row[3],
            "source": source, "target": target, "bytes": size}


def syscall(result):
    if result != 0:
        raise OSError(ctypes.get_errno(), "enclave storage syscall failed")


def mkdir_open(parent, name, mode):
    try:
        os.mkdir(name, mode, dir_fd=parent)
    except FileExistsError:
        pass
    child = os.open(name, DIRECTORY, dir_fd=parent)
    trusted(child, mode)
    return child


def private_base(base):
    """Make only the fixed root a private bind before any allocation is mounted."""
    rows = [line.split() for line in open("/proc/self/mountinfo", encoding="ascii")]
    exact = [row for row in rows if decode(row[4]) == BASE]
    require(len(exact) <= 1)
    replacement = base
    try:
        if not exact:
            require(not any(decode(row[4]).startswith(BASE + "/") for row in rows))
            target = f"/proc/self/fd/{base}".encode()
            syscall(libc.mount(target, target, None, 4096, None))  # MS_BIND, not recursive.
            replacement = walk_root()
            before, after = os.fstat(base), os.fstat(replacement)
            require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino))
        syscall(libc.mount(None, f"/proc/self/fd/{replacement}".encode(), None, (1 << 18) | 16384, None))
        rows = [line.split() for line in open("/proc/self/mountinfo", encoding="ascii")]
        exact = [row for row in rows if decode(row[4]) == BASE]
        require(len(exact) == 1)
        require(not any(field.startswith(("shared:", "master:", "propagate_from:"))
                        for field in exact[0][6:exact[0].index("-")]))
        return replacement
    except BaseException:
        if replacement != base:
            os.close(replacement)
        raise


def prepare_host_state(base, uid):
    user = mkdir_open(base, str(uid), 0o711)
    try:
        try:
            os.mkdir("host-state", 0o700, dir_fd=user)
            created = True
        except FileExistsError:
            created = False
        child = os.open("host-state", DIRECTORY, dir_fd=user)
        try:
            if created:
                trusted(child, 0o700)
                os.fchown(child, uid, -1)
                os.fsync(user)
            info = os.fstat(child)
            require(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700)
        finally:
            os.close(child)
    finally:
        os.close(user)
    return BASE + "/" + str(uid) + "/host-state"


def validate_request(args, uid):
    require(len(args) >= 1 and args[0] in ("mount", "unmount", "own", "reclaim"))
    operation = args[0]
    require(len(args) == {"own": 7, "reclaim": 5}.get(operation, 4))
    allocation, source, raw_size = args[1:4]
    match = re.fullmatch(r"([0-9a-f]{16,64})-([a-z0-9][a-z0-9-]{0,62})/([0-9a-f]{16,64})", allocation)
    require(match is not None)
    require(source == "awf-enclave-" + "-".join(match.groups()))
    require(re.fullmatch(r"[1-9][0-9]{0,10}", raw_size) is not None)
    size = int(raw_size)
    require(4096 <= size <= MAX_BYTES and size % 4096 == 0)
    target = BASE + "/" + str(uid) + "/" + allocation
    if operation == "own":
        require(args[4] in {*FILES, "agent"})
        require(args[5:7] == ["65534", "65534"])
    if operation == "reclaim":
        require(args[4] in ("out", "session.jsonl"))
    return operation, allocation, source, size, target


def allocation_operation(base, state, uid, args):
    operation, allocation, source, size, target = validate_request(args, uid)
    key = str(uid) + "-" + allocation.replace("/", "-") + ".json"
    parent_name, name = allocation.split("/")
    if operation == "mount":
        records = [read_json(state, item) for item in os.listdir(state)
                   if item.startswith(str(uid) + "-") and item.endswith(".json")]
        require(len(records) < MAX_ALLOCATIONS and sum(item["bytes"] for item in records) + size <= MAX_USER_BYTES)
    user = mkdir_open(base, str(uid), 0o711)
    parent = mkdir_open(user, parent_name, 0o711)
    try:
        try:
            record = read_json(state, key)
        except FileNotFoundError:
            record = None
        if operation == "mount":
            require(record is None and mount_at(target, source, size) is None)
            os.mkdir(name, 0o700, dir_fd=parent)
            target_fd = os.open(name, DIRECTORY, dir_fd=parent)
            try:
                trusted(target_fd, 0o700)
                info = os.fstat(target_fd)
                record = {"source": source, "bytes": size, "target": target,
                          "underDevice": info.st_dev, "underInode": info.st_ino}
                # Durable intent precedes mount, so an interrupted call can only
                # recover this exact allocation, never an arbitrary mount.
                write_json(state, key, record)
                syscall(libc.mount(source.encode(), f"/proc/self/fd/{target_fd}".encode(), b"tmpfs",
                                   2 | 4 | 8, f"size={size},mode=0700,uid={uid}".encode()))
            finally:
                os.close(target_fd)
            identity = mount_at(target, source, size)
            require(identity is not None)
            target_fd = os.open(name, DIRECTORY, dir_fd=parent)
            try:
                capacity = os.fstatvfs(target_fd)
                require(capacity.f_blocks * capacity.f_frsize == size)
                filesystem = ctypes.create_string_buffer(256)
                syscall(libc.fstatfs(target_fd, filesystem))
                require(ctypes.c_long.from_buffer(filesystem).value == 0x01021994)
                # Commit mount identity before returning to unprivileged AWF.
                write_json(state, key + ".mounted", identity)
            finally:
                os.close(target_fd)
            return identity
        if record is None:
            # Idempotent cleanup after a lost response, but never a foreign mount.
            require(operation == "unmount" and mount_at(target, source, size) is None)
            try:
                os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                return {"clean": True}
            raise ValueError("unverified allocation remains")
        require(record["source"] == source and record["bytes"] == size and record["target"] == target)
        current = mount_at(target, source, size)
        try:
            committed = read_json(state, key + ".mounted")
        except FileNotFoundError:
            committed = None
        require(committed is None or current == committed or (operation == "unmount" and current is None))
        if operation in ("own", "reclaim"):
            require(current is not None and committed == current)
            directory = os.open(name, DIRECTORY, dir_fd=parent)
            try:
                child_name = args[4]
                child = os.open(child_name, DIRECTORY if child_name == "agent" else FILE, dir_fd=directory)
                try:
                    info = os.fstat(child)
                    require(info.st_dev == os.fstat(directory).st_dev)
                    if operation == "reclaim":
                        granted = read_json(state, key + ".own-" + child_name)
                        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
                        require(info.st_uid == granted["uid"] and info.st_ino == granted["inode"])
                        os.fchown(child, uid, -1)
                        os.fchmod(child, 0o600)
                        return {"owned": True}
                    require(info.st_uid == uid)
                    if child_name == "agent":
                        require(not os.listdir(child) and stat.S_IMODE(info.st_mode) == 0o700)
                    else:
                        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
                        require(stat.S_IMODE(info.st_mode) == FILES[child_name])
                    write_json(state, key + ".own-" + child_name,
                               {"uid": int(args[5]), "inode": info.st_ino})
                    os.fchown(child, int(args[5]), int(args[6]))
                finally:
                    os.close(child)
            finally:
                os.close(directory)
            return {"owned": True}
        if current is not None:
            # All path parents are root-owned and nonreplaceable by the caller.
            # Do not keep an fd into this mount: it would make normal unmount busy.
            require(mount_at(target, source, size) == current)
            syscall(libc.umount2(target.encode(), 0))
            require(mount_at(target, source, size) is None)
        try:
            underlying = os.open(name, DIRECTORY, dir_fd=parent)
        except FileNotFoundError:
            underlying = None
        if underlying is not None:
            try:
                trusted(underlying, 0o700)
                info = os.fstat(underlying)
                require((info.st_dev, info.st_ino) == (record["underDevice"], record["underInode"]))
                require(not os.listdir(underlying))
            finally:
                os.close(underlying)
            os.rmdir(name, dir_fd=parent)
        for state_name in [key + ".mounted", *(key + ".own-" + child_name for child_name in {*FILES, "agent"})]:
            try:
                os.unlink(state_name, dir_fd=state)
            except FileNotFoundError:
                pass
        try:
            os.unlink(key, dir_fd=state)
        except FileNotFoundError:
            pass
        os.fsync(state)
        return {"clean": True}
    finally:
        os.close(parent)
        try:
            for directory, parent_fd in ((parent_name, user), (str(uid), base)):
                try:
                    os.rmdir(directory, dir_fd=parent_fd)
                except OSError as error:
                    if error.errno not in (errno.ENOTEMPTY, errno.EEXIST, errno.ENOENT):
                        raise
        finally:
            os.close(user)


def main(args):
    require(sys.flags.isolated == 1)
    os.umask(0o022)
    namespace_check()
    if args == ["check-install-host"]:
        return {"version": VERSION, "supported": True}
    installing = args == ["install"]
    if installing:
        require("SUDO_UID" not in os.environ)
    base = walk_root(create=installing)
    try:
        state = mkdir_open(base, ".state", 0o700) if installing else os.open(".state", DIRECTORY, dir_fd=base)
        try:
            trusted(state, 0o700)
            lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=state)
            try:
                trusted(lock, 0o600)
                fcntl.flock(lock, fcntl.LOCK_EX)
                reconcile_staging(base)
                reconcile_staging(state)
                if not installing:
                    namespace_check(read_json(base, "host.json"))
                replacement = private_base(base)
                if replacement != base:
                    os.close(base)
                    base = replacement
                if installing:
                    require(os.listdir(state) == ["lock"])
                    marker = {"version": VERSION, "rootDevice": os.stat("/").st_dev, "rootInode": os.stat("/").st_ino}
                    try:
                        os.unlink("host.json", dir_fd=base)
                    except FileNotFoundError:
                        pass
                    write_json(base, "host.json", marker)
                    return {"version": VERSION}
                raw_uid = os.environ.get("SUDO_UID", "")
                require(re.fullmatch(r"[1-9][0-9]{0,9}", raw_uid) is not None)
                uid = int(raw_uid)
                require(uid <= 2147483647)
                probing = args == ["probe", VERSION]
                if probing:
                    state_root = prepare_host_state(base, uid)
                    return {"version": VERSION, "uid": uid, "maxBytes": MAX_BYTES, "stateRoot": state_root}
                require(len(args) >= 1 and args[0] == VERSION)
                return allocation_operation(base, state, uid, args[1:])
            finally:
                os.close(lock)
        finally:
            os.close(state)
    finally:
        os.close(base)


if __name__ == "__main__":
    try:
        print(json.dumps(main(sys.argv[1:]), separators=(",", ":")))
    except (OSError, ValueError, KeyError, TypeError):
        # Never echo paths, file contents, arguments or caller environment.
        print("AWF enclave storage helper denied or unavailable", file=sys.stderr)
        sys.exit(1)
