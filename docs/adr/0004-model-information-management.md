# ADR 0004: Model information management

## Status

Proposed for implementation planning. This ADR defines the target model
information contract and migration constraints. Existing allowlists, pricing
tables, mappings, runtime catalogues, and reflection fields remain supported
until generated replacements reach behavioral parity and their consumers
migrate.

## Context

AWF needs model information for several independent decisions:

- validating a requested Copilot model before containers start;
- identifying retired models and suggesting replacements;
- discovering models available from configured providers;
- resolving aliases and fallback candidates;
- enforcing allowed and disallowed model policies;
- calculating and limiting AI-credit usage;
- selecting reasoning effort and context-aware routing candidates;
- selecting a compatible wire API;
- deciding whether a request can be translated without losing features;
- exposing model information through `/reflect`, `models.json`, logs, and
  diagnostics; and
- maintaining documentation and generated container assets.

Downstream consumers include `gh-aw`, which maintains models.dev-derived
`models.json` copies for AIC estimates, and gh-aw-router-training, which needs
pricing and reasoning-effort facts. They are planned consumers of the generated
export or package API, not independent sources of model facts.

These facts are currently distributed across:

- `src/copilot-model.ts`;
- `src/copilot-model-catalog-sync.test.ts`;
- `containers/api-proxy/ai-credits-pricing.js`;
- `containers/api-proxy/models.dev.catalog.json`;
- `containers/api-proxy/provider-pricing-overlays.js`;
- `containers/api-proxy/runtime-model-catalog.js`;
- `docs/model-api-mapping.json`;
- `containers/api-proxy/model-api-mapping.json`;
- routing and reasoning validation modules;
- hard-coded wire compatibility code; and
- model-related reflection and persisted-snapshot projections.

These sources evolved to solve concrete failures, but they do not share one
identity scheme, schema, normalization function, provenance model, precedence
contract, or generation pipeline. Adding or retiring a model can require edits
to an allowlist, pricing table, retirement guard, endpoint mapping, packaged
mapping copy, tests, documentation, and updater workflow. Pairwise sync tests
and explicit exclusion sets reduce drift but have become a second, implicit
catalogue.

The same model string is normalized differently by host validation, curated
pricing, operator overlays, runtime metadata, and the bundled `models.dev`
catalogue. Provider identity is removed by several pricing paths, so equivalent
slugs from different providers can collide. Family wildcard rules can
accidentally cover specialized variants unless every consumer implements the
same specificity behavior.

Pricing has several legitimate authority levels:

1. operator deployment overlays;
2. live provider metadata;
3. reviewed maintained prices;
4. imported third-party prices;
5. dynamic-selector or unknown-model policy fallbacks.

The current implementation resolves these levels, but static prices generally
lack source, channel, effective dates, confidence, and field-level provenance.
Incomplete live tariffs can be merged with lower-priority values while retaining
only a single source label. Some missing cache-read prices are inferred as ten
percent of input cost without distinguishing estimates from published prices.
Promotions can be observed but are not modeled as effective tariffs.

Reasoning effort is represented by live provider fields, maintained routing
metadata, endpoint-specific request fields, and hard-coded router enums.
Routing and request validation do not consume one resolved capability record.
Unknown future effort values can be discarded rather than preserved as
provider observations.

API compatibility is represented primarily as endpoint availability.
Feature-preserving request translation remains hard-coded. Endpoint support
alone does not answer whether a model supports function tools, hosted tools,
parallel calls, strict JSON Schema, image/audio/file input, stateful fields,
reasoning summaries, cache controls, or lossless translation between protocols.

The model API mapping updater can change only the documentation copy, while
production packages a second copy and CI requires them to remain identical.
Recent updates have therefore needed follow-up synchronization changes.

Current coverage issues make these design gaps concrete:

- #10029 identifies current Copilot models missing reviewed fallback pricing or
  host-side availability, including prices with long-context thresholds and an
  expiring promotional tariff.
- #10030 identifies incomplete reasoning-effort and context metadata, including
  exact model revisions that differ from their broader family.
- #10032 establishes characterization tests as the first implementation step
  so the redesign does not unintentionally change existing behavior.

AWF needs a principled subsystem that can absorb these and future model changes
without continuing the synchronized-table pattern.

## Decision

AWF will introduce one versioned, provider-qualified model information
subsystem. Maintained records, imported snapshots, operator overlays, central
catalogue updates, and runtime observations will use schema-validated inputs
and compile or resolve into one normalized record model.

Existing consumers will migrate to generated projections or a shared resolver.
No consumer may become a new independent source of model facts.

The subsystem has these architectural parts:

1. a versioned canonical schema;
2. one provider-qualified identity and matching implementation;
3. reviewed maintained source records;
4. governed imported snapshots;
5. validated operator overlays, including workflow-defined model entries;
6. the existing configured pricing catalogue, configurable central catalogue
   refresh, and normalized runtime observations;
7. field-level merge, precedence, freshness, and provenance;
8. deterministic generated projections for existing consumers;
9. versioned runtime and offline export contracts; and
10. one maintenance and update pipeline.

The migration is incremental. Existing behavior remains authoritative until a
new projection or resolver has characterization coverage and parity. High-risk
pricing, reasoning, and compatibility migrations use shadow comparison before
the new result controls a request.

## Architectural invariants

### Provider-qualified identity

Every exact model record has a stable key:

```text
<provider>/<provider-model-id>
```

The provider is part of identity. `copilot/gpt-x` and `openai/gpt-x` are
different records even when their displayed model IDs match. They can have
different availability, prices, context limits, endpoint support, lifecycle,
and compatibility.

Each record preserves:

- the raw provider model ID;
- the normalized lookup form;
- provider-scoped aliases;
- family membership;
- optional dated or deployment variants; and
- lifecycle status.

Normalization MUST NOT erase provider identity. Date suffix removal, separator
equivalence, query-parameter handling, provider-prefix handling, and family
matching are explicit match policies rather than unconditional string
rewrites.

Exact model records and family rules are separate concepts. A family rule
cannot make a model deployable or available. Exact records override family
defaults through deterministic specificity, not file order.

The compiler rejects:

- duplicate exact keys;
- ambiguous aliases in the same scope;
- unresolved replacements;
- equal-specificity overlapping rules with different values; and
- a family rule that unintentionally captures a declared exception.

Specialized variants such as `gpt-5.6-cyber`, `gpt-5.5-pro`, and
`claude-mythos-preview` MUST be able to exclude or refine broader family
capabilities.

### Unknown is not unsupported

Capability values use explicit states:

