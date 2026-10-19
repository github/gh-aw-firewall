"""Inputs for the parity corpus: function-level case builders.

Builders return fixture documents whose cases hold inputs only. The generator in
parity_corpus.py runs every case against the Python function it covers and records `expect`.
Keys starting with `_` are builder-only checks that catch builder mistakes, and the generator
drops them: `_expect` is a subset of the observed expectation, and `_outcome` says whether a
decoding case must decode or be rejected.
"""

from __future__ import annotations

import base64
import json
from typing import TYPE_CHECKING, Any

from gh_aw_router import heuristics

if TYPE_CHECKING:
    from collections.abc import Callable

type Case = dict[str, Any]
type Document = dict[str, Any]

FAST = "provider/fast"
REASONING = "provider/reasoning"
OTHER = "provider/other"


def canonical_json(value: object) -> str:
    """Serialize compactly with sorted keys and ASCII escapes."""
    return json.dumps(
        value, separators=(",", ":"), sort_keys=True, ensure_ascii=True, allow_nan=False
    )


# Requests -----------------------------------------------------------------------------------


def text(value: str) -> dict[str, str]:
    return {"text": value}


def message(role: str, *parts: str | dict[str, Any]) -> dict[str, Any]:
    return {
        "role": role,
        "parts": [text(part) if isinstance(part, str) else part for part in parts],
    }


def user(*parts: str | dict[str, Any]) -> dict[str, Any]:
    return message("user", *parts)


def tool_call(name: str, value: object = None, *, identifier: str = "call-1") -> dict[str, Any]:
    call: dict[str, Any] = {"id": identifier, "name": name}
    if value is not None:
        call["input"] = value
    return {"tool_call": call}


def tool_result(value: str | None = None, *, ok: bool | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {"id": "call-1"}
    if value is not None:
        result["text"] = value
    if ok is not None:
        result["ok"] = ok
    return {"tool_result": result}


def offer(
    identifier: str, model: str, effort: str | None = None, window: int | None = None
) -> dict[str, Any]:
    choice: dict[str, Any] = {"id": identifier, "model": model}
    if effort is not None:
        choice["effort"] = effort
    if window is not None:
        choice["context_window"] = window
    return choice


def route_request(
    conversation: list[dict[str, Any]],
    models: list[dict[str, Any]],
    *,
    mode: str = "balanced",
    goal: str = "cost",
    **extra: object,
) -> dict[str, Any]:
    return {
        "conversation": conversation,
        "objective": {"goal": goal, "mode": mode},
        "models": models,
        **extra,
    }


FIX_CONVERSATION = [user("Fix this function")]
BASIC_OFFERS = [
    offer("fast", FAST),
    offer("r-low", REASONING, "low"),
    offer("r-medium", REASONING, "medium"),
    offer("r-high", REASONING, "high"),
    offer("other", OTHER),
]


# Labels: heuristics and Unicode -------------------------------------------------------------

LABELS_DESCRIPTION = (
    "infer_labels(text): the heuristic labels for the text of the latest authored user turn. "
    "task_complexity is always unknown, so only task_type and scope are recorded"
)
# Frames place a cue where no earlier heuristic rule can fire first.
TYPE_FRAMES: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "explain-lead": ("explain", "{cue} the widget", heuristics._EXPLAIN_LEADS),
    "fix-lead": ("fix", "{cue} the widget", heuristics._FIX_LEADS),
    "plan-lead": ("plan", "{cue} the widget", heuristics._PLAN_LEADS),
    "chore-lead": ("chore", "{cue} the widget", heuristics._CHORE_LEADS),
    "refactor-lead": ("refactor", "{cue} the widget", heuristics._REFACTOR_CUES),
    "chore-update": ("chore", "update the {cue}", heuristics._CHORE_CUES),
    "imperative": ("implement", "{cue} the widget", heuristics._IMPERATIVE_VERBS),
    "follow-up": ("implement", "ok, {cue} now", heuristics._IMPLEMENTATION_FOLLOW_UP_CUES),
    "plan-cue": ("plan", "we need {cue} for the widget", heuristics._PLAN_CUES),
    "fix-symptom": ("fix", "the widget {cue} today", heuristics._FIX_SYMPTOMS),
    "explain-cue": ("explain", "i would like to {cue} the widget", heuristics._EXPLAIN_CUES),
    "question-lead": ("explain", "{cue} the widget", heuristics._QUESTION_LEADS),
    "question-cue": ("explain", "so {cue} the widget", heuristics._QUESTION_CUES),
    "chore-cue": ("chore", "the {cue} needs attention", heuristics._CHORE_CUES),
    "refactor-cue": ("refactor", "the widget needs {cue}", heuristics._REFACTOR_CUES),
}
SCOPE_LISTS: dict[str, tuple[str, ...]] = {
    "cross_system": heuristics._CROSS_SYSTEM_CUES,
    "subsystem": heuristics._SUBSYSTEM_CUES,
    "multi_file": heuristics._MULTI_FILE_CUES,
    "local": heuristics._LOCAL_CUES,
}


def label(identifier: str, description: str, value: str, **expected: str) -> Case:
    case: Case = {"id": identifier, "description": description, "text": value}
    if expected:
        case["_expect"] = expected
    return case


def _slug(value: str) -> str:
    return value.replace(" ", "_").replace("'", "-")


