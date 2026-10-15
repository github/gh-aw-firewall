"""Strict public contracts for the standalone planning API."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Self

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictStr, model_validator

NonEmptyString = Annotated[str, Field(min_length=1, strict=True)]
ProviderModelId = Annotated[
    str,
    Field(min_length=1, pattern=r"^[^/]+/[^/]+$", strict=True),
]
PositiveInt = Annotated[int, Field(gt=0, strict=True)]


class StrictModel(BaseModel):
    """Closed boundary model with frozen fields, not deeply immutable containers."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class TaskType(StrEnum):
    EXPLAIN = "explain"
    PLAN = "plan"
    FIX = "fix"
    REFACTOR = "refactor"
    CHORE = "chore"
    IMPLEMENT = "implement"
    UNKNOWN = "unknown"


class TaskScope(StrEnum):
    LOCAL = "local"
    MULTI_FILE = "multi_file"
    SUBSYSTEM = "subsystem"
    CROSS_SYSTEM = "cross_system"
    UNKNOWN = "unknown"


class TaskComplexity(StrEnum):
    TRIVIAL = "trivial"
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"
    EXPERT = "expert"
    UNKNOWN = "unknown"


class RoutingGoal(StrEnum):
    COST = "cost"
    COST_SPEED = "cost-speed"


class RoutingMode(StrEnum):
    ECONOMY = "economy"
    BALANCED = "balanced"
    ROBUST = "robust"
    AUTO = "auto"


class RoutingModeRecommendation(StrEnum):
    ECONOMY = "economy"
    BALANCED = "balanced"
    ROBUST = "robust"
    UNKNOWN = "unknown"


class ReasoningEffort(StrEnum):
    NONE = "none"
    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    XHIGH = "xhigh"
    MAX = "max"


class Role(StrEnum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class Labels(StrictModel):
    task_type: TaskType
    scope: TaskScope
    task_complexity: TaskComplexity


class TextPart(StrictModel):
    text: StrictStr


class ToolCall(StrictModel):
    id: StrictStr
    name: StrictStr
    input: Any = None


class ToolCallPart(StrictModel):
    tool_call: ToolCall


class ToolResult(StrictModel):
    id: StrictStr
    text: StrictStr | None = None
    ok: StrictBool | None = None


class ToolResultPart(StrictModel):
    tool_result: ToolResult


Part = TextPart | ToolCallPart | ToolResultPart


class Message(StrictModel):
    role: Role
    parts: tuple[Part, ...] = ()

    def text(self) -> str:
        """Join text parts as contiguous fragments of one message, excluding tool content."""
        return "".join(part.text for part in self.parts if isinstance(part, TextPart))


class ModelArm(StrictModel):
    model: ProviderModelId
    effort: ReasoningEffort | None = None


class ModelChoice(StrictModel):
    id: NonEmptyString
    model: ProviderModelId
    effort: ReasoningEffort | None = None


class ModelCandidate(ModelChoice):
    context_window: PositiveInt | None = None


class RoutingProfile(StrictModel):
    """Goal and mode pair naming one published routing table."""

    goal: RoutingGoal
    mode: RoutingMode


class RoutingObjective(RoutingProfile):
    """Goal and requested mode, resolved by the service to a published profile."""


class PlanningRequest(StrictModel):
    """Task text shared by stateless classification and routing requests."""

    conversation: tuple[Message, ...]


class ClassifyRequest(PlanningRequest):
    """Conversation and exact dispatch choices available for classification."""

    models: tuple[ModelChoice, ...]

    @model_validator(mode="after")
    def unique_model_ids(self) -> Self:
        """Reject ambiguous request-local choice identifiers."""
        _validate_unique_choice_ids(self.models)
        return self


class ClassifyResponse(StrictModel):
    system_prompt: NonEmptyString
    prompt: str
    ranked_choices: Annotated[tuple[ModelChoice, ...], Field(min_length=1)]


class ClassifierOutput(StrictModel):
    labels: Labels
    mode: RoutingModeRecommendation


class RouteRequest(PlanningRequest):
    """Task context, optional classifier output, and exact dispatch candidates."""

    objective: RoutingObjective
    current_id: NonEmptyString | None = None
    classification: ClassifierOutput | None = None
    models: tuple[ModelCandidate, ...] = ()

    @model_validator(mode="after")
    def unique_model_ids(self) -> Self:
        """Reject ambiguous request-local choice identifiers."""
        _validate_unique_choice_ids(self.models)
        return self


class RouteResponse(StrictModel):
    ranked_choices: Annotated[tuple[ModelChoice, ...], Field(min_length=1)]


class ExecutionModel(StrictModel):
    model: ProviderModelId
    efforts: tuple[ReasoningEffort, ...]


class ExecutionCatalogue(StrictModel):
    models: tuple[ExecutionModel, ...]


class ServiceCapabilities(StrictModel):
    name: StrictStr
    version: StrictStr
    routing_profiles: Annotated[tuple[RoutingProfile, ...], Field(min_length=1)]
    execution_catalogue: ExecutionCatalogue


class ErrorCode(StrEnum):
    INVALID_JSON = "invalid_json"
    INVALID_REQUEST = "invalid_request"
    PAYLOAD_TOO_LARGE = "payload_too_large"
    UNSUPPORTED_MEDIA_TYPE = "unsupported_media_type"
    NOT_FOUND = "not_found"
    METHOD_NOT_ALLOWED = "method_not_allowed"
    NO_ROUTE = "no_route"
    INTERNAL_ERROR = "internal_error"
    REQUEST_TIMEOUT = "request_timeout"


class ErrorResponse(StrictModel):
    code: ErrorCode
    detail: StrictStr


def decode_request[RequestModel: PlanningRequest](
    model: type[RequestModel], data: bytes | str
) -> RequestModel:
    """Decode planning JSON consistently across transports, including parser limits."""
    return model.model_validate_json(data, strict=True)


def _validate_unique_choice_ids(choices: tuple[ModelChoice, ...]) -> None:
    ids = [choice.id for choice in choices]
    if len(ids) != len(set(ids)):
        raise ValueError("model choice ids must be unique")
