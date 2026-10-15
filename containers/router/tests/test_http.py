from __future__ import annotations

import asyncio
import io
import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.exceptions import HTTPException
from starlette.types import Message, Receive, Scope, Send

from gh_aw_router import __version__
from gh_aw_router.cli import run
from gh_aw_router.http import MAX_BODY_BYTES, MAX_DETAIL_CHARS, DeadlineMiddleware, create_app
from gh_aw_router.service import GhAwRouterService

PROJECT_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def client(synthetic_service: GhAwRouterService) -> TestClient:
    return TestClient(create_app(synthetic_service))


def test_health_and_capabilities(client: TestClient) -> None:
    assert client.get("/healthz").status_code == 204

    response = client.get("/capabilities")
    assert response.status_code == 200
    body = response.json()
    assert body["version"] == __version__
    assert "api_versions" not in body
    assert any(
        model["model"] == "provider/reasoning" for model in body["execution_catalogue"]["models"]
    )


@pytest.mark.parametrize("command", ["classify", "route"])
def test_classify_and_route_use_the_shared_contract(
    client: TestClient, planning_payload: Callable[[str], dict[str, Any]], command: str
) -> None:
    payload = planning_payload(command)
    response = client.post(f"/{command}", json=payload)
    assert response.status_code == 200
    assert response.json()["ranked_choices"] == payload["models"]


def test_typed_request_errors(client: TestClient) -> None:
    unsupported = client.post(
        "/classify",
        json={
            "conversation": [],
            "models": [],
        },
    )
    assert unsupported.status_code == 422
    assert unsupported.json()["code"] == "invalid_request"

    malformed = client.post(
        "/classify",
        content=b"{",
        headers={"content-type": "application/json"},
    )
    assert malformed.status_code == 400
    assert malformed.json()["code"] == "invalid_json"

    unknown_field = client.post(
        "/classify",
        json={
            "conversation": [],
            "models": [],
            "extra": True,
        },
    )
    assert unknown_field.status_code == 422
    assert unknown_field.json()["code"] == "invalid_json"


@pytest.mark.parametrize("command", ["classify", "route"])
@pytest.mark.parametrize("field", ["api_version", "repository", "task_id"])
def test_requests_do_not_accept_retired_metadata(
    client: TestClient, planning_payload: Callable[[str], dict[str, Any]], command: str, field: str
) -> None:
    payload = planning_payload(command)
    payload[field] = "unused"

    response = client.post(f"/{command}", json=payload)

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_json"
    assert field in response.json()["detail"]


def test_no_route_and_body_limit_fail_closed(client: TestClient) -> None:
    no_route = client.post(
        "/route",
        json={
            "objective": {"goal": "cost", "mode": "balanced"},
            "conversation": [{"role": "user", "parts": [{"text": "Fix this function"}]}],
            "classification": {
                "labels": {
                    "task_type": "fix",
                    "scope": "local",
                    "task_complexity": "easy",
                },
                "mode": "balanced",
            },
            "models": [],
        },
    )
    assert no_route.status_code == 422
    assert no_route.json()["code"] == "no_route"

    too_large = client.post(
        "/route",
        content=b"x" * (MAX_BODY_BYTES + 1),
        headers={"content-type": "application/json"},
    )
    assert too_large.status_code == 413
    assert too_large.json()["code"] == "payload_too_large"


@pytest.mark.parametrize("mode", ["economy", "balanced", "robust"])
def test_service_advertises_and_enforces_its_loaded_profiles(mode: str) -> None:
    service = GhAwRouterService.load(PROJECT_ROOT / "routing" / f"cost-{mode}.json")
    client = TestClient(create_app(service))
    capabilities = client.get("/capabilities").json()
    assert capabilities["routing_profiles"] == [{"goal": "cost", "mode": mode}]
    request = {
        "conversation": [{"role": "user", "parts": [{"text": "Fix this function"}]}],
        "models": [{"id": "luna", "model": "github-copilot/gpt-5.6-luna", "effort": "medium"}],
    }
    for goal in ("cost", "cost-speed"):
        for requested_mode in ("economy", "balanced", "robust"):
            served = goal == "cost" and requested_mode == mode
            response = client.post(
                "/route", json={**request, "objective": {"goal": goal, "mode": requested_mode}}
            )
            assert response.status_code == (200 if served else 422)
            if not served:
                assert response.json()["code"] == "invalid_request"
                assert "routing profile is not served" in response.json()["detail"]
    for unknown in ({"goal": "cost", "mode": "critical"}, {"goal": "speed", "mode": "balanced"}):
        response = client.post("/route", json={**request, "objective": unknown})
        assert response.status_code == 422
        assert response.json()["code"] == "invalid_json"