def _cue_cases() -> list[Case]:
    cases = []
    for frame, (task_type, pattern, cues) in TYPE_FRAMES.items():
        cases.extend(
            label(
                f"{frame}-{_slug(cue)}",
                f"The {frame} cue {cue!r}",
                pattern.format(cue=cue),
                task_type=task_type,
            )
            for cue in cues
        )
    for scope, cues in SCOPE_LISTS.items():
        cases.extend(
            label(f"scope-{_slug(cue)}", f"The {scope} cue {cue!r}", f"look at {cue}", scope=scope)
            for cue in cues
        )
    return cases


def _boundary_cases() -> list[Case]:
    lead = heuristics._FIX_LEADS[0]
    anywhere = heuristics._FIX_SYMPTOMS[0]
    scope = heuristics._LOCAL_CUES[0]
    fix, unknown, local = {"task_type": "fix"}, {"task_type": "unknown"}, {"scope": "local"}
    return [
        label("lead-alone", "A lead cue alone", lead, **fix),
        label("lead-end-punctuation", "A lead cue followed by punctuation", f"{lead}!", **fix),
        label(
            "lead-word-suffix", "A lead cue followed by a word character", f"{lead}es the widget"
        ),
        label("lead-hyphen", "A hyphen ends a lead cue", f"{lead}-it now", **fix),
        label("lead-apostrophe", "An apostrophe ends a lead cue", f"{lead}'s widget", **fix),
        label("lead-not-first", "A lead cue must start the request", f"now {lead} the widget"),
        label("lead-after-quote", "A quote before a lead cue", f'"{lead}" the widget', **unknown),
        label("symptom-start", "A symptom at the start", f"{anywhere} in the widget", **fix),
        label("symptom-end", "A symptom at the end", f"the widget has an {anywhere}", **fix),
        label("symptom-prefixed", "A word character before a symptom", f"the widget x{anywhere}"),
        label("symptom-suffixed", "A word character after a symptom", f"the widget {anywhere}s"),
        label("symptom-underscore", "Underscore is a word character", f"the widget _{anywhere}"),
        label(
            "symptom-punctuation",
            "Punctuation around a symptom",
            f"the widget ({anywhere}).",
            **fix,
        ),
        label("scope-start", "A scope cue at the start", f"{scope} is slow", **local),
        label("scope-glued", "A word character before a scope cue", f"x{scope} is slow"),
        label("scope-punctuation", "Punctuation after a scope cue", f"look at {scope}.", **local),
        label("polite-please", "A polite prefix", f"please {lead} the widget", **fix),
        label("polite-kindly", "kindly", f"kindly {lead} the widget", **fix),
        label("polite-can-you", "can you", f"can you {lead} the widget", **fix),
        label("polite-could-you", "could you", f"could you {lead} the widget", **fix),
        label("polite-would-you", "would you", f"would you {lead} the widget", **fix),
        label("polite-will-you", "will you", f"will you {lead} the widget", **fix),
        label(
            "polite-repeated",
            "Repeated polite prefixes",
            f"could you please kindly {lead} the widget",
            **fix,
        ),
        label("polite-no-space", "A polite prefix needs whitespace", f"please{lead} the widget"),
        label("polite-comma", "A comma stops polite prefix removal", f"please, {lead} the widget"),
        label("polite-alone", "A polite prefix alone", "please", **unknown),
        label("polite-you-alone", "can you without a cue", "can you", **unknown),
        label("polite-middle", "Polite words after the start stay", f"now please {lead} it"),
        label("imperative-one-word", "One imperative word is not enough", "add", **unknown),
        label(
            "imperative-one-word-punctuation", "Punctuation doesn't add a word", "add.", **unknown
        ),
        label(
            "imperative-two-words",
            "Two words with an imperative lead",
            "add it",
            task_type="implement",
        ),
        label(
            "imperative-two-word-verb",
            "A two-word imperative alone",
            "set up",
            task_type="implement",
        ),
        label("imperative-polite-one-word", "Polite prefix plus one word", "please add", **unknown),
        label(
            "imperative-polite-two-words",
            "Polite prefix plus two words",
            "please add it",
            task_type="implement",
        ),
        label(
            "update-without-chore",
            "update without a chore cue",
            "update the widget",
            task_type="implement",
        ),
        label("update-alone", "update alone", "update", **unknown),
        label(
            "update-chore-later",
            "update with a later chore cue",
            "update the widget dependency",
            task_type="chore",
        ),
        label(
            "chore-cue-not-update",
            "A chore cue after another imperative",
            "change the lockfile",
            task_type="implement",
        ),
        label(
            "order-lead-over-symptom",
            "A lead beats a symptom",
            "explain the error",
            task_type="explain",
        ),
        label(
            "order-plan-over-symptom",
            "A plan cue beats a symptom",
            "the error in the plan",
            task_type="plan",
        ),
        label(
            "order-imperative-over-symptom",
            "An imperative beats a symptom",
            "add a fix for the error",
            task_type="implement",
        ),
        label(
            "order-follow-up-over-plan",
            "A follow-up cue beats a plan cue",
            "ok, execute the plan",
            task_type="implement",
        ),
        label(
            "order-symptom-over-question",
            "A symptom beats a question",
            "why does this crash",
            task_type="fix",
        ),
        label(
            "order-question-over-chore",
            "A question beats a chore cue",
            "what is the lockfile",
            task_type="explain",
        ),
        label(
            "order-chore-over-refactor",
            "A chore cue beats a refactor cue",
            "the typo needs cleanup",
            task_type="chore",
        ),
        label(
            "order-cross-system-first",
            "Cross-system beats other scopes",
            "this function across services module",
            scope="cross_system",
        ),
        label(
            "order-subsystem-over-files",
            "Subsystem beats multi-file",
            "several files in the module",
            scope="subsystem",
        ),
        label(
            "order-files-over-local",
            "Multi-file beats local",
            "this function and both files",
            scope="multi_file",
        ),
        label("normalize-uppercase", "Matching is case-insensitive", "FIX THE WIDGET", **fix),
        label(
            "normalize-whitespace",
            "Whitespace runs collapse",
            "  walk \t\n through   the parser  ",
            task_type="explain",
        ),
        label(
            "normalize-split-cue",
            "A newline inside a multi-word cue",
            "walk me\nthrough the parser",
            task_type="explain",
        ),
        label(
            "unknown-everything",
            "No cue at all",
            "hello there",
            task_type="unknown",
            scope="unknown",
        ),
    ]


