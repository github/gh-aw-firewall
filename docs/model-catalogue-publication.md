# Model catalogue publication

The source-aware updater still captures evidence, proposes canonical source
edits, validates the actual proposed Git bundle, and opens one review PR.
Maintainers still approve changes by merging to `main`. No publication command,
manual dispatch, data tag, package version bump, or container release is needed
after that merge.

## Bundled naming versus remotely refreshed pricing

Reviewed canonical source records own model identities, scoped identity aliases,
and family exceptions. `npm run models:generate` projects those naming facts into
bundled host/proxy assets; `npm run models:check` rejects drift. Request resolution
uses the canonical matching implementation with an explicit scope and matching
policy. Discovery still supplies executable models and their upstream wire IDs:
neither a bundled identity nor a published tariff establishes availability.

Identity aliases are not operator routing aliases. Existing recursive/glob
`apiProxy.models` expressions, loop detection, parameter suffixes, direct-ID
precedence, and configured fallback remain separate. Request matching retains
case-insensitive IDs and redundant-current-provider prefixes; separator folding
and date stripping are not globally enabled. Host CLI separator equivalence is
an explicit compatibility policy, not a proxy-wide normalization rule.

The named compatibility corrections are rejection of ambiguous case-insensitive
routing aliases, exclusion of retired alias/fallback targets, and protection of
specialized variants from implicit GPT minor-version family capture. A request
for a specialized ID no longer falls through the implicit `gpt-5` routing alias,
and bare GPT version fallback no longer picks a specialized variant. Explicit
operator glob expressions and configured automatic fallback remain opt-in paths;
family rules annotate identity without authorizing substitutions.

The [reviewed accounting-family ledger](model-families.md) lists explicit
memberships, evidence, specialized/revision boundaries and residual unknowns.
It also records the bundled family-versus-backend estimate charge change;
membership is not execution or capability authorization.

Publication v1 and v2 identities contain only `key`, `provider`, `rawId`, and `lookupId`.
Their strict schemas do not transport alias/family rules. An authenticated,
request-pinned pricing refresh can associate scoped tariffs with the resolved
provider-qualified identity, but cannot rename requests, switch providers, add
executable models, or update bundled naming. Existing pricing authority,
field-level precedence, freshness, provenance, and accounting remain unchanged.
Old v1 snapshots remain valid; remote naming would require a separately reviewed,
versioned contract.

This is not completion of the eligibility/compiler migration. Workflow overlays,
execution-environment detection, and the remaining Phase 4 and broader
pricing/eligibility work remain under #10294 and #10290 (including the companion
compiler integration in github/gh-aw#70728).

## Active canonical fallback pricing

The shared pricing resolver now receives maintained fallback rates from
`model-information.pricing.generated.json`, not `ai-credits-pricing.js`.
`scripts/model-information/compile.cjs` derives that projection from the active
`shared/model-information/sources/copilot-*.json` records. It also generates
`model-information.fallback-pricing.generated.json` from the governed import and
the explicit native compatibility associations in `sources/pricing-reference.json`.
The existing `catalogue-pricing.js` adapter consumes both assets in Docker and npm
distributions. There is no new runtime loader or independently authored price
table. Historical adapters remain for unrelated consumers.

The authority order remains operator override, configured catalogue v1, complete
fresh provider observation, applicable fresh central snapshot, maintained
fallback, governed scoped import, then explicit selector/default/sentinel policy.
Partial-provider component merging, central BYOK/channel/deployment exclusions,
strict context thresholds, request/connection captures and revision pinning are
unchanged. Remote refresh cannot change bundled names, source associations,
availability or the executing backend.

The maintained projection retains **all 42 Copilot rates and both long-context
tiers unchanged**. Native API compatibility preserves nine OpenAI and seven
Anthropic model associations: the original 12-model reference plus the four
explicit historical guard fixtures (`gpt-5-mini`, `gpt-5.4`,
`claude-sonnet-4-6`, `claude-opus-4-7`). These are labeled
`legacy_native_compatibility`, `authority: policy`, `confidence: policy_fallback`,
not independently verified current native tariffs. The original source
provenance is retained; test dates do not refresh billing evidence. Source labels
`curated` and `models.dev` remain compatible, with catalogue revisions attached;
native compatibility usage also records the policy as its catalogue ID.

The pinned raw import has 455 rows, of which 429 are accepted and 26 rejected by
the governed importer. They apply only to pricing-provider identity `openrouter`
with full native wire IDs such as `anthropic/claude-sonnet-5.5`.
`anthropic` is the publisher namespace here, **not** the serving backend.
An OpenRouter price cannot price a native Anthropic/OpenAI call, a Copilot call,
an arbitrary compatible/custom backend or an omitted provider. A pricing-provider
identity does not require a runtime adapter or establish execution support.

Within an applicable namespace, raw exact IDs win before the import's historical
separator/date normalization. Namespaces themselves match exactly; ambiguous
normalized matches produce the existing sanitized resolution error. This
normalization is local to pricing, not a global naming/routing policy. Unreviewed
`canonical_slug` aliases are not imported as identities: 39 distinct aliases
associated with accepted rows no longer resolve in this pinned snapshot after
the retained normalization. For example, `openai/gpt-4-turbo:batch` remains priced,
but its `canonical_slug` cannot assign that batch price to `openai/gpt-4-turbo`.

