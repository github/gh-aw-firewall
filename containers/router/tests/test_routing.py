from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

import pytest

from gh_aw_router.contracts import (
    Message,
    ModelCandidate,
    ReasoningEffort,
    Role,
    RouteRequest,
    RoutingGoal,
    RoutingMode,
    RoutingObjective,
    TextPart,
    ToolCall,
    ToolCallPart,
    ToolResult,
    ToolResultPart,
)
from gh_aw_router.routing import (
    WINDOW_HEADROOM_TOKENS,
    NoRouteError,
    RoutingError,
    estimate_context_tokens,
)
from gh_aw_router.routing_table import (
    RoutingTable,
    parse_pair,
    profile_key,
)


def _routing_table(document: dict[str, Any]) -> RoutingTable:
    return RoutingTable.from_bytes(json.dumps(document).encode())


def _route_request(
    *models: ModelCandidate,
    current_id: str | None = None,
    text: str = "Fix this function",
) -> RouteRequest:
    return RouteRequest(
        objective=RoutingObjective(goal=RoutingGoal.COST, mode=RoutingMode.BALANCED),
        current_id=current_id,
        conversation=(Message(role=Role.USER, parts=(TextPart(text=text),)),),
        models=models,
    )


@pytest.mark.parametrize(
    ("value", "model", "effort"),
    [
        ("provider/model", "provider/model", None),
        ("provider/model:medium", "provider/model", ReasoningEffort.MEDIUM),
    ],
)
def test_parse_pair_accepts_canonical_identities(
    value: str,
    model: str,
    effort: ReasoningEffort | None,
) -> None:
    pair = parse_pair(value)

    assert pair.model == model
    assert pair.effort is effort


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ("provider", "String should match pattern"),
        (" provider/model", "must be canonical"),
        ("provider/model ", "must be canonical"),
        ("provider/model:medium:high", "must be canonical"),
    ],
)
def test_parse_pair_rejects_noncanonical_identities(value: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        parse_pair(value)


def test_table_rejects_incomplete_or_duplicate_rankings(table_document: dict[str, Any]) -> None:
    incomplete = deepcopy(table_document)
    applies_to = incomplete["rankings"][0]["applies_to"]
    applies_to.pop()
    with pytest.raises(ValueError, match="every label combination"):
        _routing_table(incomplete)

    duplicate = deepcopy(table_document)
    duplicate["rankings"][0]["choices"].append("provider/fast")
    with pytest.raises(ValueError, match="full ordered pair list"):
        _routing_table(duplicate)


def test_table_rejects_noncanonical_repository_and_default_effort_metadata(
    table_document: dict[str, Any],
) -> None:
    noncanonical = deepcopy(table_document)
    noncanonical["repository"] = " global"
    with pytest.raises(ValueError, match="repository must be canonical"):
        _routing_table(noncanonical)

    with_defaults = deepcopy(table_document)
    with_defaults["default_efforts"] = {"provider/reasoning": "medium"}
    with pytest.raises(ValueError, match="Extra inputs are not permitted"):
        _routing_table(with_defaults)


def test_context_estimate_counts_serialized_content_and_rounds_up() -> None:
    conversation = (
        Message(
            role=Role.USER,
            parts=(
                TextPart(text="abc"),
                ToolCallPart(tool_call=ToolCall(id="call", name="lookup", input={"key": "é"})),
                ToolResultPart(tool_result=ToolResult(id="call", text="done", ok=True)),
            ),
        ),
    )
    input_text = json.dumps({"key": "é"}, ensure_ascii=False, separators=(",", ":"))
    characters = len("abc") + len("lookup") + len(input_text) + len("done")

    assert estimate_context_tokens(conversation) == (characters + 3) // 4


def test_route_orders_exact_choices_and_pins_an_eligible_current_choice(
    routing_table: RoutingTable,
) -> None:
    request = _route_request(
        ModelCandidate(id="fast", model="provider/fast"),
        ModelCandidate(
            id="explicit",
            model="provider/reasoning",
            effort=ReasoningEffort.MEDIUM,
        ),
        current_id="explicit",
    )

    choices = routing_table.route(request).ranked_choices

    assert [choice.id for choice in choices] == ["explicit", "fast"]
    assert choices[0].effort is ReasoningEffort.MEDIUM
    assert choices[1].effort is None


@pytest.mark.parametrize("effort", [None, ReasoningEffort.LOW])
def test_route_ignores_missing_or_unknown_effort(
    routing_table: RoutingTable, effort: ReasoningEffort | None
) -> None:
    request = _route_request(
        ModelCandidate(id="fast", model="provider/fast"),
        ModelCandidate(id="reasoning", model="provider/reasoning", effort=effort),
    )
    assert [choice.id for choice in routing_table.route(request).ranked_choices] == ["fast"]

    with pytest.raises(NoRouteError, match="no eligible"):
        routing_table.route(request.model_copy(update={"models": request.models[1:]}))


def test_route_distinguishes_explicit_none_effort_from_omission(
    table_document: dict[str, Any],
) -> None:
    document = table_document
    document["rankings"][0]["choices"][1] = "provider/reasoning:none"
    document["classification_choices"][1] = "provider/reasoning:none"
    table = _routing_table(document)
    request = _route_request(
        ModelCandidate(id="reasoning", model="provider/reasoning", effort=ReasoningEffort.NONE)
    )
    assert table.route(request).ranked_choices[0].effort is ReasoningEffort.NONE
    omitted = request.model_copy(
        update={"models": (request.models[0].model_copy(update={"effort": None}),)}
    )
    with pytest.raises(NoRouteError, match="no eligible"):
        table.route(omitted)


def test_route_filters_small_context_windows_and_fails_when_none_remain(
    routing_table: RoutingTable,
) -> None:
    minimum = WINDOW_HEADROOM_TOKENS + 1
    request = _route_request(
        ModelCandidate(id="small", model="provider/fast", context_window=minimum - 1),
        ModelCandidate(id="large", model="provider/fast", context_window=minimum),
        text="x",
    )

    assert [choice.id for choice in routing_table.route(request).ranked_choices] == ["large"]

    with pytest.raises(NoRouteError, match="no eligible"):
        routing_table.route(request.model_copy(update={"models": request.models[:1]}))


def test_route_ignores_unknown_model_identities(routing_table: RoutingTable) -> None:
    request = _route_request(
        ModelCandidate(id="unknown", model="provider/unknown"),
        ModelCandidate(id="fast", model="provider/fast"),
        current_id="unknown",
    )

    assert [choice.id for choice in routing_table.route(request).ranked_choices] == ["fast"]

    with pytest.raises(NoRouteError, match="no eligible"):
        routing_table.route(request.model_copy(update={"models": request.models[:1]}))

    too_small = request.models[1].model_copy(update={"context_window": 1})
    with pytest.raises(NoRouteError, match="no eligible"):
        routing_table.route(request.model_copy(update={"models": (request.models[0], too_small)}))


@pytest.mark.parametrize("profile", ["economy", "balanced", "robust"])
def test_table_serves_only_its_declared_profile(
    table_document: dict[str, Any], profile: str
) -> None:
    document = table_document
    document["profile"]["mode"] = profile
    table = _routing_table(document)
    assert [profile_key(objective) for objective in table.document.profiles] == [f"cost/{profile}"]
    request = _route_request(ModelCandidate(id="fast", model="provider/fast"))
    request = request.model_copy(update={"objective": table.document.profile})
    assert table.route(request).ranked_choices[0].id == "fast"
    other = RoutingMode.ROBUST if profile == "balanced" else RoutingMode.BALANCED
    request = request.model_copy(
        update={"objective": RoutingObjective(goal=RoutingGoal.COST, mode=other)}
    )
    with pytest.raises(RoutingError, match="not supported by this table"):
        table.route(request)


def test_table_rejects_auto_profile(table_document: dict[str, Any]) -> None:
    table_document["profile"]["mode"] = "auto"
    with pytest.raises(ValueError, match="must declare a fixed"):
        _routing_table(table_document)


@pytest.mark.parametrize("schema_version", [3, 4])
def test_table_rejects_legacy_schemas(table_document: dict[str, Any], schema_version: int) -> None:
    document = table_document
    document["schema_version"] = schema_version
    with pytest.raises(ValueError, match="schema_version"):
        _routing_table(document)


@pytest.mark.parametrize(
    ("assignment", "message"),
    [
        ("duplicate", "assigned to cost/balanced more than once"),
        ("unknown", "applies_to names an unknown label cell"),
    ],
)
def test_table_rejects_invalid_label_assignments(
    table_document: dict[str, Any], assignment: str, message: str
) -> None:
    labels = table_document["rankings"][0]["applies_to"]
    labels.append(labels[0] if assignment == "duplicate" else "invalid/local/easy")
    with pytest.raises(ValueError, match=message):
        _routing_table(table_document)


def test_table_rejects_duplicate_ranking_groups(table_document: dict[str, Any]) -> None:
    group = table_document["rankings"][0]
    table_document["rankings"].append(
        {"applies_to": [group["applies_to"].pop()], "choices": list(group["choices"])}
    )
    with pytest.raises(ValueError, match="identical rankings must share one group"):
        _routing_table(table_document)


@pytest.mark.parametrize("target", ["classification", "routing"])
@pytest.mark.parametrize(
    "choices",
    [
        ["provider/fast"],
        ["provider/fast", "provider/unknown"],
        ["provider/fast", "provider/fast"],
        ["provider/fast", "provider/reasoning:medium", "provider/extra"],
    ],
)
def test_every_order_must_be_a_catalogue_permutation(
    table_document: dict[str, Any], target: str, choices: list[str]
) -> None:
    if target == "classification":
        table_document["classification_choices"] = choices
    else:
        group = table_document["rankings"][0]
        table_document["rankings"].append(
            {"applies_to": [group["applies_to"].pop()], "choices": choices}
        )
    with pytest.raises(ValueError, match="full ordered pair list"):
        _routing_table(table_document)


def test_table_rejects_bare_aliases_for_reasoning_models(table_document: dict[str, Any]) -> None:
    table_document["rankings"][0]["choices"].append("provider/reasoning")
    with pytest.raises(ValueError, match="bare default aliases"):
        _routing_table(table_document)


@pytest.mark.parametrize("current_id", ["missing", "too-small"])
def test_ineligible_current_choice_does_not_override_ranking(
    routing_table: RoutingTable, current_id: str
) -> None:
    request = _route_request(
        ModelCandidate(id="too-small", model="provider/fast", context_window=1),
        ModelCandidate(id="second", model="provider/reasoning", effort=ReasoningEffort.MEDIUM),
        ModelCandidate(id="first", model="provider/fast"),
        current_id=current_id,
    )
    assert [choice.id for choice in routing_table.route(request).ranked_choices] == [
        "first",
        "second",
    ]


def test_equal_identities_preserve_offered_order(routing_table: RoutingTable) -> None:
    request = _route_request(
        ModelCandidate(id="second", model="provider/fast"),
        ModelCandidate(id="first", model="provider/fast"),
    )
    assert [choice.id for choice in routing_table.route(request).ranked_choices] == [
        "second",
        "first",
    ]
