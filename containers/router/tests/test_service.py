from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest

from gh_aw_router import __version__
from gh_aw_router.classification import CLASSIFICATION_LABELS
from gh_aw_router.contracts import (
    ClassifyRequest,
    Message,
    ModelCandidate,
    ModelChoice,
    Role,
    RouteRequest,
    RoutingGoal,
    RoutingMode,
    RoutingObjective,
    TextPart,
)
from gh_aw_router.routing_table import PROFILES, RoutingTable, label_key, profile_key
from gh_aw_router.service import GhAwRouterService, InvalidRequestError


def test_service_owns_its_profile_index(routing_table: RoutingTable) -> None:
    tables = {"cost/balanced": routing_table}
    service = GhAwRouterService(tables)

    tables.clear()

    assert service.primary_table is routing_table
    assert tuple(service.routing_tables) == ("cost/balanced",)


def test_capabilities_are_derived_from_compiled_catalogue(
    synthetic_service: GhAwRouterService,
) -> None:
    capabilities = synthetic_service.capabilities()

    assert capabilities.version == __version__
    assert "api_versions" not in capabilities.model_dump()
    assert [profile_key(profile) for profile in capabilities.routing_profiles] == ["cost/balanced"]
    assert capabilities.execution_catalogue.model_dump(mode="json") == {
        "models": [
            {"model": "provider/fast", "efforts": []},
            {"model": "provider/reasoning", "efforts": ["medium"]},
        ]
    }


def test_published_tables_serve_every_profile(service: GhAwRouterService) -> None:
    capabilities = service.capabilities()

    assert [profile_key(profile) for profile in capabilities.routing_profiles] == [
        profile_key(profile) for profile in PROFILES
    ]
    pair = service.primary_table.pairs[0]
    for profile in PROFILES:
        request = RouteRequest(
            objective=profile,
            conversation=(Message(role=Role.USER, parts=(TextPart(text="Fix this"),)),),
            models=(ModelCandidate(id="only", model=pair.model, effort=pair.effort),),
        )
        assert service.route(request).ranked_choices[0].id == "only"


@pytest.mark.parametrize("goal", ["cost", "cost-speed"])
@pytest.mark.parametrize(
    ("requested_mode", "recommendation", "effective_mode"),
    [
        ("auto", "economy", "economy"),
        ("auto", "balanced", "balanced"),
        ("auto", "robust", "robust"),
        ("auto", "unknown", "balanced"),
        ("economy", "robust", "economy"),
        ("balanced", "economy", "balanced"),
        ("robust", "balanced", "robust"),
    ],
)
def test_classification_selects_labels_and_auto_profile(
    table_document: dict[str, Any],
    planning_payload: Callable[[str], dict[str, Any]],
    goal: str,
    requested_mode: str,
    recommendation: str,
    effective_mode: str,
) -> None:
    target_label = label_key(CLASSIFICATION_LABELS)
    tables = []
    for profile in PROFILES:
        document = {**table_document, "profile": profile.model_dump(mode="json")}
        if profile.goal.value == goal and profile.mode.value == effective_mode:
            ranking = table_document["rankings"][0]
            document["rankings"] = [
                {
                    "applies_to": [key for key in ranking["applies_to"] if key != target_label],
                    "choices": ranking["choices"],
                },
                {"applies_to": [target_label], "choices": list(reversed(ranking["choices"]))},
            ]
        tables.append(RoutingTable.from_bytes(json.dumps(document).encode()))
    service = GhAwRouterService.from_tables(tables)
    payload = planning_payload("route")
    payload["objective"] = {"goal": goal, "mode": requested_mode}
    payload["classification"] = {
        "labels": CLASSIFICATION_LABELS.model_dump(mode="json"),
        "mode": recommendation,
    }
    request = RouteRequest.model_validate_json(json.dumps(payload), strict=True)
    original = request.model_dump()

    assert [choice.id for choice in service.route(request).ranked_choices] == ["reasoning", "fast"]
    assert request.model_dump() == original
    assert len(service.capabilities().routing_profiles) == 6


@pytest.mark.parametrize("include_null", [False, True])
def test_auto_without_classification_uses_balanced(
    synthetic_service: GhAwRouterService,
    planning_payload: Callable[[str], dict[str, Any]],
    include_null: bool,
) -> None:
    payload = planning_payload("route")
    explicit = RouteRequest.model_validate_json(json.dumps(payload), strict=True)
    payload["objective"]["mode"] = "auto"
    if include_null:
        payload["classification"] = None
    automatic = RouteRequest.model_validate_json(json.dumps(payload), strict=True)

    assert synthetic_service.route(automatic) == synthetic_service.route(explicit)


