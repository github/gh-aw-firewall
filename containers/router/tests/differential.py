"""Compare the Python and Go CLIs on the same requests and routing tables.

A temporary check for the Go port: the image cut-over deletes it along with Python. It runs
the Python CLI in process and the Go binary as a subprocess on the contract corpus requests,
requests built from the parity fixtures and a seeded set of generated requests, and fails on
any difference in exit status, stderr prefix or stdout JSON. The only differences allowed
are the fixture cases the Go tests record as decisions (see tests/fixtures/parity/README.md).
Run from containers/router after building the Go CLI:

    go -C go build -o gh-aw-router .
    python tests/differential.py --go-cli go/gh-aw-router
"""

from __future__ import annotations

import argparse
import base64
import functools
import io
import json
import os
import random
import subprocess
import sys
import tempfile
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from unittest import mock

from contract_corpus import contract_tables, load_cases, request_bytes
from pydantic import TypeAdapter

from gh_aw_router import cli, routing
from gh_aw_router.contracts import Message
from gh_aw_router.routing_table import PROFILES
from gh_aw_router.service import GhAwRouterService

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PARITY_DIRECTORY = Path(__file__).parent / "fixtures" / "parity"
CONVERSATION = TypeAdapter(tuple[Message, ...])
EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
GOALS = ("cost", "cost-speed")
MODES = ("economy", "balanced", "robust", "auto")
RECOMMENDATIONS = ("economy", "balanced", "robust", "unknown")
TASK_TYPES = ("explain", "plan", "fix", "refactor", "chore", "implement", "unknown")
SCOPES = ("local", "multi_file", "subsystem", "cross_system", "unknown")
COMPLEXITIES = ("trivial", "easy", "medium", "hard", "expert", "unknown")
EXTRA_CHARACTERS = "!?.,;:'\"-_/()[]{}#*`~\u0301\u200d\u00ad🙂🚀𝔣𝔦𝔵修复Ωσ"
FOLLOW_UP_TEXT = "Fix this"

# Fixture cases whose Go result is a recorded decision; they mirror the known-differences
# maps in go/heuristics_test.go and go/parity_test.go.
ALLOWED: dict[str, frozenset[str]] = {
    "labels": frozenset(
        [
            f"unassigned-{where}-{code}"
            for where in ("after-lead", "before-cue")
            for code in ("10D40", "10D50", "16100", "1CCF0", "1E5D0", "A7CB")
        ]
        + ["casefold-ligature", "casefold-long-s", "casefold-sharp-s", "casefold-dotted-i"]
    ),
    "decoding": frozenset(
        {
            "tool-input-nan",
            "tool-input-infinity",
            "tool-input-negative-infinity",
            "context-window-nan",
            "limit-depth-arrays-over",
            "limit-depth-arrays-scalar-over",
            "limit-depth-objects-scalar-over",
            "limit-digits-over",
            "limit-digits-negative-over",
            "context-window-digit-limit-over",
        }
    ),
    "context": frozenset(
        f"token-float-{name}" for name in ("nan", "infinity", "negative-infinity")
    ),
}


@dataclass(frozen=True)
class Request:
    """One CLI invocation: a command, a routing table directory and the request body."""

    name: str
    command: str
    tables: Path
    body: bytes
    allowed: bool = False


@dataclass(frozen=True)
class TableSet:
    name: str
    path: Path
    pairs: tuple[tuple[str, str | None], ...]


Outcome = tuple[int, str, object]


def json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def load_table_set(name: str, path: Path) -> TableSet:
    table = GhAwRouterService.load(path).primary_table
    pairs = tuple(
        (pair.model, None if pair.effort is None else pair.effort.value) for pair in table.pairs
    )
    return TableSet(name, path, pairs)


def write_tables(directory: Path, files: dict[str, bytes]) -> Path:
    directory.mkdir(parents=True)
    for name, data in files.items():
        (directory / name).write_bytes(data)
    return directory


def offers(table_set: TableSet, *, windows: dict[int, int] | None = None) -> list[dict[str, Any]]:
    """Offer every catalogue pair, with optional context windows by position."""
    result = []
    for index, (model, effort) in enumerate(table_set.pairs):
        candidate: dict[str, Any] = {"id": f"m{index}", "model": model}
        if effort is not None:
            candidate["effort"] = effort
        if windows and index in windows:
            candidate["context_window"] = windows[index]
        result.append(candidate)
    return result


def choices(table_set: TableSet) -> list[dict[str, Any]]:
    return [{k: v for k, v in c.items() if k != "context_window"} for c in offers(table_set)]


def objective(index: int) -> dict[str, str]:
    profile = PROFILES[index % len(PROFILES)]
    return profile.model_dump(mode="json")


