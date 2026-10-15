from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi.testclient import TestClient

from gh_aw_router.contracts import ClassifierOutput, ClassifyRequest, RouteRequest, RoutingMode
from gh_aw_router.http import create_app
from gh_aw_router.service import GhAwRouterService

EXAMPLES_ROOT = Path(__file__).resolve().parents[1] / "examples"


def test_classify_example_is_valid_and_executable(service: GhAwRouterService) -> None:
    request = ClassifyRequest.model_validate_json(
        (EXAMPLES_ROOT / "classify-request.json").read_bytes(),
        strict=True,
    )

    response = service.classify(request)

    assert {(choice.id, choice.model, choice.effort) for choice in response.ranked_choices} == {
        (choice.id, choice.model, choice.effort) for choice in request.models
    }


def test_route_example_is_valid_and_executable(service: GhAwRouterService) -> None:
    request = RouteRequest.model_validate_json(
        (EXAMPLES_ROOT / "route-request.json").read_bytes(),
        strict=True,
    )

    response = service.route(request)

    assert request.objective.mode is RoutingMode.AUTO
    assert request.classification is not None
    assert {(choice.id, choice.model, choice.effort) for choice in response.ranked_choices} == {
        (choice.id, choice.model, choice.effort) for choice in request.models
    }


def test_readme_http_requests_are_executable(service: GhAwRouterService) -> None:
    readme = EXAMPLES_ROOT.parent / "README.md"
    content = readme.read_text(encoding="utf-8")
    requests = []
    route_responses = []
    pattern = r"--data-binary @([^\s]+)\s+\\\s+http://127\.0\.0\.1:8737(/[^\s]+)"
    with TestClient(create_app(service)) as client:
        for target, endpoint in re.findall(pattern, content):
            payload = (EXAMPLES_ROOT.parent / target).read_bytes()
            response = client.post(
                endpoint, content=payload, headers={"Content-Type": "application/json"}
            )
            assert response.status_code == 200, response.text
            result = response.json()
            assert result["ranked_choices"]
            requests.append(endpoint)
            if endpoint == "/route":
                route_responses.append(result)
    assert requests == ["/classify", "/route"]

    examples = [
        json.loads(block) for block in re.findall(r"```json\n(.*?)\n```", content, re.DOTALL)
    ]
    assert [example for example in examples if "ranked_choices" in example] == route_responses


def test_readme_classifier_output_matches_contract() -> None:
    content = (EXAMPLES_ROOT.parent / "README.md").read_text(encoding="utf-8")
    examples = [
        block
        for block in re.findall(r"```json\n(.*?)\n```", content, re.DOTALL)
        if "labels" in json.loads(block)
    ]

    assert len(examples) == 1
    classification = ClassifierOutput.model_validate_json(examples[0], strict=True)
    request = RouteRequest.model_validate_json(
        (EXAMPLES_ROOT / "route-request.json").read_bytes(), strict=True
    )
    assert request.classification == classification
