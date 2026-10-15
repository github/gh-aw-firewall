"""FastAPI adapter for the standalone gh-aw-router planning service."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping, Sequence
from email.message import Message as HeaderMessage
from typing import Annotated, Any, Final

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.types import Message as AsgiMessage

from gh_aw_router import __version__
from gh_aw_router.classification import ClassificationError
from gh_aw_router.contracts import (
    ClassifyRequest,
    ClassifyResponse,
    ErrorCode,
    ErrorResponse,
    PlanningRequest,
    RouteRequest,
    RouteResponse,
    ServiceCapabilities,
    decode_request,
)
from gh_aw_router.routing import NoRouteError, RoutingError
from gh_aw_router.service import GhAwRouterService, InvalidRequestError

MAX_BODY_BYTES: Final = 1024 * 1024
REQUEST_DEADLINE_SECONDS: Final = 30.0
MAX_REPORTED_ERRORS: Final = 5
MAX_DETAIL_CHARS: Final = 500
_BODY_METHODS: Final = frozenset({"POST", "PUT", "PATCH"})
_TRANSPORT_ERROR_CODES: Final = {
    404: ErrorCode.NOT_FOUND,
    405: ErrorCode.METHOD_NOT_ALLOWED,
    415: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
}
_LOGGER = logging.getLogger(__name__)


class BodyLimitMiddleware:
    """Bound buffered upload size before request decoding, including chunked bodies."""

    def __init__(self, app: ASGIApp, maximum: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.maximum = maximum

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = _content_length(scope)
        if declared is not None and declared > self.maximum:
            await self._reject(scope, receive, send)
            return
        if scope.get("method") not in _BODY_METHODS:
            await self.app(scope, receive, send)
            return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > self.maximum:
                await self._reject(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay() -> AsgiMessage:
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send)

    async def _reject(self, scope: Scope, receive: Receive, send: Send) -> None:
        response = _error_response(
            413,
            ErrorCode.PAYLOAD_TOO_LARGE,
            f"request body exceeds the {self.maximum}-byte limit",
        )
        await response(scope, receive, send)


class DeadlineMiddleware:
    """Bound HTTP uploads and responses without replacing an already started response."""

    def __init__(self, app: ASGIApp, seconds: float = REQUEST_DEADLINE_SECONDS) -> None:
        self.app = app
        self.seconds = seconds

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        response_started = False

        async def track_send(message: AsgiMessage) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        deadline = asyncio.timeout(self.seconds)
        try:
            async with deadline:
                await self.app(scope, receive, track_send)
        except TimeoutError:
            if not deadline.expired() or response_started:
                raise
            response = _error_response(
                504,
                ErrorCode.REQUEST_TIMEOUT,
                f"request exceeded the {self.seconds:g}-second response deadline",
            )
            await response(scope, receive, send)


async def _validation_error(
    _request: Request,
    error: Exception,
) -> JSONResponse:
    if not isinstance(error, RequestValidationError):
        raise TypeError(f"expected RequestValidationError, got {type(error)!r}")
    errors = error.errors()
    if any(item.get("type") == "json_invalid" for item in errors):
        return _error_response(
            400,
            ErrorCode.INVALID_JSON,
            "Failed to parse the request body as JSON",
        )
    return _error_response(422, ErrorCode.INVALID_JSON, _describe_errors(errors))


def _describe_errors(errors: Sequence[Mapping[str, Any]]) -> str:
    """Name the failing fields without echoing caller-supplied values."""
    reported = "; ".join(
        f"{_error_location(item)}: {item.get('msg', 'invalid value')}"
        for item in errors[:MAX_REPORTED_ERRORS]
    )
    remaining = len(errors) - MAX_REPORTED_ERRORS
    if remaining > 0:
        reported = f"{reported}; and {remaining} more"
    return f"request does not match the contract: {reported}"


def _error_location(item: Mapping[str, Any]) -> str:
    return ".".join(str(part) for part in item.get("loc", ())) or "body"


async def _invalid_request(_request: Request, error: Exception) -> JSONResponse:
    return _error_response(
        422,
        ErrorCode.INVALID_REQUEST,
        f"invalid request: {error}",
    )


async def _no_route(_request: Request, error: Exception) -> JSONResponse:
    return _error_response(422, ErrorCode.NO_ROUTE, f"no route: {error}")


async def _transport_error(_request: Request, error: Exception) -> JSONResponse:
    """Report routing and method failures in the same envelope as planning errors."""
    if not isinstance(error, HTTPException):
        raise TypeError(f"expected HTTPException, got {type(error)!r}")
    code = _TRANSPORT_ERROR_CODES.get(
        error.status_code,
        ErrorCode.INTERNAL_ERROR if error.status_code >= 500 else ErrorCode.INVALID_REQUEST,
    )
    return _error_response(error.status_code, code, error.detail, headers=error.headers)


async def _internal_error(_request: Request, error: Exception) -> JSONResponse:
    _LOGGER.error("unhandled gh-aw-router HTTP error", exc_info=error)
    return _error_response(
        500,
        ErrorCode.INTERNAL_ERROR,
        "internal error while processing the request",
    )


async def _decode_http_request[RequestModel: PlanningRequest](
    model: type[RequestModel], request: Request
) -> RequestModel:
    if not _is_json_media_type(request.headers.get("content-type")):
        raise HTTPException(415, "Expected a JSON request body")
    try:
        return decode_request(model, await request.body())
    except ValidationError as error:
        raise RequestValidationError(error.errors(include_input=False)) from error


def _is_json_media_type(content_type: str | None) -> bool:
    """Accept an absent content type, application/json, and application/*+json."""
    headers = HeaderMessage()
    headers["content-type"] = content_type or "application/json"
    subtype = headers.get_content_subtype()
    return headers.get_content_maintype() == "application" and (
        subtype == "json" or subtype.endswith("+json")
    )


async def _classify_request(request: Request) -> ClassifyRequest:
    return await _decode_http_request(ClassifyRequest, request)


async def _route_request(request: Request) -> RouteRequest:
    return await _decode_http_request(RouteRequest, request)


def create_app(service: GhAwRouterService) -> FastAPI:
    """Expose a loaded service over private HTTP with bounded uploads and typed errors.

    Endpoints run on the event loop because planning uses only in-memory data.
    The deadline can cancel upload and response waits, not synchronous computation.
    """
    app = FastAPI(
        title="gh-aw-router HTTP API",
        version=__version__,
        description=(
            "Stateless classification planning and model routing for trusted host adapters."
        ),
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_middleware(BodyLimitMiddleware)
    app.add_middleware(DeadlineMiddleware)

    for exception_type in (
        ClassificationError,
        InvalidRequestError,
        RoutingError,
    ):
        app.add_exception_handler(exception_type, _invalid_request)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(HTTPException, _transport_error)
    app.add_exception_handler(NoRouteError, _no_route)
    app.add_exception_handler(Exception, _internal_error)

    @app.get("/healthz", status_code=204, response_class=Response)
    async def health() -> Response:
        return Response(status_code=204)

    @app.get("/capabilities", response_model=ServiceCapabilities)
    async def capabilities() -> ServiceCapabilities:
        return service.capabilities()

    @app.post(
        "/classify",
        response_model=ClassifyResponse,
        response_model_exclude_none=True,
    )
    async def classify(
        request: Annotated[ClassifyRequest, Depends(_classify_request)],
    ) -> ClassifyResponse:
        return service.classify(request)

    @app.post(
        "/route",
        response_model=RouteResponse,
        response_model_exclude_none=True,
    )
    async def route(request: Annotated[RouteRequest, Depends(_route_request)]) -> RouteResponse:
        return service.route(request)

    return app


def _content_length(scope: Scope) -> int | None:
    """Return a declared nonnegative length, treating malformed headers as unknown."""
    for name, value in scope.get("headers", ()):
        if name.lower() == b"content-length":
            try:
                length = int(value)
            except ValueError:
                return None
            return length if length >= 0 else None
    return None


def _error_response(
    status: int,
    code: ErrorCode,
    detail: str,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    printable_detail = "".join(
        character if character.isprintable() else " " for character in detail
    )
    body = ErrorResponse(code=code, detail=printable_detail[:MAX_DETAIL_CHARS])
    return JSONResponse(status_code=status, content=body.model_dump(mode="json"), headers=headers)
