# AWF Model Selection Policy Specification (W3C-style)

## Status of This Document

This document defines the canonical model-selection policy for AWF
(`awf`). It specifies how agentic workflows declare, validate, and
resolve model choices at runtime.

This specification is intended for:

- `awf` runtime enforcement at container startup
- the `gh-aw compile` compiler (serialisation into lock files)
- IDE / static validation via JSON Schema

The machine-readable schema is published at:

- `schemas/model-policy.v1.json`

## 1. Conformance

The normative keywords **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**,
**SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and
**OPTIONAL** are to be interpreted as described in
[RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

A model-policy document is **conforming** when:

1. It is valid JSON.
2. Its data model satisfies `schemas/model-policy.v1.json`.
3. Unknown top-level properties are absent (closed-world schema).

Processors (AWF runtime, gh-aw compiler) that encounter a non-conforming
document **MUST** reject it with a descriptive error and a non-zero exit
code.

## 2. Data Model

### 2.1 Root Object

The root object **MUST** contain the following properties:

| Property       | Type   | Required | Description                                     |
|----------------|--------|----------|-------------------------------------------------|
| `version`      | string | **REQUIRED** | Policy schema version. **MUST** be `"1"`. |
| `model`        | object | **REQUIRED** | Primary model specification (§2.2).        |

The root object **MAY** also contain:

| Property          | Type   | Description                                                |
|-------------------|--------|------------------------------------------------------------|
| `$schema`         | string | URI of the validating JSON Schema (for tooling).           |
| `fallback`        | array  | Ordered fallback chain (§2.3).                             |
| `constraints`     | object | Constraints applied to every candidate (§2.4).            |
| `on_unavailable`  | string | Behaviour when no candidate satisfies constraints (§2.5).  |
| `audit`           | object | Observability settings (§2.6).                             |

Additional properties are **NOT** permitted.

### 2.2 Model Specification (`model`)

A model specification identifies a single model to request.

| Property           | Type   | Required | Description                                          |
|--------------------|--------|----------|------------------------------------------------------|
| `id`               | string | **REQUIRED** | Model identifier as understood by the provider (e.g. `"gpt-5.2"`). **MUST** be a non-empty string. |
| `provider`         | string | optional | Provider hosting the model. **MUST** be one of: `copilot`, `anthropic`, `openai`, `custom`. |
| `reasoning_effort` | string | optional | Engine-specific reasoning-effort hint. **MUST** be one of: `low`, `medium`, `high`. Only applicable to models that support this parameter. |

AWF does not maintain a registry of valid model identifiers. Unknown
`id` values produce a warning at compile time but **MUST NOT** block
execution.

### 2.3 Fallback Chain (`fallback`)

The `fallback` array specifies an ordered list of alternative candidates
tried when the primary model is unavailable or fails constraints.

- The array **MUST NOT** contain more than **5** entries.
- Each entry **MUST** be one of:
  - A **model specification** (§2.2) — a concrete alternative model.
  - An **auto sentinel** — the object `{ "strategy": "auto" }`, which
    instructs the resolver to pick the best available model satisfying
    the active constraints. No other properties are permitted alongside
    `strategy`.

When a `{ "strategy": "auto" }` sentinel is reached, the resolver
selects the first entry from the available-models list that satisfies
`constraints` (§2.4). If no such entry exists, the resolver continues to
the `on_unavailable` policy (§2.5).

Once the sentinel has been evaluated, subsequent entries in the fallback
array are **NOT** evaluated.

### 2.4 Constraints (`constraints`)

The `constraints` object specifies requirements that every candidate in
the resolution chain **MUST** satisfy. A candidate that fails any
constraint is skipped.

| Property              | Type             | Description                                                            |
|-----------------------|------------------|------------------------------------------------------------------------|
| `capabilities`        | array of strings | Each value **MUST** be one of: `tool-use`, `vision`, `code-execution`, `image-generation`. All listed capabilities **MUST** be supported by the resolved model. An empty array imposes no capability constraint. |
| `max_context_window`  | integer or null  | Maximum context-window size in tokens. `null` means no upper bound. When present and not null, **MUST** be a positive integer. |
| `min_context_window`  | integer          | Minimum context-window size in tokens. **MUST** be a positive integer. |
| `cost_tier`           | string           | The resolved model's cost tier **MUST** equal this value. **MUST** be one of: `economy`, `standard`, `premium`. |

All constraint fields are optional. Omitting `constraints` entirely
imposes no constraint on any candidate.

### 2.5 Unavailability Behaviour (`on_unavailable`)

Specifies what AWF **MUST** do when no candidate in the resolution chain
satisfies all active constraints.

| Value               | Behaviour                                                                                      |
|---------------------|-----------------------------------------------------------------------------------------------|
| `fail` *(default)*  | AWF **MUST** abort with a non-zero exit code and a descriptive error message.                  |
| `warn-and-use-best` | AWF **MUST** log a warning, relax all constraints, and select the first entry in the available-models list. If the available-models list is empty, AWF **MUST** still abort with a non-zero exit code. |
| `queue`             | Reserved for future runtime queuing support. AWF implementations that do not support queuing **MUST** abort with a non-zero exit code and an explanatory message. |

When `on_unavailable` is omitted the behaviour **MUST** be `fail`.

### 2.6 Audit Settings (`audit`)

| Property             | Type    | Description                                                                              |
|----------------------|---------|------------------------------------------------------------------------------------------|
| `log_selection`      | boolean | When `true`, AWF **MUST** emit an audit-log entry recording the resolved model and the resolution source (`primary`, `fallback`, or `auto`). |
| `log_fallback_reason`| boolean | When `true`, AWF **MUST** emit an audit-log entry for each candidate that was skipped, stating why it was skipped. |

## 3. Processing Model

### 3.1 Transport

The policy is passed to AWF at container startup via the environment
variable `AWF_MODEL_POLICY_B64`. Its value is the policy document
serialised as JSON and then base64-encoded (standard RFC 4648 alphabet,
no line breaks).

When `AWF_MODEL_POLICY_B64` is absent, AWF **MUST** behave as if no
policy was supplied: the model is taken directly from the agent command
line and no fallback or constraint logic is applied.

### 3.2 Resolution Algorithm

AWF resolves the effective model using the following algorithm:

1. **Primary** — AWF queries the available-models list (via
   `GET /models` on the API-proxy sidecar). If the primary model
   (`policy.model`) appears in the list and satisfies all active
   `constraints`, AWF **MUST** use that model and stop.

2. **Fallback chain** — AWF walks `policy.fallback` left to right:
   - For each **model specification** entry: if the entry's model is
     available and satisfies `constraints`, AWF **MUST** use that model
     and stop.
   - For the **auto sentinel** (`{ "strategy": "auto" }`): AWF
     **MUST** select the first entry in the available-models list that
     satisfies `constraints` and stop. If no such entry exists, AWF
     **MUST NOT** evaluate further fallback entries and **MUST** proceed
     to step 3.

3. **on_unavailable** — AWF applies the behaviour specified by
   `policy.on_unavailable` (§2.5).

### 3.3 Applying the Resolved Model

After resolution, AWF **MUST**:

1. Set the `AWF_RESOLVED_MODEL` environment variable in the agent
   container to the `id` of the resolved model.
2. If `audit.log_selection` is `true`, emit an audit-log entry with:
   - The resolved model `id` and `provider`.
   - The `source` of the resolution (`primary`, `fallback`, or `auto`).
   - When `source` is `fallback` or `auto` and a `fallback_index` is
     available, include the zero-based index into `policy.fallback`.

### 3.4 API-Proxy Enforcement

The API-proxy sidecar **SHOULD** enforce the resolved model for requests
originating from the agent container. Two enforcement modes are
**RECOMMENDED**:

| Mode          | Description                                                                                      |
|---------------|--------------------------------------------------------------------------------------------------|
| `rewrite`     | Transparently rewrite the `model` field in each request body to `AWF_RESOLVED_MODEL`.            |
| `reject`      | Return HTTP 400 with an explanatory body when the agent requests a model other than `AWF_RESOLVED_MODEL`. |
| `passthrough` | Do not enforce the resolved model; the agent's requested model is forwarded as-is.               |

The default enforcement mode is `passthrough` when no explicit
configuration is present.

## 4. Compiler Integration (`gh-aw compile`)

The `gh-aw` compiler reads model-selection policy from workflow
frontmatter and serialises it into the generated lock file.

### 4.1 Frontmatter Syntax

```yaml
# In the .md workflow file's YAML frontmatter
model: gpt-5.2
model-policy:
  fallback: [gpt-4.1, claude-sonnet-4-20250514, auto]
  constraints:
    capabilities: [tool-use]
    min_context_window: 128000
  on_unavailable: fail
```

Shorthand string entries in the `fallback` array (`gpt-4.1`,
`claude-sonnet-4-20250514`) are expanded to `{ "id": "<value>" }` model
specifications. The string `auto` is expanded to
`{ "strategy": "auto" }`.

### 4.2 Validation at Compile Time

The compiler **SHOULD** validate the following and emit warnings (not
errors) for violations that do not prevent execution:

- Model `id` values that are not in the compiler's known-models registry.

The compiler **MUST** emit errors (blocking) for:

- Constraint fields that are not well-formed (wrong type, out-of-range
  values).
- A `fallback` array that exceeds 5 entries.
- Unknown properties anywhere in the policy document.

## 5. Security Considerations

- The `AWF_MODEL_POLICY_B64` environment variable is derived from the
  compiled lock file and is not user-editable at runtime inside the
  sandbox.
- The resolved model identifier (`AWF_RESOLVED_MODEL`) is visible to the
  agent. Agents **MUST NOT** be trusted to honour it; enforcement **MUST**
  be implemented in the API-proxy sidecar (§3.4).
- The `custom` provider value allows arbitrary model endpoints. Operators
  **SHOULD** restrict `custom` providers to trusted internal endpoints
  using network-policy ACLs.

## 6. Examples

### Minimal policy (primary only)

```json
{
  "$schema": "https://raw.githubusercontent.com/github/gh-aw-firewall/main/schemas/model-policy.v1.json",
  "version": "1",
  "model": { "id": "gpt-5.2", "provider": "copilot" }
}
```

### Full policy with fallback and constraints

```json
{
  "$schema": "https://raw.githubusercontent.com/github/gh-aw-firewall/main/schemas/model-policy.v1.json",
  "version": "1",
  "model": {
    "id": "gpt-5.2",
    "provider": "copilot",
    "reasoning_effort": "medium"
  },
  "fallback": [
    { "id": "gpt-4.1", "provider": "copilot" },
    { "id": "claude-sonnet-4-20250514", "provider": "anthropic" },
    { "strategy": "auto" }
  ],
  "constraints": {
    "capabilities": ["tool-use", "vision"],
    "max_context_window": null,
    "min_context_window": 128000,
    "cost_tier": "standard"
  },
  "on_unavailable": "fail",
  "audit": {
    "log_selection": true,
    "log_fallback_reason": true
  }
}
```

## 7. Related Documents

- `schemas/model-policy.v1.json` — machine-readable JSON Schema
- `src/model-policy.ts` — TypeScript types and validator
- `src/model-resolver.ts` — Resolution algorithm implementation
- `docs/awf-config-spec.md` — AWF configuration specification
- `docs/environment.md` — Environment variable reference