def _unicode_label_cases() -> list[Case]:
    lead = heuristics._FIX_LEADS[0]
    cases = [
        label(
            f"whitespace-{ord(character):04X}",
            f"U+{ord(character):04X} separates words",
            f"walk{character}through the parser",
            task_type="explain",
        )
        for character in map(chr, range(0x110000))
        if character.isspace()
    ]
    cases.extend(
        label(
            f"not-whitespace-{point:04X}",
            f"U+{point:04X} doesn't separate words",
            f"walk{chr(point)}through the parser",
            task_type="unknown",
        )
        for point in (0x200B, 0x180E, 0xFEFF, 0x2060)
    )
    # Unassigned in Unicode 15.0 (Python 3.12), letters or digits in Unicode 16.
    for point in (0x10D50, 0x16100, 0x1E5D0, 0xA7CB, 0x10D40, 0x1CCF0):
        character = chr(point)
        cases += [
            label(
                f"unassigned-after-lead-{point:04X}",
                f"U+{point:04X} after a lead cue",
                f"{lead}{character} the widget",
                task_type="fix",
            ),
            label(
                f"unassigned-before-cue-{point:04X}",
                f"U+{point:04X} before a symptom",
                f"the widget {character}crash",
                task_type="fix",
            ),
        ]
    neighbours = {
        "underscore": "_",
        "digit": "2",
        "arabic-indic-digit": "\u0662",
        "superscript-two": "\u00b2",
        "vulgar-half": "\u00bd",
        "roman-twelve": "\u216b",
        "ideographic-zero": "\u3007",
        "e-acute": "\u00e9",
        "combining-acute": "\u0301",
        "bold-a": "\U0001d400",
        "emoji": "\U0001f642",
    }
    for name, character in neighbours.items():
        cases += [
            label(
                f"neighbour-after-lead-{name}",
                f"{name} after a lead cue",
                f"{lead}{character} the widget",
            ),
            label(
                f"neighbour-before-cue-{name}",
                f"{name} before a symptom",
                f"the widget {character}crash",
            ),
        ]
    return [
        *cases,
        label(
            "casefold-ligature",
            "The fi ligature folds to fi",
            "\ufb01x the widget",
            task_type="fix",
        ),
        label(
            "casefold-long-s", "Long s folds to s", "\u017fummarize the widget", task_type="explain"
        ),
        label(
            "casefold-sharp-s", "Sharp s folds to ss", "po\u00dfible approaches", task_type="plan"
        ),
        label(
            "casefold-dotted-i",
            "Dotted capital I folds to i and a combining dot",
            "\u0130mprove the widget",
            task_type="unknown",
        ),
        label(
            "casefold-fullwidth",
            "Fullwidth letters don't fold to ASCII",
            "\uff26\uff29\uff38 the widget",
            task_type="unknown",
        ),
        label(
            "casefold-kelvin",
            "The Kelvin sign folds to k",
            "\u212aindly fix the widget",
            task_type="fix",
        ),
        label(
            "casefold-greek-sigma",
            "Final sigma folds like sigma",
            "\u03a3\u03c2 fix",
            task_type="unknown",
        ),
        label(
            "astral-after-text",
            "An emoji after the request",
            "fix the widget \U0001f642",
            task_type="fix",
        ),
        label(
            "astral-before-lead",
            "An emoji before a lead cue",
            "\U0001f642 fix the widget",
            task_type="unknown",
        ),
    ]


# Classification prompts ---------------------------------------------------------------------

CLASSIFICATION_DESCRIPTION = (
    "The classifier prompt for a conversation: authored_messages() then "
    "build_classification_prompt(). expect.conversation_data is the prompt from the "
    "<conversation_data> line to the end; the fixed contract text before it isn't repeated. "
    "A conversation without an authored user turn has expect.error no_authored_turn"
)


def prompt_case(identifier: str, description: str, conversation: list[dict[str, Any]]) -> Case:
    return {"id": identifier, "description": description, "conversation": conversation}


