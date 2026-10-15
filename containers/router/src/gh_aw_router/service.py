"""Transport-neutral composition of classification and routing operations."""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import TYPE_CHECKING

from gh_aw_router import __version__
from gh_aw_router.classification import create_classification_plan
from gh_aw_router.contracts import (
    ClassifyRequest,
    ClassifyResponse,
    ExecutionCatalogue,
    ExecutionModel,
    ModelArm,
    ReasoningEffort,
    RouteRequest,
    RouteResponse,
    RoutingMode,
    RoutingModeRecommendation,
    RoutingProfile,
    ServiceCapabilities,
)
from gh_aw_router.routing_table import PROFILES, RoutingTable, profile_key

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping
    from pathlib import Path


class InvalidRequestError(ValueError):
    """A decoded request names a value unsupported by this service."""


@dataclass(frozen=True)
class GhAwRouterService:
    """Serve one published routing profile per table over a shared model catalogue."""

    routing_tables: Mapping[str, RoutingTable]

    def __post_init__(self) -> None:
        """Require profile-keyed tables that agree on everything outside their rankings."""
        object.__setattr__(self, "routing_tables", MappingProxyType(dict(self.routing_tables)))
        if not self.routing_tables:
            raise ValueError("a service requires at least one routing table")
        shared = self.primary_table
        catalogue = frozenset(shared.pairs)
        for key, table in self.routing_tables.items():
            if key != profile_key(table.document.profile):
                raise ValueError(f"routing table is not keyed by its own profile: {key}")
            if (
                table.document.repository != shared.document.repository
                or frozenset(table.pairs) != catalogue
                or table.classification_ranking != shared.classification_ranking
            ):
                raise ValueError(
                    "routing profiles must share one repository, model catalogue, "
                    "and classifier order"
                )

    @classmethod
    def load(cls, routing_path: Path) -> GhAwRouterService:
        """Load every table in a directory, or the single table named by a file path."""
        paths = sorted(routing_path.glob("*.json")) if routing_path.is_dir() else [routing_path]
        if not paths:
            raise ValueError(f"routing table directory holds no tables: {routing_path}")
        return cls.from_tables(RoutingTable.from_file(path) for path in paths)

    @classmethod
    def from_tables(cls, tables: Iterable[RoutingTable]) -> GhAwRouterService:
        """Index validated tables by profile, rejecting a profile served twice."""
        indexed: dict[str, RoutingTable] = {}
        for table in tables:
            key = profile_key(table.document.profile)
            if key in indexed:
                raise ValueError(f"more than one routing table declares {key}")
            indexed[key] = table
        return cls(indexed)

    @property
    def primary_table(self) -> RoutingTable:
        """Return the table holding the catalogue and classifier order shared by all profiles."""
        return next(iter(self.routing_tables.values()))

    def capabilities(self) -> ServiceCapabilities:
        """Describe the API, served profiles, and model identities of the loaded tables."""
        return ServiceCapabilities(
            name="gh-aw-router",
            version=__version__,
            routing_profiles=tuple(
                RoutingProfile(goal=profile.goal, mode=profile.mode)
                for profile in PROFILES
                if profile_key(profile) in self.routing_tables
            ),
            execution_catalogue=_execution_catalogue(self.primary_table.pairs),
        )

    def classify(self, request: ClassifyRequest) -> ClassifyResponse:
        """Create a classifier call plan for a validated request."""
        return create_classification_plan(request, self.primary_table.classification_ranking)

    def route(self, request: RouteRequest) -> RouteResponse:
        """Resolve automatic mode selection and rank choices using the selected table."""
        if request.objective.mode is RoutingMode.AUTO:
            mode = RoutingMode.BALANCED
            if (
                request.classification is not None
                and request.classification.mode is not RoutingModeRecommendation.UNKNOWN
            ):
                mode = RoutingMode(request.classification.mode.value)
            request = request.model_copy(
                update={"objective": request.objective.model_copy(update={"mode": mode})}
            )
        key = profile_key(request.objective)
        table = self.routing_tables.get(key)
        if table is None:
            raise InvalidRequestError(f"routing profile is not served: {key}")
        return table.route(request)


def _execution_catalogue(pairs: tuple[ModelArm, ...]) -> ExecutionCatalogue:
    efforts_by_model: dict[str, set[ReasoningEffort]] = {}
    for pair in pairs:
        efforts = efforts_by_model.setdefault(pair.model, set())
        if pair.effort is not None:
            efforts.add(pair.effort)
    return ExecutionCatalogue(
        models=tuple(
            ExecutionModel(
                model=model,
                efforts=tuple(effort for effort in ReasoningEffort if effort in efforts),
            )
            for model, efforts in sorted(efforts_by_model.items())
        )
    )