def splice(conversation_json: str, **fields: object) -> bytes:
    """Build a request around conversation JSON text, keeping its exact number spellings."""
    rest = "".join(f',"{key}":{json_bytes(value).decode()}' for key, value in fields.items())
    return f'{{"conversation":{conversation_json}{rest}}}'.encode()


def planning_requests(
    name: str, conversation_json: str, table_sets: list[TableSet], *, allowed: bool, index: int
) -> list[Request]:
    """Route and classify one conversation, given as JSON text, over each table set."""
    requests = []
    for table_set in table_sets:
        bodies = {
            "route": splice(
                conversation_json, models=offers(table_set), objective=objective(index)
            ),
            "classify": splice(conversation_json, models=choices(table_set)),
        }
        requests += [
            Request(f"{name} {command} {table_set.name}", command, table_set.path, body, allowed)
            for command, body in bodies.items()
        ]
    return requests


def fixture(kind: str) -> list[dict[str, Any]]:
    return json.loads((PARITY_DIRECTORY / f"{kind}.json").read_bytes())["cases"]


def user_turn(text: str) -> dict[str, Any]:
    return {"role": "user", "parts": [{"text": text}]}


def label_requests(table_sets: list[TableSet]) -> list[Request]:
    requests = []
    for index, case in enumerate(fixture("labels")):
        allowed = case["id"] in ALLOWED["labels"]
        conversation = json_bytes([user_turn(case["text"])]).decode()
        requests += planning_requests(
            f"labels/{case['id']}", conversation, table_sets, allowed=allowed, index=index
        )
    return requests


def decoding_requests(table_sets: list[TableSet]) -> list[Request]:
    requests = []
    for case in fixture("decoding"):
        if "request" in case:
            body = json_bytes(case["request"])
        elif "body" in case:
            body = case["body"].encode("utf-8")
        else:
            body = base64.b64decode(case["body_base64"], validate=True)
        allowed = case["id"] in ALLOWED["decoding"]
        requests += [
            Request(f"decoding/{case['id']} route {t.name}", "route", t.path, body, allowed)
            for t in table_sets
        ]
    return requests


