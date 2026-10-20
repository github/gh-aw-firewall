# Router behavior fixtures

This directory records, as language-neutral JSON, the router's expected behavior in the areas
where it once came from Python itself rather than from the router's contract: the heuristic
labels, request decoding, the context estimate and the classifier prompt. The expectations were
generated from the Python router, then edited where the Go router deliberately differs (see
[Decisions for the Go port](#decisions-for-the-go-port)). The Go tests in `go/heuristics_test.go`
and `go/parity_test.go` replay every case.

Routing, the CLI and HTTP are tested by the Go unit and integration tests instead. See
[What the fixtures don't cover](#what-the-fixtures-dont-cover).

## Changing expectations

Edit the JSON by hand, and change an expectation only in a reviewed pull request that explains
every changed case. Keep the format below so diffs stay small.

## Reference

The expectations were first recorded from:

| Component | Version |
|---|---|
| gh-aw-router | 0.1.3, at commit `0e06f1e2` |
| Python | 3.12.13 (Unicode 15.0.0) |
| pydantic / pydantic-core | 2.13.5 / 2.46.5 |

The Go cut-over then changed the cases the decisions table covers: labels around letters added
after Unicode 15 and around case folding, `NaN` and `Infinity`, and the decoding limits. It
removed the context cases for `NaN` and `Infinity`, which no longer decode.

## Layout

| Path | Function | Cases |
|---|---|---|
| `labels.json` | `InferLabels(text)` | Every cue in every heuristic list, word-boundary and precedence cases, and Unicode whitespace, word characters and case folding around cues |
| `decoding.json` | `DecodeRouteRequest(body)` | JSON syntax, UTF-8, number and literal spellings, deep nesting and long integers, duplicate keys, and the strict request schema |
| `context.json` | `estimateContext(conversation)` | Character counts for text, tool names, tool input serialization and tool results, including non-ASCII text and unusual numbers |
| `classification.json` | `authoredMessages` then `ClassificationPrompt` | Which turns are authored, prior-turn limits, truncation, stripping and escaping |

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
| `malformed` | A JSON syntax error, including `NaN` and `Infinity` | Exit 2, `invalid request: ` | 400 `invalid_json` |
| `invalid` | Valid JSON that breaks the request schema | Exit 2, `invalid request: ` | 422 `invalid_json` |

Duplicate keys are accepted at any depth. The last value replaces the earlier ones, and only it is
validated: an invalid value followed by a valid one decodes, a valid value followed by an invalid
one doesn't, and two partial objects aren't merged. `context.json` (`token-duplicate-keys`) shows
which value is used inside free-form tool input.

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

The document also records the fixed `system_prompt` and `classification_contract` text, which the Go
router embeds verbatim.

## Decoding limits

The Go decoder has no nesting or digit limits; the HTTP body limit bounds the request instead.
The `limit-*` cases keep the sizes around the Python router's former limits, the last size it
accepted (`-at`) and the first it rejected (`-over`), and all of them decode. They put the value
at `tool_call.input`, which is already inside six levels: the request object, the
`conversation` array, a message, its `parts` array, a part and the `tool_call` object.

| Cases | `-at` | `-over` |
|---|---|---|
| `limit-depth-arrays-*` | 195 nested empty arrays | 196 |
| `limit-depth-arrays-scalar-*` | 194 nested arrays around `0` | 195 |
| `limit-depth-objects-scalar-*` | 194 nested `{"a": ...}` objects around `0` | 195 |
| `limit-digits-*` | An integer of 4,300 digits | 4,301 |
| `limit-digits-negative-*` | A negative integer of 4,299 digits | 4,300 |

## What the fixtures don't cover

The fixtures hold only facts that would otherwise have been lost with the Python code. The rest
is tested directly:

| Area | Where it's tested |
|---|---|
| Routing: rankings, profiles, automatic modes, explicit and omitted efforts, ties, `current_id`, context-window filtering, no-route | `go/route_test.go` and the [routing-contract corpus](../routing-contract) |
| Classifier choices: ranking, efforts and no-route | `go/classify_test.go` |
| Routing table loading and validation | `go/table_test.go` and `go/schema_test.go`, against the published schema in `schemas/` |
| CLI commands, options, exit codes and `serve` settings | `go/cli_test.go` and `go/serve_test.go` |
| HTTP paths, methods, media types, error envelopes and the body limit | `go/server_test.go`, `go/corpus_test.go` and the container tests in `go/container_test.go` |

## Decisions for the Go port

The Go router replaced the Python router at the image cut-over. These are the places where it
deliberately behaves differently. When the port compared errors with Python's, it compared only
the HTTP status and the error `code` (for the CLI, the exit status and the stderr prefix);
`detail` is diagnostic text.
| Decision | Python | Go |
|---|---|---|
| Default tables path | Falls back to the `routing` directory of its source checkout | Uses `./routing` in the working directory if present, otherwise the option is required |
| Option abbreviations | argparse accepts unambiguous prefixes, such as `--routing-t` | Full option names only. Go's `flag` package also accepts a single dash, such as `-routing-tables` |
| `GH_AW_ROUTER_LOG_LEVEL` | Not validated | Usage error, exit 2 |
| Empty `GH_AW_ROUTER_BIND` or `GH_AW_ROUTER_LOG_LEVEL` | Used as given: an empty bind exits 2 with `bind must use HOST:PORT syntax`, and an empty log level makes Uvicorn fail at startup with a `KeyError` | Treated as unset, so the default applies, as both CLIs already do for `GH_AW_ROUTER_ROUTING_TABLES` |
| Bind port syntax | `int()` accepts a sign, underscores, surrounding whitespace and non-ASCII digits | ASCII digits only |
| `serve` startup errors | Plain one-line text | JSON log records; other commands keep plain text |
| Trailing slash | Starlette redirects `/healthz/` to `/healthz` with 307 | 404 `not_found`, like any unknown path |
| Unsupported transfer coding | Uvicorn answers a bare 400 | Go's HTTP/1.1 server answers a bare 501, as RFC 9112 recommends |
| Paths that aren't clean, such as `//healthz` and `/a/../healthz` | 404 `not_found` | `ServeMux` redirects to the cleaned path with 307 |
| Request deadline | A request still running after 30 s gets 504 `request_timeout`, if its response hasn't started | Server timeouts: 10 s for the headers, 30 s for the whole request and 30 s for the response. A request past them has its connection closed, and `openapi.yaml` no longer documents the 504 |
| `OPTIONS *` | 404 `not_found` | `net/http` answers an empty 200 |
| Absolute-form request target, such as `GET http://host/healthz` | 404 `not_found` | Routed by its path |
| Invalid chunked request body | Uvicorn answers a bare 400 | The connection closes without a response |
| Chunked body over the limit on a path that doesn't read it, such as `POST /healthz` or `PUT /missing` | Buffers every POST, PUT and PATCH body before routing, so 413 `payload_too_large` | Only `/route` and `/classify` read the body, so the path's usual 405 or 404. A `Content-Length` over the limit still gets 413 on every path |
| CLI line endings | Writes CRLF to a Windows pipe | LF on every platform |
| CLI output encoding | `json.dumps` escapes non-ASCII characters as `\uXXXX` | Writes UTF-8. Both are the same JSON value |
| Unicode character data | Unicode 15.0.0 through `str` methods and `re`, with full case folding | Go's `unicode` package and `strings.ToLower`. Labels differ only for letters added after Unicode 15 and for `ﬁ`, `ſ`, `ß` and `İ` |
| `NaN` and `Infinity` | Accepted in tool input and as a context window | Malformed JSON, as RFC 8259 requires |
| JSON nesting and digit limits | pydantic rejects about 195 levels of nesting and integers over 4,300 digits | No such limits. The HTTP body limit bounds the request |
| Huge context windows | Kept as an arbitrary-precision integer | Saturate at the largest `uint64` |
| Error details | pydantic's wording | The Go decoder's wording. The error code, HTTP status and CLI exit status are the same |
