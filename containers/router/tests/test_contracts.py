from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from gh_aw_router.contracts import (
    ClassifyRequest,
    Labels,
    RouteRequest,
    RoutingMode,
    RoutingModeRecommendation,
    RoutingObjective,
)


@pytest.mark.parametrize("mode_type", [RoutingMode, RoutingModeRecommendation])
def test_critical_mode_is_not_supported(
    mode_type: type[RoutingMode] | type[RoutingModeRecommendation],
) -> None:
    with pytest.raises(ValueError, match="'critical' is not a valid"):
        mode_type("critical")


def test_labels_reject_unknown_fields() -> None:
    with pytest.raises(ValidationError, match="extra"):
        Labels.model_validate_json(
            b'{"task_type":"fix","scope":"local","task_complexity":"easy","extra":true}',
            strict=True,
        )


@pytest.mark.parametrize("missing", ["task_type", "scope", "task_complexity"])
def test_every_live_label_field_is_required(missing: str) -> None:
    labels = {"task_type": "fix", "scope": "local", "task_complexity": "easy"}
    del labels[missing]
    with pytest.raises(ValidationError, match=missing):
        Labels.model_validate(labels)


@pytest.mark.parametrize("goal", ["cost", "cost-speed"])
@pytest.mark.parametrize("mode", ["economy", "balanced", "robust", "auto"])
def test_objective_contains_only_goal_and_mode(goal: str, mode: str) -> None:
    payload = {"goal": goal, "mode": mode}
    objective = RoutingObjective.model_validate_json(json.dumps(payload), strict=True)

    assert objective.model_dump(mode="json") == payload


@pytest.mark.parametrize(
    "payload",
    [
        {"goal": "cost", "mode": "critical"},
        {"goal": "speed", "mode": "balanced"},
        {"goal": "cost", "mode": "custom"},
        {"goal": "cost", "mode": "custom", "overrides": {"cost": 1000.0}},
    ],
)
def test_objective_rejects_unsupported_goals_and_modes(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        RoutingObjective.model_validate(payload)


@pytest.mark.parametrize("mode", ["economy", "balanced", "robust", "auto"])
@pytest.mark.parametrize("overrides", [None, {}, {"cost": 1000.0}])
def test_objective_rejects_overrides(mode: str, overrides: dict[str, float] | None) -> None:
    with pytest.raises(ValidationError, match="overrides") as error:
        RoutingObjective.model_validate({"goal": "cost", "mode": mode, "overrides": overrides})
    assert error.value.errors()[0]["type"] == "extra_forbidden"


@pytest.mark.parametrize("model", [ClassifyRequest, RouteRequest])
def test_requests_reject_duplicate_model_choice_ids(
    model: type[ClassifyRequest] | type[RouteRequest],
) -> None:
    payload = _planning_payload(model)
    payload["models"] = [
        {"id": "same", "model": "provider/first"},
        {"id": "same", "model": "provider/second"},
    ]
    with pytest.raises(ValidationError, match="model choice ids must be unique"):
        model.model_validate_json(json.dumps(payload), strict=True)


def test_route_requests_require_a_conversation() -> None:
    payload = _planning_payload(RouteRequest)
    del payload["conversation"]
    with pytest.raises(ValidationError, match="conversation"):
        RouteRequest.model_validate_json(json.dumps(payload), strict=True)


@pytest.mark.parametrize("mode", ["auto", "custom", "critical", None])
def test_classification_requires_a_recommendation_mode(mode: str | None) -> None:
    payload = _planning_payload(RouteRequest)
    payload["classification"] = {
        "labels": {"task_type": "fix", "scope": "local", "task_complexity": "easy"},
        "mode": mode,
    }
    with pytest.raises(ValidationError, match=r"classification\.mode"):
        RouteRequest.model_validate_json(json.dumps(payload), strict=True)


@pytest.mark.parametrize("include_classification", [False, True])
@pytest.mark.parametrize(
    "labels", [None, {"task_type": "fix", "scope": "local", "task_complexity": "easy"}]
)
def test_top_level_labels_are_rejected(
    include_classification: bool, labels: dict[str, str] | None
) -> None:
    payload = _planning_payload(RouteRequest)
    payload["labels"] = labels
    if include_classification:
        payload["classification"] = {
            "labels": {"task_type": "fix", "scope": "local", "task_complexity": "easy"},
            "mode": "balanced",
        }
    with pytest.raises(ValidationError, match="labels") as error:
        RouteRequest.model_validate_json(json.dumps(payload), strict=True)
    assert error.value.errors()[0]["type"] == "extra_forbidden"


@pytest.mark.parametrize("model", [ClassifyRequest, RouteRequest])
@pytest.mark.parametrize("field", ["repository", "task_id"])
@pytest.mark.parametrize("value", [None, "", " ", 123, "acme/widgets"])
def test_planning_requests_reject_execution_metadata(
    model: type[ClassifyRequest] | type[RouteRequest], field: str, value: object
) -> None:
    payload = _planning_payload(model)
    request = model.model_validate_json(json.dumps(payload), strict=True)
    assert field not in request.model_dump()
    payload[field] = value
    with pytest.raises(ValidationError, match=field) as error:
        model.model_validate_json(json.dumps(payload), strict=True)
    assert error.value.errors()[0]["type"] == "extra_forbidden"


@pytest.mark.parametrize("model", [ClassifyRequest, RouteRequest])
def test_planning_contract_has_no_version_negotiation(
    model: type[ClassifyRequest] | type[RouteRequest],
) -> None:
    payload = _planning_payload(model)
    request = model.model_validate_json(json.dumps(payload), strict=True)
    assert "api_version" not in request.model_dump()
    payload["api_version"] = "0.2.0"
    with pytest.raises(ValidationError, match="api_version") as error:
        model.model_validate_json(json.dumps(payload), strict=True)
    assert error.value.errors()[0]["type"] == "extra_forbidden"


def _planning_payload(model: type[ClassifyRequest] | type[RouteRequest]) -> dict[str, object]:
    payload: dict[str, object] = {
        "conversation": [],
        "models": [],
    }
    if model is RouteRequest:
        payload["objective"] = {"goal": "cost", "mode": "balanced"}
    return payload
