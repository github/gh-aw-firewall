#!/usr/bin/env python3
"""Run the pinned native Copilot CLI inside a enclave-agent enclave."""

import errno
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

SEED_DIR = Path("/awf/seed")
TASK_PATH = Path("/awf/task.txt")
SCHEMA_PATH = Path("/awf/schema.json")
OUT_PATH = Path("/awf/out")
SESSION_LOG_PATH = Path("/awf/session.jsonl")
AGENT_DIR = Path("/agent")
COPILOT_BIN = "/usr/local/bin/copilot"

MAX_INPUT_BYTES = 64 * 1024
MAX_TRANSCRIPT_BYTES = 1024 * 1024
MAX_ENGINE_STREAM_BYTES = MAX_TRANSCRIPT_BYTES // 4
MAX_DIAGNOSTIC_BYTES = 256 * 1024
MAX_DIAGNOSTIC_FILES = 32
MAX_STARTUP_RETRIES = 2
STARTUP_CRASH_WINDOW_SECONDS = 30
EXIT_CONFIGURATION_INVALID = 10
EXIT_INPUT_INVALID = 11
EXIT_DEADLINE_EXCEEDED = 20
EXIT_ENGINE_FAILED = 24
EXIT_RESULT_WRITE_FAILED = 30


def truncate_utf8(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def append_event(event: dict) -> None:
    try:
        encoded = (json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
        current = SESSION_LOG_PATH.stat().st_size
        if len(encoded) <= MAX_TRANSCRIPT_BYTES and current + len(encoded) <= MAX_TRANSCRIPT_BYTES:
            with SESSION_LOG_PATH.open("ab") as handle:
                handle.write(encoded)
    except (OSError, TypeError, ValueError):
        pass


def read_bounded(path: Path) -> str:
    data = path.read_bytes()
    if not data or len(data) > MAX_INPUT_BYTES:
        raise ValueError("invalid bounded input")
    return data.decode("utf-8")


def redact_diagnostics(value: str) -> str:
    redacted = re.sub(
        r"(?im)^(\s*(?:authorization|proxy-authorization)\s*[:=]\s*).*$",
        r"\1[REDACTED]",
        value,
    )
    redacted = re.sub(r"(?i)\bbearer\s+\S+", "Bearer [REDACTED]", redacted)
    redacted = re.sub(
        r"\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b",
        "[REDACTED]",
        redacted,
    )
    for name, secret in os.environ.items():
        if secret and secret != "******" and re.search(r"(?:TOKEN|KEY|SECRET|CREDENTIAL)", name):
            redacted = redacted.replace(secret, "[REDACTED]")
    return redacted


def append_progress(stage: str, **metadata) -> None:
    append_event({"event": "progress", "stage": stage, **metadata})


def safe_os_error(error: OSError, operation: str) -> None:
    error_number = error.errno if isinstance(error.errno, int) else None
    category = {
        errno.ENOENT: "not-found",
        errno.EACCES: "permission-denied",
        errno.ENOEXEC: "not-executable",
        errno.ENOTDIR: "not-directory",
        errno.EISDIR: "is-directory",
        errno.EROFS: "read-only-filesystem",
    }.get(error_number, "os-error")
    exception = type(error).__name__
    if exception not in {
        "OSError",
        "FileNotFoundError",
        "PermissionError",
        "NotADirectoryError",
        "IsADirectoryError",
    }:
        exception = "OSError"
    event = {
        "event": "operation-error",
        "operation": operation,
        "exception": exception,
        "category": category,
    }
    if error_number is not None:
        event["errno"] = error_number
        try:
            event["strerror"] = os.strerror(error_number)
        except (ValueError, OverflowError):
            pass
    append_event(event)


def preflight_path(
    identifier: str,
    path: Path,
    expected_type: str,
    *,
    executable: bool = False,
    writable: bool = False,
) -> OSError | None:
    metadata = {
        "event": "preflight",
        "path": identifier,
        "exists": False,
        "type": "missing",
    }
    try:
        path_stat = path.stat()
    except OSError as error:
        append_event(metadata)
        return error

    is_file = stat.S_ISREG(path_stat.st_mode)
    is_directory = stat.S_ISDIR(path_stat.st_mode)
    actual_type = "file" if is_file else "directory" if is_directory else "other"
    metadata.update({"exists": True, "type": actual_type})
    if executable:
        metadata["executable"] = os.access(path, os.X_OK)
    if writable:
        metadata["writable"] = os.access(path, os.W_OK)
    append_event(metadata)

    type_matches = (
        (expected_type == "file" and is_file)
        or (expected_type == "directory" and is_directory)
    )
    if not type_matches:
        error_number = errno.EISDIR if is_directory else errno.ENOTDIR
        return OSError(error_number, os.strerror(error_number))
    if executable and not metadata["executable"]:
        if is_directory:
            return PermissionError(errno.EACCES, os.strerror(errno.EACCES))
        return OSError(errno.ENOEXEC, os.strerror(errno.ENOEXEC))
    if writable and not metadata["writable"]:
        return PermissionError(errno.EACCES, os.strerror(errno.EACCES))
    return None


def run_preflight(copilot_logs: Path) -> bool:
    checks = [
        ("copilot-executable", Path(COPILOT_BIN), "file", True, False),
        ("seed-directory", SEED_DIR, "directory", True, False),
        ("task-input", TASK_PATH, "file", False, False),
        ("schema-input", SCHEMA_PATH, "file", False, False),
        ("output-file", OUT_PATH, "file", False, True),
        ("session-log", SESSION_LOG_PATH, "file", False, True),
        ("agent-directory", AGENT_DIR, "directory", True, True),
        ("copilot-log-directory", copilot_logs, "directory", True, True),
    ]
    valid = True
    for identifier, path, expected_type, executable, writable in checks:
        error = preflight_path(
            identifier,
            path,
            expected_type,
            executable=executable,
            writable=writable,
        )
        if error is not None:
            safe_os_error(error, f"preflight-{identifier}")
            valid = False
    append_progress("preflight-completed", valid=valid)
    return valid


def read_copilot_diagnostics(log_dir: Path) -> str:
    chunks = []
    remaining = MAX_DIAGNOSTIC_BYTES
    try:
        candidates = sorted(log_dir.rglob("*"))
    except OSError:
        return ""
    for path in candidates[:MAX_DIAGNOSTIC_FILES]:
        try:
            if not stat.S_ISREG(path.lstat().st_mode):
                continue
            with path.open("rb") as handle:
                data = handle.read(remaining + 1)[:remaining]
        except OSError:
            continue
        chunks.append(
            f"--- diagnostic-{len(chunks) + 1}\n"
            f"{data.decode('utf-8', errors='replace')}"
        )
        remaining -= len(data)
        if remaining <= 0:
            break
    return truncate_utf8(redact_diagnostics("\n".join(chunks)), MAX_DIAGNOSTIC_BYTES)


def build_prompt(task: str, schema_text: str) -> str:
    schema = json.loads(schema_text)
    if schema.get("type") == "boolean":
        output_contract = (
            "Your final response MUST be exactly the lowercase JSON literal true or false. "
            "Do not use quotes, a JSON object, a Markdown fence, an explanation, or any "
            "surrounding text.\n"
        )
    else:
        output_contract = (
            "Your final response MUST be exactly one JSON value conforming to this finite "
            "schema, with no Markdown fence, explanation, surrounding text, or repeated "
            f"schema:\n{schema_text}\n"
        )
    github_access = ""
    if os.environ.get("AWF_ENCLAVE_AGENT_GITHUB_ENABLED") == "true":
        github_access = (
            " A narrow credential-isolated gh wrapper is available only for REST issue reads. "
            "Use `gh api --method GET` with repos/{owner}/{repo}/issues, "
            "repos/{owner}/{repo}/issues/{number}, or "
            "repos/{owner}/{repo}/issues/{number}/comments. GraphQL, search, writes, "
            "and other GitHub paths are unavailable."
        )
    return (
        "You are the native GitHub Copilot CLI running in an AWF enclave-agent enclave.\n"
        "The repository root is your current directory and is mounted read-only at /awf/seed. "
        "/agent and /tmp are bounded writable tmpfs storage. You may use your built-in shell, "
        "bash, file-reading, and search tools. You have no GitHub MCP, no credentials, no host "
        "filesystem, and no network route except AWF's model and optional GitHub proxies."
        f"{github_access}\n\n"
        "Complete this task:\n"
        f"{task}\n\n"
        f"{output_contract}"
    )


def normalize_copilot_output(stdout: str, schema_text: str) -> str:
    result = stdout.strip()
    result = re.sub(r"^●\s*", "", result, count=1)
    schema_suffix = schema_text.strip()
    if len(result) > len(schema_suffix) and result.endswith(schema_suffix):
        result = result[:-len(schema_suffix)].strip()
    schema = json.loads(schema_text)
    if schema.get("type") == "boolean" and result in {"True", "False"}:
        result = result.lower()
    return result


def append_engine_result(completed: subprocess.CompletedProcess) -> tuple[str, str]:
    stdout = completed.stdout.decode("utf-8", errors="replace").strip()
    stderr = completed.stderr.decode("utf-8", errors="replace")
    append_event({
        "event": "engine-result",
        "exitCode": completed.returncode,
        "stdout": truncate_utf8(redact_diagnostics(stdout), MAX_ENGINE_STREAM_BYTES),
        "stderr": truncate_utf8(redact_diagnostics(stderr), MAX_ENGINE_STREAM_BYTES),
    })
    return stdout, stderr


def main() -> int:
    if os.environ.get("AWF_ENCLAVE_AGENT_ENGINE") != "copilot":
        append_event({"event": "failure", "category": "configuration-invalid"})
        return EXIT_CONFIGURATION_INVALID
    append_progress("configuration-accepted", engine="copilot")
    try:
        task = read_bounded(TASK_PATH)
        schema_text = read_bounded(SCHEMA_PATH)
        json.loads(schema_text)
        max_output = int(os.environ["AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES"])
        timeout = int(os.environ["AWF_ENCLAVE_AGENT_DEADLINE_SECONDS"])
        model = os.environ["AWF_ENCLAVE_AGENT_MODEL"]
        max_model_requests = os.environ.get("AWF_ENCLAVE_AGENT_MAX_MODEL_REQUESTS")
        max_model_tokens = os.environ.get("AWF_ENCLAVE_AGENT_MAX_MODEL_TOKENS")
        if (
            (max_model_requests is not None and int(max_model_requests) < 1)
            or (max_model_tokens is not None and int(max_model_tokens) < 1)
        ):
            raise ValueError("invalid model limits")
    except (KeyError, OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        append_event({"event": "failure", "category": "input-invalid"})
        return EXIT_INPUT_INVALID
    append_progress(
        "input-accepted",
        taskBytes=len(task.encode("utf-8")),
        schemaBytes=len(schema_text.encode("utf-8")),
    )

    runtime_paths = [
        ("home-directory", AGENT_DIR / "home"),
        ("copilot-directory", AGENT_DIR / "copilot"),
        ("copilot-log-directory", AGENT_DIR / "copilot-logs"),
    ]
    for identifier, path in runtime_paths:
        try:
            path.mkdir(mode=0o700, exist_ok=True)
        except OSError as error:
            safe_os_error(error, f"runtime-path-creation-{identifier}")
            append_event({"event": "failure", "category": "engine-failed"})
            return EXIT_ENGINE_FAILED
    copilot_logs = runtime_paths[-1][1]
    append_progress(
        "runtime-paths-ready",
        paths=[identifier for identifier, _ in runtime_paths],
    )
    append_event({
        "event": "session",
        "engine": "copilot",
        "taskBytes": len(task.encode("utf-8")),
        "schemaBytes": len(schema_text.encode("utf-8")),
    })
    if not run_preflight(copilot_logs):
        diagnostics = read_copilot_diagnostics(copilot_logs)
        if diagnostics:
            append_event({"event": "engine-diagnostics", "log": diagnostics})
        append_event({"event": "failure", "category": "engine-failed"})
        return EXIT_ENGINE_FAILED

    command = [
        COPILOT_BIN,
        "--prompt", build_prompt(task, schema_text),
        "--model", model,
        "--silent",
        "--stream", "off",
        "--no-color",
        "--no-ask-user",
        "--no-auto-update",
        "--no-custom-instructions",
        "--no-remote",
        "--disable-builtin-mcps",
        "--allow-all-tools",
        "--allow-all-paths",
        "--log-level", "all",
        "--log-dir", str(copilot_logs),
    ]
    if max_model_requests is not None:
        command.extend(["--max-model-requests", max_model_requests])
    if max_model_tokens is not None:
        command.extend(["--max-model-tokens", max_model_tokens])
    deadline = time.monotonic() + timeout
    completed = None
    stdout = ""
    for attempt in range(MAX_STARTUP_RETRIES + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        started = time.monotonic()
        append_progress("engine-launch-attempt", attempt=attempt + 1)
        try:
            process = subprocess.Popen(
                command,
                cwd=SEED_DIR,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            append_progress("engine-started", attempt=attempt + 1)
            try:
                process_stdout, process_stderr = process.communicate(timeout=remaining)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process_stdout, process_stderr = process.communicate()
                append_event({
                    "event": "engine-result",
                    "exitCode": None,
                    "stdout": truncate_utf8(
                        redact_diagnostics(process_stdout.decode("utf-8", errors="replace").strip()),
                        MAX_ENGINE_STREAM_BYTES,
                    ),
                    "stderr": truncate_utf8(
                        redact_diagnostics(process_stderr.decode("utf-8", errors="replace")),
                        MAX_ENGINE_STREAM_BYTES,
                    ),
                })
                diagnostics = read_copilot_diagnostics(copilot_logs)
                if diagnostics:
                    append_event({"event": "engine-diagnostics", "log": diagnostics})
                append_event({"event": "failure", "category": "deadline-exceeded"})
                return EXIT_DEADLINE_EXCEEDED
            completed = subprocess.CompletedProcess(
                command,
                process.returncode,
                process_stdout,
                process_stderr,
            )
        except OSError as error:
            safe_os_error(error, "engine-launch")
            diagnostics = read_copilot_diagnostics(copilot_logs)
            if diagnostics:
                append_event({"event": "engine-diagnostics", "log": diagnostics})
            append_event({"event": "failure", "category": "engine-failed"})
            return EXIT_ENGINE_FAILED

        stdout, _ = append_engine_result(completed)
        runtime = time.monotonic() - started
        append_progress(
            "engine-completed",
            attempt=attempt + 1,
            exitCode=completed.returncode,
            runtimeMs=int(runtime * 1000),
        )
        startup_crash = (
            completed.returncode in {-signal.SIGABRT, -signal.SIGSEGV}
            and not stdout
            and runtime < STARTUP_CRASH_WINDOW_SECONDS
        )
        if not startup_crash or attempt == MAX_STARTUP_RETRIES:
            break
        append_event({
            "event": "engine-retry",
            "category": "startup-crash",
            "signal": -completed.returncode,
        })

    if completed is None:
        append_event({"event": "failure", "category": "deadline-exceeded"})
        return EXIT_DEADLINE_EXCEEDED

    if completed.returncode != 0:
        diagnostics = read_copilot_diagnostics(copilot_logs)
        if diagnostics:
            append_event({"event": "engine-diagnostics", "log": diagnostics})
        append_event({"event": "failure", "category": "engine-failed"})
        return EXIT_ENGINE_FAILED
    append_progress("output-normalization-started")
    result = normalize_copilot_output(stdout, schema_text)
    if not result or len(result.encode("utf-8")) > max_output:
        append_event({"event": "failure", "category": "result-write-failed"})
        return EXIT_RESULT_WRITE_FAILED
    append_progress("output-normalized", outputBytes=len(result.encode("utf-8")))
    append_progress("output-write-attempt")
    try:
        OUT_PATH.write_text(result, encoding="utf-8")
    except OSError as error:
        safe_os_error(error, "output-write")
        append_event({"event": "failure", "category": "result-write-failed"})
        return EXIT_RESULT_WRITE_FAILED
    append_progress("output-written", outputBytes=len(result.encode("utf-8")))
    append_event({"event": "success"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
