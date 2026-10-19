# Router parity corpus

This directory records, as language-neutral JSON, what the Python router returns from the
functions whose behavior comes from Python itself rather than from the router's contract: the
heuristic labels, request decoding, the context estimate and the classifier prompt. It also
records the Unicode properties those functions rely on. The Go port of the router
([#10261](https://github.com/github/gh-aw-firewall/issues/10261)) replays these fixtures as unit
tests, and keeps them after the Python router is removed.

Everything else, such as routing, the CLI and HTTP, is tested by the Go port's own unit and
integration tests, which port the Python tests. During the port, a differential job also runs
the Python and Go routers on the same inputs. See [What the corpus doesn't cover](#what-the-corpus-doesnt-cover).

Everything here except this README is generated. Don't edit the generated files by hand.

| File | Role |
|---|---|
| `tests/parity_cases.py` | Builds every case's inputs, plus checks the generator runs before it records an output |
| `tests/parity_corpus.py` | Runs each case through the Python function and writes the fixtures (`--write`), or fails when they are stale (`--check`) |
| `tests/test_parity_corpus.py` | Replays every committed case against Python as part of `pytest` |

## Regenerating

Run from `containers/router`:

```sh
uv run --locked python tests/parity_corpus.py --write   # regenerate every file
uv run --locked python tests/parity_corpus.py --check   # fail if a committed file is stale
```

CI runs `--check` and the replay on Linux and Windows. A change to the Python router's behavior
in these functions therefore fails CI until the fixtures are regenerated, and the fixture diff
shows exactly which cases changed. Review that diff like a contract change.

Generation needs no network access and takes a few seconds. It refuses to run unless Python
reports Unicode 15.0.0, which is Python 3.12's version. The generator deletes files it no longer
produces, except `README.md`.

## Reference

The committed outputs were recorded from:

| Component | Version |
|---|---|
| gh-aw-router | 0.1.3, at commit `0e06f1e2` |
| Python | 3.12.13 (Unicode 15.0.0) |
| pydantic / pydantic-core | 2.13.5 / 2.46.5 |

The locked dependencies, not this table, define the reference. A dependency update that changes an
output shows up in `--check`.

## Layout

| Path | Function | Cases |
|---|---|---|
| `labels.json` | `heuristics.infer_labels(text)` | Every cue in every heuristic list, word-boundary and precedence cases, and Unicode whitespace, word characters and case folding around cues |
| `decoding.json` | `contracts.decode_request(RouteRequest, body)` | JSON syntax, UTF-8, number and literal spellings, parser depth and digit limits, duplicate keys, and the strict request schema |
| `context.json` | `routing.estimate_context_tokens(conversation)` | Character counts for text, tool names, tool input serialization and tool results, including non-ASCII text and unusual numbers |
| `classification.json` | `classification.authored_messages` then `build_classification_prompt` | Which turns are authored, prior-turn limits, truncation, stripping and escaping |
| `unicode/` | Python's character data | Inputs for generating the Go character tables |

## Document format

Each case document is a JSON object with a `kind` (`labels`, `decoding`, `context` or
`classification`), a `description` and an array of `cases`. Every case has an `id` that is unique
in its file, a `description`, its inputs and an `expect` object.

Files are UTF-8 with LF line endings, 2-space indentation and sorted keys. Non-ASCII characters
are written as `\u` escapes, so the bytes in each case are unambiguous.

A JSON-valued input (`request`, `conversation`) is passed to the function as its JSON text. Use the
raw JSON of the field as written; whitespace doesn't matter. Inputs whose exact spelling matters,
such as `NaN`, duplicate keys or a particular escape, use a text field instead.

### Labels

| Field | Meaning |
|---|---|
| `text` | The text of the latest authored user turn |
| `expect.task_type`, `expect.scope` | The inferred labels. `task_complexity` is always `unknown`, so it isn't recorded |

### Decoding

Each case has exactly one of:

| Field | Meaning |
|---|---|
| `request` | A JSON request, as JSON |
| `body` | The request body as UTF-8 text |
| `body_base64` | The request body as base64 bytes, for bytes that aren't valid UTF-8 |

`expect.result` is one of:

| Result | Meaning | CLI | HTTP |
|---|---|---|---|
| `decoded` | The body is a valid `RouteRequest` | Continues | Continues |
| `malformed` | A JSON syntax error or a parser limit (pydantic error type `json_invalid`) | Exit 2, `invalid request: ` | 400 `invalid_json` |
| `invalid` | Valid JSON that breaks the request schema | Exit 2, `invalid request: ` | 422 `invalid_json` |

Duplicate keys are accepted and the last value wins; `context.json` (`token-duplicate-keys`) shows
which value is used.

### Context

Each case has exactly one of `conversation` (JSON) or `conversation_text` (the JSON text of the
conversation array, for tokens such as `NaN` or `1e400` that need their exact spelling).

| Field | Meaning |
|---|---|
| `expect.characters` | The character count: text length, tool name plus compact JSON of the tool input, and tool result text, in code points |
| `expect.tokens` | `characters` divided by 4, rounded up |

### Classification

`conversation` is the request's conversation. `expect` holds either:

- `conversation_data`: the classifier prompt from the `<conversation_data>` line to the end. The
  full prompt is `classification_contract`, two newlines, then `conversation_data`;
- or `error`: `no_authored_turn`, when no user message has non-blank text.

The document also records the fixed `system_prompt` and `classification_contract` text, so the Go
port can embed them verbatim.

## Decoding limits

The decoder rejects deeply nested JSON and very long integers. The generator finds each limit by
binary search and records the last accepted size (`-at`) and the first rejected one (`-over`). The
`limit-*` cases put the value at `tool_call.input`, which is already inside six levels: the
request object, the `conversation` array, a message, its `parts` array, a part and the
`tool_call` object.

| Case | Last accepted |
|---|---|
| `limit-depth-arrays-at` | 195 nested empty arrays |
| `limit-depth-arrays-scalar-at` | 194 nested arrays around `0` |
| `limit-depth-objects-scalar-at` | 194 nested `{"a": ...}` objects around `0` |
| `limit-digits-at` | An integer of 4,300 digits |
| `limit-digits-negative-at` | A negative integer of 4,299 digits, because the sign counts |

## Unicode data

The heuristics and the error-detail sanitizer use Python's string methods and `re`, which follow
Unicode 15.0.0. Go's `unicode` package follows a newer version, so the Go port generates its own
tables from these files instead:

| File | Contents |
|---|---|
| `unicode/whitespace.json` | Code points where `str.isspace()` is true. It drives `split()`, `strip()` and `\s` |
| `unicode/word.json` | Code points `\w` matches in a `str` pattern: `str.isalnum()` plus `_` |
| `unicode/printable.json` | Code points where `str.isprintable()` is true. Error details replace the others with a space |
| `unicode/casefold.json` | `str.casefold()` for every code point it changes |

Each file records its definition, `python_version` and `unicode_version`. The ranges cover
U+0000 to U+10FFFF, excluding surrogates.

## What the corpus doesn't cover

The corpus holds only facts that would be lost with the Python code. Everything else is behavior
the Go port can test directly:

| Area | Where it's tested |
|---|---|
| Routing: rankings, profiles, automatic modes, explicit and omitted efforts, ties, `current_id`, context-window filtering, no-route | Go unit tests ported from `test_routing.py`, `test_service.py` and `test_contracts.py`, and the [portable contract corpus](../routing-contract) |
| Classifier choices: ranking, efforts and no-route | Go unit tests ported from `test_classification.py` |
| Routing table loading and validation | The published schema in `schemas/`, and a Go table test ported from `test_table_schema.py` |
| CLI commands, options, exit codes and `serve` settings | Go CLI integration tests ported from `test_cli.py` |
| HTTP paths, methods, media types, error envelopes and the body limit | Go HTTP integration tests ported from `test_http.py` |
| Agreement between Python and Go | A differential job during the port, which runs both routers on the contract corpus, inputs built from these fixtures and generated inputs |

## Decisions for the Go port

Where the Go router deliberately behaves differently from Python, the Go tests encode the Go
behavior and the differential job allows the difference. Merging the PR that adds this README
approves these decisions:

| Decision | Python | Go |
|---|---|---|
| Default tables path | Falls back to the `routing` directory of its source checkout | Uses `./routing` in the working directory if present, otherwise the option is required |
| Option abbreviations | argparse accepts unambiguous prefixes, such as `--routing-t` | Full option names only |
| `GH_AW_ROUTER_LOG_LEVEL` | Not validated | Usage error, exit 2 |
| Bind port syntax | `int()` accepts a sign, underscores, surrounding whitespace and non-ASCII digits | ASCII digits only |
| `serve` startup errors | Plain one-line text | JSON log records; other commands keep plain text |
| Trailing slash | Starlette redirects `/healthz/` to `/healthz` with 307 | 404 `not_found`, like any unknown path |
| Unsupported transfer coding | Uvicorn answers a bare 400 | Go's HTTP/1.1 server answers a bare 501, as RFC 9112 recommends |
| CLI line endings | Writes CRLF to a Windows pipe | LF on every platform |

## After the Python router is removed

- `labels.json`, `decoding.json`, `context.json` and `classification.json` stay as Go unit-test
  data. Their expectations change only through the Go tests' update flag, and the PR must explain
  every changed case.
- `unicode/` is deleted. The generated Go tables keep a header that names the reference commit,
  the Python and Unicode versions and how they were generated.
- `parity_cases.py`, `parity_corpus.py` and `test_parity_corpus.py` are deleted with the rest of
  the Python tests.
- The decisions table stays in this README as a record of what changed.