def _classification_cases() -> list[Case]:
    many = [user(f"turn {number}") for number in range(1, 10)]
    long_turn = "x" * 399
    return [
        prompt_case("single-turn", "A single turn has no prior turns", [user("only")]),
        prompt_case(
            "escaping",
            "Escape &, < and > in authored text, but not quotes",
            [user("a <b> & c \"q\" 'q'"), user("x < y && y > z")],
        ),
        prompt_case(
            "prior-turn-limit",
            "Keep the last six prior turns, numbered from their position",
            many,
        ),
        prompt_case(
            "prior-turn-truncate-400",
            "A 400-character prior turn is kept whole",
            [user(long_turn + "y"), user("now")],
        ),
        prompt_case(
            "prior-turn-truncate-401",
            "A 401-character prior turn loses its last character",
            [user(long_turn + "yz"), user("now")],
        ),
        prompt_case(
            "prior-turn-truncate-astral",
            "Truncation counts code points, so an astral character fits at position 400",
            [user(long_turn + "\U0001f642z"), user("now")],
        ),
        prompt_case(
            "prior-turn-strip-before-truncate",
            "Prior turns are stripped before truncation",
            [user("   " + long_turn + "yz   "), user("now")],
        ),
        prompt_case(
            "prior-turn-escape-after-truncate",
            "Escaping happens after truncation",
            [user(long_turn + "&<"), user("now")],
        ),
        prompt_case(
            "current-not-truncated", "The current request isn't truncated", [user("y" * 2000)]
        ),
        prompt_case(
            "current-strip-python-whitespace",
            "Stripping uses Python whitespace, including U+001C and U+3000 but not U+200B",
            [user("\u001c\u3000 fix \u200b\u3000\u001c")],
        ),
        prompt_case(
            "skip-unauthored",
            "Only user messages with non-blank text are authored turns",
            [
                user("first"),
                message("assistant", "reply"),
                message("system", "rules"),
                user(tool_result("output")),
                user(" \t\u3000"),
                user(""),
                message("user"),
                user("last"),
            ],
        ),
        prompt_case(
            "multi-part",
            "Text parts join without separators and tool parts are skipped",
            [
                user("Hello ", tool_call("read"), "world", tool_result("ignored"), "!"),
                user(" ", "  next  ", " "),
            ],
        ),
        prompt_case(
            "zero-width-authored",
            "U+200B isn't whitespace, so it makes an authored turn",
            [user("\u200b")],
        ),
        prompt_case(
            "whitespace-only-python",
            "Text made of Python whitespace isn't an authored turn",
            [user("\u001c\u3000\u0085")],
        ),
        prompt_case("no-conversation", "An empty conversation", []),
        prompt_case("assistant-only", "Only assistant text", [message("assistant", "hello there")]),
    ]


# Context estimates --------------------------------------------------------------------------

CONTEXT_DESCRIPTION = (
    "estimate_context_tokens(conversation). expect.characters is the character count before "
    "rounding and expect.tokens is that count divided by 4, rounded up. A case gives the "
    "conversation as JSON, or as conversation_text when a raw token such as NaN must reach "
    "the decoder unchanged"
)
# Raw JSON tokens are spliced in as a tool_call input, so their exact spelling reaches the decoder.
CONTEXT_TOKENS = {
    "int-zero-negative": "-0",
    "float-zero-negative": "-0.0",
    "float-exponent-upper": "1E5",
    "float-1e15": "1e15",
    "float-1e16": "1e16",
    "float-small-exponent": "1.5e-7",
    "float-1e-5": "1e-5",
    "float-1e-4": "1e-4",
    "float-subnormal": "5e-324",
    "float-underflow": "1e-400",
    "float-overflow": "1e400",
    "float-nan": "NaN",
    "float-infinity": "Infinity",
    "float-negative-infinity": "-Infinity",
    "float-hundred": "1.0e2",
    "float-tenth": "0.1",
    "float-rounding": "0.30000000000000004",
    "float-max": "1.7976931348623157e308",
    "float-large": "123456789012345678901.5",
    "float-negative": "-1.5",
    "float-unsafe-int": "9007199254740993.0",
    "int-unsafe": "9007199254740993",
    "int-over-64-bits": str(2**64 + 1),
    "int-negative-over-64-bits": str(-(2**64) - 1),
    "duplicate-keys": '{"a":1,"a":22}',
    "escaped-key": '{"\\u0061":1}',
    "spaced": '{ "a" : [ 1 , 2 ] , "b" : { } }',
    "escaped-characters": '"\\u00e9\\ud83d\\ude42\\/\\u2028"',
    "literals": "[true,false,null]",
}


def _context_components() -> dict[str, tuple[list[dict[str, Any]], str | None]]:
    def call(value: object) -> list[dict[str, Any]]:
        return [message("assistant", tool_call("tool", value))]

    components: dict[str, tuple[list[dict[str, Any]], str | None]] = {
        "text-ascii": ([user("hello world")], None),
        "text-empty-part": ([user("")], None),
        "text-latin": ([user("caf\u00e9")], None),
        "text-astral": ([user("\U0001f642\U0001f642")], None),
        "text-combining": ([user("e\u0301")], None),
        "text-cjk": ([user("\u6f22\u5b57")], None),
        "text-control": ([user("a\u0000b\u001f")], None),
        "text-whitespace": ([user("a\nb\tc ")], None),
        "role-system": ([message("system", "system text")], None),
        "role-assistant": ([message("assistant", "assistant text")], None),
        "parts-omitted": ([{"role": "assistant"}], None),
        "parts-empty": ([message("assistant")], None),
        "tool-name-only": ([message("assistant", tool_call("read_file"))], None),
        "tool-name-astral": ([message("assistant", tool_call("\U0001f642"))], None),
        "tool-input-null": (
            [message("assistant", {"tool_call": {"id": "c", "name": "t", "input": None}})],
            None,
        ),
        "tool-input-empty-string": (call(""), None),
        "tool-input-escapes": (call('a"b\\c/d'), None),
        "tool-input-controls": (call("\u0001\u001f\b\f\n\r\t"), None),
        "tool-input-delete": (call("\u007f"), None),
        "tool-input-latin": (call("caf\u00e9"), None),
        "tool-input-astral": (call("\U0001f642"), None),
        "tool-input-separators": (call("\u2028\u2029"), None),
        "tool-input-html": (call("<a>&</a>"), None),
        "tool-input-nested": (call({"b": [1, {"c": None}], "a": True}), None),
        "tool-input-empty-containers": (call([{}, []]), None),
        "tool-input-key-order": (call({"z": 1, "a": 2}), None),
        "tool-result-text": ([user(tool_result("result text"))], None),
        "tool-result-no-text": ([user(tool_result(ok=True))], None),
        "tool-result-empty-text": ([user(tool_result(""))], None),
        "tool-result-astral": ([user(tool_result("\U0001f642"))], None),
        "mixed-parts": ([message("assistant", "a", tool_call("t", [1]), tool_result("r"))], None),
    }
    for name, token in CONTEXT_TOKENS.items():
        components[f"token-{name}"] = (call("__INPUT__"), token)
    return components


