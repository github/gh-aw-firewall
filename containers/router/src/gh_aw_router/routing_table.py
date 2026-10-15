"""Order-only lookup policies for standalone serving."""

from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from pathlib import Path
from typing import Final, Literal

from pydantic import Field

from gh_aw_router.classification import authored_messages
from gh_aw_router.contracts import (
    Labels,
    ModelArm,
    ModelChoice,
    ReasoningEffort,
    RouteRequest,
    RouteResponse,
    RoutingGoal,
    RoutingMode,
    RoutingObjective,
    RoutingProfile,
    StrictModel,
    TaskComplexity,
    TaskScope,
    TaskType,
)
from gh_aw_router.heuristics import infer_labels
from gh_aw_router.routing import (
    WINDOW_HEADROOM_TOKENS,
    NoRouteError,
    RoutingError,
    estimate_context_tokens,
)

type _PairIdentity = tuple[str, ReasoningEffort | None]
type _PositionIndex = dict[str, dict[str, dict[_PairIdentity, int]]]

DEFAULT_TABLE_DIRECTORY: Final = Path("routing")
DEFAULT_PROFILE: Final = RoutingObjective(goal=RoutingGoal.COST, mode=RoutingMode.BALANCED)
COST_PROFILES: Final = tuple(
    RoutingObjective(goal=RoutingGoal.COST, mode=mode)
    for mode in (RoutingMode.ECONOMY, RoutingMode.BALANCED, RoutingMode.ROBUST)
)
PROFILES: Final = COST_PROFILES + tuple(
    RoutingObjective(goal=RoutingGoal.COST_SPEED, mode=profile.mode) for profile in COST_PROFILES
)


def profile_key(profile: RoutingProfile) -> str:
    """Encode a fixed profile as the goal/mode lookup key used by compiled tables."""
    return f"{profile.goal.value}/{profile.mode.value}"


def profile_filename(profile: RoutingProfile) -> str:
    """Name the published table file that carries a fixed profile."""
    return f"{profile.goal.value}-{profile.mode.value}.json"


def label_key(labels: Labels) -> str:
    """Encode a complete label triple in the table's stable field order."""
    return f"{labels.task_type.value}/{labels.scope.value}/{labels.task_complexity.value}"


def all_labels() -> tuple[Labels, ...]:
    """Enumerate every label cell, including combinations with unknown values."""
    return tuple(
        Labels(task_type=task, scope=scope, task_complexity=complexity)
        for task, scope, complexity in product(TaskType, TaskScope, TaskComplexity)
    )


class CellRecord(StrictModel):
    labels: Labels
    rankings: dict[str, tuple[ModelArm, ...]]


def pair_key(pair: ModelArm) -> str:
    """Encode a provider-qualified model with an optional explicit effort suffix."""
    return pair.model if pair.effort is None else f"{pair.model}:{pair.effort.value}"


def parse_pair(value: str) -> ModelArm:
    """Decode a canonical table identity, raising ValueError for invalid forms."""
    model, separator, effort = value.rpartition(":")
    pair = ModelArm(
        model=model if separator else value,
        effort=ReasoningEffort(effort) if separator else None,
    )
    if pair.model != pair.model.strip() or ":" in pair.model or pair_key(pair) != value:
        raise ValueError(f"model-effort string must be canonical: {value!r}")
    return pair


class RankingGroup(StrictModel):
    applies_to: tuple[str, ...] = Field(min_length=1)
    choices: tuple[str, ...] = Field(min_length=1)


class TableDocument(StrictModel):
    """One generated profile with offline provenance and an independent classifier order."""

    schema_version: Literal[5] = 5
    profile: RoutingObjective
    repository: str = Field(min_length=1)
    classification_choices: tuple[str, ...] = Field(min_length=1)
    rankings: tuple[RankingGroup, ...] = Field(min_length=1)

    @property
    def profiles(self) -> tuple[RoutingObjective, ...]:
        """Expose the sole profile through the shared compiler/serving interface."""
        return (self.profile,)


