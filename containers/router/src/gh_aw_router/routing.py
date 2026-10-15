"""Runtime routing errors and context-window estimation."""

from __future__ import annotations

import json
from typing import Final, assert_never

from gh_aw_router.contracts import Message, Part, TextPart, ToolCallPart, ToolResultPart

WINDOW_HEADROOM_TOKENS: Final = 16_000
CHARACTERS_PER_TOKEN: Final = 4


class RoutingError(ValueError):
    """A route request is invalid for the active model data."""


class NoRouteError(RoutingError):
    """No offered candidate can serve the request."""


def estimate_context_tokens(conversation: tuple[Message, ...]) -> int:
    """Estimate tokens from text and serialized tool content, rounding upward.

    This character-count heuristic is not a tokenizer or a safe upper bound.
    Callers must enforce actual provider context limits before dispatch.
    """
    characters = sum(_part_characters(part) for message in conversation for part in message.parts)
    return (characters + CHARACTERS_PER_TOKEN - 1) // CHARACTERS_PER_TOKEN


def _part_characters(part: Part) -> int:
    if isinstance(part, TextPart):
        return len(part.text)
    if isinstance(part, ToolCallPart):
        input_size = (
            0
            if part.tool_call.input is None
            else len(
                json.dumps(
                    part.tool_call.input,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
        )
        return len(part.tool_call.name) + input_size
    if isinstance(part, ToolResultPart):
        return len(part.tool_result.text or "")
    assert_never(part)
