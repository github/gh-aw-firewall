from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from contract_corpus import synthetic_table_document

from gh_aw_router.routing_table import RoutingTable
from gh_aw_router.service import GhAwRouterService

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption("--run-docker", action="store_true", help="Run Docker acceptance tests")
    parser.addoption("--run-release", action="store_true", help="Run isolated distribution tests")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    disabled = [name for name in ("docker", "release") if not config.getoption(f"--run-{name}")]
    excluded = [item for item in items if any(item.get_closest_marker(name) for name in disabled)]
    items[:] = [item for item in items if item not in excluded]
    config.hook.pytest_deselected(items=excluded)


@pytest.fixture(scope="session")
def service() -> GhAwRouterService:
    """Use published data only for examples and release-data integration checks."""
    return GhAwRouterService.load(PROJECT_ROOT / "routing")


@pytest.fixture
def table_document() -> dict[str, Any]:
    return synthetic_table_document()


@pytest.fixture
def routing_table(table_document: dict[str, Any]) -> RoutingTable:
    return RoutingTable.from_bytes(json.dumps(table_document).encode())


@pytest.fixture
def synthetic_service(routing_table: RoutingTable) -> GhAwRouterService:
    return GhAwRouterService.from_tables([routing_table])


@pytest.fixture
def synthetic_table_path(table_document: dict[str, Any], tmp_path: Path) -> Path:
    path = tmp_path / "routing.json"
    path.write_text(json.dumps(table_document), encoding="utf-8")
    return path


@pytest.fixture
def planning_payload() -> Callable[[str], dict[str, Any]]:
    def build(command: str) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "conversation": [{"role": "user", "parts": [{"text": "Fix this function"}]}],
            "models": [
                {"id": "fast", "model": "provider/fast"},
                {"id": "reasoning", "model": "provider/reasoning", "effort": "medium"},
            ],
        }
        if command == "route":
            payload["objective"] = {"goal": "cost", "mode": "balanced"}
        return payload

    return build
