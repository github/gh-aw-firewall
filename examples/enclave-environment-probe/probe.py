"""Bounded, read-only guest observations; only the required result file is written."""

import errno
import json
import os
import platform
import re
import resource
import stat
import sys

MAX_INTEGER = (1 << 53) - 1
MAX_RESULT_BYTES = 8192
PATHS = (
    "/input-seed", "/input-request", "/output", "/runtime",
    "/awf", "/awf/seed", "/awf/out", "/awf/query-script.py",
)
STATUSES = (
    "ok", "absent", "permission_denied", "unsupported", "truncated",
    "malformed", "out_of_range", "unlimited",
)


def observation(status, values=()):
    if len(values) > 8:
        raise ValueError("invalid observation width")
    if any(not isinstance(value, int) or not -1 <= value <= MAX_INTEGER
           for value in values):
        return {"status": "out_of_range", "values": [-1] * 8}
    return {"status": status, "values": list(values) + [-1] * (8 - len(values))}


def unavailable(error):
    statuses = {
        errno.ENOENT: "absent", errno.ENOTDIR: "absent",
        errno.EACCES: "permission_denied", errno.EPERM: "permission_denied",
        errno.ENOSYS: "unsupported", errno.ENOTSUP: "unsupported",
    }
    if error.errno not in statuses:
        raise error
    return observation(statuses[error.errno])


def read_text(path, bound):
    try:
        with open(path, "rb") as stream:
            data = stream.read(bound + 1)
    except OSError as error:
        return unavailable(error), None
    if len(data) > bound:
        return observation("truncated"), None
    try:
        return observation("ok"), data.decode("ascii")
    except UnicodeDecodeError:
        return observation("malformed"), None


def version(value):
    match = re.match(r"^([0-9]{1,6})\.([0-9]{1,6})\.([0-9]{1,6})(?:\D|$)", value)
    return (observation("ok", tuple(map(int, match.groups()))) if match
            else observation("malformed"))


def process_security():
    result, text = read_text("/proc/self/status", 16384)
    if text is None:
        return result
    values = []
    for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"):
        matches = re.findall(r"^" + key + r":\s+([0-9a-fA-F]+)$", text, re.M)
        if len(matches) != 1:
            return observation("malformed")
        if key == "NoNewPrivs" and matches[0] not in ("0", "1"):
            return observation("malformed")
        values.append(int(matches[0], 10 if key == "NoNewPrivs" else 16))
    return observation("ok", values)


def mount_table():
    result, text = read_text("/proc/self/mountinfo", 65536)
    if text is None:
        return result, None
    mounts = []
    for line in text.splitlines():
        fields = line.split()
        if (len(fields) < 10 or "-" not in fields[6:]
                or not fields[0].isdigit() or not fields[1].isdigit()
                or not fields[4].startswith("/")):
            return observation("malformed"), None
        separator = fields.index("-", 6)
        if len(fields) != separator + 4:
            return observation("malformed"), None
        # Decode mountpoint escapes internally; never return mount names or sources.
        target = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), fields[4])
        mounts.append((target, fields[5].split(",")))
    if not mounts:
        return observation("malformed"), None
    return result, mounts


def path_observation(path, mount_status, mounts):
    try:
        info = os.stat(path)
        metadata = observation("ok", (
            info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode),
            int(stat.S_ISDIR(info.st_mode)),
            int(os.access(path, os.R_OK)), int(os.access(path, os.W_OK)),
            int(os.access(path, os.X_OK)),
        ))
    except OSError as error:
        missing = unavailable(error)
        return {"metadata": missing, "mount": missing, "capacity": missing}
    try:
        capacity = os.statvfs(path)
        capacity_result = observation("ok", (
            capacity.f_frsize, capacity.f_blocks, capacity.f_bavail,
            capacity.f_files, capacity.f_favail,
            int(bool(capacity.f_flag & os.ST_RDONLY)),
        ))
    except OSError as error:
        capacity_result = unavailable(error)
    mount_result = mount_status
    if mounts is not None:
        resolved = os.path.realpath(path)
        candidates = [(target, flags) for target, flags in mounts
                      if resolved == target or resolved.startswith(target.rstrip("/") + "/")]
        if not candidates:
            mount_result = observation("absent")
        else:
            target, flags = max(candidates, key=lambda item: len(item[0]))
            mount_result = observation("ok", (
                int("ro" in flags), int("nosuid" in flags),
                int("nodev" in flags), int("noexec" in flags),
                int(resolved == target),
            ))
    return {"metadata": metadata, "mount": mount_result, "capacity": capacity_result}