def test_published_tables_serve_every_profile() -> None:
    client = TestClient(create_app(GhAwRouterService.load(PROJECT_ROOT / "routing")))

    assert client.get("/capabilities").json()["routing_profiles"] == [
        {"goal": goal, "mode": mode}
        for goal in ("cost", "cost-speed")
        for mode in ("economy", "balanced", "robust")
    ]


@pytest.mark.parametrize(
    ("path", "code"), [("/classify", "invalid_request"), ("/route", "no_route")]
)
def test_missing_reasoning_effort_returns_the_operation_error(
    client: TestClient, path: str, code: str
) -> None:
    request = {
        "conversation": [{"role": "user", "parts": [{"text": "Fix this function"}]}],
        "models": [{"id": "reasoning", "model": "provider/reasoning"}],
    }
    if path == "/route":
        request["objective"] = {"goal": "cost", "mode": "balanced"}
    response = client.post(path, json=request)
    assert response.status_code == 422
    assert response.json()["code"] == code
    assert "effort" in response.json()["detail"]


@pytest.mark.parametrize("supported", [False, True])
@pytest.mark.parametrize(
    "candidate",
    [
        {"id": "unsupported", "model": "provider/unknown"},
        {"id": "unsupported", "model": "provider/reasoning", "effort": "low"},
        {"id": "unsupported", "model": "provider/reasoning"},
    ],
)
def test_route_filters_unsupported_choices(
    client: TestClient,
    planning_payload: Callable[[str], dict[str, Any]],
    candidate: dict[str, str],
    supported: bool,
) -> None:
    payload = planning_payload("route")
    expected = payload["models"] if supported else []
    payload["models"] = [candidate, *expected]
    payload["current_id"] = candidate["id"]

    response = client.post("/route", json=payload)

    assert response.status_code == (200 if supported else 422)
    if supported:
        assert response.json()["ranked_choices"] == expected
    else:
        assert response.json()["code"] == "no_route"


@pytest.mark.parametrize(
    "objective",
    [
        {"goal": "cost", "mode": "custom"},
        {"goal": "cost-speed", "mode": "custom", "overrides": {"cost": 1000}},
        {"goal": "cost", "mode": "balanced", "overrides": None},
        {"goal": "cost", "mode": "auto", "overrides": {"cost": 1000}},
    ],
)
def test_removed_objective_settings_are_schema_errors(
    client: TestClient,
    planning_payload: Callable[[str], dict[str, Any]],
    objective: dict[str, Any],
) -> None:
    payload = planning_payload("route")
    payload["objective"] = objective
    response = client.post("/route", json=payload)

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_json"
    assert "objective" in response.json()["detail"]
    assert client.get("/capabilities").json()["routing_profiles"] == [
        {"goal": "cost", "mode": "balanced"},
    ]