### Explicit charge and coverage changes

For the 429 exact qualified OpenRouter IDs, 426 default four-component rate
vectors are unchanged. The following three change; two additional models stop
inheriting another backend's long-context tiers. Prices below are USD per million
tokens, and one AI credit remains USD 0.01.

| OpenRouter wire ID | Previous fallback | Active scoped import |
| --- | --- | --- |
| `openai/gpt-4o-2024-05-13` | Bare/date-folded collision: input 2.5, cached input 1.25, output 10 | Exact dated ID: input 5, cached input 0.5, output 15. One million fresh input plus one million output changes from 1,250 to 2,000 credits. |
| `google/gemini-2.5-pro` | Curated cache write unavailable: zero cache-write charge | Imported cache write 0.375: 37.5 credits per million cache-write tokens. |
| `google/gemini-3.5-flash` | Curated cache write unavailable: zero cache-write charge | Imported cache write 0.0833333333333333: 8.333333 credits per million cache-write tokens after existing response rounding. |
| `anthropic/claude-haiku-5.5`, above 100,000 prompt tokens | Copilot long tier: input 0.5, cached input 0.05, cache write 0.625, output 2.5 | Imported flat rates: 0.1, 0.01, 0.125, 0.5 respectively. At 100,001 fresh input tokens: 5.00005 to 1.00001 credits. |
| `openai/gpt-6.1-sol`, above 272,000 prompt tokens | Copilot long tier: input 4, cached input 0.2, cache write 5, output 15 | Imported flat rates: 2, 0.1, 2.5, 10 respectively. At 272,001 fresh input tokens: 108.8004 to 54.4002 credits. |

These are intentional source-scope corrections, not new verified native tariffs.
Copilot's tiers and the explicit native compatibility policy retain their rates
and exact boundaries. No `target.json` tariff, promotion or successor is activated.
Future OpenRouter tier support requires governed upstream evidence, not borrowing
the Copilot tier. Missing imported cache-read prices retain the explicit legacy
10%-of-input policy; missing cache-write prices remain null. Explicit zero prices
remain zero. Missing/null required input or output prices are rejected, not free.
Out-of-bound imported decimals fail explicitly rather than underflowing to free.

