#!/usr/bin/env python3
"""Fixed AWF bounded-agent enclave bootstrap.

This is the *only* program that ever runs inside a bounded-agent enclave. It is
authored by AWF, baked into the image, and mounted nowhere: a request cannot
replace it, extend it, or pass it arguments.

What it does, in order:

  1. reads the caller's byte-bounded task text and finite response schema from
     fixed read-only paths;
  2. runs a small, fixed model loop against the AWF API proxy — the enclave's
     only reachable peer — using the trusted profile/model chosen by AWF
     configuration;
  3. exposes exactly three local, read-only repository tools plus one terminal
     "finish" tool. There is no shell, no network tool, no write tool, no
     package installation, and no way to add a tool;
  4. writes the final answer, and nothing else, as a single JSON value to the
     dedicated bounded result file.

It deliberately holds no credentials: the API proxy injects the real key. It
never prints repository contents, task text, model output, or provider payloads
to stdout/stderr — the broker discards those streams anyway, so anything written
there would only be a latent leak if that ever changed.

Standard library only.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Fixed mount points. `main()` uses only these; they are never derived from the
# environment, from the task, or from anything a request can influence.
SEED_DIR = Path("/awf/seed")
TASK_PATH = Path("/awf/task.txt")
SCHEMA_PATH = Path("/awf/schema.json")
OUT_PATH = Path("/agent/out")
SESSION_LOG_PATH = Path("/agent/session.jsonl")


class Layout:
    """The four fixed paths, threaded explicitly so `run()` stays testable."""

    def __init__(self, seed_dir, task_path, schema_path, out_path, session_log_path):
        # Resolved once so containment checks and relative-path reporting agree
        # even when an ancestor is a symlink.
        self.seed_dir = Path(seed_dir).resolve()
        self.task_path = Path(task_path)
        self.schema_path = Path(schema_path)
        self.out_path = Path(out_path)
        self.session_log_path = Path(session_log_path)

# Fixed local tool bounds. Not configurable, and never caller-supplied.
MAX_LIST_ENTRIES = 200
MAX_READ_BYTES = 8192
MAX_SEARCH_RESULTS = 40
MAX_SEARCH_PATTERN = 200
MAX_TOOL_RESULT_BYTES = 12000
HTTP_TIMEOUT_SECONDS = 60
MAX_SESSION_LOG_BYTES = 1024 * 1024
EXIT_CONFIGURATION_INVALID = 10
EXIT_INPUT_INVALID = 11
EXIT_DEADLINE_EXCEEDED = 20
EXIT_PROVIDER_HTTP_ERROR = 21
EXIT_PROVIDER_TRANSPORT_ERROR = 22
EXIT_PROVIDER_RESPONSE_INVALID = 23
EXIT_RESULT_WRITE_FAILED = 30
EXIT_MODEL_LOOP_EXHAUSTED = 31


def _fail(code: int) -> "int":
    """Exits with one fixed diagnostic code and without writing a result."""
    return code


def _session_event(layout: Layout, event: dict) -> None:
    """Appends one bounded transcript event without headers or credentials."""
    try:
        encoded = (json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        if len(encoded) > MAX_SESSION_LOG_BYTES:
            return
        current_size = layout.session_log_path.stat().st_size
        if current_size + len(encoded) > MAX_SESSION_LOG_BYTES:
            return
        with open(layout.session_log_path, "ab") as handle:
            handle.write(encoded)
    except (OSError, TypeError, ValueError):
        pass


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _safe_repo_path(layout: Layout, relative: str) -> "Path | None":
    """Resolves a model-supplied path strictly inside the read-only seed."""
    if not isinstance(relative, str) or len(relative) > 4096:
        return None
    candidate = (layout.seed_dir / relative.lstrip("/")).resolve()
    try:
        candidate.relative_to(layout.seed_dir)
    except ValueError:
        return None
    return candidate


def tool_list_files(layout: Layout, args: dict) -> str:
    target = _safe_repo_path(layout, args.get("path", "."))
    if target is None or not target.is_dir():
        return "error: not a directory inside the repository"
    entries = []
    for entry in sorted(target.iterdir())[:MAX_LIST_ENTRIES]:
        kind = "dir" if entry.is_dir() else "file"
        entries.append(f"{kind} {entry.relative_to(layout.seed_dir)}")
    return "\n".join(entries) if entries else "(empty)"


def tool_read_file(layout: Layout, args: dict) -> str:
    target = _safe_repo_path(layout, args.get("path", ""))
    if target is None or not target.is_file():
        return "error: not a file inside the repository"
    try:
        data = target.read_bytes()[:MAX_READ_BYTES]
    except OSError:
        return "error: unreadable"
    return data.decode("utf-8", errors="replace")


def tool_search(layout: Layout, args: dict) -> str:
    pattern = args.get("pattern", "")
    if not isinstance(pattern, str) or not pattern or len(pattern) > MAX_SEARCH_PATTERN:
        return "error: invalid pattern"
    root = _safe_repo_path(layout, args.get("path", "."))
    if root is None or not root.is_dir():
        return "error: not a directory inside the repository"
    needle = re.escape(pattern)
    matcher = re.compile(needle)
    results = []
    for path in sorted(root.rglob("*")):
        if len(results) >= MAX_SEARCH_RESULTS:
            break
        try:
            relative_path = path.relative_to(layout.seed_dir)
        except ValueError:
            continue
        target = _safe_repo_path(layout, str(relative_path))
        if target is None or not target.is_file():
            continue
        try:
            text = target.read_bytes()[:MAX_READ_BYTES].decode("utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if matcher.search(line):
                results.append(f"{relative_path}:{lineno}")
                break
    return "\n".join(results) if results else "(no matches)"


LOCAL_TOOLS = {
    "list_files": tool_list_files,
    "read_file": tool_read_file,
    "search": tool_search,
}

TOOL_DESCRIPTIONS = [
    {
        "name": "list_files",
        "description": "List entries of a directory inside the read-only repository.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "read_file",
        "description": (
            "Read up to %d bytes of a file inside the read-only repository." % MAX_READ_BYTES
        ),
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "search",
        "description": "Find files containing a literal substring inside the read-only repository.",
        "parameters": {
            "type": "object",
            "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}},
            "required": ["pattern"],
        },
    },
    {
        "name": "finish",
        "description": (
            "Record the final answer. `result` must conform exactly to the declared "
            "response schema. Calling this ends the task."
        ),
        "parameters": {
            "type": "object",
            "properties": {"result": {}},
            "required": ["result"],
        },
    },
]


def _provider_result_schema(schema: dict) -> dict:
    """Converts the finite-disclosure schema into provider tool JSON Schema."""
    schema_type = schema["type"]
    if schema_type == "const":
        return {"const": schema["value"]}
    if schema_type == "boolean":
        return {"type": "boolean"}
    if schema_type == "enum":
        return {"enum": schema["values"]}
    if schema_type == "integer":
        return {
            "type": "integer",
            "minimum": schema["minimum"],
            "maximum": schema["maximum"],
        }
    if schema_type == "object":
        fields = schema["fields"]
        return {
            "type": "object",
            "properties": {
                name: _provider_result_schema(child) for name, child in fields.items()
            },
            "required": list(fields),
            "additionalProperties": False,
        }
    if schema_type == "tuple":
        items = [_provider_result_schema(item) for item in schema["items"]]
        return {
            "type": "array",
            "prefixItems": items,
            "minItems": len(items),
            "maxItems": len(items),
        }
    if schema_type == "array":
        length = schema["length"]
        return {
            "type": "array",
            "items": _provider_result_schema(schema["items"]),
            "minItems": length,
            "maxItems": length,
        }
    if schema_type == "union":
        return {
            "oneOf": [
                {
                    "type": "object",
                    "properties": {
                        "tag": {"const": tag},
                        "value": _provider_result_schema(child),
                    },
                    "required": ["tag", "value"],
                    "additionalProperties": False,
                }
                for tag, child in schema["variants"].items()
            ]
        }
    raise ValueError("unsupported finite-disclosure schema")


def tool_descriptions(schema_text: str) -> list:
    """Binds the caller's validated finite schema to the terminal finish tool."""
    result_schema = _provider_result_schema(json.loads(schema_text))
    return TOOL_DESCRIPTIONS[:-1] + [
        {
            "name": "finish",
            "description": TOOL_DESCRIPTIONS[-1]["description"],
            "parameters": {
                "type": "object",
                "properties": {"result": result_schema},
                "required": ["result"],
                "additionalProperties": False,
            },
        }
    ]


