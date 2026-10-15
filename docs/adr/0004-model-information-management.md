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
subsystem. Maintained records, imported snapshots, operator overlays, and
runtime observations will use schema-validated inputs and compile or resolve
into one normalized record model.

Existing consumers will migrate to generated projections or a shared resolver.
No consumer may become a new independent source of model facts.

The subsystem has these architectural parts:

1. a versioned canonical schema;
2. one provider-qualified identity and matching implementation;
3. reviewed maintained source records;
4. governed imported snapshots;
5. validated operator overlays;
6. normalized runtime observations;
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

Promotional pricing is time-bounded data. It MUST include an expiry or effective
end and, where known, the successor tariff. A source-code reminder is not an
acceptable expiry mechanism.

Long-context pricing is a first-class tariff selected by the same normalized
input-token semantics used for runtime provider pricing. Threshold boundaries
and tariff selection are covered by tests.

Dynamic selectors such as Copilot `auto`, unknown response models, and
conservative ceilings are policy tariffs, not ordinary model prices.

## Data layers and precedence

The subsystem uses four input layers.

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

### Operator overlays

Operator configuration can define deployment-specific:

- model IDs and aliases;
- prices;
- compatibility restrictions;
- availability;
- target protocol; and
- source labels.

Overlays are validated against a versioned overlay schema at startup. Unknown
fields and invalid prices fail before requests are accepted. Operator overlays
have highest configured authority within their declared provider, channel, and
deployment scope.

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

## Field-level resolution

Precedence is resolved per field, not by replacing an entire record:

1. operator overlay within its declared scope;
2. complete, fresh runtime provider observation;
3. reviewed maintained record;
4. governed imported snapshot;
5. explicit policy fallback.

Availability may have a different safe fallback rule from pricing or
compatibility. The resolver therefore applies a policy per field group.

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
- manifests containing schema version, catalogue revision, and generation time.

The host and API proxy may consume different projections, but both derive from
the same source records and identity rules.

Because the API proxy is CommonJS JavaScript and the host is TypeScript, JSON is
the interoperability format. Consumers do not reimplement canonicalization.

CI validates source schemas, compiles projections, and fails when checked-in
generated files differ from compiler output.

## Runtime and offline exports

### Existing contracts

Current `/reflect`, `models.json`, logs, and validation messages remain
compatible during migration. They are gradually generated from resolved records
without changing field meaning.

### `/reflect/v2`

AWF will add a versioned reflection contract containing:

- schema version;
- static catalogue revision;
- generation time;
- runtime observation time;
- provider-qualified resolved model records;
- source and freshness summaries;
- routing-selectability reasons;
- warnings for stale, estimated, incomplete, or conflicting information; and
- sanitized runtime provenance.

The default representation is compact. A detail mode may expose field-level
provenance when payload size requires separation.

Raw provider payloads, credentials, private headers, and unreviewed arbitrary
fields are never reflected.

### Persisted snapshots

AWF will version `models.json` or add a sibling `model-catalog.json`. Persisted
snapshots include schema and catalogue revisions so tooling can distinguish
static data from run-specific observations.

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

The report identifies:

- added and removed models;
- lifecycle and replacement changes;
- channel availability changes;
- price and tariff changes;
- threshold and effective-date changes;
- promotion expiry;
- effort-set and context-limit changes;
- protocol and feature compatibility changes;
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
- maintained compatibility is reviewed when provider documentation changes;
- imported fallback prices have an explicit snapshot age; and
- operator overlays remain valid until configuration changes or an optional
  expiry is reached.

Stale information is not silently current. Reflection and logs expose stale
state. Budget enforcement, routing, and validation each define whether stale
data can be used and fail closed when their policy requires fresh data.

## Security and reliability requirements

The redesign preserves these existing safeguards:

- operator overlays outrank bundled defaults only within validated scope;
- live provider availability outranks maintained assumptions;
- routing fails closed when authoritative discovery is required and unavailable;
- custom or non-native provider targets do not inherit native-provider claims;
- model policy and picker exclusions apply before routing;
- lossy wire translation is rejected rather than silently dropping features;
- AI-credit enforcement rejects unpriceable models when no approved fallback
  exists;
- dynamic selectors use conservative explicit policy tariffs when the concrete
  model is unavailable for accounting;
- public exports sanitize provider data; and
- invalid inputs, unknown fields, merge conflicts, and ambiguous identities
  produce explicit failures rather than success-shaped fallbacks.

The compiler and runtime resolver treat source data as untrusted input for
validation purposes. URLs, notes, model IDs, aliases, and provider payloads do
not become executable code, filesystem paths, request destinations, or
credentials.

## Validation and CI requirements

The implementation includes:

1. characterization tests for every existing canonicalizer and precedence path;
2. provider-prefix, separator, date-suffix, query, and case fixtures;
3. exact versus family-pattern collision tests;
4. supported, retired, mapped, priced, and excluded model fixtures;
5. complete pricing precedence and mixed-component provenance tests;
6. default, threshold, boundary, promotion-expiry, and successor-tariff tests;
7. exact reasoning-effort positive and negative fixtures;
8. unknown future effort round-trip tests;
9. routing and direct-request validation parity tests;
10. compatibility declaration and translator rejection parity tests;
11. deterministic generation and stale-output tests;
12. source-schema, overlay-schema, and snapshot-metadata tests;
13. freshness and stale-fallback tests;
14. `/reflect/v2` and persisted-export contract tests; and
15. malformed, ambiguous, and unknown-field fail-closed tests.

The #10029 and #10030 cases are named fixtures. They do not disappear into broad
family tests.

## Implementation and rollout

Implementation follows these gates.

### Gate 1: Characterize current behavior

Add the issue 10032 characterization and drift coverage. If the immediate fixes
from issues 10029 and 10030 land first, the tests characterize the corrected
baseline. Otherwise the tests mark those cases as known gaps to close through
the catalogue.

### Gate 2: Schema and identity

Land the canonical, overlay, and snapshot schemas plus one provider-qualified
identity and specificity implementation. No consumer migrates before collision
and parity fixtures pass.

### Gate 3: Compiler and maintained records

Add deterministic compilation, migrate maintained facts, and represent the
current pricing and reasoning gaps as canonical records. Generate existing
legacy formats without requiring consumers to change.

### Gate 4: Lifecycle consumers

Migrate host validation and proxy retirement handling to generated projections.
Host and proxy can no longer disagree about support or retirement.

### Gate 5: Pricing resolver

Migrate static pricing, then operator and runtime pricing, preserving current
credit calculations. Add provider/channel scope, tier selection, effective
dates, exact arithmetic, field provenance, and freshness.

### Gate 6: Reasoning and compatibility

Unify routing, validation, and reflection on resolved reasoning data. Add the
feature compatibility model and connect translator rejection to declared
requirements.

### Gate 7: Exports

Add `/reflect/v2`, versioned persisted snapshots, CLI inspection, and package
exports while retaining legacy contracts.

### Gate 8: Unified updater

Replace the endpoint-only updater and govern imported snapshots. One pull
request updates sources and every generated output.

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