def context_requests(table_sets: list[TableSet]) -> list[Request]:
    """Route each context conversation with candidates on either side of its window minimum."""
    requests = []
    follow_up = json_bytes(user_turn(FOLLOW_UP_TEXT)).decode()
    for index, case in enumerate(fixture("context")):
        text = case.get("conversation_text") or json_bytes(case["conversation"]).decode()
        inner = text.strip()[1:-1].strip()
        conversation = f"[{inner},{follow_up}]" if inner else f"[{follow_up}]"
        characters = case["expect"]["characters"] + len(FOLLOW_UP_TEXT)
        tokens = -(-characters // routing.CHARACTERS_PER_TOKEN)
        minimum = tokens + routing.WINDOW_HEADROOM_TOKENS
        allowed = case["id"] in ALLOWED["context"]
        for table_set in table_sets:
            models = offers(table_set, windows={0: minimum - 1, 1: minimum})
            body = splice(conversation, models=models, objective=objective(index))
            name = f"context/{case['id']} route {table_set.name}"
            requests.append(Request(name, "route", table_set.path, body, allowed))
    return requests


def classification_requests(table_sets: list[TableSet]) -> list[Request]:
    requests = []
    for index, case in enumerate(fixture("classification")):
        conversation = json_bytes(case["conversation"]).decode()
        requests += planning_requests(
            f"classification/{case['id']}", conversation, table_sets, allowed=False, index=index
        )
    return requests


def contract_requests(contract_files: dict[str, bytes], scratch: Path) -> list[Request]:
    requests = []
    for case in load_cases():
        if case["method"] != "POST" or "headers" in case:
            continue
        names = sorted(case.get("profiles", contract_files))
        directory = scratch / ("contract-" + "-".join(name.removesuffix(".json") for name in names))
        if not directory.exists():
            write_tables(directory, {name: contract_files[name] for name in names})
        command = case["path"].removeprefix("/")
        requests.append(Request(f"contract/{case['id']}", command, directory, request_bytes(case)))
    return requests


# Generated requests ---------------------------------------------------------------------------


def safe_character(character: str) -> bool:
    """Leave out characters covered by the casefold and Unicode-version decisions."""
    return (
        unicodedata.category(character) not in {"Cn", "Cs", "Co"}
        and character.casefold() == character.lower()
        and len(character.lower()) == 1
    )


def range_characters(name: str) -> list[str]:
    ranges = json.loads((PARITY_DIRECTORY / "unicode" / f"{name}.json").read_bytes())["ranges"]
    characters = []
    for item in ranges:
        low, high = (int(bound, 16) for bound in item.split("-"))
        characters += [chr(code) for code in range(low, high + 1)]
    return [character for character in characters if safe_character(character)]


class Generator:
    """Build seeded requests mixing cue words with whitespace, word and astral characters."""

    def __init__(self, seed: int, table_sets: list[TableSet]) -> None:
        self.random = random.Random(seed)  # noqa: S311 - reproducible test data, not secrets
        self.table_sets = table_sets
        self.whitespace = range_characters("whitespace")
        self.word = self.random.sample(range_characters("word"), 400)
        self.extra = [character for character in EXTRA_CHARACTERS if safe_character(character)]
        vocabulary = {
            word
            for case in fixture("labels")
            for word in case["text"].lower().split()
            if word.isascii() and word.isalpha()
        }
        self.vocabulary = sorted(vocabulary)

    def choice(self, values: tuple[str, ...], invalid: str) -> str:
        """Pick a valid value, or occasionally one the contract rejects."""
        return invalid if self.random.random() < 0.03 else self.random.choice(values)

    def token(self) -> str:
        roll = self.random.random()
        if roll < 0.7:
            word = self.random.choice(self.vocabulary)
            return self.random.choice((word, word.upper(), word.title()))
        pool = self.word if roll < 0.9 else self.extra
        return "".join(self.random.choices(pool, k=self.random.randint(1, 3)))

    def text(self) -> str:
        parts = []
        for _ in range(self.random.randint(0, 12)):
            parts.append(self.token())
            separator = (
                " " if self.random.random() < 0.8 else self.random.choice([*self.whitespace, ""])
            )
            parts.append(separator)
        prefix = self.random.choice(("", "", "please ", "Could you ", "PLEASE  kindly "))
        return prefix + "".join(parts)

    def number(self) -> int | float:
        if self.random.random() < 0.5:
            return self.random.randint(-(2**53) + 1, 2**53 - 1)
        # Short non-integral floats print the same way in both languages.
        return self.random.randrange(-4_000_001, 4_000_001, 2) / 4

    def value(self, depth: int = 0) -> object:
        kind = self.random.choice(
            ("text", "number", "bool", "null", "list", "object")
            if depth < 3
            else ("text", "number")
        )
        if kind == "text":
            return self.text()
        if kind == "number":
            return self.number()
        if kind == "bool":
            return self.random.random() < 0.5
        if kind == "null":
            return None
        if kind == "list":
            return [self.value(depth + 1) for _ in range(self.random.randint(0, 3))]
        return {self.text()[:12]: self.value(depth + 1) for _ in range(self.random.randint(0, 3))}

    def part(self) -> dict[str, Any]:
        roll = self.random.random()
        if roll < 0.7:
            return {"text": self.text()}
        if roll < 0.85:
            call: dict[str, Any] = {
                "id": "call",
                "name": self.random.choice(("read", "bash", "édit")),
            }
            if self.random.random() < 0.8:
                call["input"] = self.value()
            return {"tool_call": call}
        result: dict[str, Any] = {"id": "call"}
        if self.random.random() < 0.5:
            result["ok"] = self.random.random() < 0.5
        if self.random.random() < 0.8:
            result["text"] = self.text()
        return {"tool_result": result}

    def conversation(self) -> list[dict[str, Any]]:
        messages = []
        for _ in range(self.random.randint(0, 3)):
            role = self.random.choice(("system", "user", "assistant"))
            messages.append(
                {"role": role, "parts": [self.part() for _ in range(self.random.randint(1, 3))]}
            )
        # Most requests end with an authored user turn so they reach labelling and ranking.
        if not messages or self.random.random() < 0.9:
            messages.append(user_turn(self.text() or "Fix this"))
        return messages

    def candidates(self, table_set: TableSet, minimum: int) -> list[dict[str, Any]]:
        pairs = self.random.sample(
            table_set.pairs, min(len(table_set.pairs), self.random.randint(1, 8))
        )
        if self.random.random() < 0.2:
            pairs.append(("provider/unknown", None))
        result = []
        for index, (model, effort) in enumerate(pairs):
            candidate: dict[str, Any] = {"id": f"c{index}", "model": model}
            if effort is not None and self.random.random() < 0.9:
                candidate["effort"] = effort
            elif self.random.random() < 0.2:
                candidate["effort"] = self.choice(EFFORTS, "turbo")
            if self.random.random() < 0.4:
                candidate["context_window"] = minimum + self.random.choice((-1, 0, 1, 100_000))
            result.append(candidate)
        return result

    def request(self, index: int) -> Request:
        table_set = self.random.choice(self.table_sets)
        conversation = self.conversation()
        minimum = (
            routing.estimate_context_tokens(CONVERSATION.validate_python(conversation))
            + routing.WINDOW_HEADROOM_TOKENS
        )
        candidates = self.candidates(table_set, minimum)
        if self.random.random() < 0.3:
            plan = {
                "conversation": conversation,
                "models": [
                    {k: v for k, v in c.items() if k != "context_window"} for c in candidates
                ],
            }
            return Request(
                f"generated/{index} classify {table_set.name}",
                "classify",
                table_set.path,
                json_bytes(plan),
            )
        body: dict[str, Any] = {
            "conversation": conversation,
            "models": candidates,
            "objective": {"goal": self.choice(GOALS, "speed"), "mode": self.random.choice(MODES)},
        }
        if candidates and self.random.random() < 0.3:
            body["current_id"] = self.random.choice([*(c["id"] for c in candidates), "absent"])
        if self.random.random() < 0.4:
            body["classification"] = {
                "labels": {
                    "task_type": self.random.choice(TASK_TYPES),
                    "scope": self.random.choice(SCOPES),
                    "task_complexity": self.random.choice(COMPLEXITIES),
                },
                "mode": self.random.choice(RECOMMENDATIONS),
            }
        return Request(
            f"generated/{index} route {table_set.name}", "route", table_set.path, json_bytes(body)
        )


# Running and comparing ------------------------------------------------------------------------


def outcome(code: int, stdout: str, stderr: str) -> Outcome:
    try:
        output: object = json.loads(stdout) if stdout else None
    except ValueError:
        output = stdout
    return code, stderr.split(":", 1)[0], output


def run_python(request: Request) -> Outcome:
    stdin = io.TextIOWrapper(io.BytesIO(request.body), encoding="utf-8")
    stdout, stderr = io.StringIO(), io.StringIO()
    code = cli.run(
        ["--routing-tables", str(request.tables), request.command],
        stdin=stdin,
        stdout=stdout,
        stderr=stderr,
    )
    return outcome(code, stdout.getvalue(), stderr.getvalue())


def run_go(go_cli: Path, request: Request) -> Outcome:
    completed = subprocess.run(  # noqa: S603 - the binary under test, with fixed arguments
        [str(go_cli), "--routing-tables", str(request.tables), request.command],
        input=request.body,
        capture_output=True,
        timeout=60,
        check=False,
    )
    return outcome(
        completed.returncode, completed.stdout.decode("utf-8"), completed.stderr.decode("utf-8")
    )


def build_requests(scratch: Path, generated: int, seed: int) -> list[Request]:
    contract_files = contract_tables()
    contract = load_table_set("contract", write_tables(scratch / "contract", contract_files))
    bundled = load_table_set("bundled", PROJECT_ROOT / "routing")
    table_sets = [contract, bundled]
    generator = Generator(seed, table_sets)
    return [
        *contract_requests(contract_files, scratch),
        *label_requests(table_sets),
        *decoding_requests(table_sets),
        *context_requests(table_sets),
        *classification_requests(table_sets),
        *(generator.request(index) for index in range(generated)),
    ]


def compare(go_cli: Path, requests: list[Request]) -> tuple[list[str], int]:
    with ThreadPoolExecutor(max_workers=os.cpu_count()) as pool:
        go_outcomes = list(pool.map(functools.partial(run_go, go_cli), requests))
    differences, allowed = [], 0
    for request, go_outcome in zip(requests, go_outcomes, strict=True):
        python_outcome = run_python(request)
        if python_outcome == go_outcome:
            continue
        if request.allowed:
            allowed += 1
            continue
        differences.append(
            f"{request.name}\n  request: {request.body[:300]!r}\n"
            f"  python:  {json.dumps(python_outcome, ensure_ascii=False)[:500]}\n"
            f"  go:      {json.dumps(go_outcome, ensure_ascii=False)[:500]}"
        )
    return differences, allowed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--go-cli", type=Path, required=True, help="the built Go gh-aw-router binary"
    )
    parser.add_argument("--generated", type=int, default=500, help="number of generated requests")
    parser.add_argument("--seed", type=int, default=10261, help="seed for the generated requests")
    args = parser.parse_args(argv)
    go_cli = args.go_cli.resolve()
    # Tables never change during a run, so load each directory once rather than per request.
    cached_load = staticmethod(functools.cache(GhAwRouterService.load))
    with (
        tempfile.TemporaryDirectory() as scratch,
        mock.patch.object(GhAwRouterService, "load", cached_load),
    ):
        requests = build_requests(Path(scratch), args.generated, args.seed)
        differences, allowed = compare(go_cli, requests)
    for difference in differences:
        print(difference, file=sys.stderr)
    summary = f"{len(requests)} requests: {len(differences)} differences"
    print(f"{summary}, {allowed} allowed by recorded decisions")
    return 1 if differences else 0


if __name__ == "__main__":
    raise SystemExit(main())