def system_prompt(schema_text: str) -> str:
    return (
        "You are a bounded analysis agent running inside an isolated enclave.\n"
        "Mount points: one private repository is mounted read-only at /awf/seed; "
        "/agent is private invocation state managed by AWF; /tmp is ephemeral. "
        "Only the provided read-only repository tools can access repository content. "
        "Their `path` arguments are relative to /awf/seed: use `.` for the repository "
        "root, `go.mod` for a root file, and `src/file.py` for a nested file. Never "
        "include `/awf/seed` in a tool path. You have no network access other than "
        "this API, no shell, no write access, and no host access.\n\n"
        "Answer the user's task by calling tools, then call `finish` exactly once "
        "with a `result` that conforms EXACTLY to this finite response schema:\n"
        f"{schema_text}\n\n"
        "Schema semantics: `const` is one fixed value; `boolean` is true/false; "
        "`enum` values are the only permitted values; `integer` is an inclusive "
        "bounded range; `object` requires every declared field and no others; "
        "`tuple`/`array` are fixed length; `union` values are "
        '{\"tag\":..., \"value\":...}. Free-form prose is never a valid result.\n'
        "Do not explain your reasoning in the final answer. Never emit anything "
        "except tool calls and the final `finish` call."
    )


def _post_json(url: str, payload: dict, headers: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("content-type", "application/json")
    for key, value in headers.items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


class OpenAiProfile:
    """Narrow OpenAI-compatible chat-completions loop."""

    def __init__(self, endpoint: str, model: str, max_tokens: int) -> None:
        self.url = f"{endpoint}/v1/chat/completions"
        self.model = model
        self.max_tokens = max_tokens
        self.tools = TOOL_DESCRIPTIONS

    def initial_messages(self, schema_text: str, task: str) -> list:
        self.tools = tool_descriptions(schema_text)
        return [
            {"role": "system", "content": system_prompt(schema_text)},
            {"role": "user", "content": task},
        ]

    def request(self, messages: list, force_finish: bool = False) -> dict:
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "tools": [
                {"type": "function", "function": tool} for tool in self.tools
            ],
        }
        if force_finish:
            payload["tool_choice"] = {
                "type": "function",
                "function": {"name": "finish"},
            }
        return _post_json(self.url, payload, {})

    def parse(self, response: dict) -> "tuple[list, list]":
        """Returns (assistant message to append, list of (id, name, args))."""
        choices = response.get("choices") or []
        if not choices:
            return [], []
        message = choices[0].get("message") or {}
        calls = []
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            try:
                args = json.loads(function.get("arguments") or "{}")
            except (TypeError, ValueError):
                args = {}
            if not isinstance(args, dict):
                args = {}
            calls.append((call.get("id") or "", function.get("name") or "", args))
        return [message], calls

    def tool_result_messages(self, results: list) -> list:
        return [
            {"role": "tool", "tool_call_id": call_id, "content": content}
            for call_id, _name, content in results
        ]

    def finish_recovery_messages(self) -> list:
        return [{"role": "user", "content": "Call `finish` now with the finite result."}]

    def repository_recovery_messages(self) -> list:
        return [{"role": "user", "content": "Inspect the repository with a read-only tool before answering."}]


