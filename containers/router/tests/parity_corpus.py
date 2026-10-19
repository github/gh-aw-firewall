"""Generate or check the Python parity corpus in tests/fixtures/parity.

The corpus records what the Python reference returns from the functions whose behavior
depends on Python itself, so the Go port can replay the same fixtures as unit-test data.
parity_cases.py builds the inputs. Run from containers/router:

    python tests/parity_corpus.py --write   # regenerate the fixtures
    python tests/parity_corpus.py --check   # fail if the committed fixtures are stale
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import TYPE_CHECKING, Any

import parity_cases
from pydantic import TypeAdapter, ValidationError

from gh_aw_router import classification, heuristics, routing
from gh_aw_router.contracts import Message, RouteRequest, TaskComplexity, decode_request

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator, Mapping

PARITY_DIRECTORY = Path(__file__).parent / "fixtures" / "parity"
UNICODE_VERSION = "15.0.0"
PYTHON_VERSION = "3.12"
KEPT_FILES = frozenset({"README.md"})
MAX_SEARCH_DEPTH = 2_000
MAX_SEARCH_DIGITS = 20_000
CONVERSATION = TypeAdapter(tuple[Message, ...])
CONTRACT_PREFIX = classification.CLASSIFICATION_CONTRACT + "\n\n"
NO_AUTHORED_TURN = "no_authored_turn"

# Input keys for each document kind: every case needs all of `required` and exactly one of
# `one_of` when that is non-empty.
INPUT_KEYS: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    "labels": (frozenset({"text"}), frozenset()),
    "decoding": (frozenset(), frozenset({"request", "body", "body_base64"})),
    "context": (frozenset(), frozenset({"conversation", "conversation_text"})),
    "classification": (frozenset({"conversation"}), frozenset()),
}
EXPECT_KEYS: dict[str, tuple[frozenset[str], ...]] = {
    "labels": (frozenset({"task_type", "scope"}),),
    "decoding": (frozenset({"result"}),),
    "context": (frozenset({"characters", "tokens"}),),
    "classification": (frozenset({"conversation_data"}), frozenset({"error"})),
}
DOCUMENT_KEYS: dict[str, frozenset[str]] = {
    kind: frozenset({"kind", "description", "cases"}) for kind in INPUT_KEYS
}
DOCUMENT_KEYS["classification"] |= {"system_prompt", "classification_contract"}


class CorpusError(ValueError):
    """A corpus case is malformed or produced an output the format cannot record."""


def render_document(document: object) -> bytes:
    """Render a fixture file: 2-space indent, sorted keys, ASCII only, LF line endings."""
    text = json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True, allow_nan=False)
    return (text + "\n").encode("ascii")


# Observing the Python functions ---------------------------------------------------------------


def observe(kind: str, case: Mapping[str, Any]) -> dict[str, Any]:
    """Run one case's inputs through the Python function its kind covers."""
    if kind == "labels":
        return _labels(case["text"])
    if kind == "decoding":
        return _decoding(_request_bytes(case))
    if kind == "context":
        return _context(_conversation(case))
    if kind == "classification":
        return _classification(_conversation(case))
    raise CorpusError(f"unknown kind {kind!r}")


def _labels(text: str) -> dict[str, Any]:
    labels = heuristics.infer_labels(text)
    if labels.task_complexity is not TaskComplexity.UNKNOWN:
        raise CorpusError("heuristic labels now infer task_complexity; record it")
    return {"task_type": labels.task_type.value, "scope": labels.scope.value}


def _request_bytes(case: Mapping[str, Any]) -> bytes:
    if "request" in case:
        return parity_cases.canonical_json(case["request"]).encode("ascii")
    if "body" in case:
        return case["body"].encode("utf-8")
    return base64.b64decode(case["body_base64"], validate=True)


def _decoding(data: bytes) -> dict[str, Any]:
    try:
        decode_request(RouteRequest, data)
    except ValidationError as error:
        errors = error.errors(include_input=False)
        malformed = any(item["type"] == "json_invalid" for item in errors)
        return {"result": "malformed" if malformed else "invalid"}
    return {"result": "decoded"}


def _conversation(case: Mapping[str, Any]) -> tuple[Message, ...]:
    text = case.get("conversation_text")
    if text is None:
        text = parity_cases.canonical_json(case["conversation"])
    return CONVERSATION.validate_json(text, strict=True)