- `supported`;
- `unsupported`;
- `unknown`; and
- `conditional` where a documented condition exists.

Missing provider data becomes `unknown`, not `unsupported`. An explicit
provider value may establish `unsupported`. Maintained data may fill a missing
runtime field when its provider, channel, exact model scope, source, and
freshness satisfy the resolver policy.

Consumers fail closed when a safety-sensitive decision requires a known value.
They expose an incomplete-data reason rather than silently inventing support.

### Source and projection separation

Human-reviewed source records and governed imported snapshots are authoring
inputs. Files consumed by the host, API proxy, documentation, and container
build are generated projections.

Generated projections are deterministic, sorted, schema-versioned where
externally consumed, and checked for staleness in CI. Contributors do not edit
them directly.

The documentation and packaged model API mappings are generated from the same
source. Their current byte-for-byte sync test is replaced by compiler and
stale-output checks once generation is active.

## Canonical record requirements

A canonical exact-model record contains the following logical groups. The
concrete JSON Schema may split these into reusable definitions.

### Identity and lifecycle

- schema version;
- provider-qualified key;
- provider;
- raw provider ID;
- family;
- aliases with scope and match policy;
- lifecycle status such as active, preview, restricted, retired, or removed;
- replacement key or explicit no-replacement marker;
- availability channels such as native API, Copilot API, Copilot CLI, BYOK, or
  internal;
- picker visibility where the provider exposes it; and
- model type, such as completion, embedding, reranker, or other.

Availability and lifecycle are channel-specific when necessary. A model priced
for BYOK is not thereby a valid Copilot CLI completion model.

### Harness version constraints

Model records can declare channel-specific harness requirements:

- harness identifier, such as `copilot-cli`;
- minimum supported version and its version-comparison scheme;
- optional additional version-range restrictions;
- source, review time, and freshness; and
- an actionable incompatibility reason.

For example, a Sol model can require `copilot-cli` at or above a documented
minimum version. The actual floor is sourced and reviewed model data, not a
version guessed from the model name or hard-coded in a consumer.

AWF validates the version of the harness that will actually execute, including
the selected binary and execution environment, before launching the agent.
A host installation with a different version is not sufficient evidence.
Version comparison defines boundary and prerelease behavior. If an applicable
requirement exists, an unknown, unavailable, or unparsable harness version does
not satisfy it.

Explicit incompatible model requests fail with the model, harness, required
version, detected version or detection failure, and upgrade guidance. Routing,
dynamic selectors, and fallback selection exclude incompatible candidates
before dispatch and fail explicitly when no eligible candidate remains.
Runtime catalogue refreshes re-evaluate eligibility before subsequent dispatch;
they do not upgrade the harness or silently substitute a different model for an
explicit request.

These requirements are supported in maintained records, central catalogue
updates, and workflow/operator entries, and are exposed in resolved exports.
Model availability or native protocol support does not establish harness
compatibility.

### Limits and modalities

- context-window tokens;
- maximum output tokens;
- input modalities;
- output modalities;
- tokenizer or accounting family where relevant;
- limits conditioned on protocol, tier, or channel; and
- field provenance and freshness.

### Reasoning

- support state;
- raw provider effort values;
- router-selectable normalized effort values;
- default effort when documented;
- whether effort is optional, required, or forbidden;
- protocol-specific request field;
- provider-specific aliases or mappings;
- exact-model refinements over family defaults;
- effort-dependent limits or pricing references when applicable; and
- provenance.

Unknown provider effort strings MUST survive ingestion and export. A router
version that does not understand a value omits it from selectable choices and
reports an explicit non-selectable reason; it does not discard the observation.

### Protocol and feature compatibility

Compatibility is represented per protocol, including:

- OpenAI Responses;
- OpenAI Chat Completions;
- Anthropic Messages;
- Gemini generate-content protocols where needed; and
- future versioned protocols.

For each protocol, the record distinguishes:

- native support;
- AWF-translatable support;
- lossy translation;
- unsupported; and
- unknown.

AWF translation support is additionally declared for each directed source and
target protocol pair, with per-feature conditions and the translator version or
capability revision. Responses-to-Chat support does not imply Chat-to-Responses
support. A model supporting both endpoints does not establish that either
translation preserves every feature. Routing and validation use the applicable
directed pair and actual request features.

Feature compatibility can include:

- function tools;
- hosted or built-in tools;
- parallel tool calls;
- strict JSON Schema;
- image, audio, video, and file input;
- streaming;
- usage reporting;
- developer and system roles;
- stateful response fields;
- reasoning summaries or encrypted reasoning content;
- cache controls;
- web search or fetch;
- structured output forms; and
- any feature that the AWF translators explicitly accept or reject.

Hard-coded translation logic remains the enforcement implementation until
migrated, but each rejection must eventually correspond to a declared feature
requirement. AWF continues to reject lossy translation rather than dropping
request fields.

### Pricing

Pricing is provider- and channel-scoped. A tariff contains:

- currency;
- exact accounting unit;
- input price;
- cached-input price or explicit unavailability;
- cache-write price or explicit unavailability;
- output price;
- optional non-token charges;
- tier name;
- optional prompt-token threshold;
- effective start and end;
- promotion identifier where applicable;
- source and observation or review time;
- confidence, such as verified, imported, estimated, or policy fallback; and
- provenance for every component when a tariff is assembled from more than one
  source.

Maintained decimal prices are stored without binary floating-point loss and
converted to an exact internal unit for accounting.

An omitted price is not automatically zero. An unavailable cache-write price is
different from a published zero-cost cache write.

Estimated cache-read prices remain permitted only when policy explicitly allows
them. They are labeled `estimated` and never presented as provider-published
pricing.

Reviewed promotional list-price tariffs are time-bounded data. They MUST include
an expiry or effective end and, where known, the successor tariff. A source-code
reminder is not an acceptable expiry mechanism. Runtime-advertised discounts are
informational observations only: discovery does not prove request-level
eligibility, so they MUST NOT reduce the effective tariff or `maxAiCredits`
accounting. Supporting request-level discounts in the future requires a
separately reviewed contract; discovery alone never makes a discount billable.

Long-context pricing is a first-class tariff selected by the same normalized
input-token semantics used for runtime provider pricing. Threshold boundaries
and tariff selection are covered by tests.

Dynamic selectors such as Copilot `auto`, unknown response models, and
conservative ceilings are policy tariffs, not ordinary model prices.

## Data layers and precedence

The subsystem uses five input layers. Workflow-defined entries are a
run-scoped form of operator overlay, not an independent authority level.

### Maintained base registry

Reviewed records owned by this repository define:

- supported channels;
- lifecycle and replacements;
- documented endpoint and capability facts;
- reviewed fallback pricing;
- exact reasoning and context metadata; and
- known exceptions to family defaults.

Maintained records are split into reviewable provider or family files. Every
fact group has source and review metadata.

### Imported snapshots

Third-party or generated inputs, including `models.dev`, are immutable snapshots
with adjacent metadata:

- source URL or repository;
- source revision;
- retrieval time;
- importer version;
- content hash;
- license or usage note;
- accepted and rejected record counts; and
- canonicalization collision report.

Imported data can supply lower-confidence pricing or capabilities according to
policy. It cannot establish first-party Copilot CLI availability, retirement,
or replacement.

AWF MUST use governed `models.dev` snapshots as the pricing fallback for
inference providers without native AWF pricing support, including configured
custom providers, when an applicable provider/model entry exists. This allows
accounting without requiring a maintained pricing table or native pricing
adapter for every inference provider. Higher-priority sources still win under
the field-level precedence contract.

Lookup preserves the `models.dev` provider identity and exact model scope,
using explicit provider mappings or aliases where necessary. A matching model
slug at a different provider is not a pricing match. Imported rates are
normalized to the canonical accounting unit and tariff structure, retaining
source revision, confidence, freshness, and per-component provenance.

Using imported pricing does not add provider execution support or establish
availability, harness compatibility, or wire compatibility. Missing or
inapplicable prices remain unresolved and use the explicit unpriceable-model
policy, never a silent zero price. Bundled snapshots and configured local or
mirrored sources support this fallback without requiring runtime access to
`models.dev`.

### Operator overlays

Operator configuration can define deployment-specific:

- model IDs and aliases;
- prices;
- compatibility restrictions;
- harness version requirements;
- availability;
- target protocol; and
- source labels.

New, explicitly versioned overlays are validated against the versioned overlay
schema at startup; unknown fields and invalid prices fail before requests are
accepted. Existing unversioned `apiProxy.providers` overlays retain their
currently supported open, models.dev-shaped input contract during migration and
are not subjected to strict unknown-field rejection. A compatibility reader
continues to interpret these overlays until they are translated or explicitly
migrated to the versioned format. Operator overlays have highest configured
authority within their declared provider, channel, and deployment scope.

#### Workflow-defined model entries

Phase 2 proposes that users define model entries in the YAML frontmatter of a
gh-aw workflow `.md` file. Entries would use a versioned model-overlay schema
to add custom models or override scoped facts, including pricing, reasoning,
limits, protocol compatibility, and harness version requirements. The gh-aw
compiler would validate and pass a structured payload through the AWF
configuration file for AWF to validate before accepting requests. Model
definitions must not be encoded in prompt text or passed through ad hoc
environment-variable conventions. This cross-repository handoff is **unresolved**
until gh-aw and AWF agree on verifiable schemas, version compatibility, and
conflict behavior; no frontmatter or config field names are settled here. See
the Phase 2 compatibility matrix under Gate 2.

When agreed and implemented, workflow entries have operator-overlay precedence
within their declared provider, channel, and deployment scope. The handoff must
define one unambiguous effective overlay: conflicting same-scope workflow and
operator entries fail validation unless their override order is explicitly
configured. Entries remain run-local, do not modify the bundled registry or
shared cache, and retain sanitized workflow provenance in reflection and
persisted exports. Overrides do not bypass model-policy, network, or harness
checks.

Before this feature ships, the compiler and AWF must agree on an overlay schema
version. A workflow using it with an older pinned AWF must fail explicitly as
unsupported rather than silently losing entries; existing workflows without
entries retain their current behavior. The exact handoff is a cross-repository
acceptance condition, not an established protocol.

### Existing configured pricing catalogue

`AWF_MODEL_PRICING_CATALOG` is an **existing** operator-configured, provider-scoped
pricing input with `schemaVersion: 1` (also configured via
`apiProxy.modelPricingCatalog`). It is not a downloaded central feed, a runtime
provider observation, or the proposed strict versioned overlay. Preserve its
current pricing authority **above** complete, fresh runtime pricing and its
existing schema/compatibility semantics during migration. A new strict schema
does not retroactively reject or reinterpret this configured format. Its
provider/model matching and pricing behavior are characterized in Phase 1; any
change to those semantics requires an explicit migration and parity review.

### Central catalogue updates

AWF can dynamically refresh pricing from a configurable central catalogue
without an AWF or container-image release. The versioned feed can also publish
model-to-harness version constraints. It uses the canonical pricing and harness
schemas; it does not introduce another normalization or accounting path.
Fetched data cannot by itself establish provider availability. This **new**
fetched feed is distinct from the existing configured
`AWF_MODEL_PRICING_CATALOG` and ranks **below** complete, fresh runtime provider
pricing, not above it.

AWF MUST assume that the default pricing feed is blocked or unreachable.
Reaching that endpoint is not a startup prerequisite when approved workflow,
operator, cached, or bundled pricing is available. AWF must not implicitly
allowlist the feed, relax egress policy, or retry through a different network
path to bypass a denial.

Users can replace the pricing source through direct AWF configuration; workflow
frontmatter selection depends on the unresolved gh-aw config handoff. Planned
sources include a configurable feed URL, such as an internal mirror, and an explicitly
configured local snapshot using the same versioned schema. The source
selection replaces the default endpoint; a failed custom source does not cause
AWF to contact the default feed or another unconfigured endpoint.

AWF configuration specifies the source, enabled/offline mode, bounded fetch
timeout, refresh interval, and maximum acceptable snapshot age. Source URLs and
local snapshot paths are explicit configuration, not destinations or paths
inferred from model metadata. Retrieval uses an approved transport and network
policy, validates the configured source and payload, and keeps authentication
material out of logs, cache metadata, and exports. Offline mode and local-only
sources perform no pricing-feed network requests.

Each snapshot includes schema version, catalogue revision, publication time,
effective dates, source provenance, and an integrity digest. Source
authentication is a separate requirement; a content digest alone does not
authenticate the publisher. Malformed, unsupported, or inconsistent updates
are rejected atomically with an explicit diagnostic, never partially applied.
The shared cache is partitioned by configured source and schema version so
changing pricing sources cannot reuse an unrelated source's last-known-good
snapshot.

When the feed is enabled, AWF resolves an initial snapshot or approved fallback
before price-dependent requests are accepted and refreshes at the configured
interval during long runs. A validated update becomes available atomically for
subsequent requests. Each request's accounting retains its resolved tariff,
effective time, revision, and provenance; refreshes do not retroactively reprice
recorded usage.

