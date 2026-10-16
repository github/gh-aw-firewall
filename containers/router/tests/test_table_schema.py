"""Keep the published routing-table schema, the table loader and the bundled tables in step."""

from __future__ import annotations

import functools
import hashlib
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any, get_args

import pytest
from contract_corpus import contract_tables, synthetic_table_document
from jsonschema import Draft202012Validator
from jsonschema.protocols import Validator
from pydantic import BaseModel

from gh_aw_router.contracts import (
    ReasoningEffort,
    RoutingObjective,
    TaskComplexity,
    TaskScope,
    TaskType,
)
from gh_aw_router.routing_table import (
    PROFILES,
    RankingGroup,
    RoutingTable,
    TableDocument,
    all_labels,
    label_key,
    profile_filename,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIRECTORY = PROJECT_ROOT / "schemas"
CURRENT_VERSION = get_args(TableDocument.model_fields["schema_version"].annotation)[0]
# A published schema never changes. A format change adds a new file and pins its hash here.
PUBLISHED_SCHEMAS = {
    1: "c76de15239db5d6ee9bfc3fa4f4b797887efe04f40334e2ca9e8afe5377461cd",
}
# The loader trims with str.strip(), which removes exactly the characters str.isspace() accepts.
WHITESPACE = "".join(chr(code) for code in range(0x110000) if chr(code).isspace())

type Mutation = Callable[[dict[str, Any]], None]


def _schema_name(version: int) -> str:
    return f"routing-table.v{version}.schema.json"


@functools.cache
def _schema() -> dict[str, Any]:
    return json.loads((SCHEMA_DIRECTORY / _schema_name(CURRENT_VERSION)).read_bytes())


def _validator() -> Validator:
    return Draft202012Validator(_schema())


def _definition_validator(name: str) -> Validator:
    return Draft202012Validator({"$ref": f"#/$defs/{name}", "$defs": _schema()["$defs"]})


def _node(document: dict[str, Any], path: tuple[str | int, ...]) -> Any:  # noqa: ANN401
    node: Any = document
    for key in path:
        node = node[key]
    return node


def _loader_accepts(document: dict[str, Any]) -> bool:
    try:
        RoutingTable.from_bytes(json.dumps(document).encode())
    except ValueError:
        return False
    return True


def _alternation(enum: type[Any]) -> str:
    return "(" + "|".join(item.value for item in enum) + ")"


def _character_class_body(characters: str) -> str:
    """List characters as literals, collapsing runs of three or more into ranges."""
    runs: list[list[int]] = []
    for code in map(ord, characters):
        if runs and code == runs[-1][1] + 1:
            runs[-1][1] = code
        else:
            runs.append([code, code])
    return "".join(
        chr(first) + ("-" + chr(last) if last - first > 1 else chr(last) if last > first else "")
        for first, last in runs
    )


def _patterns(node: object) -> list[str]:
    if isinstance(node, dict):
        found = [node["pattern"]] if isinstance(node.get("pattern"), str) else []
        return found + [pattern for value in node.values() for pattern in _patterns(value)]
    if isinstance(node, list):
        return [pattern for value in node for pattern in _patterns(value)]
    return []


@functools.cache
def _router_tables() -> dict[str, bytes]:
    tables = {
        f"routing/{path.name}": path.read_bytes()
        for path in sorted((PROJECT_ROOT / "routing").glob("*.json"))
    }
    tables["synthetic"] = json.dumps(synthetic_table_document()).encode()
    tables.update({f"contract/{name}": data for name, data in contract_tables().items()})
    return tables


def test_schema_is_a_valid_draft_2020_12_schema() -> None:
    Draft202012Validator.check_schema(_schema())
    assert _schema()["$schema"] == "https://json-schema.org/draft/2020-12/schema"


def test_router_tables_include_every_bundled_profile() -> None:
    bundled = {name for name in _router_tables() if name.startswith("routing/")}
    assert bundled == {f"routing/{profile_filename(profile)}" for profile in PROFILES}


@pytest.mark.parametrize("name", sorted(_router_tables()))
def test_every_router_table_conforms_to_the_schema(name: str) -> None:
    data = _router_tables()[name]
    _validator().validate(json.loads(data))
    RoutingTable.from_bytes(data)


def test_schema_constants_match_the_runtime() -> None:
    properties = _schema()["properties"]
    assert properties["schema_version"]["const"] == CURRENT_VERSION
    profile = properties["profile"]["properties"]
    goals, modes = profile["goal"]["enum"], profile["mode"]["enum"]
    assert len(goals) == len(set(goals))
    assert len(modes) == len(set(modes))
    assert {(goal, mode) for goal in goals for mode in modes} == {
        (objective.goal.value, objective.mode.value) for objective in PROFILES
    }


def test_schema_patterns_are_built_from_the_runtime_enums() -> None:
    definitions = _schema()["$defs"]
    labels = "/".join(_alternation(enum) for enum in (TaskType, TaskScope, TaskComplexity))
    space = _character_class_body(WHITESPACE)
    assert definitions["labelKey"]["pattern"] == f"^{labels}$"
    assert definitions["modelIdentity"]["pattern"] == (
        f"^[^/:{space}][^/:]*/[^/:]*[^/:{space}](:{_alternation(ReasoningEffort)})?$"
    )
    assert definitions["trimmed"] == {
        "description": definitions["trimmed"]["description"],
        "not": {"pattern": f"^[{space}]|[{space}]$"},
    }


def test_schema_patterns_use_only_syntax_that_every_engine_shares() -> None:
    # No escapes (\s differs between Python and ECMA-262, \u is not RE2) and no lookaround.
    patterns = _patterns(_schema())
    assert len(patterns) == 3
    for pattern in patterns:
        assert "\\" not in pattern, pattern
        assert "(?" not in pattern, pattern
        re.compile(pattern)


def test_pattern_checked_strings_also_reject_outer_whitespace() -> None:
    definitions = _schema()["$defs"]
    trimmed = {"$ref": "#/$defs/trimmed"}
    assert _schema()["properties"]["repository"]["$ref"] == trimmed["$ref"]
    for name in ("labelKey", "modelIdentity"):
        assert definitions[name]["$ref"] == trimmed["$ref"]


# Every character the loader strips, plus format and separator characters it keeps.
EDGE_CHARACTERS = [*WHITESPACE, "\ufeff", "\u200b", "\u180e"]


@pytest.mark.parametrize("character", EDGE_CHARACTERS, ids=lambda c: f"U+{ord(c):04X}")
def test_schema_and_loader_agree_on_outer_whitespace(character: str) -> None:
    candidates: list[tuple[str, str]] = [
        ("repository", f"{character}global"),
        ("repository", f"global{character}"),
        ("identity", f"{character}provider/fast"),
        ("identity", f"provider/fast{character}"),
        ("identity", f"provider/reasoning{character}:medium"),
    ]
    for field, value in candidates:
        document = synthetic_table_document()
        if field == "repository":
            document["repository"] = value
        else:
            original = "provider/reasoning:medium" if ":" in value else "provider/fast"
            document["classification_choices"] = [
                value if choice == original else choice
                for choice in document["classification_choices"]
            ]
            for group in document["rankings"]:
                group["choices"] = [
                    value if choice == original else choice for choice in group["choices"]
                ]
        assert _validator().is_valid(document) is _loader_accepts(document), (field, value)


@pytest.mark.parametrize(
    ("model", "pointer"),
    [
        (TableDocument, ()),
        (RoutingObjective, ("properties", "profile")),
        (RankingGroup, ("$defs", "rankingGroup")),
    ],
    ids=["TableDocument", "profile", "rankingGroup"],
)
def test_schema_objects_match_the_runtime_fields(
    model: type[BaseModel], pointer: tuple[str, ...]
) -> None:
    node = _node(_schema(), pointer)
    runtime_required = {name for name, field in model.model_fields.items() if field.is_required()}
    assert model.model_config.get("extra") == "forbid"
    assert node["additionalProperties"] is False
    assert set(node["properties"]) == set(model.model_fields)
    # Every table includes the version, even though the loader defaults it.
    expected_required = runtime_required | ({"schema_version"} if model is TableDocument else set())
    assert set(node["required"]) == expected_required


def test_schema_nests_the_same_objects_as_the_runtime() -> None:
    fields = TableDocument.model_fields
    assert fields["profile"].annotation is RoutingObjective
    assert get_args(fields["rankings"].annotation)[0] is RankingGroup


def test_label_key_pattern_accepts_every_runtime_cell() -> None:
    keys = [label_key(labels) for labels in all_labels()]
    validator = _definition_validator("labelKey")
    assert len(set(keys)) == len(TaskType) * len(TaskScope) * len(TaskComplexity)
    assert [key for key in keys if not validator.is_valid(key)] == []


@pytest.mark.parametrize(
    "key",
    [
        "fix/easy/local",
        "local/fix/easy",
        "invalid/local/easy",
        "fix/local/invalid",
        "Fix/local/easy",
        "fix/local",
        "fix/local/easy/extra",
        " fix/local/easy",
        "fix/local/easy\n",
    ],
)
def test_label_key_pattern_rejects_other_keys(key: str) -> None:
    assert not _definition_validator("labelKey").is_valid(key)


@pytest.mark.parametrize(
    ("identity", "valid"),
    [
        *((f"provider/model:{effort.value}", True) for effort in ReasoningEffort),
        ("provider/model", True),
        ("provider/my model", True),
        ("provider /model", True),
        ("p/m", True),
        ("provider", False),
        ("provider/", False),
        ("/model", False),
        ("a/b/c", False),
        (" provider/model", False),
        ("provider/model ", False),
        ("\u00a0provider/model", False),
        ("provider/model :medium", False),
        ("provider/model:", False),
        ("provider/model:turbo", False),
        ("provider/model:MEDIUM", False),
        ("provider/model:medium:high", False),
        ("provider/model\n", False),
        ("provider/model:medium\n", False),
    ],
)
def test_schema_and_loader_agree_on_model_identities(identity: str, valid: bool) -> None:
    document = synthetic_table_document()
    document["classification_choices"] = [identity]
    document["rankings"][0]["choices"] = [identity]
    assert _definition_validator("modelIdentity").is_valid(identity) is valid
    assert _validator().is_valid(document) is valid
    assert _loader_accepts(document) is valid


def _set(*path: str | int, value: object) -> Mutation:
    def mutate(document: dict[str, Any]) -> None:
        _node(document, path[:-1])[path[-1]] = value

    return mutate


def _append(*path: str | int, value: object) -> Mutation:
    def mutate(document: dict[str, Any]) -> None:
        _node(document, path).append(value)

    return mutate


def _delete(*path: str | int) -> Mutation:
    def mutate(document: dict[str, Any]) -> None:
        del _node(document, path[:-1])[path[-1]]

    return mutate


def _duplicate_first_cell(document: dict[str, Any]) -> None:
    group = document["rankings"][0]
    group["applies_to"].append(group["applies_to"][0])


def _new_group(choices: Callable[[list[str]], list[str]]) -> Mutation:
    """Move the last label cell of the first group into a new group with derived choices."""

    def mutate(document: dict[str, Any]) -> None:
        group = document["rankings"][0]
        cell = group["applies_to"].pop()
        document["rankings"].append({"applies_to": [cell], "choices": choices(group["choices"])})

    return mutate


def _assign_first_cell_twice(document: dict[str, Any]) -> None:
    group = document["rankings"][0]
    document["rankings"].append(
        {"applies_to": [group["applies_to"][0]], "choices": group["choices"][::-1]}
    )


REJECTED_BY_BOTH: dict[str, Mutation] = {
    "unknown top-level field": _set("default_efforts", value={"provider/reasoning": "medium"}),
    "unknown profile field": _set("profile", "overrides", value=None),
    "unknown ranking group field": _set("rankings", 0, "weight", value=1),
    "missing profile": _delete("profile"),
    "missing profile goal": _delete("profile", "goal"),
    "missing repository": _delete("repository"),
    "missing classification_choices": _delete("classification_choices"),
    "missing rankings": _delete("rankings"),
    "missing applies_to": _delete("rankings", 0, "applies_to"),
    "missing choices": _delete("rankings", 0, "choices"),
    "schema_version 0": _set("schema_version", value=0),
    "schema_version 2": _set("schema_version", value=2),
    "schema_version 5": _set("schema_version", value=5),
    "schema_version as a string": _set("schema_version", value="1"),
    "schema_version as a boolean": _set("schema_version", value=True),
    "auto profile": _set("profile", "mode", value="auto"),
    "unknown mode": _set("profile", "mode", value="custom"),
    "unknown goal": _set("profile", "goal", value="speed"),
    "empty repository": _set("repository", value=""),
    "repository with leading whitespace": _set("repository", value=" global"),
    "repository with trailing whitespace": _set("repository", value="global "),
    "repository with a trailing newline": _set("repository", value="global\n"),
    "repository not a string": _set("repository", value=1),
    "unknown label key": _append("rankings", 0, "applies_to", value="invalid/local/easy"),
    "label key in another order": _append("rankings", 0, "applies_to", value="local/fix/easy"),
    "label key with a trailing newline": _append(
        "rankings", 0, "applies_to", value="fix/local/easy\n"
    ),
    "cell repeated in one group": _duplicate_first_cell,
    "choice repeated in one group": _append("rankings", 0, "choices", value="provider/fast"),
    "unknown effort": _set("rankings", 0, "choices", 1, value="provider/reasoning:turbo"),
    "non-canonical identity": _set("rankings", 0, "choices", 0, value=" provider/fast"),
    "empty rankings": _set("rankings", value=[]),
    "empty applies_to": _set("rankings", 0, "applies_to", value=[]),
    "empty choices": _set("rankings", 0, "choices", value=[]),
    "empty classification_choices": _set("classification_choices", value=[]),
    "rankings not an array": _set("rankings", value={}),
    "applies_to not an array": _set("rankings", 0, "applies_to", value="fix/local/easy"),
}


@pytest.mark.parametrize("change", REJECTED_BY_BOTH)
def test_schema_and_loader_reject_the_same_defects(change: str) -> None:
    document = synthetic_table_document()
    REJECTED_BY_BOTH[change](document)
    assert not _validator().is_valid(document)
    assert not _loader_accepts(document)


# Rules that relate parts of a table to each other. The schema's description lists them.
LOADER_ONLY: dict[str, tuple[Mutation, str]] = {
    "missing label cell": (
        _delete("rankings", 0, "applies_to", -1),
        "every label combination",
    ),
    "cell assigned to two groups": (_assign_first_cell_twice, "more than once"),
    "ranking not a permutation": (
        _new_group(lambda choices: choices[:1]),
        "full ordered pair list",
    ),
    "classification order not a permutation": (
        _set("classification_choices", value=["provider/fast"]),
        "full ordered pair list",
    ),
    "identical groups": (_new_group(list), "identical rankings must share one group"),
    "bare alias next to explicit efforts": (
        _append("rankings", 0, "choices", value="provider/reasoning"),
        "bare default aliases",
    ),
}


@pytest.mark.parametrize("change", LOADER_ONLY)
def test_cross_reference_rules_are_enforced_only_by_the_loader(change: str) -> None:
    mutate, message = LOADER_ONLY[change]
    document = synthetic_table_document()
    mutate(document)
    _validator().validate(document)
    with pytest.raises(ValueError, match=message):
        RoutingTable.from_bytes(json.dumps(document).encode())


def test_schema_requires_the_version_that_the_loader_defaults() -> None:
    document = synthetic_table_document()
    del document["schema_version"]
    assert not _validator().is_valid(document)
    assert _loader_accepts(document)


def test_published_schemas_are_frozen() -> None:
    expected = {_schema_name(version) for version in PUBLISHED_SCHEMAS}
    assert {path.name for path in SCHEMA_DIRECTORY.iterdir()} == expected
    assert CURRENT_VERSION in PUBLISHED_SCHEMAS
    for version, digest in PUBLISHED_SCHEMAS.items():
        name = _schema_name(version)
        data = (SCHEMA_DIRECTORY / name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == digest, (
            f"{name} is published and must not change. Add {_schema_name(version + 1)} and "
            "bump TableDocument.schema_version for a format change."
        )
        schema = json.loads(data)
        assert schema["$id"].endswith(f"/{name}")
        assert re.search(rf"\bschema version {version}$", schema["title"])
        assert schema["properties"]["schema_version"]["const"] == version
