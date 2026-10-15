from __future__ import annotations

import pytest

from gh_aw_router.contracts import TaskComplexity, TaskScope, TaskType
from gh_aw_router.heuristics import infer_labels


def test_heuristic_fallback_preserves_unknown_complexity() -> None:
    labels = infer_labels("Diagnose the root cause across services")

    assert labels.task_type is TaskType.FIX
    assert labels.scope is TaskScope.CROSS_SYSTEM
    assert "uncertainty" not in labels.model_dump()
    assert labels.task_complexity is TaskComplexity.UNKNOWN


@pytest.mark.parametrize(
    ("text", "task_type", "scope"),
    [
        ("Fix the architecture regression in this module", TaskType.FIX, TaskScope.SUBSYSTEM),
        ("Add an error counter to this function", TaskType.IMPLEMENT, TaskScope.LOCAL),
        ("Could you please fix this file?", TaskType.FIX, TaskScope.LOCAL),
        ("Explain the architecture bug", TaskType.EXPLAIN, TaskScope.SUBSYSTEM),
        ("Plan a fix across services", TaskType.PLAN, TaskScope.CROSS_SYSTEM),
        ("Compare both files", TaskType.PLAN, TaskScope.MULTI_FILE),
        ("Rename this function", TaskType.REFACTOR, TaskScope.LOCAL),
        ("Update the dependency in this file", TaskType.CHORE, TaskScope.LOCAL),
        ("Create a debug flag", TaskType.IMPLEMENT, TaskScope.UNKNOWN),
        ("Please execute the proposed plan", TaskType.IMPLEMENT, TaskScope.UNKNOWN),
        ("How should we approach this?", TaskType.PLAN, TaskScope.UNKNOWN),
        ("The parser is failing", TaskType.FIX, TaskScope.UNKNOWN),
        ("PLEASE\nFIX this function", TaskType.FIX, TaskScope.LOCAL),
        ("address bookmark", TaskType.UNKNOWN, TaskScope.UNKNOWN),
        ("microservice", TaskType.UNKNOWN, TaskScope.UNKNOWN),
        ("", TaskType.UNKNOWN, TaskScope.UNKNOWN),
    ],
)
def test_fallback_prefers_actions_and_matches_whole_words(
    text: str, task_type: TaskType, scope: TaskScope
) -> None:
    labels = infer_labels(text)

    assert labels.task_type is task_type
    assert labels.scope is scope
    assert labels.task_complexity is TaskComplexity.UNKNOWN