class AnthropicProfile:
    """Narrow Anthropic-compatible messages loop."""

    def __init__(self, endpoint: str, model: str, max_tokens: int) -> None:
        self.url = f"{endpoint}/v1/messages"
        self.model = model
        self.max_tokens = max_tokens
        self.system = ""
        self.tools = TOOL_DESCRIPTIONS

    def initial_messages(self, schema_text: str, task: str) -> list:
        self.system = system_prompt(schema_text)
        self.tools = tool_descriptions(schema_text)
        return [{"role": "user", "content": task}]

    def request(self, messages: list, force_finish: bool = False) -> dict:
        payload = {
            "model": self.model,
            "system": self.system,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "tools": [
                {
                    "name": tool["name"],
                    "description": tool["description"],
                    "input_schema": tool["parameters"],
                }
                for tool in self.tools
            ],
        }
        if force_finish:
            payload["tool_choice"] = {"type": "tool", "name": "finish"}
        return _post_json(self.url, payload, {"anthropic-version": "2023-06-01"})

    def parse(self, response: dict) -> "tuple[list, list]":
        content = response.get("content") or []
        calls = []
        for block in content:
            if block.get("type") == "tool_use":
                args = block.get("input")
                if not isinstance(args, dict):
                    args = {}
                calls.append((block.get("id") or "", block.get("name") or "", args))
        return [{"role": "assistant", "content": content}], calls

    def tool_result_messages(self, results: list) -> list:
        return [
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": call_id, "content": content}
                    for call_id, _name, content in results
                ],
            }
        ]

    def finish_recovery_messages(self) -> list:
        return [{"role": "user", "content": "Call `finish` now with the finite result."}]

    def repository_recovery_messages(self) -> list:
        return [{"role": "user", "content": "Inspect the repository with a read-only tool before answering."}]


def build_profile(endpoint: str, model: str, max_tokens: int):
    profile = os.environ.get("AWF_BOUNDED_AGENT_PROFILE", "")
    if profile == "anthropic":
        return AnthropicProfile(endpoint, model, max_tokens)
    if profile == "openai":
        return OpenAiProfile(endpoint, model, max_tokens)
    return None


def write_result(layout: Layout, value, max_output_bytes: int) -> bool:
    """Writes exactly one JSON value to the dedicated bounded result file."""
    try:
        encoded = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError):
        return False
    if len(encoded) > max_output_bytes:
        return False
    try:
        with open(layout.out_path, "wb") as handle:
            handle.write(encoded)
    except OSError:
        return False
    return True


