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

## Trust contract and staged rollout

A digest proves byte integrity, **not publisher authentication**. The intended
default trust root for a future loader is the configured repository
`https://github.com/github/gh-aw-firewall`, the protected/reviewed `main` source
and this workflow's fixed `catalogue-data` destination, delivered over approved
HTTPS GitHub transport. A loader must authenticate the configured repository,
host and transport, resolve the pointer at one data-branch commit, and retrieve
the snapshot at that same immutable Git commit (not a second mutable-branch
read). It must validate supported schemas, exact path/revision/digest, source
provenance, freshness/effective-time policy and rollback rules before atomic
activation. A custom mirror/local file requires explicit operator trust; data
cannot authorize a new source, transport or egress destination.

This PR implements **publication only**. There is no feed fetch, cache, source
authentication/verification in AWF, resolver activation, accounting migration,
availability change, runtime endpoint or egress-policy change. The API proxy's
legacy pricing readers remain untouched. Gate 5 and its source-authentication
work, the cross-repository configuration handoff, and the remaining Gate 8 work
are not complete. See [ADR 0004](adr/0004-model-information-management.md),
tracking issues [#10290](https://github.com/github/gh-aw-firewall/issues/10290),
[#10295](https://github.com/github/gh-aw-firewall/issues/10295), and
[#10298](https://github.com/github/gh-aw-firewall/issues/10298).