@pytest.mark.parametrize("path", ["/classify", "/route"])
def test_invalid_utf8_uses_the_canonical_error(client: TestClient, path: str) -> None:
    response = client.post(
        path,
        content=b"\xff",
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 400
    assert response.json() == {
        "code": "invalid_json",
        "detail": "Failed to parse the request body as JSON",
    }


@pytest.mark.parametrize("command", ["classify", "route"])
@pytest.mark.parametrize(
    ("content_type", "status"),
    [
        (None, 200),
        ("application/json", 200),
        ("Application/JSON; charset=utf-8", 200),
        ("application/vnd.router+json", 200),
        ("text/plain", 415),
        ("multipart/form-data", 415),
    ],
)
def test_planning_endpoints_accept_only_json_media_types(
    client: TestClient,
    planning_payload: Callable[[str], dict[str, Any]],
    command: str,
    content_type: str | None,
    status: int,
) -> None:
    headers = {} if content_type is None else {"content-type": content_type}
    response = client.post(
        f"/{command}", content=json.dumps(planning_payload(command)).encode(), headers=headers
    )
    assert response.status_code == status
    if status != 200:
        assert response.json()["code"] == "unsupported_media_type"


@pytest.mark.parametrize("method", ["GET", "POST", "DELETE"])
def test_declared_oversize_length_is_rejected_for_every_method(
    client: TestClient, method: str
) -> None:
    response = client.request(
        method,
        "/capabilities",
        headers={"content-type": "application/json", "content-length": str(MAX_BODY_BYTES + 1)},
    )

    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"


def test_validation_errors_name_fields_without_echoing_values(
    client: TestClient, planning_payload: Callable[[str], dict[str, Any]]
) -> None:
    payload = planning_payload("route")
    payload["models"][0]["effort"] = "supreme"
    response = client.post("/route", json=payload)

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "models.0.effort" in detail
    assert "supreme" not in detail

    incomplete = planning_payload("route")
    del incomplete["objective"]
    assert "objective" in client.post("/route", json=incomplete).json()["detail"]

    noisy = planning_payload("route")
    noisy["conversation"] = [
        {"role": "user", "parts": [{"text": "x", "bad\u0007key": i}]} for i in range(40)
    ]
    crowded = client.post("/route", json=noisy).json()["detail"]
    assert len(crowded) <= MAX_DETAIL_CHARS
    assert crowded.isprintable()


def test_request_errors_have_bounded_printable_details(client: TestClient) -> None:
    response = client.post(
        "/classify",
        json={
            "api_version": "x" * (MAX_DETAIL_CHARS * 2),
            "conversation": [],
            "models": [],
        },
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert len(detail) <= MAX_DETAIL_CHARS
    assert detail.isprintable()


def test_transport_errors_use_the_shared_envelope(synthetic_service: GhAwRouterService) -> None:
    app = create_app(synthetic_service)

    @app.get("/bad-request")
    def bad_request() -> None:
        raise HTTPException(400, "application error", headers={"x-error": "original"})

    client = TestClient(app)
    response = client.get("/bad-request")

    assert response.status_code == 400
    assert response.json() == {"code": "invalid_request", "detail": "application error"}
    assert response.headers["x-error"] == "original"

    missing = client.get("/missing")
    assert missing.status_code == 404
    assert missing.json() == {"code": "not_found", "detail": "Not Found"}

    wrong_method = client.get("/route")
    assert wrong_method.status_code == 405
    assert wrong_method.json()["code"] == "method_not_allowed"
    assert "POST" in wrong_method.headers["allow"]


def test_internal_errors_log_tracebacks_without_exposing_details(
    synthetic_service: GhAwRouterService, caplog: pytest.LogCaptureFixture
) -> None:
    app = create_app(synthetic_service)
    error = RuntimeError("private internal failure details")

    @app.get("/internal-error")
    def internal_error() -> None:
        raise error

    client = TestClient(app, raise_server_exceptions=False)
    response = client.get("/internal-error")

    assert response.status_code == 500
    assert response.json() == {
        "code": "internal_error",
        "detail": "internal error while processing the request",
    }
    records = [
        record
        for record in caplog.records
        if record.getMessage() == "unhandled gh-aw-router HTTP error"
    ]
    assert len(records) == 1
    record = records[0]
    assert record.levelname == "ERROR"
    assert record.exc_info is not None
    assert record.exc_info[1] is error
    assert record.exc_info[2] is not None


@pytest.mark.parametrize("path", ["/classify", "/route", "/route/", "/missing", "/healthz"])
@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH"])
@pytest.mark.parametrize("content_length", [None, b"100"])
def test_deadline_includes_incomplete_uploads(
    synthetic_service: GhAwRouterService, path: str, method: str, content_length: bytes | None
) -> None:
    app = create_app(synthetic_service)
    for middleware in app.user_middleware:
        if middleware.cls is DeadlineMiddleware:
            middleware.kwargs["seconds"] = 0.01
    messages: list[Message] = []
    headers = [(b"content-type", b"application/json")]
    if content_length is not None:
        headers.append((b"content-length", content_length))
    scope: Scope = {
        "type": "http",
        "method": method,
        "path": path,
        "headers": headers,
    }

    async def upload() -> None:
        delivered = False

        async def receive() -> Message:
            nonlocal delivered
            if delivered:
                await asyncio.Event().wait()
            delivered = True
            return {"type": "http.request", "body": b"{", "more_body": True}

        async def send(message: Message) -> None:
            messages.append(message)

        await asyncio.wait_for(app(scope, receive, send), timeout=1.0)

    asyncio.run(upload())

    assert messages[0]["type"] == "http.response.start"
    assert messages[0]["status"] == 504
    assert json.loads(messages[1]["body"]) == {
        "code": "request_timeout",
        "detail": "request exceeded the 0.01-second response deadline",
    }


@pytest.mark.parametrize("path", ["/openapi.json", "/docs", "/redoc"])
def test_generated_contract_endpoints_are_disabled(client: TestClient, path: str) -> None:
    assert client.get(path).status_code == 404


@pytest.mark.parametrize("command", ["classify", "route"])
@pytest.mark.parametrize("case", ["unicode", "surrogate", "nested", "invalid-field"])
def test_cli_and_http_share_json_decoding(
    client: TestClient,
    planning_payload: Callable[[str], dict[str, Any]],
    synthetic_table_path: Path,
    command: str,
    case: str,
) -> None:
    payload = planning_payload(command)
    text = "Fix the parser \u00e9"
    if case == "surrogate":
        text = "\ud800"
    payload["conversation"][-1]["parts"] = [{"text": text}]
    if case == "invalid-field":
        payload["conversation"][-1]["role"] = 123
    raw = json.dumps(payload)
    if case == "nested":
        nested: object = 0
        for _depth in range(250):
            nested = [nested]
        payload["conversation"].append(
            {
                "role": "assistant",
                "parts": [{"tool_call": {"id": "call", "name": "lookup", "input": nested}}],
            }
        )
        raw = json.dumps(payload)
    response = client.post(
        f"/{command}", content=raw.encode(), headers={"content-type": "application/json"}
    )
    stdout, stderr = io.StringIO(), io.StringIO()
    status = run(
        ["--routing-tables", str(synthetic_table_path), command],
        stdin=io.StringIO(raw),
        stdout=stdout,
        stderr=stderr,
    )
    if case == "unicode":
        assert response.status_code == 200
        assert status == 0
        assert response.json() == json.loads(stdout.getvalue())
    else:
        assert response.status_code == (422 if case == "invalid-field" else 400)
        assert response.json()["code"] == "invalid_json"
        assert status == 2
        assert stdout.getvalue() == ""


@pytest.mark.parametrize(
    ("recommendation", "legacy_labels", "error_code"),
    [
        (None, False, None),
        ("balanced", False, None),
        ("unknown", False, None),
        ("economy", False, "invalid_request"),
        ("robust", False, "invalid_request"),
        ("auto", False, "invalid_json"),
        ("balanced", True, "invalid_json"),
    ],
)
def test_cli_and_http_share_auto_routing(
    client: TestClient,
    planning_payload: Callable[[str], dict[str, Any]],
    synthetic_table_path: Path,
    recommendation: str | None,
    legacy_labels: bool,
    error_code: str | None,
) -> None:
    payload = planning_payload("route")
    payload["objective"]["mode"] = "auto"
    payload["current_id"] = "reasoning"
    if recommendation is not None:
        labels = {"task_type": "fix", "scope": "local", "task_complexity": "easy"}
        payload["classification"] = {"labels": labels, "mode": recommendation}
        if legacy_labels:
            payload["labels"] = labels
    response = client.post("/route", json=payload)
    stdout, stderr = io.StringIO(), io.StringIO()
    status = run(
        ["--routing-tables", str(synthetic_table_path), "route"],
        stdin=io.StringIO(json.dumps(payload)),
        stdout=stdout,
        stderr=stderr,
    )

    if error_code is None:
        assert response.status_code == 200
        assert status == 0
        assert stderr.getvalue() == ""
        assert response.json() == json.loads(stdout.getvalue())
        assert [choice["id"] for choice in response.json()["ranked_choices"]] == [
            "reasoning",
            "fast",
        ]
    else:
        assert response.status_code == 422
        assert response.json()["code"] == error_code
        assert status == 2
        assert stdout.getvalue() == ""
        assert stderr.getvalue().startswith("invalid request:")


def test_route_deadline_returns_the_canonical_error() -> None:
    app = FastAPI()
    app.add_middleware(DeadlineMiddleware, seconds=0.001)

    @app.post("/route")
    def slow_route() -> dict[str, bool]:
        time.sleep(0.05)
        return {"completed": True}

    response = TestClient(app).post("/route")

    assert response.status_code == 504
    assert response.json() == {
        "code": "request_timeout",
        "detail": "request exceeded the 0.001-second response deadline",
    }


@pytest.mark.parametrize("started", [False, True])
def test_deadline_does_not_replace_application_timeouts_or_started_responses(
    started: bool,
) -> None:
    messages: list[Message] = []

    async def application(_scope: Scope, _receive: Receive, send: Send) -> None:
        if started:
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await asyncio.Event().wait()
        raise TimeoutError("application timeout")

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        messages.append(message)

    async def exercise() -> None:
        middleware = DeadlineMiddleware(application, seconds=0.01)
        with pytest.raises(TimeoutError):
            await middleware({"type": "http", "path": "/route"}, receive, send)

    asyncio.run(exercise())

    assert [message["status"] for message in messages] == ([200] if started else [])