@dataclass(frozen=True)
class RoutingTable:
    """Validated lookup indexes shared by requests. Treat nested mappings as read-only."""

    document: TableDocument
    cells: dict[str, CellRecord]
    pairs: tuple[ModelArm, ...]
    positions: _PositionIndex
    classification_ranking: tuple[ModelArm, ...]

    @classmethod
    def from_file(cls, path: Path) -> RoutingTable:
        """Read and validate a table, propagating file errors and invalid-data ValueError."""
        return cls.from_bytes(path.read_bytes())

    @classmethod
    def from_bytes(cls, data: bytes) -> RoutingTable:
        """Validate schema, full label coverage, and exact model-effort permutations."""
        document = TableDocument.model_validate_json(data, strict=True)
        if document.profile not in PROFILES:
            raise ValueError("routing table must declare a fixed cost or cost-speed profile")
        if document.repository != document.repository.strip():
            raise ValueError("routing table repository must be canonical")
        labels = {label_key(label): label for label in all_labels()}
        pairs, expected = _parse_catalogue(document)
        cells, positions = _compile_rankings(document, labels, expected)
        classification_ranking, _ = _compile_order(document.classification_choices, expected, set())
        return cls(document, cells, pairs, positions, classification_ranking)

    def route(self, request: RouteRequest) -> RouteResponse:
        """Filter and rank exact offered identities, pinning an eligible current choice.

        Metadata does not select a policy. Context filtering is approximate and
        missing labels use heuristics. Ignore unsupported model-effort pairs.
        Raise RoutingError for invalid requests or NoRouteError when no supported
        offered candidate has sufficient context capacity.
        """
        profile = profile_key(request.objective)
        if request.objective not in self.document.profiles:
            raise RoutingError(f"routing profile is not supported by this table: {profile}")
        authored = authored_messages(request.conversation)
        if not authored:
            raise RoutingError("conversation must contain an authored user message")
        labels = (
            request.classification.labels
            if request.classification is not None
            else infer_labels(authored[-1].text())
        )
        order = self.positions[label_key(labels)][profile]
        minimum = estimate_context_tokens(request.conversation) + WINDOW_HEADROOM_TOKENS
        eligible = []
        for candidate in request.models:
            pair = (candidate.model, candidate.effort)
            if pair not in order:
                continue
            if candidate.context_window is None or candidate.context_window >= minimum:
                eligible.append(candidate)
        if not eligible:
            raise NoRouteError("no eligible offered model-effort pair")
        ordered = sorted(
            eligible,
            key=lambda candidate: order[(candidate.model, candidate.effort)],
        )
        selected = next((item for item in ordered if item.id == request.current_id), None)
        if selected is not None:
            ordered.remove(selected)
            ordered.insert(0, selected)
        return RouteResponse(
            ranked_choices=tuple(
                ModelChoice(id=item.id, model=item.model, effort=item.effort) for item in ordered
            )
        )


def _parse_catalogue(
    document: TableDocument,
) -> tuple[tuple[ModelArm, ...], frozenset[_PairIdentity]]:
    """Read the catalogue from the first ranking, which every other ranking must permute."""
    pairs = tuple(parse_pair(value) for value in document.rankings[0].choices)
    expected = frozenset((pair.model, pair.effort) for pair in pairs)
    explicit_models = {pair.model for pair in pairs if pair.effort is not None}
    if any(pair.effort is None and pair.model in explicit_models for pair in pairs):
        raise ValueError("models with efforts must not include bare default aliases")
    return pairs, expected


def _compile_rankings(
    document: TableDocument,
    labels: dict[str, Labels],
    expected: frozenset[_PairIdentity],
) -> tuple[dict[str, CellRecord], _PositionIndex]:
    cell_rankings: dict[str, dict[str, tuple[ModelArm, ...]]] = {key: {} for key in labels}
    positions: _PositionIndex = {key: {} for key in labels}
    profile = profile_key(document.profile)
    seen_orders: set[tuple[str, ...]] = set()
    for group in document.rankings:
        ranking, order = _compile_order(group.choices, expected, seen_orders)
        for key in group.applies_to:
            if key not in labels:
                raise ValueError(f"applies_to names an unknown label cell: {key!r}")
            if profile in cell_rankings[key]:
                raise ValueError(f"label cell is assigned to {profile} more than once: {key!r}")
            cell_rankings[key][profile] = ranking
            positions[key][profile] = order
    if any(profile not in rankings for rankings in cell_rankings.values()):
        raise ValueError("routing table must contain every label combination")
    cells = {
        key: CellRecord(labels=labels[key], rankings=rankings)
        for key, rankings in cell_rankings.items()
    }
    return cells, positions


def _compile_order(
    choices: tuple[str, ...],
    expected: frozenset[_PairIdentity],
    seen_orders: set[tuple[str, ...]],
) -> tuple[tuple[ModelArm, ...], dict[_PairIdentity, int]]:
    ranking = tuple(parse_pair(value) for value in choices)
    order = {(pair.model, pair.effort): index for index, pair in enumerate(ranking)}
    if len(order) != len(ranking) or set(order) != expected:
        raise ValueError("every ranking must contain the full ordered pair list")
    if choices in seen_orders:
        raise ValueError("identical rankings must share one group")
    seen_orders.add(choices)
    return ranking, order