def _context_cases() -> list[Case]:
    cases = []
    for name, (component, token) in _context_components().items():
        case: Case = {"id": name, "description": f"Context estimate for {name}"}
        if token is None:
            case["conversation"] = component
        else:
            case["conversation_text"] = spliced_value(component, token)
        cases.append(case)
    return cases


# Decoding -----------------------------------------------------------------------------------

INPUT_PLACEHOLDER = '"__INPUT__"'
DECODED = "decoded"
REJECTED = "rejected"
DECODING_REQUEST = route_request(FIX_CONVERSATION, BASIC_OFFERS)
DECODING_TEXT = canonical_json(DECODING_REQUEST)
DECODING_PROMPT = "Fix this function"
DECODING_DESCRIPTION = (
    "decode_request(RouteRequest, body). expect.result is decoded, malformed (a JSON syntax "
    "or parser-limit error: HTTP 400 invalid_json) or invalid (a schema error: HTTP 422 "
    "invalid_json). The CLI reports both errors on stderr as 'invalid request: ' with exit 2. "
    "The limit-* "
    "items put the value at tool_call.input, inside six enclosing levels (object, "
    "conversation array, message, parts array, part, tool_call)"
)
# Each shape builds a tool_call.input token from a nesting depth or a digit count.
LIMIT_SHAPES: dict[str, Callable[[int], str]] = {
    "depth_arrays": lambda depth: "[" * depth + "]" * depth,
    "depth_arrays_scalar": lambda depth: "[" * depth + "0" + "]" * depth,
    "depth_objects_scalar": lambda depth: '{"a":' * depth + "0" + "}" * depth,
    "digits": lambda count: "7" * count,
    "digits_negative": lambda count: "-" + "7" * count,
}
LIMIT_DESCRIPTIONS = {
    "depth_arrays": "{} nested empty arrays",
    "depth_arrays_scalar": "{} nested arrays around 0",
    "depth_objects_scalar": '{} nested {{"a": ...}} objects around 0',
    "digits": "An integer of {} digits",
    "digits_negative": "A negative integer of {} digits",
}
TOOL_INPUT_TOKENS = {
    "nan": ("NaN", DECODED),
    "infinity": ("Infinity", DECODED),
    "negative-infinity": ("-Infinity", DECODED),
    "lowercase-nan": ("nan", REJECTED),
    "inf": ("inf", REJECTED),
    "float-overflow": ("1e400", DECODED),
    "negative-float-overflow": ("-1e400", DECODED),
    "negative-zero": ("-0", DECODED),
    "exponent-plus": ("1E+2", DECODED),
    "exponent-zero": ("1e-0", DECODED),
    "leading-zero": ("01", REJECTED),
    "negative-leading-zero": ("-01", REJECTED),
    "plus-sign": ("+1", REJECTED),
    "leading-point": (".5", REJECTED),
    "trailing-point": ("1.", REJECTED),
    "point-before-exponent": ("1.e5", REJECTED),
    "empty-exponent": ("1e", REJECTED),
    "bare-minus": ("-", REJECTED),
    "hexadecimal": ("0x10", REJECTED),
    "underscore": ("1_000", REJECTED),
    "python-true": ("True", REJECTED),
    "python-none": ("None", REJECTED),
    "array-trailing-comma": ("[1,]", REJECTED),
    "object-trailing-comma": ('{"a":1,}', REJECTED),
    "missing-comma": ("[1 2]", REJECTED),
    "nbsp-separator": ("[\u00a01]", REJECTED),
    "form-feed-separator": ("[\f1]", REJECTED),
    "vertical-tab-separator": ("[\v1]", REJECTED),
    "crlf-separator": ("[\r\n1]", DECODED),
}
WINDOW_TOKENS = {
    "float": ("1.0", REJECTED),
    "exponent": ("1E0", REJECTED),
    "exponent-integral": ("1e3", REJECTED),
    "boolean": ("true", REJECTED),
    "string": ('"5"', REJECTED),
    "nan": ("NaN", REJECTED),
    "zero": ("0", REJECTED),
    "negative-zero": ("-0", REJECTED),
    "negative": ("-1", REJECTED),
    "over-64-bits": (str(2**64 + 1), DECODED),
}
MODEL_FORMS = {
    "trailing-newline": ("provider/fast\n", DECODED),
    "leading-newline": ("\nprovider/fast", DECODED),
    "trailing-space": ("provider/fast ", DECODED),
    "inner-space": ("a b/c d", DECODED),
    "non-ascii": ("provider/caf\u00e9", DECODED),
    "three-segments": ("a/b/c", REJECTED),
    "empty-provider": ("/fast", REJECTED),
    "empty-name": ("provider/", REJECTED),
    "no-slash": ("provider", REJECTED),
    "empty": ("", REJECTED),
}