Network denials, timeouts, and rejected updates are expected operating
conditions, reported with the fallback used. They can retain a last-known-good
snapshot only within the configured age policy. Offline mode and expired or
absent caches use applicable workflow/operator pricing, explicit bundled or
conservative fallback policy, or fail closed when no approved price exists.
They do not silently treat an old snapshot as fresh.
Reflection and diagnostics expose the active source/revision, snapshot age,
refresh failure, and fallback reason without exposing credentials.

Central updates preserve reviewed promotion expiry and informational-only
treatment of runtime-advertised discounts. Workflow/operator overlays and the
existing configured pricing catalogue retain precedence. Downloaded updates
remain separate from reproducible checked-in projections and never rewrite
package assets.

### Runtime observations

Provider model-list responses can supply:

- current availability;
- picker state;
- capabilities;
- supported endpoints;
- reasoning efforts;
- limits;
- prices and pricing tiers;
- promotions;
- API version; and
- observation time.

Runtime observations are normalized without retaining or exporting arbitrary
raw provider payloads. Sanitized public and private routing projections are
explicit schema contracts.

Runtime provider facts have highest authority for current availability and
provider-published values when complete and fresh. A later incomplete response
does not silently erase a complete tariff, but retained data is subject to a
maximum age and is marked stale. Safety-sensitive consumers decide whether stale
data is acceptable under an explicit policy.
Provider-advertised promotions remain informational and do not override a
reviewed effective tariff.

## Field-level resolution

Precedence is resolved per field, not by replacing an entire record:

1. operator overlay within its declared scope;
2. existing configured `AWF_MODEL_PRICING_CATALOG` `schemaVersion: 1` for pricing
   within its configured scope;
3. complete, fresh runtime provider observation;
4. validated, fresh **fetched** central catalogue update within its declared
   scope;
5. reviewed maintained record;
6. governed imported snapshot;
7. explicit policy fallback.

The configured catalogue supplies pricing only, not provider availability or
other model capabilities. Where a higher source omits a compatible component,
the tariff-component merge rules below apply; a fetched feed never supersedes
an applicable configured price or complete fresh runtime price. Legacy
configured-catalogue and unversioned provider-overlay readers keep their
existing input semantics; strict unknown-field validation applies only to new,
explicitly versioned formats.

Availability may have a different safe fallback rule from pricing or
compatibility. The resolver therefore applies a policy per field group.

Pricing is merged one tier at a time. A higher-priority tier defines the
threshold and tariff scope; lower-priority sources may fill only components it
omits, never replace components it supplies. A tier completed from multiple
sources is labeled `assembled`, with provenance retained for every component.
This prevents a result from silently combining values from different tiers or
presenting an unpublished component combination as a single source tariff.
Runtime-advertised discounts are excluded from this merge and remain
informational as described above.

Component filling requires compatible provider, channel, deployment, currency,
accounting unit, prompt-token applicability, and effective-date scope. A shared
tier name alone is not a match. For example, a cache price applicable only
through 128k prompt tokens cannot fill a live tier extending to 200k for a 160k
request, nor can an expired promotional component fill a current tariff.
Without an applicable component, resolution remains incomplete or invokes an
explicit approved fallback; `assembled` provenance does not make an
incompatible component eligible.

Every resolved value retains:

- winning source;
- source-specific version or revision;
- observed or reviewed time;
- fallback sources considered;
- stale state;
- estimated state;
- exact scope; and
- optional conflict diagnostics.

If a runtime tariff contributes input and output prices while maintained data
contributes cache prices, the result carries provenance for each component. It
is not labeled only `provider`.

The resolver produces a stable resolution trace suitable for reflection, logs,
tests, and diagnostics without exposing secrets or arbitrary provider payloads.

## Concrete current coverage requirements

The initial maintained registry MUST represent the current gaps from issues
10029 and 10030 through canonical records, not additional handwritten exception
lists.

### Pricing and availability

The registry includes Copilot-channel availability and reviewed pricing for:

- Claude Opus 5.5;
- Claude Sonnet 5.5;
- GPT-6.1 Sol;
- Gemini 3.8 Flash;
- Grok 4.5;
- Grok 4.6; and
- Grok 4.7.

GPT-6.1 Sol and Grok 4.5/4.6/4.7 exercise long-context tariffs. Gemini 3.8
Flash exercises a promotional tariff with an effective end and successor rate.
Generated projections provide the host allowlist and any compatibility pricing
shape required during migration.

### Reasoning and context

The registry includes exact maintained records for:

- OpenAI GPT-5.4 Mini, GPT-5.5, GPT-5.6 Sol/Terra/Luna, GPT-6 Astra/Sol/Luna,
  and GPT-6.1 Sol;
- Anthropic Opus 5.5/5, Fable 5.1/5, Mythos 5.1/5, Sonnet 5.5/5, Opus 4.8/4.7,
  Opus 4.6, Sonnet 4.6, Haiku 5.5, and Mythos Preview.

Exact matching preserves at least these differences:

- `gpt-5.6-cyber` does not inherit general GPT-5.6 routing data;
- `gpt-5.5-pro` does not inherit general GPT-5.5 routing data;
- GPT-5.4 Mini has its own context window;
- Opus 4.7 and 4.8 support `xhigh`, while Opus 4.6 does not;
- Fable 5/5.1 and Mythos 5/5.1 support `xhigh`, while Mythos Preview does not;
- Haiku 5.5 has its own verified effort and context record; and
- broad endpoint-family mappings do not imply unverified routing capability.

## Generated projections

The compiler generates the smallest stable projection needed by each consumer.
Initial projections include:

- host-side Copilot model validation and suggestions;
- proxy-side retirement validation;
- curated pricing compatibility data;
- model API and routing mappings;
- public documentation mapping;
- static catalogue export;
- generated documentation tables; and
- manifests containing schema version, catalogue revision, and a reproducible
  static generation timestamp.

The host and API proxy may consume different projections, but both derive from
the same source records and identity rules.

Because the API proxy is CommonJS JavaScript and the host is TypeScript, JSON is
the interoperability format. Consumers do not reimplement canonicalization.

The catalogue revision is a deterministic digest of the normalized source
records, schema version, and compiler version. The static generation timestamp
is derived from versioned source metadata (the latest included review or import
timestamp), never the compiler's wall-clock time. Additive `/reflect` fields
reuse that static timestamp and report live observation times separately.
Optional build wall-clock timestamps are not included in checked-in projections.

CI validates source schemas, compiles projections, and fails when checked-in
generated files differ from compiler output.

## Runtime and offline exports

### Existing contracts