Native/custom requests outside the explicit associations, and requests that
previously borrowed another backend's same-slug price, may now be unpriced.
Concrete requests without exact/default pricing now warn and use the exact
per-component median of applicable same-backend declared-family tariffs, or
the backend-wide median when no family donors exist. These accounting estimates
contribute to credits and budgets; only a backend with no eligible donors remains
unpriced/excluded, with an explicit undercount warning. See
[missing model pricing](awf-config-spec.md#1033-missing-model-pricing-warnings)
for donor, optional-component and provenance semantics. Use an explicit
operator/configured tariff or configured default for verified rates. Price coverage is
not execution admission. Existing recovery, opt-outs, dynamic-selector ceilings,
unknown-sentinel fallback, budget guards and accounting-error dispatch blocking
remain active.

The provider-free `scripts/ci/smoke-pricing-resolution.cjs` runs from the off-tree
Docker application layout and extracted npm package, both with shipped data and
with changed maintained rates and additional test imports passed through the
real canonical compiler. The changed rates must change HTTP/WebSocket charges
without editing the historical table. It
checks actual HTTP/WebSocket charges and budgets, overriding sources, native and
custom/OpenRouter scope, same-slug namespaces, exact/date precedence, ambiguity,
strict tier boundaries, missing/null/zero prices, explicit charge deltas and
refresh pins. Every run prohibits network access and requires zero network calls.
This does not run live inference, a workflow, a container or a VM.

Generalized assembled tariffs, promotions/successors,
non-token charges, broader export/reasoning migrations and harness/compiler/VM
changes remain outside this slice. This is not completion of #10295 or #10290.

## Reviewed native reasoning and context activation

This bounded #11330 review starts from the merged #11328 implementation
(`5785815`), after verifying its live merged state on November 8, 2026.
Canonical authoring remains in `shared/model-information/sources/mapping.json`;
only the four delivered mini/Opus-4 target rows are removed from
`sources/target.json`. Its unrelated source provenance, pricing, availability,
effort, lifecycle, harness and translation proposals remain staged. Generated
mapping/catalogue copies are produced by `npm run models:generate`.

### Refreshed evidence and scope

The original provider pages were read through the browser, not inferred from
Copilot observations, an SDK-wide enum, accounting families or OpenRouter.
Direct fetches initially failed DNS; browser reads returned HTTP 200. Capture
crossed midnight: OpenAI was captured at **2026-11-09T00:09:52Z**, Anthropic at
**2026-11-09T00:10:26Z**. These are capture times, not release dates.
Per-entry `routingEvidence` records original sources, exact IDs and native-API
scope. The mapping revision changes for substantive facts, not a timestamp-only
refresh. Unchanged entries are not recertified by its aggregate `lastUpdated`.

- [GPT-5.4 mini's original model page](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
  independently lists `none (default), low, medium, high and xhigh`, a
  **400,000**-token context window, and snapshot `gpt-5.4-mini-2026-03-17`.
  These apply to native OpenAI serving, not Copilot, Codex harness settings,
  imported publisher namespaces or custom deployments.
- [Anthropic's original effort guide](https://platform.claude.com/docs/en/build-with-claude/effort)
  explicitly lists Opus 4.7/4.8 for `xhigh`, but not Opus 4.6, and warns
  "Not every model that supports max supports xhigh." It states that the API
  default is `high` for these models and is equivalent to omission.
  The `xhigh` coding recommendation is **not** a default.
- [Anthropic's original context guide](https://platform.claude.com/docs/en/build-with-claude/context-windows)
  names Opus 4.6/4.7/4.8 with a **1M**-token default context and no required
  long-context beta header. The exact existing native IDs are corroborated by
  [Anthropic's pinned model implementation](https://github.com/anthropics/ClaudeForFoundationModels/blob/0262e1a766c461a4268dcec656eca95dd74cebf8/Sources/ClaudeForFoundationModels/ClaudeModel.swift).
  Top-level `output_config.effort` is the reviewed surface, not per-message beta
  effort, Bedrock, Managed Agents or Copilot.

Windows describe total native model context, **not guaranteed remaining input**.
Output/thinking tokens, accumulated history and request-size limits can reduce
usable input. No token counting, live-fit guarantee, new availability or output
limit is inferred. Provider runtime context observations retain precedence.

### Before/after behavior ledger

| Exact native IDs | Before | After | Intentional selection change |
| --- | --- | --- | --- |
| `openai/gpt-5.4-mini`, `openai/gpt-5.4-mini-2026-03-17` | No effort/context metadata | `none, low, medium, high, xhigh`; 400,000 context; optional effort, default `none` | Five explicit Responses choices become selectable when discovery, policy and eligibility permit. Invalid `minimal`, `max` and future efforts now fail direct validation. |
| `anthropic/claude-opus-4-6` | `low, medium, high, max`; 1M context; unknown mode/default | Same effort list/context, separate exact entry; optional effort, default `high` | No new explicit choice; `xhigh` remains rejected. |
| `anthropic/claude-opus-4-7`, `anthropic/claude-opus-4-8` | `low, medium, high, max`; 1M context; unknown mode/default | Add `xhigh`; optional effort, default `high` | Each gains one automatic `xhigh` choice. Direct `xhigh` was already admitted by the preserved exact exception; automatic fallback is now admitted by shared evidence. |
| `openai/gpt-5.4`, `openai/gpt-5.4-2026-03-05` | Five efforts; 1,050,000 context; unknown mode/default | Unchanged; original page rechecked | No delivered correction is repeated or inherited by mini/nano. |

Optionality now admits omitted effort in the shared assessment for the reviewed
models. The router still enumerates explicit efforts, and **no default is inserted
into a request**. Defaults are descriptive resolver metadata, not effort
substitution. The existing resolver consumes the new maintained mode/default
fields through the mapping adapter; no second capability evaluator is added.
The compiler rejects malformed effort values, forbidden mode with supported
efforts, required mode without supported efforts, and defaults outside the
supported list before writing generated projections. Future non-empty effort
names remain representable, but are not automatically selectable until understood.
Absent/unknown direct support remains passthrough and automatic explicit effort
still requires known, understood support. Higher-authority provider observations,
request/selection pins, pricing, retirement, policy, harness admission, fallback
ordering and opt-outs remain authoritative.

One tightly coupled consumer correction gates maintained routing context by the
same native channel/deployment boundary as maintained reasoning. Previously,
normalizing native GPT-5.4 in a custom scope incorrectly supplied its native
1,050,000-token context even though reasoning was absent. Custom scopes now
retain their own runtime limits or unknown context, not native fallback facts.
This prevents the same leak for the newly activated mini data.

### #10030 reconciliation and remaining work

Delivered here: separately verified GPT-5.4 mini and its recorded snapshot,
Opus 4.6's negative `xhigh` exception, Opus 4.7/4.8's `xhigh`, and the reviewed
models' optionality/default metadata. No new separator/date alias normalization
is introduced: unlisted dated revisions and dotted native Opus spellings remain
unknown. Pro/cyber/research/preview/nano/fast variants gain no routing support.
The native `gpt-5.6` alias is not added to global naming.

Original pages were also refreshed for the remaining proposed OpenAI IDs:
[`gpt-5.5`](https://developers.openai.com/api/docs/models/gpt-5.5),
[`gpt-5.6`](https://developers.openai.com/api/docs/models/gpt-5.6),
[`gpt-5.6-sol`](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[`gpt-5.6-terra`](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
[`gpt-5.6-luna`](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra),
[`gpt-6-sol`](https://developers.openai.com/api/docs/models/gpt-6-sol),
[`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna), and
[`gpt-6.1-sol`](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
Their targets remain **inactive**, not automatically approved by this review.
Notably, GPT-6 Sol/Luna restrict Chat Completions function calling to effort
`none`; GPT-6.1 Sol's marketed native 1,050,000 context is distinct from its
documented 500K default in Codex/ChatGPT Work. These conditions must not be lost
in a broader activation.

Anthropic's refreshed effort/context guides and
[model overview](https://platform.claude.com/docs/en/models/overview) corroborate
Opus 5/5.5, Sonnet 5/5.5 and Haiku 5.5 effort claims, but those changes remain
staged. The effort guide documents model-specific `thinking` restrictions:
for example, Haiku 5.5 rejects disabled thinking at `xhigh`/`max`, and Sonnet 5.5
rejects `between_tools` at those levels. Protocol translation compatibility
cannot establish those native conditions or faithful translation. Fable/Mythos,
per-message beta effort and unrelated Sonnet 4.6 targets also remain untouched.

Evidence gaps remain for specialized/future variants not individually reviewed,
Copilot serving of identical slugs, imported/custom backend capabilities,
unlisted snapshots and their conditional/effective limits. They remain unknown,
not unsupported. This does **not** close #10030, #10296 or #10290, prove full
translator parity, downstream adoption or measured live-agent improvement.
No live inference or workflow dispatch is part of this deterministic slice.

Provider-free combined checks exercise shared reasoning, direct validation,
router choices, actual fallback dispatch and `/reflect`, including the Docker
COPY layout and extracted npm package. Mapping copies must match, compiler
checks must pass, invalid/unknown efforts and negative variants stay covered,
and refresh cannot rewrite in-flight reasoning or selection.

## Exact-decimal accounting

Active accounting uses `shared/model-information/exact-pricing.js`, shipped by
the existing compiler into both contract distributions. Decimal source strings
remain exact in maintained projections, governed imports, central tariffs and
operator/configured/default prices. Provider AIU/nano-AIU and batch-size
conversions, and the explicit missing-cache 10% policy, use exact rational
arithmetic. Rational denominators also preserve provider batches such as three
tokens without truncating a repeating decimal. No price evidence, source scope,
authority order or staged tariff is changed.

The shared resolver carries private exact rates alongside compatible numeric
rate views. Tier selection and partial-provider component merging preserve those
rates. HTTP and WebSocket token tracking feed the same exact token multiplication,
reasoning/cache split, component summation, per-model buckets and process total.
Request/connection runtime captures explicitly copy private rates; refreshes
cannot reprice an in-flight response. Additive Anthropic/precise Copilot input and
total-inclusive OpenAI-style input retain their existing cache semantics.
Missing prices still warn and exclude usage, not fabricate free coverage or
change execution admission. Null cache-write prices remain unavailable; explicit
zero remains supplied zero.

Only output projections round: response credits, `/reflect` totals and per-model
components, usage/budget logs and JSONL, telemetry and `AWF_AI_CREDITS_USED` keep
their existing numeric/string types and six decimal places. Exact nonnegative
ties round upward: exactly `0.0000005` credits displays as `0.000001`; an
arbitrarily close supported decimal below it displays as zero. `/reflect`
percent-used keeps its ceiling clamp and two decimal places. No BigInt or
internal rational is serialized. Numeric rate/limit views remain binary Numbers
and may display a rounded boundary (or zero for a sub-Number-range value); they
are never read back into accounting. Logs/env remain output snapshots, not an
exact ledger for restarting a process.

Budget, the fixed 10,000-credit hard cap, and 80/90/95/99% steering compare the
**unrounded accumulated charge** against exact thresholds; equality exhausts the
budget. Previously, a total of `0.9999996` could display as one and prematurely
exhaust a one-credit budget. It now remains below budget. At exactly one credit
the guard blocks, regardless of accumulation order. One thousand one-token
responses at USD `0.0001` per million tokens each display zero but together
consume exactly `0.00001` credits, as does a single thousand-token response.
Sub-output-unit charges are never discarded before addition.

Precision and failure boundaries are explicit:

- Legacy/config/provider **Number** inputs preserve only `String(value)`, not
  their original JSON spelling or precision already lost by upstream parsing.
  Existing host numeric config schemas are unchanged. Decimal strings at the
  supported proxy pricing boundaries preserve their supplied precision.
- Parsing accepts nonnegative decimal/scientific strings with at most 400
  mantissa digits, 420 total characters and an absolute decimal exponent after
  accounting for fractional places of at most 400. Exponent text has at most
  three digits. Surrounding whitespace, a leading plus and omitted integer or
  fractional digits around a decimal point retain decimal compatibility. Hex,
  negative/nonfinite values, malformed values
  and larger representations are not approximated. Positive tiny supported
  rates remain chargeable even when their numeric view underflows.
- Rational numerator/denominator intermediates are bounded to 4,096 decimal
  digits; usage counts must be nonnegative safe integers. Unrepresentable
  numeric outputs or exhausted arithmetic bounds fail explicitly. Invalid
  supplied operator rates now error instead of silently falling through to a
  lower-priority source. Existing absent/nonpositive/invalid-limit opt-outs and
  the hard cap remain; syntactically decimal but out-of-bound limits error.
- Selected-tariff/arithmetic failures use sanitized `pricing_resolution_error`
  logging and responses and latch subsequent HTTP/WebSocket dispatch blocking.
  No approximate, legacy or free-price fallback is used after such a failure.
  Malformed provider observations remain explicit invalid facts across discovery
  and refresh, rather than being swallowed as fetch failures or replaced by an
  older tariff. Existing valid in-flight captures remain pinned.

Provider-free tests exercise long decimal maintained/imported compiler fixtures,
central and runtime pins, overrides, fractional batch conversions, exact
below/equal/above budgets/hard caps/steering, rounding ties, cache/reasoning splits,
many tiny HTTP/WebSocket responses and explicit failures. The same smoke script
runs against off-tree Docker application files and the extracted npm package,
with zero network calls enforced. This is an authoritative arithmetic change,
not a shadow/waiting phase, and does not complete #10295 or #10290.

## Automatic publication

`.github/workflows/publish-model-catalogue.yml` is an ordinary deterministic
Actions workflow triggered by pushes to `main` that touch model sources,
compiler/contract/publisher code, generated projections, or their dependency
manifests. The workflow itself is an input, so merging its initial installation
automatically bootstraps the `catalogue-data` branch if absent. There is no
external branch-provisioning or environment-approval prerequisite. Repository
rules must permit the workflow's normal `GITHUB_TOKEN` pushes to that branch;
the publisher does not bypass branch protection.

The read-only build job checks out the exact event SHA, installs locked
dependencies without lifecycle scripts, and runs the offline compiler in
`--check` mode. This regenerates expected canonical inputs and all projections
in memory, including the governed raw-snapshot import, and rejects any stale
committed bytes. It does not fetch model facts or scrape documentation. It then
builds and validates both publication-only projections and uploads one artifact
containing independently digested v1 and v2 snapshots.

Publication also requires automated runtime-consumer checks in that read-only
job. The exact commands are:

```sh
npm test -- --runInBand scripts/model-information/publication.test.ts
npm test --prefix containers/api-proxy -- --runInBand catalogue-loader.test.js catalogue-proxy.test.js guards/ai-credits-guard.test.js runtime-model-catalog.test.js token-budget-log.test.js upstream-token.test.js upstream-http.test.js
```

These replace the former
`MODEL_CATALOGUE_PHASE5_LOADER_AUTH_TESTS_PASSED` repository-variable condition;
the variable is no longer consulted. The producer test publishes to a disposable
Git remote and passes that branch through the actual loader, source verification,
resolver and request accounting. The proxy tests cover hostile integrity-valid
payloads, envelope tampering, rollback, offline/failure behavior, request pinning,
and the Docker application's packaged files. A failed check prevents artifact
upload and the dependent write job. No manual flag change or dispatch is needed
to bootstrap the branch after this integration merges. Existing repository rules
still apply; this does not bypass a protected environment or branch policy.

Only the dependent write job has `contents: write`. It checks out the same
trusted source SHA, downloads that run's artifact, and verifies each snapshot's byte digest
against the build job's output and its source against the event SHA. It installs
no dependencies, runs no package hooks and executes no data-branch code. Its
only push destination is `refs/heads/catalogue-data`, using the repository's
existing token; GitHub's contents permission is repository-wide, not a
branch-scoped token. The source checks and fixed ref constrain this workflow's
write path.

On the data branch:

| Path | Contract |
| --- | --- |
| `snapshots/v1/<revision>.json` | Immutable original pricing/harness projection. |
| `channels/v1/current.json` | Original v1 pointer, retained for old consumers. |
| `snapshots/v2/<revision>.json` | Immutable pricing/harness/protocol projection. |
| `channels/v2/current.json` | Default v2 pointer with schema version, revision, accepted source commit, snapshot path and full snapshot SHA-256. |

One Git commit contains both channels' complete new snapshots and pointers before a
normal push makes either visible. The first commit is an orphan, not a copy of
the source tree. Subsequent commits retain all older snapshots and any other
channels. An existing revision is never overwritten. A reviewed rollback reuses
the original immutable snapshot bytes and advances only the pointer's accepted
source commit.

The writer validates both channels before a single atomic commit/push; failure
validating either channel leaves both pointers unchanged. Adding v2 to an existing v1 data branch preserves its
v1 pointer and every immutable snapshot. Protocol-only changes do not alter the
v1 projection or revision.

Concurrency is serialized without cancelling a running writer, but Actions
ordering is not assumed. Every attempt fetches trusted `main` and the data
branch. A source outside `main`, divergent pointer provenance, or inconsistent
same-source result fails. Runs superseded by newer relevant source changes or
an already newer current pointer cannot move the channel backwards. The source
check covers the workflow's exact path filter, including reverted input changes,
so an intermediate delayed run cannot undo a newer identical-data no-op.
Unrelated later `main` changes do not suppress an eligible publication.

Competing writers/bootstrap attempts use normal fast-forward push rejection,
then refetch and revalidate up to three attempts. Validation, fetch, immutable
collision, or persistent push failures leave the previous usable pointer
unchanged and fail the job visibly. A failed initial publication leaves the
branch absent. There is no force push. A retry after a successful but
unacknowledged push sees a no-op.

Standard maintainer merges trigger publication regardless of PR author/title.
GitHub suppresses follow-on workflow events for pushes made using
`GITHUB_TOKEN`, including a merge performed with that token. Such a merge does
not trigger this push publisher. This implementation adds no credentials to
change that platform restriction. The existing updater opens review PRs; it
does not merge them. Data-branch token pushes need no follow-on event.

## Producer contracts v1 and v2

`shared/model-information/publication.v1.schema.json` and `publication.cjs`
retain the original v1 schema, hash and pricing/harness projection. Its schema
hash remains `8e631bcac2398743dceec874e5eb7bbde0e31f5b482e8c7855e80b73890be21e`.
`publication.v2.schema.json` and `publication.v2.cjs` add protocol facts using
schema version 2 and a distinct schema hash. These are dedicated producer wire contracts, **not** a complete
assembled `resolvedExport`, staged `target.generated.json`, or the earlier
`centralFeed` schema placeholder. It reuses the canonical tariff, harness, protocol and
provenance schemas (protocols only in v2). Consumers must explicitly support each version.

The allowlisted projection includes only exact maintained models with reviewed
tariffs or harness constraints in v1, or those facts plus protocols in v2, from the checked baseline catalogue. It preserves
provider-qualified identity, provider/channel/deployment scope, decimal strings,
units, tiers, promotion/effective dates, unavailable components, and original
dated evidence/confidence at every field. The envelope labels distribution
authority `central_feed`; nested `maintained` provenance describes the evidence,
not a grant of maintained authority to future downloaded data.

The projection excludes availability, lifecycle, aliases, families, reasoning,
limits, translations, family rules, target corrections, raw
OpenRouter exports and governed `importedPricing`. In particular, an OpenRouter
namespace or price is not recast as a native-provider or Copilot tariff. Adding
another kind of authority requires a separately reviewed producer/consumer
contract. The current maintained projection has Copilot-scoped tariffs;
publication does not declare those models available. Harness constraints are
supported when explicitly present in maintained records, not inferred.

In v2, Decisions protocol support and feature constraints retain exact provider/model
identity, support/unknown states and reviewed provenance. OpenAI-native facts
do not establish Copilot support. Protocol availability does not authorize
cross-API translation or establish losslessness, credentials or deployment
availability; [credential restrictions](./auth-matrix.md) remain separate.
The bounded loader preserves these facts without turning them into pricing,
availability, or translation authority.

Canonical bytes are UTF-8 JSON, recursively sorted object keys, two-space
indentation and a trailing newline; models sort by provider-qualified key.
Arrays within facts retain canonical source order.

`schemaHash` is SHA-256 over the canonical JSON object
`{ canonicalSchema, publicationSchema }` containing both schema documents.
`revision` and the snapshot's `sha256` are SHA-256 over canonical JSON of
`{ schemaVersion, schemaHash, models }`, **not** over the self-containing
envelope. The pointer's `sha256` hashes the complete immutable snapshot bytes.
Schema changes therefore change revisions; incompatible contracts must use a
new versioned channel/path rather than replacing v1 semantics.

`sourceCommit` in the snapshot identifies its first publishing source SHA.
`publishedAt` and envelope `effectiveFrom` use that commit's committer time as a
deterministic publication marker, not the runner wall clock or a claim of first
network availability. `observedAt` is the latest committed evidence timestamp
among published facts. Tariff-specific effective intervals remain authoritative;
the envelope does not make an expired tariff usable. No expiry is invented for
facts without a committed expiry. These metadata fields and unrelated compiler
revision changes do not create new data revisions. Identical projected data
and schemas produce no new snapshot, pointer update or Git commit, even from a
different source SHA. On rollback, the pointer's `sourceCommit` is the later
approved source and the snapshot retains its original provenance.

## Runtime consumer and trust

A digest proves byte integrity, **not publisher authentication**. The
default trust root for the loader is the fixed repository
`https://github.com/github/gh-aw-firewall`, the protected/reviewed `main` source
and this workflow's fixed `catalogue-data` destination, delivered over approved
HTTPS GitHub transport. Anonymous requests use only
`https://api.github.com/repos/github/gh-aw-firewall`; neither ambient GitHub nor
inference credentials are used. The loader resolves `catalogue-data` once and
retrieves both pointer and snapshot at that immutable commit. Redirects are
rejected. It checks the locally supported schema hash, canonical bytes, exact
path, revision and both digest levels, then verifies
`snapshot.sourceCommit <= pointer.sourceCommit <= main` using GitHub ancestry
(`<=` means ancestor-or-equal).

The updated loader requests `channels/v2/current.json` first. Only an HTTP 404
for that pointer permits a v1 pointer lookup at the same data commit; invalid v2
bytes, denial, timeout or a missing v2 snapshot never trigger a downgrade.
Source authentication reconstructs the matching version's projection. Trusted
custom/local snapshots may also use either supported version. Old consumers keep
reading the unchanged v1 channel; v2 data never appears under its paths.

For an already accepted source, the candidate must also contain that source in
its reachable commit history. Cached identifiers are compared locally, never
sent in outbound requests. This check reads at most ten 100-commit pages selected
by the network candidate, within the same total deadline. If history is too deep
to establish ordering, activation fails explicitly and preserves eligible
accepted state; the loader never assumes ancestry from timestamps.

Ancestry alone is insufficient: a data-branch writer could otherwise fabricate
prices and recompute hashes. The loader independently retrieves the committed
baseline catalogue at the snapshot's reviewed source SHA, obtains that commit's
committer time, and runs the **local** producer projection. All resulting
snapshot bytes must match, including `sourceCommit`, `publishedAt`,
`effectiveFrom`, `observedAt`, nested evidence and prices. On rollback it also
reconstructs the pointer source's projection and requires the same data revision.
Downloaded validation code and schemas are never executed or loaded. This
trusts the repository's reviewed `main` and GitHub HTTPS/API responses, not
data-branch write permissions or matching hashes alone. There is no additional
branch-rule, signing-key or credential-provisioning prerequisite.

Anonymous API denial, rate limits, missing branches, egress rejection, timeout,
malformed or oversized responses, unsupported versions and failed authentication
are explicit fallback conditions. Each response is limited to 8 MiB and one
refresh has a bounded total deadline. Retrieval uses the existing HTTP client's
proxy agent; it never retries directly after a proxy denial, adds an allowlist
entry, or changes hosts as a workaround. Dedicated enclave proxies retain their
existing explicit direct-egress configuration; no new network attachment or
credential path is introduced.

### Configuration and fallback

The API proxy enables the GitHub source by default, with a five-second initial
deadline, hourly refresh and a 30-day maximum snapshot/evidence age. New inference
HTTP requests and WebSocket upgrades wait for initial resolution or fallback.
Refreshes are single-flight; shutdown cancels retrieval and drains it.
`apiProxy.modelCatalogue` is direct AWF configuration, not a new compiler ABI:

```yaml
apiProxy:
  modelCatalogue:
    enabled: true
    offline: false
    source: github
    timeoutMs: 5000
    refreshSeconds: 3600
    maxAgeSeconds: 2592000
```

`enabled: false` disables the loader. `offline: true` reads only the selected
source's private cache and makes **zero feed network requests**. A custom
HTTPS `source` serves one canonical publication snapshot and requires
`trustSource: true`: this explicitly delegates authenticity to the operator's
configured HTTPS source instead of GitHub reviewed-source verification. It
never falls back to the default source. An inline `localSnapshot` object also
requires `trustSource: true`, performs zero feed requests, and needs no new
mount or local-file exposure. Operators can read their reviewed local JSON into
that config field before invoking AWF. Schema, integrity, age and compatibility
checks still apply to custom/local sources. Sources cannot contain URL credentials.
Standalone proxy processes use the same object in `AWF_MODEL_CATALOGUE`.

Accepted state is atomic and immutable. `cacheDirectory` selects a proxy-private
directory (default `/tmp/awf-model-catalogue-<uid>`), partitioned by configured
source, local content and schema hash. Directories must be owned by the proxy
UID with mode 0700; cache files use 0600 and atomic rename. Cache state is
trusted local state, not an import channel: do not place it in an agent-writable
workspace, shared artifact/log mount or untrusted parent directory. By default
it survives proxy-process restarts in the same container, **not** container
removal or a new workflow run; this change adds no host mount or persistent
volume. An expired cache retains its accepted-source high-water mark for online
anti-regression checks but cannot supply prices. Refresh failure preserves the
previous file and eligible run-local state. Successful fetches and cache loads
never renew evidence or effective intervals.

Pricing authority is existing operator overlays, then existing configured
`AWF_MODEL_PRICING_CATALOG` v1, then complete fresh provider prices, then fresh
fetched central prices, then the unchanged curated/bundled/selector/default
fallback paths. Incomplete provider components do not override a complete fresh
central tariff. Without an applicable feed tariff the existing provider-component
merge remains compatible. Nested maintained evidence never elevates a downloaded
tariff above `central_feed`. Existing configured-catalog input acceptance and
authority are unchanged.

The bounded consumer applies exact reviewed Copilot identities only to the
Copilot adapter's `copilot-api` scope, not native providers, custom/BYOK routes,
deployment-specific prices or inferred families. Supported tariffs retain token
units, complete input/output/cache components, optional reasoning rates, strict
long-context thresholds and effective intervals. Unsupported units, components,
tiers or unrepresentable numeric rates reject activation, not partial truncation.
The existing numerical credit calculation is unchanged; this is not the ADR's
full exact-arithmetic migration.

Each HTTP request (or WebSocket connection) pins its feed revision, effective
time and provider-price observation before dispatch; response accounting uses
those selections even after refresh/expiry. Only later requests see updates.
Availability, budget, model policy, egress and retirement checks remain in place.
Snapshots with any explicit harness constraint are rejected as
`catalogue_harness_unsupported`: this consumer cannot attest execution versions
and does not silently ignore new constraints. No new process, kernel or
attestation infrastructure is introduced.

`/reflect` adds `model_catalogue` source/state/revision, source commit, snapshot
and evidence timestamps, age, origin and failure reason. Structured
`model_catalogue` logs diagnose fallback without transport exception strings or
credentials; custom/local sources use stable fingerprints instead of URLs or
local snapshot contents. Existing token accounting records carry `central_feed` and the
selected catalogue revision. There is no `/reflect/v2` or new public catalogue CLI.

### Released-consumer live smoke

`smoke-model-catalogue.yml` is an ordinary Ubuntu/Docker Actions workflow,
not an agentic workflow. It runs manually on `main` or automatically when its
workflow/harness changes merge to `main`; PRs never receive inference credentials.
It uses the existing `github.token` / `copilot-requests: write` path, not a new
secret. No workflow dispatch is needed to publish catalogue data.

A narrowly authorized repair exception permits manual `workflow_dispatch` on
the fixed `lpcox-fix-catalogue-denial-smoke` follow-up branch only (replacing
the merged startup-repair branch). The dispatcher must
provide `reviewed_head_sha` equal to the full, security-reviewed event SHA;
missing, abbreviated, or mismatched input grants no branch authorization.
Checkout uses the immutable event SHA, not a moving branch. The harness
independently cross-checks the repository, event/ref, sender, workflow identity
and SHA, reviewed input from the actual event file, and checked-out SHA before
starting. Event-file type/size checks and JSON reads use the same open file
descriptor, so replacing its path cannot substitute a different file after
validation; the descriptor is closed on both success and failure.
No other branch, PR event, or alternate launching workflow is allowed.
Normal main execution needs no reviewed-SHA input, but rejects a mismatched one.
The coordinator must review each exact revision and recheck the remote SHA before
dispatch; the authorized repair loop is limited to five runs total, counting
both manual repair runs and automatic main runs, each with the
existing 20-minute job limit and one bounded inference request. That cumulative
limit is enforced by the dispatching coordinator, not an automatic retry loop.
This exception deliberately lets the reviewed candidate harness use the existing
CI token; it adds no credentials or permission scopes and does not authorize merge.

The initial release is **v0.28.75**. The harness checks the released Linux CLI's
SHA-256 and version, selects all three matching released images by digest, and
verifies the running image references/IDs. Updating that pin requires reviewing
the release checksums and `containers.txt`; there is no `latest`, local build,
candidate runtime import, or version-input fallback.

The online case requires network-origin authenticated catalogue activation,
then reads the loader's private accepted cache to identify the immutable
data-branch commit. It rechecks the pointer at **that commit through Squid**,
not a second mutable channel read. It selects a small actually available
Copilot model with an applicable reviewed tariff and makes one non-streaming
`Reply OK.` request (16 output tokens, 90-second deadline, one-run/one-credit
budget). Accounting must identify the selected source and, for `central_feed`,
the accepted revision. Complete fresh provider prices retain precedence; that
outcome explicitly reports central accounting as **not exercised**, even though
live catalogue activation passed. Unsupported/stale publication data fails the
smoke rather than being patched or replaced by fixtures.

Offline and denied cases use independent new containers, unmounted private
caches, and **no inference credentials**. This separates catalogue traffic from
Copilot authentication. They require explicit bundled fallback and check the
released guard's curated Haiku price with synthetic usage, not extra inference.
The released trusted sidecar bypasses agent domain ACLs, including explicit
domain blocks; an omitted allowlist entry does not deny catalogue traffic.
For the denied case only, a test-owned Docker forwarding wrapper synchronously
creates a private Compose override **before** forwarding the real container
startup. It prepends one Squid deny rule matching only source `172.30.0.30/32`,
method `CONNECT`, exact host `api.github.com`, and port `443`. All remaining
generated policy and released binaries/images stay unchanged; there is no
post-start reload race. Evidence identifies this as **test-injected policy**,
records generated/injected policy hashes, and verifies the running Squid
configuration. It tests loader fallback under a real imposed denial, not
ordinary agent-domain enforcement on the trusted sidecar.
A metadata-only TCP SYN observer starts before each fallback proxy: offline must
have zero observed outbound TCP attempts and zero proxy-origin Squid requests;
denied must have terminal `TCP_DENIED:HIER_NONE` for exactly
`CONNECT api.github.com:443` and no other Squid destinations or direct TCP
attempts. Ordinary 403 denials are counted separately. The released TLS-guard
listener logs its preliminary CONNECT 200 even for this terminal denial; that
shape is accepted only with verified injected policy and verified actual running
TLS-guard configuration, and is never reported as an actual 403 or successful
upstream access. Generic 200, successful tunnels, aborted denials, other
hierarchies, and unverified TLS-guard cases fail. Allowlisted aggregate counts
are retained before assertions, including on failure; raw targets are not.
Capture loss fails the check. This is
bounded transport observation, not packet-payload capture or proof about every
possible DNS lookup. The proxy must have one IPv4-only internal network, with
Squid as its only internet route; egress is never relaxed to make a case pass.

Only `evidence.json` and a small job summary are retained: allowlisted catalogue
identifiers/state/failure code, pinned release/image metadata, selected accounting
fields, and network counts. Each explicit work directory is created owner-only
(`0700`) before launching the release, including its filesystem probe. Readiness
failures retain a bounded startup stage, exit status, and closed-vocabulary error
class (or `unknown`), never raw stderr. `failed_stage` identifies the first failed
case while later independent cases still report their own results.
Raw reflection, logs, environment, packet traces,
headers, and inference bodies are not uploaded. Cleanup targets this invocation's
Compose services and temporary directory; an existing AWF container causes an
early failure rather than being removed. Independent fallback cases still run
after an online failure. Parser/assertion/workflow regressions run locally with
`npm test -- --runInBand scripts/ci/model-catalogue-live-smoke.test.ts`;
those fixtures do **not** substitute for a successful approved live Actions run.

### Bounded rollout

This integration ships the publication consumer and its automated authenticity
gate, not all Gate 5/8 criteria. Generated retired/mapping readers and the active
canonical pricing fallbacks described above are enabled. Staged target model
facts, full pricing/eligibility consolidation, cross-repository configuration
handoff and the broader export/compatibility phases are not activated. See
[ADR 0004](adr/0004-model-information-management.md),
tracking issues [#10290](https://github.com/github/gh-aw-firewall/issues/10290),
[#10295](https://github.com/github/gh-aw-firewall/issues/10295), and
[#10298](https://github.com/github/gh-aw-firewall/issues/10298).