type DecodingItem = tuple[str, str, dict[str, Any], str]


def spliced(request: dict[str, Any], token: str) -> str:
    """Serialize a request and replace its one "__INPUT__" string with a raw JSON token."""
    return spliced_value(request, token)


def spliced_value(value: object, token: str) -> str:
    """Serialize a JSON value and replace its one "__INPUT__" string with a raw JSON token."""
    serialized = canonical_json(value)
    if serialized.count(INPUT_PLACEHOLDER) != 1:
        raise ValueError("the value must contain exactly one input placeholder")
    return serialized.replace(INPUT_PLACEHOLDER, token)


def tool_input_base() -> dict[str, Any]:
    """A route request whose tool_call input is the "__INPUT__" placeholder."""
    return route_request(
        [user(DECODING_PROMPT), message("assistant", tool_call("read_file", "__INPUT__"))],
        BASIC_OFFERS,
    )


def tool_input_text(token: str) -> str:
    """A route request whose tool_call input is the given raw JSON token."""
    return spliced(tool_input_base(), token)


def _request_item(identifier: str, description: str, outcome: str, request: object) -> DecodingItem:
    return (identifier, description, {"request": request}, outcome)


def _text_item(identifier: str, description: str, outcome: str, data: str | bytes) -> DecodingItem:
    if isinstance(data, bytes):
        try:
            data = data.decode("utf-8")
        except UnicodeDecodeError:
            payload = {"base64": base64.b64encode(data).decode("ascii")}
            return (identifier, description, payload, outcome)
    return (identifier, description, {"text": data}, outcome)


def _edited(old: str, new: str) -> str:
    if DECODING_TEXT.count(old) != 1:
        raise ValueError(f"{old!r} must occur once in the decoding request")
    return DECODING_TEXT.replace(old, new)


def _prompt_bytes(replacement: bytes) -> bytes:
    return _edited(DECODING_PROMPT, "\x00").encode("utf-8").replace(b"\x00", replacement)


def _syntax_items() -> list[DecodingItem]:
    def prompt(replacement: str) -> str:
        return _edited(DECODING_PROMPT, replacement)

    return [
        _text_item("empty", "An empty body", REJECTED, ""),
        _text_item("whitespace-only", "Only JSON whitespace", REJECTED, " \r\n\t"),
        _text_item("unterminated-object", "An object that is never closed", REJECTED, "{"),
        _text_item(
            "byte-order-mark", "A UTF-8 byte order mark first", REJECTED, "\ufeff" + DECODING_TEXT
        ),
        _text_item(
            "leading-whitespace", "JSON whitespace first", DECODED, " \r\n\t" + DECODING_TEXT
        ),
        _text_item(
            "trailing-whitespace", "JSON whitespace last", DECODED, DECODING_TEXT + " \r\n\t"
        ),
        _text_item(
            "trailing-nbsp",
            "U+00A0 last, which isn't JSON whitespace",
            REJECTED,
            DECODING_TEXT + "\u00a0",
        ),
        _text_item("trailing-token", "A token after the value", REJECTED, DECODING_TEXT + "x"),
        _text_item("trailing-object", "A second object", REJECTED, DECODING_TEXT + "{}"),
        _text_item("invalid-utf8", "A 0xFF byte in a string", REJECTED, _prompt_bytes(b"Fix \xff")),
        _text_item(
            "overlong-utf8",
            "An overlong two-byte encoding of '/' in a string",
            REJECTED,
            _prompt_bytes(b"Fix \xc0\xaf"),
        ),
        _text_item(
            "encoded-surrogate",
            "A UTF-8 encoded surrogate (ED A0 80) in a string",
            REJECTED,
            _prompt_bytes(b"Fix \xed\xa0\x80"),
        ),
        _text_item(
            "truncated-utf8",
            "A string that ends inside a two-byte sequence",
            REJECTED,
            _prompt_bytes(b"Fix \xc3"),
        ),
        _text_item(
            "escaped-high-surrogate",
            "An escaped high surrogate without a low surrogate",
            REJECTED,
            prompt("Fix \\ud800"),
        ),
        _text_item(
            "escaped-low-surrogate",
            "An escaped low surrogate without a high surrogate",
            REJECTED,
            prompt("Fix \\udc00"),
        ),
        _text_item(
            "escaped-reversed-surrogates",
            "An escaped low surrogate before a high surrogate",
            REJECTED,
            prompt("Fix \\udc00\\ud800"),
        ),
        _text_item(
            "escaped-surrogate-pair",
            "An escaped surrogate pair",
            DECODED,
            prompt("Fix \\ud83d\\ude42"),
        ),
        _text_item(
            "escaped-uppercase-hex", "Uppercase hex in a \\u escape", DECODED, prompt("Fix \\u00E9")
        ),
        _text_item("unknown-escape", "The undefined \\x escape", REJECTED, prompt("Fix \\x41")),
        _text_item(
            "raw-control", "An unescaped U+0001 in a string", REJECTED, prompt("Fix \u0001")
        ),
        _text_item("raw-tab", "An unescaped tab in a string", REJECTED, prompt("Fix \t")),
        _text_item("raw-delete", "An unescaped U+007F in a string", DECODED, prompt("Fix \u007f")),
        _text_item(
            "raw-line-separator", "An unescaped U+2028 in a string", DECODED, prompt("Fix \u2028")
        ),
        _text_item(
            "single-quotes", "A key in single quotes", REJECTED, _edited('"role"', "'role'")
        ),
        _text_item("unquoted-key", "A key without quotes", REJECTED, _edited('"role"', "role")),
        _text_item(
            "trailing-comma", "A comma after the last member", REJECTED, DECODING_TEXT[:-1] + ",}"
        ),
        _text_item("block-comment", "A /* */ comment first", REJECTED, "/* c */" + DECODING_TEXT),
        _text_item("line-comment", "A // comment last", REJECTED, DECODING_TEXT + "// c"),
    ]