def limits():
    results = []
    for name in ("RLIMIT_NPROC", "RLIMIT_FSIZE", "RLIMIT_NOFILE"):
        if not hasattr(resource, name):
            results.append(observation("unsupported"))
            continue
        try:
            values = resource.getrlimit(getattr(resource, name))
        except OSError as error:
            results.append(unavailable(error))
            continue
        results.append(observation("ok", tuple(
            -1 if value == resource.RLIM_INFINITY else value for value in values
        )))
    return results


def cgroup_limit(name, width):
    result, text = read_text("/sys/fs/cgroup/" + name, 128)
    if text is None:
        return result
    tokens = text.split()
    if len(tokens) != width or (width == 2 and tokens[1] == "max") or any(
        token != "max" and re.fullmatch(r"[0-9]{1,20}", token) is None
        for token in tokens
    ):
        return observation("malformed")
    return observation("unlimited" if tokens[0] == "max" else "ok",
                       tuple(-1 if token == "max" else int(token) for token in tokens))


def collect():
    mount_status, mounts = mount_table()
    system = platform.system()
    machine = platform.machine()
    return {
        "schemaVersion": 1,
        "system": system if system in ("Linux", "Darwin") else "other",
        "architecture": machine if machine in ("x86_64", "aarch64", "arm64") else "other",
        "pythonImplementation": (
            sys.implementation.name if sys.implementation.name in ("cpython", "pypy")
            else "other"
        ),
        "kernelVersion": version(platform.release()),
        "pythonVersion": observation("ok", sys.version_info[:3]),
        "identity": observation("ok", (os.getuid(), os.getgid(), os.geteuid(), os.getegid())),
        "processSecurity": process_security(),
        "limits": limits(),
        "cgroupRootLimits": [
            cgroup_limit("memory.max", 1), cgroup_limit("pids.max", 1),
            cgroup_limit("cpu.max", 2),
        ],
        "paths": [path_observation(path, mount_status, mounts) for path in PATHS],
    }


def schema():
    item = {
        "type": "object",
        "fields": {
            "status": {"type": "enum", "values": list(STATUSES)},
            "values": {"type": "array", "length": 8, "items": {
                "type": "integer", "minimum": -1, "maximum": MAX_INTEGER,
            }},
        },
    }
    fields = {
        "schemaVersion": {"type": "const", "value": 1},
        "system": {"type": "enum", "values": ["Linux", "Darwin", "other"]},
        "architecture": {"type": "enum", "values": ["x86_64", "aarch64", "arm64", "other"]},
        "pythonImplementation": {"type": "enum", "values": ["cpython", "pypy", "other"]},
    }
    for key in ("kernelVersion", "pythonVersion", "identity", "processSecurity"):
        fields[key] = item
    for key in ("limits", "cgroupRootLimits"):
        fields[key] = {"type": "array", "length": 3, "items": item}
    fields["paths"] = {"type": "array", "length": len(PATHS), "items": {
        "type": "object", "fields": {
            "metadata": item, "mount": item, "capacity": item,
        },
    }}
    return {"type": "object", "fields": fields}


def encode(result):
    data = json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False)
    if len(data.encode("utf8")) > MAX_RESULT_BYTES:
        raise ValueError("result exceeded bound")
    return data


if __name__ == "__main__":
    try:
        # Local schema generation does not observe the environment or write a result.
        if sys.argv[1:] == ["--schema"]:
            print(encode(schema()))
        elif sys.argv[1:]:
            raise ValueError("unsupported arguments")
        else:
            encoded = encode(collect())
            with open("/awf/out", "w", encoding="ascii") as output:
                output.write(encoded)
    except Exception:
        # Unexpected failures must fail execution without paths or exception payloads.
        raise SystemExit("environment probe failed") from None