Current `/reflect`, `models.json`, logs, and validation messages remain
compatible during migration. They are gradually generated from resolved records
without changing field meaning.

### Additive `/reflect`

AWF will extend the existing `/reflect` response additively with a versioned
model-information section containing:

- schema version;
- static catalogue revision;
- generation time;
- runtime observation time;
- provider-qualified resolved model records;
- source and freshness summaries;
- routing-selectability reasons;
- model-to-harness constraints and detected compatibility;
- central catalogue revision, freshness, and refresh/fallback diagnostics;
- warnings for stale, estimated, incomplete, or conflicting information; and
- sanitized runtime provenance.

Each new exported value, including every pricing component, carries its source
and freshness state (for example, `estimated` or `stale`), so consumers need
not reconstruct those labels from a summary. A version on the new section
identifies its schema; existing `/reflect` fields keep their shape and meaning.
Consumers use the existing endpoint, treating the new section as optional on
older pinned AWF versions. There is no new endpoint or endpoint negotiation.

The default representation is compact. A detail mode may expose field-level
provenance when payload size requires separation.

Raw provider payloads, credentials, private headers, and unreviewed arbitrary
fields are never reflected.

### Persisted snapshots

AWF will version `models.json` or add a sibling `model-catalog.json`. Persisted
snapshots include schema and catalogue revisions so tooling can distinguish
static data from run-specific observations. The generated export or npm package
is the planned source for gh-aw's AIC `models.json` copies and
gh-aw-router-training's pricing and effort data; their consumers may switch at
Gate 7 after export compatibility and accounting-parity tests pass.

### CLI and package API

The CLI will eventually provide:

- `awf models list`;
- `awf models show`;
- `awf models export`;
- `awf models validate`;
- `awf models sources`; and
- optionally `awf models diff`.

The npm package will ship the generated static catalogue and read-only APIs for
identity, capabilities, and pricing. Runtime overlays remain run-local.

## Maintenance workflow

One model catalogue updater replaces endpoint-only and ad hoc update paths. It:

1. fetches approved provider documentation and provider model APIs;
2. imports third-party sources into governed snapshots;
3. proposes changes to maintained source records or imported snapshots;
4. runs schema validation and compilation;
5. includes every generated projection in the same pull request;
6. emits a machine-readable change report; and
7. applies review gates for high-impact changes.

