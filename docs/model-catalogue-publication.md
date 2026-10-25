# Model catalogue publication

The source-aware updater still captures evidence, proposes canonical source
edits, validates the actual proposed Git bundle, and opens one review PR.
Maintainers still approve changes by merging to `main`. No publication command,
manual dispatch, data tag, package version bump, or container release is needed
after that merge.

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
builds and validates the publication-only projection and uploads one artifact.

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
trusted source SHA, downloads that run's artifact, and verifies its byte digest
against the build job's output and its source against the event SHA. It installs
no dependencies, runs no package hooks and executes no data-branch code. Its
only push destination is `refs/heads/catalogue-data`, using the repository's
existing token; GitHub's contents permission is repository-wide, not a
branch-scoped token. The source checks and fixed ref constrain this workflow's
write path.

On the data branch:

| Path | Contract |
| --- | --- |
| `snapshots/v1/<revision>.json` | Immutable, canonical JSON snapshot. |
| `channels/v1/current.json` | Small current pointer with schema version, revision, accepted source commit, snapshot path and full snapshot SHA-256. |

A single Git commit contains the complete new snapshot and pointer before a
normal push makes either visible. The first commit is an orphan, not a copy of
the source tree. Subsequent commits retain all older snapshots and any other
channels. An existing revision is never overwritten. A reviewed rollback reuses
the original immutable snapshot bytes and advances only the pointer's accepted
source commit.

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

## Producer contract v1

`shared/model-information/publication.v1.schema.json` defines the snapshot and
pointer shapes. This is a dedicated producer wire contract, **not** a complete
assembled `resolvedExport`, staged `target.generated.json`, or the earlier
`centralFeed` schema placeholder. It reuses the canonical tariff, harness and
provenance schemas. A future loader must explicitly support this version.

The allowlisted projection includes only exact maintained models with reviewed
tariffs or harness constraints from the checked baseline catalogue. It preserves
provider-qualified identity, provider/channel/deployment scope, decimal strings,
units, tiers, promotion/effective dates, unavailable components, and original
dated evidence/confidence at every field. The envelope labels distribution
authority `central_feed`; nested `maintained` provenance describes the evidence,
not a grant of maintained authority to future downloaded data.

The projection excludes availability, lifecycle, aliases, families, reasoning,
limits, protocols, translations, family rules, target corrections, raw
OpenRouter exports and governed `importedPricing`. In particular, an OpenRouter
namespace or price is not recast as a native-provider or Copilot tariff. Adding
another kind of authority requires a separately reviewed producer/consumer
contract. The current maintained projection has Copilot-scoped tariffs;
publication does not declare those models available. Harness constraints are
supported when explicitly present in maintained records, not inferred.

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
the fixed `lpcox-fix-catalogue-smoke-startup` branch only. The dispatcher must
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
dispatch; the authorized repair loop is limited to five runs, each with the
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
A metadata-only TCP SYN observer starts before each fallback proxy: offline must
have zero observed outbound TCP attempts and zero proxy-origin Squid requests;
denied must have an actual `api.github.com:443` Squid 403 and no other Squid
destinations or direct TCP attempts. Capture loss fails the check. This is
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
gate, not all Gate 5/8 criteria. Generated retired/mapping readers and legacy
bundled pricing paths remain active. Governed OpenRouter imports, staged model
facts, full pricing/eligibility consolidation, cross-repository configuration
handoff and the broader export/compatibility phases are not activated. See
[ADR 0004](adr/0004-model-information-management.md),
tracking issues [#10290](https://github.com/github/gh-aw-firewall/issues/10290),
[#10295](https://github.com/github/gh-aw-firewall/issues/10295), and
[#10298](https://github.com/github/gh-aw-firewall/issues/10298).
