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


class Layout:
    """The four fixed paths, threaded explicitly so `run()` stays testable."""

    def __init__(self, seed_dir, task_path, schema_path, out_path):
        # Resolved once so containment checks and relative-path reporting agree
        # even when an ancestor is a symlink.
        self.seed_dir = Path(seed_dir).resolve()
        self.task_path = Path(task_path)
        self.schema_path = Path(schema_path)
        self.out_path = Path(out_path)

# Fixed local tool bounds. Not configurable, and never caller-supplied.
MAX_LIST_ENTRIES = 200
MAX_READ_BYTES = 8192
MAX_SEARCH_RESULTS = 40
MAX_SEARCH_PATTERN = 200
MAX_TOOL_RESULT_BYTES = 12000
HTTP_TIMEOUT_SECONDS = 60


def _fail() -> "int":
    """Exits without writing a result. The broker maps this to canonical ERROR."""
    return 1


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
        if not path.is_file():
            continue
        try:
            text = path.read_bytes()[:MAX_READ_BYTES].decode("utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if matcher.search(line):
                results.append(f"{path.relative_to(layout.seed_dir)}:{lineno}")
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


def system_prompt(schema_text: str) -> str:
    return (
        "You are a bounded analysis agent running inside an isolated enclave.\n"
        "You can read one private repository at /awf/seed through the provided "
        "read-only tools. You have no network access other than this API, no shell, "
        "no write access, and no host access.\n\n"
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

    def initial_messages(self, schema_text: str, task: str) -> list:
        return [
            {"role": "system", "content": system_prompt(schema_text)},
            {"role": "user", "content": task},
        ]

    def request(self, messages: list) -> dict:
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "tools": [
                {"type": "function", "function": tool} for tool in TOOL_DESCRIPTIONS
            ],
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


class AnthropicProfile:
    """Narrow Anthropic-compatible messages loop."""

    def __init__(self, endpoint: str, model: str, max_tokens: int) -> None:
        self.url = f"{endpoint}/v1/messages"
        self.model = model
        self.max_tokens = max_tokens
        self.system = ""

    def initial_messages(self, schema_text: str, task: str) -> list:
        self.system = system_prompt(schema_text)
        return [{"role": "user", "content": task}]

    def request(self, messages: list) -> dict:
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
                for tool in TOOL_DESCRIPTIONS
            ],
        }
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
        return _fail()

    max_requests = _env_int("AWF_BOUNDED_AGENT_MAX_MODEL_REQUESTS", 8)
    max_tokens = _env_int("AWF_BOUNDED_AGENT_MAX_MODEL_TOKENS", 1024)
    max_output_bytes = _env_int("AWF_BOUNDED_AGENT_MAX_OUTPUT_BYTES", 8192)
    deadline = time.monotonic() + _env_int("AWF_BOUNDED_AGENT_DEADLINE_SECONDS", 120)

    try:
        task = layout.task_path.read_text(encoding="utf-8")
        schema_text = layout.schema_path.read_text(encoding="utf-8")
        json.loads(schema_text)
    except (OSError, ValueError):
        return _fail()

    profile = build_profile(endpoint, model, max_tokens)
    if profile is None:
        return _fail()

    messages = profile.initial_messages(schema_text, task)

    for _ in range(max_requests):
        if time.monotonic() >= deadline:
            return _fail()
        try:
            response = profile.request(messages)
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError, TimeoutError):
            return _fail()

        appended, calls = profile.parse(response)
        messages.extend(appended)
        if not calls:
            # A model that stops calling tools without finishing produces no
            # result; the broker reports the canonical error.
            return _fail()

        results = []
        for call_id, name, args in calls:
            if name == "finish":
                if write_result(layout, args.get("result"), max_output_bytes):
                    return 0
                return _fail()
            handler = LOCAL_TOOLS.get(name)
            if handler is None:
                results.append((call_id, name, "error: unknown tool"))
                continue
            try:
                output = handler(layout, args)
            except Exception:  # noqa: BLE001 - never leak a traceback
                output = "error: tool failed"
            results.append((call_id, name, output[:MAX_TOOL_RESULT_BYTES]))

        messages.extend(profile.tool_result_messages(results))

    return _fail()


def main() -> int:
    """Entry point. Uses only the fixed mount points; nothing is configurable."""
    return run(Layout(SEED_DIR, TASK_PATH, SCHEMA_PATH, OUT_PATH))


if __name__ == "__main__":
    sys.exit(main())