def _token_items(limits: dict[str, int]) -> list[DecodingItem]:
    items = [
        _text_item(
            f"tool-input-{name}",
            f"tool_call.input is the raw token {token!r}",
            outcome,
            tool_input_text(token),
        )
        for name, (token, outcome) in TOOL_INPUT_TOKENS.items()
    ]
    for name, shape in LIMIT_SHAPES.items():
        limit = limits[name]
        slug = name.replace("_", "-")
        for suffix, size, outcome in (("at", limit, DECODED), ("over", limit + 1, REJECTED)):
            items.append(
                _text_item(
                    f"limit-{slug}-{suffix}",
                    f"tool_call.input: {LIMIT_DESCRIPTIONS[name].format(size)}",
                    outcome,
                    tool_input_text(shape(size)),
                )
            )
    return items


def _with(**fields: object) -> dict[str, Any]:
    return {**DECODING_REQUEST, **fields}


def _without(field: str) -> dict[str, Any]:
    return {key: value for key, value in DECODING_REQUEST.items() if key != field}


def _with_offer(**fields: object) -> dict[str, Any]:
    return _with(models=[*BASIC_OFFERS, {"id": "extra", "model": FAST, **fields}])


def _before_prompt(*messages: dict[str, Any]) -> dict[str, Any]:
    return _with(conversation=[*messages, *FIX_CONVERSATION])


def _offer_items(limits: dict[str, int]) -> list[DecodingItem]:
    windows = {
        **WINDOW_TOKENS,
        "digit-limit": ("7" * limits["digits"], DECODED),
        "digit-limit-over": ("7" * (limits["digits"] + 1), REJECTED),
    }
    items = [
        _text_item(
            f"context-window-{name}",
            f"An offer whose context_window is the raw token {token[:20]!r}",
            outcome,
            spliced(_with_offer(context_window="__INPUT__"), token),
        )
        for name, (token, outcome) in windows.items()
    ]
    items += [
        _request_item(
            f"model-{name}", f"An offer whose model is {model!r}", outcome, _with_offer(model=model)
        )
        for name, (model, outcome) in MODEL_FORMS.items()
    ]
    return [
        *items,
        _request_item("choice-id-empty", "An offer with an empty id", REJECTED, _with_offer(id="")),
        _request_item(
            "choice-id-integer", "An offer with a numeric id", REJECTED, _with_offer(id=1)
        ),
        _request_item(
            "choice-id-duplicate", "Two offers share an id", REJECTED, _with_offer(id="fast")
        ),
        _request_item("effort-unknown", "An unknown effort", REJECTED, _with_offer(effort="turbo")),
        _request_item(
            "effort-uppercase", "An uppercase effort", REJECTED, _with_offer(effort="LOW")
        ),
        _request_item("effort-null", "An explicit null effort", DECODED, _with_offer(effort=None)),
    ]