@pytest.mark.parametrize("goal", ["cost", "cost-speed"])
@pytest.mark.parametrize(
    ("served_mode", "recommendation", "effective_mode"),
    [
        ("balanced", "economy", "economy"),
        ("balanced", "robust", "robust"),
        ("robust", "unknown", "balanced"),
        ("robust", None, "balanced"),
    ],
)
def test_auto_does_not_substitute_for_an_unserved_profile(
    table_document: dict[str, Any],
    planning_payload: Callable[[str], dict[str, Any]],
    goal: str,
    served_mode: str,
    recommendation: str | None,
    effective_mode: str,
) -> None:
    table_document["profile"] = {"goal": goal, "mode": served_mode}
    table = RoutingTable.from_bytes(json.dumps(table_document).encode())
    service = GhAwRouterService.from_tables([table])
    payload = planning_payload("route")
    payload["objective"] = {"goal": goal, "mode": "auto"}
    if recommendation is not None:
        payload["classification"] = {
            "labels": CLASSIFICATION_LABELS.model_dump(mode="json"),
            "mode": recommendation,
        }
    request = RouteRequest.model_validate_json(json.dumps(payload), strict=True)

    with pytest.raises(
        InvalidRequestError, match=f"routing profile is not served: {goal}/{effective_mode}"
    ):
        service.route(request)


def test_unserved_objectives_are_invalid_requests(synthetic_service: GhAwRouterService) -> None:
    request = RouteRequest(
        objective=RoutingObjective(goal=RoutingGoal.COST_SPEED, mode=RoutingMode.ROBUST),
        conversation=(Message(role=Role.USER, parts=(TextPart(text="Fix this"),)),),
        models=(ModelCandidate(id="fast", model="provider/fast"),),
    )

    with pytest.raises(
        InvalidRequestError, match="routing profile is not served: cost-speed/robust"
    ):
        synthetic_service.route(request)


def test_profiles_must_share_one_catalogue(
    routing_table: RoutingTable, table_document: dict[str, Any]
) -> None:
    document = {**table_document, "profile": {"goal": "cost", "mode": "economy"}}
    document["classification_choices"] = list(reversed(document["classification_choices"]))
    economy = RoutingTable.from_bytes(json.dumps(document).encode())

    with pytest.raises(ValueError, match="must share one repository"):
        GhAwRouterService.from_tables([routing_table, economy])

    with pytest.raises(ValueError, match="more than one routing table declares cost/balanced"):
        GhAwRouterService.from_tables([routing_table, routing_table])


def test_classification_respects_embedded_preference_order(
    synthetic_service: GhAwRouterService,
) -> None:
    document = synthetic_service.primary_table.document.model_dump(mode="json")
    document["classification_choices"].reverse()
    table = RoutingTable.from_bytes(json.dumps(document).encode())
    service = GhAwRouterService.from_tables([table])
    expected = tuple(
        ModelChoice(id=str(index), model=pair.model, effort=pair.effort)
        for index, pair in enumerate(table.classification_ranking)
    )
    request = ClassifyRequest(
        conversation=(Message(role=Role.USER, parts=(TextPart(text="Explain this"),)),),
        models=tuple(reversed(expected)),
    )

    assert service.classify(request).ranked_choices == expected


def test_classification_uses_balanced_cell_with_full_fallbacks(
    service: GhAwRouterService,
) -> None:
    ranking = service.primary_table.classification_ranking
    balanced = service.routing_tables["cost/balanced"]
    assert ranking == balanced.cells[label_key(CLASSIFICATION_LABELS)].rankings["cost/balanced"]
    explicit_models = {pair.model for pair in ranking if pair.effort is not None}
    offered = tuple(
        ModelChoice(id=str(index), model=pair.model, effort=pair.effort)
        for index, pair in enumerate(ranking)
        if pair.effort is not None or pair.model not in explicit_models
    )
    offered = (offered[0], offered[0].model_copy(update={"id": "alias"}), *offered[1:])
    request = ClassifyRequest(
        models=offered,
        conversation=(Message(role=Role.USER, parts=(TextPart(text="Classify this request"),)),),
    )
    choices = service.classify(request).ranked_choices
    assert choices == offered
    restricted = offered[4::7]
    assert (
        service.classify(request.model_copy(update={"models": restricted})).ranked_choices
        == restricted
    )