def _context(conversation: tuple[Message, ...]) -> dict[str, Any]:
    characters = sum(
        routing._part_characters(part) for message in conversation for part in message.parts
    )
    tokens = routing.estimate_context_tokens(conversation)
    if tokens != -(-characters // routing.CHARACTERS_PER_TOKEN):
        raise CorpusError("estimate_context_tokens no longer rounds characters / 4 upward")
    return {"characters": characters, "tokens": tokens}


def _classification(conversation: tuple[Message, ...]) -> dict[str, Any]:
    authored = classification.authored_messages(conversation)
    if not authored:
        return {"error": NO_AUTHORED_TURN}
    prompt = classification.build_classification_prompt(authored)
    if not prompt.startswith(CONTRACT_PREFIX):
        raise CorpusError("the classifier prompt no longer starts with the contract")
    return {"conversation_data": prompt.removeprefix(CONTRACT_PREFIX)}


# Structure ----------------------------------------------------------------------------------


def validate_document(document: object) -> list[str]:
    """Return the structural problems in one fixture document."""
    if not isinstance(document, dict) or document.get("kind") not in INPUT_KEYS:
        return [f"document must be an object with kind {', '.join(INPUT_KEYS)}"]
    kind = document["kind"]
    problems = [f"unknown document key {key!r}" for key in set(document) - DOCUMENT_KEYS[kind]]
    problems.extend(f"document needs {key!r}" for key in DOCUMENT_KEYS[kind] - set(document))
    if not isinstance(document.get("description"), str):
        problems.append("document description must be a string")
    cases = document.get("cases")
    if not isinstance(cases, list) or not cases:
        return [*problems, "document needs a non-empty cases list"]
    seen: set[str] = set()
    for case in cases:
        identifier = case.get("id") if isinstance(case, dict) else None
        if not isinstance(identifier, str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9_.-]*", identifier
        ):
            problems.append(f"case without a valid id: {str(case)[:80]}")
            continue
        if identifier in seen:
            problems.append(f"{identifier}: duplicate id")
        seen.add(identifier)
        problems.extend(f"{identifier}: {problem}" for problem in _case_problems(kind, case))
    return problems


def _case_problems(kind: str, case: Mapping[str, Any]) -> list[str]:
    required, one_of = INPUT_KEYS[kind]
    allowed = {"id", "description", "expect"} | required | one_of
    problems = [f"unknown key {key!r}" for key in sorted(set(case) - allowed)]
    problems.extend(f"missing {key!r}" for key in sorted(required - set(case)))
    if one_of and len(one_of & set(case)) != 1:
        problems.append(f"needs exactly one of {', '.join(sorted(one_of))}")
    if not isinstance(case.get("description"), str) or not case["description"]:
        problems.append("missing description")
    expect = case.get("expect")
    if not isinstance(expect, dict) or frozenset(expect) not in EXPECT_KEYS[kind]:
        shapes = " or ".join(str(sorted(keys)) for keys in EXPECT_KEYS[kind])
        problems.append(f"expect must have the keys {shapes}")
    return problems


# Unicode data -------------------------------------------------------------------------------


def unicode_files() -> dict[str, bytes]:
    """Record the Unicode properties the router's text handling depends on."""
    if unicodedata.unidata_version != UNICODE_VERSION:
        raise CorpusError(
            f"Python uses Unicode {unicodedata.unidata_version}; the corpus pins {UNICODE_VERSION}"
        )
    characters = [chr(point) for point in range(0x110000) if not 0xD800 <= point <= 0xDFFF]
    spaces = [character for character in characters if character.isspace()]
    if spaces != [character for character in characters if re.fullmatch(r"\s", character)]:
        raise CorpusError(r"re \s and str.isspace disagree")
    properties = {
        "whitespace": (
            "Code points where str.isspace() is true. str.split(), str.strip() and the regular "
            "expression \\s use this set.",
            spaces,
        ),
        "word": (
            "Code points the regular expression \\w matches in a str pattern: str.isalnum() "
            "plus underscore.",
            [character for character in characters if re.fullmatch(r"\w", character)],
        ),
        "printable": (
            "Code points where str.isprintable() is true. HTTP error details replace the others "
            "with a space.",
            [character for character in characters if character.isprintable()],
        ),
    }
    files = {
        f"unicode/{name}.json": render_document(
            {**_unicode_header(definition), "ranges": _ranges(members)}
        )
        for name, (definition, members) in properties.items()
    }
    folds = [
        [_hex(character), " ".join(_hex(item) for item in character.casefold())]
        for character in characters
        if character.casefold() != character
    ]
    files["unicode/casefold.json"] = render_document(
        {
            **_unicode_header(
                "str.casefold() for every code point it changes, as [code point, folded "
                "code points]. Other code points fold to themselves."
            ),
            "mappings": folds,
        }
    )
    return files


def _unicode_header(definition: str) -> dict[str, str]:
    return {
        "definition": definition,
        "python_version": PYTHON_VERSION,
        "unicode_version": UNICODE_VERSION,
    }


def _hex(character: str) -> str:
    return f"{ord(character):04X}"


def _ranges(members: list[str]) -> list[str]:
    ranges: list[list[int]] = []
    for point in map(ord, members):
        if ranges and ranges[-1][1] == point - 1:
            ranges[-1][1] = point
        else:
            ranges.append([point, point])
    return [f"{start:04X}-{end:04X}" for start, end in ranges]


# Decoder limits -----------------------------------------------------------------------------


def search_limits() -> dict[str, int]:
    """Find the largest accepted nesting depth or digit count for each tool_call.input shape."""
    return {
        name: _largest_accepted(
            lambda size, shape=shape: _accepts(shape(size)),
            MAX_SEARCH_DIGITS if name.startswith("digits") else MAX_SEARCH_DEPTH,
        )
        for name, shape in parity_cases.LIMIT_SHAPES.items()
    }


