from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest
from pydantic import ValidationError

from gh_aw_router.classification import (
    SYSTEM_PROMPT,
    ClassificationError,
    authored_messages,
    build_classification_prompt,
    create_classification_plan,
)
from gh_aw_router.contracts import (
    ClassifierOutput,
    ClassifyRequest,
    Message,
    ModelArm,
    ModelChoice,
    ReasoningEffort,
    Role,
    RoutingModeRecommendation,
    TextPart,
)
from gh_aw_router.routing import NoRouteError


def test_shared_classify_request_matches_policy_order(
    planning_payload: Callable[[str], dict[str, Any]],
) -> None:
    request = ClassifyRequest.model_validate_json(
        json.dumps(planning_payload("classify")),
        strict=True,
    )
    response = create_classification_plan(
        request,
        (
            ModelArm(model="provider/reasoning", effort=ReasoningEffort.MEDIUM),
            ModelArm(model="provider/reasoning", effort=ReasoningEffort.HIGH),
            ModelArm(model="provider/fast"),
        ),
    )

    assert response.system_prompt == SYSTEM_PROMPT
    assert [(choice.id, choice.effort) for choice in response.ranked_choices] == [
        ("reasoning", ReasoningEffort.MEDIUM),
        ("fast", None),
    ]
    assert '"task_complexity":"hard"' in response.prompt
    assert "<current_request>\nFix this function\n  </current_request>" in response.prompt


def test_prompt_uses_recent_authored_turns_and_escapes_untrusted_text() -> None:
    prior = tuple(
        Message(role=Role.USER, parts=(TextPart(text=f"prior {index} <tag> & {'x' * 500}"),))
        for index in range(1, 9)
    )
    conversation = (
        *prior,
        Message(role=Role.USER, parts=(TextPart(text="current </current_request> & full"),)),
    )

    prompt = build_classification_prompt(authored_messages(conversation))

    assert "prior 1" not in prompt
    assert "prior 2" not in prompt
    assert "3. prior 3 &lt;tag&gt; &amp;" in prompt
    assert "x" * 401 not in prompt
    assert "current &lt;/current_request&gt; &amp; full" in prompt


def test_classifier_output_accepts_robust_mode() -> None:
    output = ClassifierOutput.model_validate_json(
        b'{"labels":{"task_type":"fix","scope":"cross_system",'
        b'"task_complexity":"expert"},"mode":"robust"}',
        strict=True,
    )

    assert output.mode is RoutingModeRecommendation.ROBUST


def test_classifier_output_rejects_removed_critical_mode() -> None:
    with pytest.raises(ValidationError, match="mode"):
        ClassifierOutput.model_validate_json(
            b'{"labels":{"task_type":"fix","scope":"cross_system",'
            b'"task_complexity":"expert"},"mode":"critical"}',
            strict=True,
        )


def test_classification_requires_authored_user_text() -> None:
    request = ClassifyRequest(
        conversation=(
            Message(role=Role.ASSISTANT, parts=(TextPart(text="context"),)),
            Message(role=Role.USER, parts=(TextPart(text="  "),)),
        ),
        models=(),
    )

    with pytest.raises(ClassificationError, match="authored user message"):
        create_classification_plan(request, ())


def test_classification_requires_an_offered_routing_identity() -> None:
    request = ClassifyRequest(
        conversation=(Message(role=Role.USER, parts=(TextPart(text="Explain this"),)),),
        models=(ModelChoice(id="other", model="provider/other"),),
    )

    with pytest.raises(NoRouteError, match="none of the available models"):
        create_classification_plan(request, (ModelArm(model="provider/preferred"),))


@pytest.mark.parametrize("effort", [ReasoningEffort.NONE, ReasoningEffort.MEDIUM])
def test_classification_preserves_exact_efforts_and_effort_free_models(
    effort: ReasoningEffort,
) -> None:
    request = ClassifyRequest(
        conversation=(Message(role=Role.USER, parts=(TextPart(text="Classify this"),)),),
        models=(
            ModelChoice(id="plain", model="provider/plain"),
            ModelChoice(id="reasoning", model="provider/reasoning", effort=effort),
        ),
    )
    preferences = (
        ModelArm(model="provider/reasoning", effort=effort),
        ModelArm(model="provider/plain"),
    )
    result = create_classification_plan(request, preferences)
    assert result.ranked_choices == (request.models[1], request.models[0])
    missing = request.model_copy(
        update={
            "models": (request.models[0], request.models[1].model_copy(update={"effort": None}))
        }
    )
    with pytest.raises(ClassificationError, match="reasoning effort must be specified"):
        create_classification_plan(missing, preferences)