For Copilot models, use GitHub's
[supported models reference](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
as the authority for the currently supported-model list. Also review
[Copilot changelog announcements](https://github.blog/changelog/2026-09-18-upcoming-deprecation-of-selected-github-copilot-models-in-mid-october/)
for announced lifecycle changes that may precede updates to that reference,
including the [October 15, 2026 announcement](https://github.blog/changelog/2026-10-15-upcoming-deprecation-of-selected-github-copilot-models-in-mid-november/).
Treat an announcement as evidence for a reviewed, dated lifecycle change, not
as proof that a model is already unsupported: preserve the current support
status until the announced effective date and reconcile it with the supported
models reference and provider data. Record the sources and effective date so
conflicts or delayed changes are visible to reviewers.

On each scheduled run, the updater compares available live provider model data
with the maintained registry. It reports missing models, price changes beyond
the documented provider-specific rounding tolerance, and changed reasoning
efforts or limits. Drift findings propose reviewed source updates; they do not
silently promote runtime observations into maintained facts or make runtime
discounts billable.

After review and validation, the same canonical source pipeline can publish
versioned central catalogue snapshots. This distribution step is distinct from
provider discovery and does not bypass the update review gates.

The report identifies:

- added and removed models;
- lifecycle and replacement changes;
- channel availability changes;
- price and tariff changes;
- threshold and effective-date changes;
- promotion expiry;
- effort-set and context-limit changes;
- protocol and feature compatibility changes;
- harness minimum-version and version-range changes;
- source-confidence changes;
- stale or missing sources; and
- import collisions or rejected records.

Pricing decreases, retirement, compatibility contraction, source-confidence
downgrade, and source disappearance require explicit review.

The updater does not derive verified compatibility or reasoning support from
marketing prose. Uncertain facts are marked unverified or left unknown.

## Freshness and staleness

Each fact group has a policy-appropriate maximum age:

- current provider availability and picker state are run-local observations;
- runtime prices use a provider-specific freshness window;
- central catalogue snapshots use configured maximum ages and preserve
  component effective dates independently of fetch time;
- maintained compatibility is reviewed when provider documentation changes;
- imported fallback prices have an explicit snapshot age; and
- operator overlays remain valid until configuration changes or an optional
  expiry is reached.

Stale information is not silently current. Reflection and logs expose stale
state. Budget enforcement, routing, and validation each define whether stale
data can be used and fail closed when their policy requires fresh data.

## Security and reliability requirements

The redesign preserves existing safeguards and adds the following requirements:

- operator overlays outrank bundled defaults only within validated scope;
- live provider availability outranks maintained assumptions;
- routing fails closed when authoritative discovery is required and unavailable;
- custom or non-native provider targets do not inherit native-provider claims;
- model policy and picker exclusions apply before routing;
- harness requirements apply to explicit requests, routing, and fallbacks;
- central refresh is validated and atomic, with bounded stale-cache fallback;
- lossy wire translation is rejected rather than silently dropping features;
- AI-credit enforcement rejects unpriceable models when no approved fallback
  exists;
- dynamic selectors use conservative explicit policy tariffs when the concrete
  model is unavailable for accounting;
- public exports sanitize provider data; and
- invalid inputs, unknown fields in new strict formats, merge conflicts, and
  ambiguous identities produce explicit failures rather than success-shaped
  fallbacks, without retroactive rejection of existing open input formats.

The compiler and runtime resolver treat source data as untrusted input for
validation purposes. URLs within model metadata, notes, model IDs, aliases,
and provider payloads do not become executable code, filesystem paths,
request destinations, or credentials. Explicitly configured pricing-source
URLs or local snapshot paths are used only by the dedicated source loader under
explicit source configuration and applicable transport, network, and
file-access policies; feed records cannot redirect that loader.

## Validation and CI requirements

The implementation includes:

1. characterization tests for every existing canonicalizer and precedence path;
2. provider-prefix, separator, date-suffix, query, and case fixtures;
3. exact versus family-pattern collision tests;
4. supported, retired, mapped, priced, and excluded model fixtures;
5. pricing precedence, same-tier component filling, and assembled-tier provenance
   tests, including mismatched token ranges, effective dates, and units;
6. default, threshold, boundary, reviewed-promotion expiry, and successor-tariff
   tests, plus proof that runtime-advertised discounts never reduce
   `maxAiCredits` accounting;
7. exact reasoning-effort positive and negative fixtures;
8. unknown future effort round-trip tests;
9. routing and direct-request validation parity tests;
10. directed protocol-pair feature declarations, translator-version coverage,
    and translator rejection parity tests;
11. deterministic generation-revision and source-derived timestamp tests;
12. source-schema, strict **new** versioned-overlay/feed, legacy unversioned
    overlay and configured `AWF_MODEL_PRICING_CATALOG` `schemaVersion: 1`
    compatibility, and snapshot-metadata tests;
13. freshness and stale-fallback tests;
14. additive `/reflect` model-section version, unchanged existing fields,
    optional section on older pinned AWF, per-value provenance, and
    persisted-export contract tests;
15. recurring drift-check tests for missing models, price tolerance, efforts,
    and limits;
16. gh-aw and gh-aw-router-training export parity tests;
17. malformed, ambiguous, and unknown-field fail-closed tests;
18. after cross-repo handoff agreement, workflow frontmatter-to-AWF-config
    round-trip, duplicate/conflicting entry, overlay precedence,
    pricing-source replacement, provenance, and older-pinned-AWF
    unsupported-config tests;
19. central feed configuration, initial fetch, periodic refresh, atomic update,
    source-partitioned cache, schema rejection, network denial, timeout, offline,
    local-snapshot, expiry, and last-known-good/fail-closed tests, including
    blocked-feed startup with no cache and approved bundled pricing, zero
    network requests in offline/local-only mode, and no default-endpoint
    contact after source replacement;
20. central refresh accounting tests proving request-level tariff/revision
    consistency and no retroactive repricing;
21. harness version boundary, prerelease, missing/unparsable version,
    execution-environment detection, explicit-request rejection, and
    routing/fallback eligibility tests; and
22. `models.dev` pricing for providers without native pricing support, including
    exact provider/model matching, cross-provider collision rejection, unit and
    tariff normalization, higher-priority overrides, missing-price handling,
    provenance, and blocked-network operation.

The #10029 and #10030 cases are named fixtures. They do not disappear into broad
family tests.

## Implementation and rollout

Implementation follows these gates.

### Gate 1: Characterize current behavior

Add the issue 10032 characterization and drift coverage. If the immediate fixes
from issues 10029 and 10030 land first, the tests characterize the corrected
baseline. Otherwise the tests mark those cases as known gaps to close through
the catalogue.

Gate 1 handoff (baseline on this branch; these are observations, not the
target contract):

- `src/copilot-model.test.ts` freezes host exact allowlist validation,
  separator/case equivalence, retired replacement, and rejection of prefixes,
  dates, queries, family variants, and specialized variants.
  `src/copilot-model-catalog-sync.test.ts` inventories supported, curated-priced,
  fallback-priced, mapped, and explicitly excluded families; it fails with both
  mapping-copy paths if the documentation and packaged bytes diverge.
- Proxy characterization lives in
  `containers/api-proxy/model-metadata-characterization.test.js`, alongside
  existing model resolver, mapping, routing, policy, reflection, discovery,
  and AI-credit guard tests. Host validation does not strip provider prefixes
  or date suffixes; the proxy strips a matching provider prefix, runtime
  pricing strips date suffixes and lowercases, operator overlays keep date
  suffixes and match families, and `models.dev` strips dates but preserves
  case. The proxy retirement guard only lowercases, so it blocks
  `GPT-5-CODEX` but not `GPT_5_CODEX`; host validation normalizes separators and
  rejects both. Dated operator-overlay fixtures distinguish the exact dated
  tariff from the base tariff selected for another date. These differences must
  be compared before Gate 2 changes identity.
- Pricing precedence to preserve in Gate 3/5 is operator overlay, configured
  shared pricing catalogue, complete runtime price, incomplete runtime price
  with lower-priority components, curated price, bundled `models.dev`,
  dynamic-selector conservative price, configured default, then built-in
  unknown-model fallback (only for the `unknown` sentinel). Compare selected
  tier, tariff, source, and accounting/reflection fields, not only a model ID.
- Known gaps: #10029 is not fully landed: six proposed models are absent from
  the host allowlist and four from curated pricing (`gemini-3.8-flash` and
  `grok-4.5`/`4.6`/`4.7`). `claude-opus-5.5`, `claude-sonnet-5.5`, and
  `gpt-6.1-sol` already have curated entries. Four entries still appear in the
  stale `SUPPORTED_WITHOUT_CURATED_PRICING` exception set. #10030 is not landed:
  `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6` (including Sol, Terra, and Luna),
  `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, and `gpt-6.1-sol` lack mapping
  routing metadata, as does the `claude-haiku-5` family. The mapping currently
  omits `xhigh` for Claude Opus 5/5.5, Sonnet 5/5.5, and Opus 4.7/4.8. The
  named host and proxy tests inventory these gaps; replace their expectations
  when the fixes land rather than treating absence as the future specification.
- Validation: run `npm run build && npx jest --runInBand
  src/copilot-model.test.ts src/copilot-model-catalog-sync.test.ts` from the
  repository root, and `npm test -- --runInBand
  model-metadata-characterization.test.js` from `containers/api-proxy`.
  These are separate Jest configurations. All reflection fixtures use
  `/reflect`, not a new endpoint.

### Gate 2: Schema and identity

Land the canonical, overlay, and snapshot schemas plus one provider-qualified
identity and specificity implementation. No consumer migrates before collision
and parity fixtures pass.

Resolve and verify the workflow frontmatter and AWF-config handoff schemas with
gh-aw before implementing that feature, including supported version checks and
conflict handling. No concrete field names or cross-repo acceptance are
presumed. Include central feed metadata and harness constraints in the
canonical schema. See the Phase 2 compatibility and handoff below.

#### Phase 2 compatibility matrix

The Phase 1 tests [host validation](../../src/copilot-model.test.ts),
[host catalogue sync](../../src/copilot-model-catalog-sync.test.ts), and
[proxy characterization](../../containers/api-proxy/model-metadata-characterization.test.js)
describe the **legacy baseline**, not a new universal normalization policy.

| Surface | Existing behavior | Target and migration requirement |
| --- | --- | --- |
| Host exact allowlist | Trims/case-folds and treats dot, underscore, hyphen as equivalent for exact/retired names; rejects `copilot/gpt-5.3-codex`, dated IDs, queries, `gpt-5.6-cyber`, `gpt-5.5-pro` and other undeclared suffixes. | Match provider-qualified exact entries and scoped aliases; do not infer availability from family rules. Preserve existing rejections until reviewed migration. |
| Proxy prefix and direct resolver | Strips a matching provider prefix on requests; direct resolver does not necessarily normalize dated runtime IDs. Endpoint mapping matches exact/prefix globs, not price canonicalization. | Retain routing parity; prefix rewriting and date handling require explicit provider match policies, not identity erasure. Endpoint support does not imply selectable reasoning or lossless translation. |
| Runtime observations and credits | Runtime drops dates/prefixes and normalizes separators/case; credit paths handle query suffixes differently. | Preserve raw provider IDs and explicit exact/alias/date scopes; a runtime observation alone does not establish deployment support or configured authority. |
| Proxy retirement | Lowercases `GPT-5-CODEX` but does not normalize `GPT_5_CODEX`, unlike host validation. | Generate host/proxy decisions from scoped retirement aliases only after parity review. |
| Unversioned operator overlay | Exact dated cost wins before base prefix; a base can match specialized suffixes; queries do not match in Phase 1 fixtures. | Keep the open legacy reader; new strict overlays use deterministic exact/alias/family specificity with declared exclusions for specialized variants. |
| Configured shared catalogue | `AWF_MODEL_PRICING_CATALOG` v1 strips prefix/date, normalizes separators/case, uses configured provider aliases, selects long tier only when input tokens **exceed** threshold. Carries `shared_catalog`, ID and version; outranks complete runtime pricing. | Map to `configured_catalog` pricing authority, **not** fetched-feed authority. Preserve existing acceptance, provider aliases, component rates, threshold boundary and accounting. Never apply new strict-format rejection retroactively. |
| Fetched central feed | No corresponding Phase 1 loader exists. | Explicit source/revision, freshness, integrity and offline policy; price and harness only, below complete fresh runtime pricing and the existing configured catalogue. A failed custom source never triggers an unconfigured default. |
| Curated and `models.dev` | Curated precedes bundled import. The legacy `models.dev` resolver strips any provider prefix and indexes the bare normalized slug; the credit guard calls it without a provider, so the same slug at another provider can resolve. | Preserve reviewed facts ahead of governed imports. Provider-qualified imported pricing is a future behavior change and requires parity review; do not imply that legacy lookup preserves provider identity. |
| Specialized family variants | `gpt-5.5-pro` has mapping but no routing metadata; `gpt-5.6-cyber` is not a host-supported model. | Explicit exact exceptions or exclusions; family rules cannot manufacture capabilities, availability or verified pricing. |
| `/reflect` and `models.json` | Phase 1 fixtures freeze current fields and meanings. | Extend **the existing `/reflect`** additively with an optional versioned model-information section. Do not negotiate endpoints or change the legacy snapshot shape in place. |

The shared contract resides in `shared/model-information/schema.v1.json`,
`identity.js`, `contracts.js`, and `fixtures.v1.json`. `identity()` retains
provider and raw ID; `matchModel()` matches exact and scoped aliases, and
`matchFamilyRule()` requires explicit opt-in and declared-exception checks.
`validateRecords()` rejects normalized duplicate keys, ambiguous scoped aliases,
unresolved replacements, conflicting equal-specificity rules, and family
capture of declared exact variants. Providers/families can be reviewed in
separate source files before Gate 3 compiles their JSON projections; no
maintained catalogue is migrated by this gate.

An overlay's provider and channel are exact scope boundaries. An omitted
deployment means all deployments and may contain facts scoped to one deployment;
a deployment-specific overlay may contain only facts with that same deployment,
not broader facts with deployment omitted.

The configured shared catalogue remains an operator-supplied pricing-only
input: `projectConfiguredCatalogResolution()` maps its **existing resolver's**
selected tier into decimal-string canonical prices and per-component
`shared_catalog` provenance with catalogue ID and version kept as separate
fields, without changing its parser. Null cache-write prices project to zero,
matching current accounting. A
downloaded central snapshot has `central_feed` authority regardless of whether
its tariff has the same shape. The v1 catalogue has no review timestamp;
projection reports unknown freshness rather than inventing an observation time.
For pricing the future order is scoped operator
overlay > configured catalogue > complete fresh runtime > fresh fetched feed >
reviewed maintained > governed import > explicit policy fallback. Incomplete
runtime tiers may only be assembled from compatible components and must retain
their individual sources. This ordering is a future resolver handoff, not an
implementation of that resolver in Phase 2.

#### Cross-repository workflow handoff blocker

The opt-in frontmatter-to-AWF-config contract is **not agreed with
github/gh-aw** as of this gate. The companion dependency is tracked by
[Phase 4 #10294](https://github.com/github/gh-aw-firewall/issues/10294) under
[parent #10290](https://github.com/github/gh-aw-firewall/issues/10290);
there is no verified gh-aw companion issue or PR for this exact contract.
Do not publish a one-sided field name or claim this handoff complete. Before
Phase 4 wiring, agree the exact frontmatter and AWF config keys, a versioned
payload and the supported schema-version range on both sides. The payload
must carry provider/channel/deployment-scoped overlays using the `overlay`
record, optional central-feed URL **or** local snapshot and enabled/offline
settings, sanitized workflow provenance (no secrets or arbitrary prompt text),
and the actual selected harness version and comparison scheme.

Both compiler and AWF must validate the same payload; unsupported or newer
schema versions on older pinned AWF fail explicitly without silently dropping
entries. A duplicate same-scope workflow/operator entry fails unless an
explicit override order is negotiated; no implicit last-writer-wins.
Semver comparison must specify prerelease ordering, while numeric-component
comparison must compare integer components (not strings); absent, unknown,
or unparsable selected-harness versions cannot satisfy a minimum. A host
binary's version cannot substitute for the selected execution environment.
Source selection replaces the default rather than falling back to it; offline
and local-only modes make no feed network requests. Existing workflows,
unversioned `apiProxy.providers`, and configured v1 pricing remain inert
and unaffected. Compiler-to-runtime round-trip fixtures and agreed links
are a blocking follow-up, not fabricated Phase 2 test coverage.

Phase 2 validation: `npm run build`, `npm run type-check`,
`npx jest --runInBand src/model-information-contract.test.ts
src/copilot-model.test.ts src/copilot-model-catalog-sync.test.ts`; separately,
`cd containers/api-proxy && npm test -- --runInBand
model-information-contract.test.js model-metadata-characterization.test.js
guards/ai-credits-guard.test.js`. Phase 3 consumes schemas and identity for
deterministic compilation; Phases 4–6 integrate consumers and compare legacy
decisions; Phase 7 adds resolved data through `/reflect` only.

### Gate 3: Compiler and maintained records

Add deterministic compilation, migrate maintained facts, and represent the
current pricing and reasoning gaps as canonical records. Generate existing
legacy formats without requiring consumers to change. Before the compiler
generates `docs/model-api-mapping.json`, retarget the daily endpoint-mapping
updater to update source records and all generated outputs in one change, or
pause it until that replacement is ready. It must not keep opening PRs that edit
generated output without its source.

### Gate 4: Lifecycle consumers

Migrate host validation and proxy retirement handling to generated projections.
Host and proxy can no longer disagree about support or retirement.

Only after the cross-repo handoff is verified, wire workflow-defined entries
through the gh-aw compiler and AWF config reader as run-scoped overlays. Enforce
harness requirements against the actual execution environment for explicit
models and routing/fallback candidates.

### Gate 5: Pricing resolver

Migrate static pricing, then operator and runtime pricing, preserving current
credit calculations. Add provider/channel scope, tier selection, effective
dates, exact arithmetic, field provenance, and freshness.

Add configurable central pricing refresh, validated atomic snapshots,
source-partitioned caching, user-replaceable URL or local-snapshot sources,
blocked-by-default feed assumptions, bounded offline/stale fallbacks, and
request-level tariff revision tracking. Keep the existing configured
`AWF_MODEL_PRICING_CATALOG` v1 above runtime prices; rank fetched central prices
below complete, fresh runtime prices. Central updates include harness
constraints and trigger eligibility re-evaluation before subsequent dispatch.

Wire governed `models.dev` imports into provider-qualified pricing fallback for
inference providers without native AWF pricing support, including custom
providers, without requiring runtime access to the upstream catalogue.

### Gate 6: Reasoning and compatibility

Unify routing, validation, and reflection on resolved reasoning data. Add the
feature compatibility model and connect translator rejection to declared
requirements for each directed protocol pair and translator revision.

### Gate 7: Exports

Extend `/reflect` additively, add versioned persisted snapshots, CLI
inspection, and package exports while retaining existing reflection fields.
Publish the new model section's schema version, per-value provenance and
freshness contract; older pinned AWF versions simply omit the section.
Export workflow-overlay provenance only after the cross-repo handoff is agreed,
along with central feed state and resolved harness constraints. This gate
enables gh-aw and gh-aw-router-training to adopt generated pricing and effort
data after parity tests pass.

### Gate 8: Unified updater

Complete the source-aware updater and govern imported snapshots. One pull
request updates sources and every generated output. The endpoint-only updater
must already have been retargeted or paused at Gate 3.

Publish reviewed versioned central snapshots through the same source-aware
pipeline used for bundled projections.

### Gate 9: Legacy removal

Remove repeated canonicalizers, mirrored retirement maps, handwritten pricing
ownership, duplicate mapping ownership, exception-list sync tests, and direct
consumer access to raw runtime records only after parity and compatibility
windows are complete.

High-risk migrations support temporary shadow comparison:

- old and new paths resolve the same request;
- the old path remains authoritative;
- structured differences are logged without changing the result;
- mismatches become fixtures or explicit approved behavior changes; and
- the flag is removed after parity and a stable release.

## Consequences

### Positive

- Model additions, retirement, pricing, reasoning, and compatibility become one
  reviewed source change with generated projections.
- Provider identity and channel scope prevent accidental cross-provider facts.
- Pricing can represent long-context tiers, promotions, expiry, and provenance.
- Routing and request validation use the same reasoning capability.
- Exact variants can safely refine family defaults.
- Runtime and static data merge explainably at field level.
- Third-party imports become reproducible and governed.
- Reflection, logs, CLI output, and package APIs share schema versions and
  catalogue revisions.
- Existing fail-closed behavior is preserved.

### Negative

- The compiler, schemas, resolver, generated projections, and updater add
  implementation complexity.
- Source records require disciplined provenance and review.
- Runtime merging and freshness policies require more tests than independent
  lookup tables.
- Checked-in generated files remain temporarily necessary for packaging and
  compatibility.
- The migration spans multiple pull requests and requires a period of dual-path
  testing.

### Operational

- Model updates become more visible: expired promotions, stale prices, and
  compatibility contractions can block or warn rather than remaining implicit.
- Contributors use generation commands instead of editing consumer files.
- Release and container builds must include the generated catalogue revision.
- Diagnostics can explain why a model is unavailable, unpriceable, unroutable,
  stale, estimated, or incompatible.

## Alternatives considered

### Continue independent tables with more sync tests

Rejected. Pairwise tests detect only declared relationships and require growing
exception lists. They do not create shared identity, provenance, tiered
pricing, freshness, or compatibility semantics.

### Treat the provider `/models` response as the only source

Rejected. Provider responses can be unavailable, incomplete, channel-specific,
versioned, or omit compatibility and lifecycle facts. AWF needs reviewed
fallbacks and deterministic offline validation.

### Treat `models.dev` as the canonical source

Rejected. It is useful as a governed lower-confidence import, but it cannot
authoritatively define Copilot CLI availability, AWF retirement policy,
provider-specific runtime behavior, or feature-preserving compatibility.

### Keep provider-agnostic model keys

Rejected. The same slug can have different pricing, availability, or behavior
across Copilot, native providers, BYOK targets, and operator deployments.

### Store all resolved data in one mutable runtime object

Rejected. Static reviewed facts, operator configuration, imports, and runtime
observations have different trust, freshness, and reproducibility properties.
They remain separate inputs merged into an explainable resolved view.

### Extend the existing mapping JSON to contain everything

Rejected. The mapping is family- and endpoint-oriented, duplicated for
packaging, and lacks identity, lifecycle, tariff, overlay, freshness, and
field-provenance semantics. It becomes a generated compatibility projection.

## Non-goals

This ADR does not:

- choose models for users outside the existing routing and fallback policies;
- standardize provider marketing names or effort semantics beyond explicit
  mappings;
- infer compatibility from model names;
- permit lossy protocol translation;
- expose raw provider payloads;
- make third-party data authoritative for first-party availability;
- require every model to have complete information before it can be listed;
- remove operator control over deployment-specific aliases and prices; or
- require a flag-day migration of current consumers.

## Decision review triggers

Review this ADR if:

- a provider introduces pricing that cannot be represented as bounded tariffs;
- model identity requires dimensions beyond provider and provider model ID;
- runtime provider data becomes cryptographically versioned and complete enough
  to replace maintained facts;
- compatibility requires active probing rather than documented or advertised
  capabilities;
- catalogue size makes checked-in projections impractical; or
- a public export must expose data that conflicts with the sanitization and
  provenance rules above.
