#!/usr/bin/env python3
"""Run the pinned native Copilot CLI inside a enclave-agent enclave."""

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
MAX_DIAGNOSTIC_BYTES = 256 * 1024
MAX_DIAGNOSTIC_FILES = 32
MAX_STARTUP_RETRIES = 2
STARTUP_CRASH_WINDOW_SECONDS = 30
EXIT_CONFIGURATION_INVALID = 10
EXIT_INPUT_INVALID = 11
EXIT_DEADLINE_EXCEEDED = 20
EXIT_ENGINE_FAILED = 24
EXIT_RESULT_WRITE_FAILED = 30


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
        relative = path.relative_to(log_dir)
        chunks.append(f"--- {relative}\n{data.decode('utf-8', errors='replace')}")
        remaining -= len(data)
        if remaining <= 0:
            break
    return redact_diagnostics("\n".join(chunks))


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
    return (
        "You are the native GitHub Copilot CLI running in an AWF enclave-agent enclave.\n"
        "The repository root is your current directory and is mounted read-only at /awf/seed. "
        "/agent and /tmp are bounded writable tmpfs storage. You may use your built-in shell, "
        "bash, file-reading, and search tools. You have no GitHub MCP, no credentials, no host "
        "filesystem, and no network route except the AWF API proxy used for model inference.\n\n"
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
        "stdout": stdout[:MAX_TRANSCRIPT_BYTES // 2],
        "stderr": stderr[:MAX_TRANSCRIPT_BYTES // 2],
    })
    return stdout, stderr


def main() -> int:
    if os.environ.get("AWF_ENCLAVE_AGENT_ENGINE") != "copilot":
        append_event({"event": "failure", "category": "configuration-invalid"})
        return EXIT_CONFIGURATION_INVALID
    try:
        task = read_bounded(TASK_PATH)
        schema_text = read_bounded(SCHEMA_PATH)
        json.loads(schema_text)
        max_output = int(os.environ["AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES"])
        timeout = int(os.environ["AWF_ENCLAVE_AGENT_DEADLINE_SECONDS"])
        model = os.environ["AWF_ENCLAVE_AGENT_MODEL"]
    except (KeyError, OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        append_event({"event": "failure", "category": "input-invalid"})
        return EXIT_INPUT_INVALID

    (AGENT_DIR / "home").mkdir(mode=0o700, exist_ok=True)
    (AGENT_DIR / "copilot").mkdir(mode=0o700, exist_ok=True)
    copilot_logs = AGENT_DIR / "copilot-logs"
    copilot_logs.mkdir(mode=0o700, exist_ok=True)
    append_event({
        "event": "session",
        "engine": "copilot",
        "model": model,
        "task": task,
        "schema": json.loads(schema_text),
    })

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
    deadline = time.monotonic() + timeout
    completed = None
    stdout = ""
    for attempt in range(MAX_STARTUP_RETRIES + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        started = time.monotonic()
        try:
            completed = subprocess.run(
                command,
                cwd=SEED_DIR,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=remaining,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            partial_stdout = (error.stdout or b"").decode("utf-8", errors="replace").strip()
            partial_stderr = (error.stderr or b"").decode("utf-8", errors="replace")
            append_event({
                "event": "engine-result",
                "exitCode": None,
                "stdout": partial_stdout[:MAX_TRANSCRIPT_BYTES // 2],
                "stderr": partial_stderr[:MAX_TRANSCRIPT_BYTES // 2],
            })
            diagnostics = read_copilot_diagnostics(copilot_logs)
            if diagnostics:
                append_event({"event": "engine-diagnostics", "log": diagnostics})
            append_event({"event": "failure", "category": "deadline-exceeded"})
            return EXIT_DEADLINE_EXCEEDED
        except OSError:
            append_event({"event": "failure", "category": "engine-failed"})
            return EXIT_ENGINE_FAILED

        stdout, _ = append_engine_result(completed)
        runtime = time.monotonic() - started
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
    result = normalize_copilot_output(stdout, schema_text)
    if not result or len(result.encode("utf-8")) > max_output:
        append_event({"event": "failure", "category": "result-write-failed"})
        return EXIT_RESULT_WRITE_FAILED
    try:
        OUT_PATH.write_text(result, encoding="utf-8")
    except OSError:
        append_event({"event": "failure", "category": "result-write-failed"})
        return EXIT_RESULT_WRITE_FAILED
    append_event({"event": "success"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