def _accepts(token: str) -> bool:
    try:
        decode_request(RouteRequest, parity_cases.tool_input_text(token))
    except ValidationError:
        return False
    return True


def _largest_accepted(accepts: Callable[[int], bool], high: int) -> int:
    low = 1
    if not accepts(low) or accepts(high):
        raise CorpusError("limit search bounds don't bracket the limit")
    while high - low > 1:
        middle = (low + high) // 2
        if accepts(middle):
            low = middle
        else:
            high = middle
    return low


# Materializing cases ------------------------------------------------------------------------


def materialize(document: Mapping[str, Any]) -> dict[str, Any]:
    """Run every case in a builder document and record its expectations."""
    kind = document["kind"]
    output = {key: value for key, value in document.items() if key != "cases"}
    if kind == "classification":
        output["system_prompt"] = classification.SYSTEM_PROMPT
        output["classification_contract"] = classification.CLASSIFICATION_CONTRACT
    cases = []
    for case in document["cases"]:
        recorded = {key: value for key, value in case.items() if not key.startswith("_")}
        try:
            observed = observe(kind, recorded)
            _check_builder(case, observed)
        except (CorpusError, ValidationError) as error:
            raise CorpusError(f"{case.get('id')}: {error}") from error
        recorded["expect"] = observed
        cases.append(recorded)
    output["cases"] = cases
    problems = validate_document(output)
    if problems:
        raise CorpusError("; ".join(problems[:20]))
    return output


def _check_builder(case: Mapping[str, Any], observed: Mapping[str, Any]) -> None:
    wanted = case.get("_expect", {})
    differences = {
        key: observed.get(key) for key, value in wanted.items() if observed.get(key) != value
    }
    if differences:
        raise CorpusError(f"expected {dict(wanted)}, observed {differences}")
    outcome = case.get("_outcome")
    if outcome is not None and (observed["result"] == parity_cases.DECODED) != (
        outcome == parity_cases.DECODED
    ):
        raise CorpusError(f"expected {outcome}, observed {observed['result']}")


# Files --------------------------------------------------------------------------------------


def generate() -> dict[str, bytes]:
    """Return every generated fixture file keyed by its path under fixtures/parity."""
    files = unicode_files()
    for name, document in parity_cases.documents(search_limits()).items():
        try:
            files[name] = render_document(materialize(document))
        except CorpusError as error:
            raise CorpusError(f"{name}: {error}") from error
    return files


def committed_files() -> dict[str, bytes]:
    return {
        path.relative_to(PARITY_DIRECTORY).as_posix(): path.read_bytes()
        for path in sorted(PARITY_DIRECTORY.rglob("*"))
        if path.is_file() and path.name not in KEPT_FILES
    }


def write(files: Mapping[str, bytes]) -> None:
    for name in committed_files().keys() - files.keys():
        (PARITY_DIRECTORY / name).unlink()
    for name, data in files.items():
        path = PARITY_DIRECTORY / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists() or path.read_bytes() != data:
            path.write_bytes(data)
    for directory in sorted(PARITY_DIRECTORY.rglob("*"), reverse=True):
        if directory.is_dir() and not any(directory.iterdir()):
            directory.rmdir()


def differences(files: Mapping[str, bytes]) -> Iterator[str]:
    """Describe how the committed fixtures differ from freshly generated ones."""
    committed = committed_files()
    for name in sorted(committed.keys() - files.keys()):
        yield f"{name}: stale file, not generated"
    for name in sorted(files.keys() - committed.keys()):
        yield f"{name}: missing"
    for name in sorted(files.keys() & committed.keys()):
        if files[name] != committed[name]:
            yield f"{name}: differs{_changed_cases(committed[name], files[name])}"


def _changed_cases(old: bytes, new: bytes) -> str:
    try:
        before, after = (
            {case["id"]: case for case in json.loads(data).get("cases", [])} for data in (old, new)
        )
    except (ValueError, AttributeError, TypeError, KeyError):
        return ""
    changed = sorted(
        identifier
        for identifier in before.keys() | after.keys()
        if before.get(identifier) != after.get(identifier)
    )
    if not changed:
        return ""
    return f" in cases {', '.join(changed[:20])}" + (" ..." if len(changed) > 20 else "")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--write", action="store_true", help="regenerate the fixtures")
    action.add_argument("--check", action="store_true", help="fail if the fixtures are stale")
    args = parser.parse_args(argv)
    try:
        files = generate()
    except CorpusError as error:
        print(f"parity corpus: {error}", file=sys.stderr)
        return 1
    if args.write:
        write(files)
        print(f"parity corpus: wrote {len(files)} files to {PARITY_DIRECTORY}")
        return 0
    problems = list(differences(files))
    for problem in problems:
        print(f"parity corpus: {problem}", file=sys.stderr)
    if problems:
        print("parity corpus: run python tests/parity_corpus.py --write", file=sys.stderr)
        return 1
    print(f"parity corpus: {len(files)} files are up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