def run(layout: Layout) -> int:
    """Runs one bounded-agent invocation against the given fixed layout."""
    endpoint = os.environ.get("AWF_BOUNDED_AGENT_API_ENDPOINT", "")
    model = os.environ.get("AWF_BOUNDED_AGENT_MODEL", "")
    if not endpoint or not model:
        return _fail(EXIT_CONFIGURATION_INVALID)

    max_requests = _env_int("AWF_BOUNDED_AGENT_MAX_MODEL_REQUESTS", 8)
    max_tokens = _env_int("AWF_BOUNDED_AGENT_MAX_MODEL_TOKENS", 1024)
    max_output_bytes = _env_int("AWF_BOUNDED_AGENT_MAX_OUTPUT_BYTES", 8192)
    deadline = time.monotonic() + _env_int("AWF_BOUNDED_AGENT_DEADLINE_SECONDS", 120)

    try:
        task = layout.task_path.read_text(encoding="utf-8")
        schema_text = layout.schema_path.read_text(encoding="utf-8")
        json.loads(schema_text)
    except (OSError, ValueError):
        _session_event(layout, {"event": "failure", "category": "input-invalid"})
        return _fail(EXIT_INPUT_INVALID)

    profile = build_profile(endpoint, model, max_tokens)
    if profile is None:
        _session_event(layout, {"event": "failure", "category": "configuration-invalid"})
        return _fail(EXIT_CONFIGURATION_INVALID)

    _session_event(layout, {
        "event": "session",
        "profile": os.environ.get("AWF_BOUNDED_AGENT_PROFILE", ""),
        "model": model,
        "task": task,
        "schema": json.loads(schema_text),
    })
    messages = profile.initial_messages(schema_text, task)
    force_finish = False
    repository_tool_called = False

    for _ in range(max_requests):
        if time.monotonic() >= deadline:
            _session_event(layout, {"event": "failure", "category": "deadline-exceeded"})
            return _fail(EXIT_DEADLINE_EXCEEDED)
        try:
            response = profile.request(messages, force_finish)
        except urllib.error.HTTPError as error:
            _session_event(layout, {
                "event": "failure",
                "category": "provider-http-error",
                "status": error.code,
            })
            return _fail(EXIT_PROVIDER_HTTP_ERROR)
        except (urllib.error.URLError, OSError, TimeoutError):
            _session_event(layout, {"event": "failure", "category": "provider-transport-error"})
            return _fail(EXIT_PROVIDER_TRANSPORT_ERROR)
        except ValueError:
            _session_event(layout, {"event": "failure", "category": "provider-response-invalid"})
            return _fail(EXIT_PROVIDER_RESPONSE_INVALID)

        _session_event(layout, {"event": "provider-response", "response": response})
        appended, calls = profile.parse(response)
        messages.extend(appended)
        if not calls:
            if repository_tool_called:
                messages.extend(profile.finish_recovery_messages())
                force_finish = True
            else:
                messages.extend(profile.repository_recovery_messages())
                force_finish = False
            continue
        force_finish = False

        results = []
        for call_id, name, args in calls:
            if name == "finish":
                if not repository_tool_called:
                    results.append((call_id, name, "error: inspect repository before finishing"))
                    continue
                if write_result(layout, args.get("result"), max_output_bytes):
                    _session_event(layout, {"event": "success"})
                    return 0
                _session_event(layout, {"event": "failure", "category": "result-write-failed"})
                return _fail(EXIT_RESULT_WRITE_FAILED)
            handler = LOCAL_TOOLS.get(name)
            if handler is None:
                results.append((call_id, name, "error: unknown tool"))
                continue
            repository_tool_called = True
            try:
                output = handler(layout, args)
            except Exception:  # noqa: BLE001 - never leak a traceback
                output = "error: tool failed"
            _session_event(layout, {
                "event": "tool-result",
                "callId": call_id,
                "name": name,
                "arguments": args,
                "output": output[:MAX_TOOL_RESULT_BYTES],
            })
            results.append((call_id, name, output[:MAX_TOOL_RESULT_BYTES]))

        messages.extend(profile.tool_result_messages(results))

    _session_event(layout, {"event": "failure", "category": "model-loop-exhausted"})
    return _fail(EXIT_MODEL_LOOP_EXHAUSTED)


def main() -> int:
    """Entry point. Uses only the fixed mount points; nothing is configurable."""
    return run(Layout(SEED_DIR, TASK_PATH, SCHEMA_PATH, OUT_PATH, SESSION_LOG_PATH))


if __name__ == "__main__":
    sys.exit(main())