def _structure_items() -> list[DecodingItem]:
    robust = '"objective":{"goal":"cost","mode":"robust"}'
    unknown_mode = '"objective":{"goal":"cost","mode":"bogus"}'
    objective = '"objective":{"goal":"cost","mode":"balanced"}'
    return [
        _text_item(
            "duplicate-key-last",
            "A repeated objective key last; the last value wins",
            DECODED,
            DECODING_TEXT[:-1] + "," + robust + "}",
        ),
        _text_item(
            "duplicate-key-first",
            "A repeated objective key first; the last value wins",
            DECODED,
            "{" + robust + "," + DECODING_TEXT[1:],
        ),
        _text_item(
            "duplicate-key-invalid-first",
            "An objective with an unknown mode, then a valid one; only the last value is validated",
            DECODED,
            "{" + unknown_mode + "," + DECODING_TEXT[1:],
        ),
        _text_item(
            "duplicate-key-invalid-last",
            "A valid objective, then one with an unknown mode; the last value is validated",
            REJECTED,
            DECODING_TEXT[:-1] + "," + unknown_mode + "}",
        ),
        _text_item(
            "duplicate-key-partial-last",
            "A complete objective, then one with only goal; the last value replaces the first "
            "instead of being merged with it",
            REJECTED,
            DECODING_TEXT[:-1] + ',"objective":{"goal":"cost"}}',
        ),
        _text_item(
            "duplicate-key-partial-split",
            "An objective with only goal, then one with only mode; the objects aren't merged",
            REJECTED,
            _edited(objective, '"objective":{"goal":"cost"},"objective":{"mode":"balanced"}'),
        ),
        _text_item(
            "duplicate-key-nested-user-last",
            "A message repeats role, ending with user",
            DECODED,
            _edited('"role":"user"', '"role":"assistant","role":"user"'),
        ),
        _text_item(
            "duplicate-key-nested-assistant-last",
            "A message repeats role, ending with assistant",
            DECODED,
            _edited('"role":"user"', '"role":"user","role":"assistant"'),
        ),
        _text_item(
            "duplicate-key-nested-invalid-first",
            "A message repeats role, an unknown role then user; only the last value is validated",
            DECODED,
            _edited('"role":"user"', '"role":"narrator","role":"user"'),
        ),
        _text_item(
            "duplicate-key-nested-invalid-last",
            "A message repeats role, user then an unknown role; the last value is validated",
            REJECTED,
            _edited('"role":"user"', '"role":"user","role":"narrator"'),
        ),
        _text_item(
            "escaped-key",
            "A key spelled with a \\u escape",
            DECODED,
            _edited('"conversation"', '"\\u0063onversation"'),
        ),
        _text_item(
            "escaped-slash",
            "A model id spelled with an escaped slash",
            DECODED,
            _edited('"provider/fast"', '"provider\\/fast"'),
        ),
        _text_item("top-level-array", "A top-level array", REJECTED, "[]"),
        _text_item("top-level-null", "A top-level null", REJECTED, "null"),
        _text_item("top-level-string", "A top-level string", REJECTED, '"route"'),
        _text_item("top-level-number", "A top-level number", REJECTED, "1"),
        _text_item("top-level-true", "A top-level true", REJECTED, "true"),
        _text_item(
            "key-wrong-case",
            "Conversation with a capital C",
            REJECTED,
            _edited('"conversation"', '"Conversation"'),
        ),
        _request_item("extra-field", "An unknown top-level field", REJECTED, _with(extra=1)),
        _request_item(
            "conversation-null", "A null conversation", REJECTED, _with(conversation=None)
        ),
        _request_item("models-null", "A null models list", REJECTED, _with(models=None)),
        _request_item(
            "parts-omitted",
            "A message without parts",
            DECODED,
            _before_prompt({"role": "assistant"}),
        ),
        _request_item(
            "parts-null",
            "A message with null parts",
            REJECTED,
            _before_prompt({"role": "assistant", "parts": None}),
        ),
        _request_item(
            "role-tool", "The role tool", REJECTED, _before_prompt(message("tool", "result"))
        ),
        _request_item(
            "role-uppercase", "The role USER", REJECTED, _before_prompt(message("USER", "hello"))
        ),
        _request_item(
            "text-null",
            "A text part whose text is null",
            REJECTED,
            _before_prompt(message("assistant", {"text": None})),
        ),
        _request_item(
            "part-empty",
            "A part with no fields",
            REJECTED,
            _before_prompt(message("assistant", {})),
        ),
        _request_item(
            "part-extra-key",
            "A text part with an unknown field",
            REJECTED,
            _before_prompt(message("assistant", {"text": "a", "extra": 1})),
        ),
        _request_item(
            "part-text-and-tool-call",
            "One part holding both text and tool_call",
            REJECTED,
            _before_prompt(
                message("assistant", {"text": "a", "tool_call": {"id": "c", "name": "t"}})
            ),
        ),
        _request_item(
            "tool-call-without-input",
            "A tool_call without input",
            DECODED,
            _before_prompt(message("assistant", tool_call("read_file"))),
        ),
        _request_item(
            "tool-call-without-id",
            "A tool_call without id",
            REJECTED,
            _before_prompt(message("assistant", {"tool_call": {"name": "read_file"}})),
        ),
        _request_item(
            "tool-result-ok-string",
            "A tool_result whose ok is a string",
            REJECTED,
            _before_prompt(user({"tool_result": {"id": "c", "ok": "true"}})),
        ),
        _request_item("objective-missing", "No objective", REJECTED, _without("objective")),
        _request_item(
            "goal-uppercase",
            "The goal COST",
            REJECTED,
            _with(objective={"goal": "COST", "mode": "balanced"}),
        ),
        _request_item(
            "mode-unknown",
            "The mode unknown, which only classifier output uses",
            REJECTED,
            _with(objective={"goal": "cost", "mode": "unknown"}),
        ),
        _request_item("current-id-empty", "An empty current_id", REJECTED, _with(current_id="")),
        _request_item("current-id-null", "A null current_id", DECODED, _with(current_id=None)),
        _request_item(
            "classification-null", "A null classification", DECODED, _with(classification=None)
        ),
        _request_item(
            "classification-missing-complexity",
            "Classifier labels without task_complexity",
            REJECTED,
            _with(
                classification={"labels": {"task_type": "fix", "scope": "local"}, "mode": "unknown"}
            ),
        ),
    ]


def decoding_items(limits: dict[str, int]) -> list[DecodingItem]:
    """Return every decoding item as (id, description, payload, outcome)."""
    return [*_syntax_items(), *_token_items(limits), *_offer_items(limits), *_structure_items()]


def decoding_cases(limits: dict[str, int]) -> list[Case]:
    fields = {"text": "body", "base64": "body_base64", "request": "request"}
    cases = []
    for identifier, description, payload, outcome in decoding_items(limits):
        case: Case = {"id": identifier, "description": description}
        case.update({fields[key]: value for key, value in payload.items()})
        case["_outcome"] = outcome
        cases.append(case)
    return cases


# Registry -----------------------------------------------------------------------------------


def documents(limits: dict[str, int]) -> dict[str, Document]:
    """Return every builder document keyed by its path under fixtures/parity."""
    return {
        "labels.json": {
            "kind": "labels",
            "description": LABELS_DESCRIPTION,
            "cases": _cue_cases() + _boundary_cases() + _unicode_label_cases(),
        },
        "classification.json": {
            "kind": "classification",
            "description": CLASSIFICATION_DESCRIPTION,
            "cases": _classification_cases(),
        },
        "context.json": {
            "kind": "context",
            "description": CONTEXT_DESCRIPTION,
            "cases": _context_cases(),
        },
        "decoding.json": {
            "kind": "decoding",
            "description": DECODING_DESCRIPTION,
            "cases": decoding_cases(limits),
        },
    }
