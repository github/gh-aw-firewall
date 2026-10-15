"""Best-effort labels when a caller cannot obtain model-based classification."""

from __future__ import annotations

import re
from typing import Final

from gh_aw_router.contracts import Labels, TaskComplexity, TaskScope, TaskType


def _leading(cues: tuple[str, ...]) -> re.Pattern[str]:
    return re.compile(rf"(?:{'|'.join(re.escape(cue) for cue in cues)})(?!\w)")


def _anywhere(cues: tuple[str, ...]) -> re.Pattern[str]:
    return re.compile(rf"(?<!\w)(?:{'|'.join(re.escape(cue) for cue in cues)})(?!\w)")


_EXPLAIN_LEADS: Final = (
    "explain",
    "summarize",
    "summarise",
    "describe",
    "walk me through",
    "walk through",
    "clarify",
    "elaborate",
)
_FIX_LEADS: Final = ("fix", "debug", "repair", "resolve", "troubleshoot", "diagnose", "correct")
_PLAN_LEADS: Final = ("plan", "design", "architect", "propose", "compare", "evaluate")
_CHORE_LEADS: Final = ("bump", "upgrade", "downgrade", "format", "reformat", "pin")
_PLAN_CUES: Final = (
    "plan",
    "planning",
    "design",
    "architect",
    "architecture",
    "propose an approach",
    "implementation approach",
    "implementation plan",
    "break down",
    "tradeoff",
    "what would it take",
    "how should we",
    "before implementing",
    "possible approaches",
)
_FIX_SYMPTOMS: Final = (
    "error",
    "stack trace",
    "traceback",
    "panic",
    "exception",
    "failing",
    "fails",
    "failed",
    "broken",
    "doesn't work",
    "not working",
    "crash",
    "regression",
    "bug",
    "wrong",
    "incorrect",
    "unexpected",
    "times out",
    "deadlock",
    "memory leak",
    "segfault",
    "null pointer",
    "flaky",
    "won't compile",
    "doesn't compile",
    "stopped working",
    "no longer works",
    "hangs",
    "freezes",
    "infinite loop",
    "stuck",
)
_IMPLEMENTATION_FOLLOW_UP_CUES: Final = (
    "execute this plan",
    "execute that plan",
    "execute the plan",
    "execute the proposed plan",
    "make this change",
    "make that change",
    "make the change",
    "make these changes",
    "make those changes",
    "make the proposed change",
    "make the proposed changes",
    "make proposed change",
    "make proposed changes",
    "apply this change",
    "apply that change",
    "apply the change",
    "apply these changes",
    "apply those changes",
    "apply the proposed change",
    "apply the proposed changes",
    "apply proposed change",
    "apply proposed changes",
    "apply these",
    "apply those",
)
_EXPLAIN_CUES: Final = (
    "explain",
    "summarize",
    "summarise",
    "summary of",
    "describe",
    "clarify",
    "elaborate",
    "walk me through",
    "walk through",
    "tell me about",
    "understand",
    "overview",
    "high level",
)
_QUESTION_LEADS: Final = ("why", "what", "how", "what's", "whats")
_QUESTION_CUES: Final = (
    "why",
    "what is",
    "what are",
    "what does",
    "what it does",
    "what it is",
    "what's",
    "how does",
    "how do",
    "where is",
)
_CHORE_CUES: Final = (
    "bump",
    "upgrade",
    "downgrade",
    "update deps",
    "dependency",
    "dependencies",
    "lockfile",
    "lock file",
    "version bump",
    "pin the",
    "ci config",
    "config file",
    "gitignore",
    "rustfmt",
    "clippy",
    "prettier",
    "eslint",
    "reformat",
    "formatting",
    "cargo update",
    "npm update",
    "workflow file",
    "github action",
    "typo",
)
_REFACTOR_CUES: Final = (
    "refactor",
    "rename",
    "clean up",
    "cleanup",
    "restructure",
    "extract",
    "simplify",
    "reorganize",
    "deduplicate",
    "de-duplicate",
    "tidy",
    "consolidate",
    "modularize",
    "modularise",
    "decouple",
    "encapsulate",
    "untangle",
    "factor out",
    "pull out",
    "split up",
)
_IMPERATIVE_VERBS: Final = (
    "add",
    "create",
    "implement",
    "build",
    "write",
    "make",
    "update",
    "change",
    "remove",
    "delete",
    "support",
    "handle",
    "wire",
    "generate",
    "introduce",
    "set up",
    "replace",
    "rewrite",
    "extend",
    "expose",
    "enable",
    "disable",
    "convert",
    "migrate",
    "improve",
    "optimize",
    "optimise",
    "ensure",
    "allow",
    "port",
)
_CROSS_SYSTEM_CUES: Final = (
    "cross-system",
    "cross system",
    "end-to-end",
    "end to end",
    "multiple services",
    "across services",
    "frontend and backend",
    "client and server",
    "all crates",
    "all packages",
    "entire workspace",
)
_SUBSYSTEM_CUES: Final = (
    "subsystem",
    "service",
    "module",
    "crate",
    "package",
    "architecture",
    "codebase",
    "repository",
    "this repo",
    "the repo",
    "whole repo",
    "entire repo",
    "repo-wide",
    "repo wide",
    "this project",
    "the project",
    "whole project",
    "entire project",
    "project-wide",
    "project wide",
)
_MULTI_FILE_CUES: Final = (
    "multiple files",
    "several files",
    "across files",
    "components",
    "call sites",
    "implementations",
    "all files",
    "every file",
    "both files",
    "two files",
)
_LOCAL_CUES: Final = (
    "this function",
    "this method",
    "this file",
    "this test",
    "this type",
    "this component",
    "one file",
    "single file",
)

_LEAD_PATTERNS: Final = (
    (TaskType.EXPLAIN, _leading(_EXPLAIN_LEADS)),
    (TaskType.FIX, _leading(_FIX_LEADS)),
    (TaskType.PLAN, _leading(_PLAN_LEADS)),
    (TaskType.CHORE, _leading(_CHORE_LEADS)),
    (TaskType.REFACTOR, _leading(_REFACTOR_CUES)),
)
_SCOPE_PATTERNS: Final = (
    (TaskScope.CROSS_SYSTEM, _anywhere(_CROSS_SYSTEM_CUES)),
    (TaskScope.SUBSYSTEM, _anywhere(_SUBSYSTEM_CUES)),
    (TaskScope.MULTI_FILE, _anywhere(_MULTI_FILE_CUES)),
    (TaskScope.LOCAL, _anywhere(_LOCAL_CUES)),
)
_UPDATE_LEAD: Final = _leading(("update",))
_IMPERATIVE_LEAD: Final = _leading(_IMPERATIVE_VERBS)
_QUESTION_LEAD: Final = _leading(_QUESTION_LEADS)
_POLITE_PREFIX: Final = re.compile(r"^(?:(?:please|kindly)\s+|(?:can|could|would|will) you\s+)*")
_PLAN_CUE_PATTERN: Final = _anywhere(_PLAN_CUES)
_FIX_SYMPTOM_PATTERN: Final = _anywhere(_FIX_SYMPTOMS)
_FOLLOW_UP_PATTERN: Final = _anywhere(_IMPLEMENTATION_FOLLOW_UP_CUES)
_EXPLAIN_CUE_PATTERN: Final = _anywhere(_EXPLAIN_CUES)
_QUESTION_CUE_PATTERN: Final = _anywhere(_QUESTION_CUES)
_CHORE_CUE_PATTERN: Final = _anywhere(_CHORE_CUES)
_REFACTOR_CUE_PATTERN: Final = _anywhere(_REFACTOR_CUES)


def infer_labels(user_message: str) -> Labels:
    """Prefer explicit actions over incidental keywords and leave complexity unknown."""
    lower = " ".join(user_message.casefold().split())
    return Labels(
        task_type=_infer_task_type(lower),
        scope=_infer_scope(lower),
        task_complexity=TaskComplexity.UNKNOWN,
    )


def _infer_task_type(lower: str) -> TaskType:
    action = _POLITE_PREFIX.sub("", lower)
    for task_type, pattern in _LEAD_PATTERNS:
        if pattern.match(action):
            return task_type
    if _UPDATE_LEAD.match(action) and _CHORE_CUE_PATTERN.search(lower):
        return TaskType.CHORE
    if (len(action.split()) >= 2 and _IMPERATIVE_LEAD.match(action)) or _FOLLOW_UP_PATTERN.search(
        lower
    ):
        return TaskType.IMPLEMENT
    if _PLAN_CUE_PATTERN.search(lower):
        return TaskType.PLAN
    if _FIX_SYMPTOM_PATTERN.search(lower):
        return TaskType.FIX
    if (
        _EXPLAIN_CUE_PATTERN.search(lower)
        or _QUESTION_LEAD.match(action)
        or _QUESTION_CUE_PATTERN.search(lower)
    ):
        return TaskType.EXPLAIN
    if _CHORE_CUE_PATTERN.search(lower):
        return TaskType.CHORE
    if _REFACTOR_CUE_PATTERN.search(lower):
        return TaskType.REFACTOR
    return TaskType.UNKNOWN


def _infer_scope(lower: str) -> TaskScope:
    for scope, pattern in _SCOPE_PATTERNS:
        if pattern.search(lower):
            return scope
    return TaskScope.UNKNOWN
