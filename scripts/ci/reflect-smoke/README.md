# Real-agent `/reflect` utilization smoke

The manually dispatched
[`agent-reflect-smoke.yml`](../../../.github/workflows/agent-reflect-smoke.yml)
runs **Copilot, Claude Code and Codex as three parallel Actions matrix jobs**.
Each invokes the actual pinned CLI through AWF's Docker runtime. There is no
schedule, PR trigger, workflow dispatch from this harness, or live inference
in its local tests. Dispatch is a separate, paid-inference authorization.

## Architecture and scenarios

Each job builds the CLI and Squid/agent/API-proxy images from the exact dispatched
checkout SHA, not a published release or `latest`. The versions and source/image
identities are recorded in artifacts. Agent installation, authentication and
Codex's explicit Responses provider follow the daily runtime regression harness.

Each engine runs two scenarios sequentially, with a fresh CLI home, workspace and
credential-free fixture container for each. The fixture starts with no network
and AWF attaches it as a trusted peer on the internal Docker topology network.
Its address is passed to the guest; no fixed sidecar IP is assumed. AWF supplies
the peer's DNS and `NO_PROXY` configuration. The agent's **own inference** goes
through the normal AWF credential-isolating sidecar and Squid. Deliberately failing
**target requests** go to the separate fixture.

The target instantiates the checkout's exported production `createProviderServer`
and `makeModelBodyTransform`, real policy/effort admission, runtime model catalog,
decision observation and `/reflect`. It does not imitate `/reflect` or rewrite a
production rejection. Only the upstream inference is a deterministic loopback
HTTP service in the fixture container. A single known-priced model (`gpt-5.4`)
keeps production accounting enabled. Its supported effort is randomly selected
from `low`/`high`, and its input challenge has a fresh 192-bit nonce.

| Scenario | Actual required behavior |
|---|---|
| Recover | Attempt the initial `max` effort, receive production HTTP 400, read real `/reflect`, change only the effort to the currently advertised value, receive HTTP 200 and report the returned nonce-derived result. |
| Deny | Attempt the same initial task under a deny-all model policy, receive production HTTP 403, read real `/reflect`, make no further target attempts and explicitly report the policy block with `retry: false`. |

The fixture publishes `initial-request.json` containing only `task.json.request`.
The host copies both files into the guest. The prompt supplies an exact
`curl --data-binary @initial-request.json` command for the agent to execute as its
first target call; submitting the task envelope or reconstructing the payload
is not required. The guest launcher itself makes no target requests.

The prompt gives the task/report format, diagnostics URL and conditional
evidence/stop guidance, **not a recovery script or correct effort**. After a
rejection the agent must GET `/reflect`, distinguish an unsupported effort from
a policy denial, and choose its own next action. `do_not_repeat` prohibits the
unchanged rejected request, not a narrowly justified correction: an unsupported
effort with current exact-model, provider- and endpoint-scoped evidence requires
changing only `reasoning.effort` and submitting the corrected request. An actual
policy rejection confirmed by `policy_denied` requires stopping with no further
target POST. Other errors and missing evidence are not permanent policy denial.
Neither correction nor incomplete evidence guarantees success.

The normal effort error already lists supported values. This is therefore a
diagnostic **utilization** smoke: it verifies observable diagnostic access before
correction, not that `/reflect` was causally necessary or understood internally.
The report's structured refusal alone is not proof: absence of further attempts,
zero denied upstream requests, normal CLI exit and complete fixture evidence are
independently required. It does not test alternative runtimes or real upstream
model capabilities.

## Trusted grading and bounds

The fixture has no evidence/state endpoint, credentials, Docker socket or
agent-shared filesystem. The agent receives only `task.json`, `initial-request.json`, its guest launcher
and installed CLI in a small workspace outside the source checkout. Reference
answers, grader and fixture journals stay outside that workspace. After AWF
returns, the host stops the fixture and copies its journal with `docker cp`.
The grader is host-owned, not an agent-created success marker or transcript.

Recovery requires exactly two target POSTs and exactly one upstream request;
denial requires exactly one POST and zero upstream requests. Both require a
successful `/reflect` GET after the actual rejection, whose production diagnostics
contain the corresponding rejection and `do_not_repeat`. There may be at most
five total target requests, only `/responses` POSTs and `/reflect` GETs. Every
request must finish, and a recovery POST must follow the diagnostic GET. Wrong
nonce/result, missing diagnostics, no action, repeated invalid attempts, model
switching, reasoning omission, unexpected endpoints, missing evidence, malformed
reports, nonzero exits and truncation all fail. Reports must be small regular
files, not symlinks.

Per scenario: AWF enforces 24 inference turns, 30 AI credits, 12 provider requests
per minute / 30 per hour, 1 MiB request bytes per minute, one upstream auth denial,
and six agent minutes. A host timeout allows eight minutes with a further
30-second termination grace. The target refuses requests after twelve; the
grader's five-request limit is stricter. Copilot also has its CLI credit limit;
Claude has a twelve-turn CLI limit. These are enforcement bounds, not dollar
estimates or guaranteed maximum final billing: production accounting can lag an
in-flight response. Missing credentials fail; there are no success-shaped skips,
free-cost defaults, credential bypasses or policy changes.

Each matrix job receives only its engine's credential: Copilot uses
`COPILOT_GITHUB_TOKEN` (or the workflow token), Claude uses `ANTHROPIC_API_KEY`,
and Codex uses `CODEX_API_KEY` / `OPENAI_API_KEY`. Credentials stay in AWF's
standard sidecar, never the fixture. The host temporarily keeps AWF containers
so it can freeze/copy/remove the external fixture peer before running explicit
Compose teardown; otherwise that peer can prevent removal of the internal
network. Exit cleanup also removes the fixture and Compose services. AWF's work
directory and private raw logs/state stay outside the mounted guest workspace on the ephemeral hosted
runner and are never uploaded. Artifacts on success/failure contain sanitized
request/status/reason chronology, verdicts, harness exit, source SHA, image IDs and
numeric CLI version only: no prompts, response text, arbitrary agent output or
credentials. Missing artifact evidence is an error, not a passing skip.

### Sanitized failure evidence

Verdicts retain `stage` and a `failedAssertion`: the **first** failed contract's
static ID, or `null` for success and failures outside a recognized grading
assertion (for example, an unreadable report). Assertion messages, diffs, stacks
and arbitrary exception properties are never copied. Useful IDs include
`initial_request_exact`, `initial_rejection_status`, `endpoint_method`,
`reflect_get_success`, `reflect_schema`, `reflect_rejection`,
`recovery_attempt_count`, `corrected_request_exact`, `recovery_upstream_exact`,
`denial_attempt_count`, `denial_upstream_empty` and the scenario's report ID.
Later failures can coexist; the first ID is not a complete diagnosis.

`trace` describes incoming requests; `upstream` describes what the production
proxy actually forwarded to the deterministic backend. Each has an independent
sequence. The backend now records its own status and fixed
`fixture_task_mismatch` classification, including when a streamed upstream
response did not leave an error code in the incoming journal. This is a fixture
gate failure, **not** the required production effort/policy rejection.

Non-diagnostic requests have a `requestShape` of booleans only:

| Flag | Comparison with private host-owned fixture state |
|---|---|
| `methodMatches`, `pathMatches` | Exactly `POST`, `/responses`. |
| `modelMatches` | Exact task model. |
| `initialEffortMatches`, `supportedEffortMatches` | Initial `max`, or the randomized supported effort. |
| `inputMatches`, `streamMatches` | Exact nonce input, and literal `false`. |
| `exactInitialMatches`, `exactCorrectedMatches` | Entire initial/corrected body, including absence of extra keys. |

These are comparisons, not the values or alternate request bodies. A mismatch
already present on ingress differs from one first appearing after forwarding;
neither alone proves a production bug. Each public trace is capped at thirteen
entries (the target's twelve-request cap plus its refusal); grading still
requires at most **five**. Methods, paths, reasons and assertion IDs are
allowlisted, reflection reasons are deduplicated to two known classes, and
sequence/status/exit numbers are bounded. No bodies, nonce, expected result,
headers, transcripts, error text or arbitrary agent strings are published.

### First live run: observed versus established

The [first authorized run](https://github.com/github/gh-aw-firewall/actions/runs/42678673312)
at `eeefa05f0d457b43d693dd74f68de2348d69ddc9` passed provider-free checks and
only Copilot denial (one of six live scenarios). All three CLIs exited zero;
that did not satisfy grading. Four failing scenarios started with HTTP 422,
then read `/reflect` without a relevant recent rejection; Codex denial instead
POSTed to `/reflect` after HTTP 403, without a successful diagnostic GET.
The old artifacts discarded the 422 classification, request shapes and failed
assertion, so the historical request-mismatch cause remains **unknown**.
No canonical diagnosis registry finding establishes a production fix.

Provider-free regressions reproduce all five failing chronologies using the
real fixture/grader/collector. For the 422 traces, submitting the task envelope
instead of its nested request is one **demonstrated local cause**, not a claim
about what the live agents sent. Separate regressions isolate missing effort,
wrong input shape, missing stream and a production model-prefix normalization
across ingress/forwarded boundaries. Exact requests still produce the required
400/403 and both original success paths still pass. Those evidence-only changes
did not alter any model subsystem, prompt, admission rule or substantive
acceptance requirement.
The mock host-orchestration test supplies its own bounded timeout executable so
these provider-free tests also run on hosts without GNU `timeout`; the Linux
live harness continues to require the real host timeout.

### Follow-up run and task-handoff fix

The [reviewed follow-up run](https://github.com/github/gh-aw-firewall/actions/runs/42896199716)
at `616172f057da815e7af345662c78e264dd2764d8` passed the provider-free gate
(including linked job `130109871417`). All three live jobs built their images
and installed their CLIs, but failed grading; all six scenario agent exits were
zero. Copilot denial passed. The other scenarios were:

| Scenario | Observed target chronology | First failed assertion |
|---|---|---|
| Copilot recover | Mismatched POST 422, GET 200 without relevant rejection, exact initial POST 400, exact corrected POST 200. | `initial_request_exact` |
| Claude recover | Exact initial POST 400, GET 200 with `unsupported_reasoning_effort`, no correction POST, zero upstream. | `recovery_attempt_count` |
| Claude deny | Mismatched POST 422, GET 200 without relevant rejection, exact initial POST 403, no subsequent diagnostic GET. | `initial_request_exact` |
| Codex recover | Mismatched POST 422, GET 200 without relevant rejection, exact corrected POST 200; no initial effort rejection. | `initial_request_exact` |
| Codex deny | Mismatched POST 422, two GETs 200 without relevant rejection, no policy rejection. | `initial_request_exact` |

For all four initial mismatches, the model/effort/input/stream and exact-body
comparisons were false both on ingress and after forwarding. The upstream
classified those 422s as `fixture_task_mismatch`. This establishes a mismatch
before proxy transformation, **not the original raw payload**. Submitting the
task envelope remains a demonstrated local reproduction, not a proven historical
cause. Claude's early-stop cause is also unproven; misinterpreting
`do_not_repeat` as forbidding a changed request is only a hypothesis.

The follow-up fix removes the ambiguous envelope submission boundary with the
request-only file and exact first command, and clarifies correction versus
permanent-denial instructions. Production `/reflect` already provides
`change_request` / `do_not_repeat`, an explanation requiring exact-model and
endpoint-scoped evidence, and current supported-effort evidence in the recovery
fixture. No production guidance or model admission change is necessary for this
reproduction. No grader, first-failed IDs, shape evidence, credential/isolation
bound, workflow build strategy or substantive acceptance rule is relaxed.

## Provider-free local validation

With root and API-proxy dependencies installed:

```bash
npm ci
npm --prefix containers/api-proxy ci
npm run test:reflect-smoke
```

These tests run actual production proxy HTTP servers in isolated child processes
with a deterministic local upstream and **no provider credentials or Docker**.
They exercise real rejection envelopes, real diagnostic capability/outcome
evidence, corrected success, deny-all reflection, policy evasion and fail-closed
grading of tampered/missing/repeated/failed evidence. All five follow-up failure
chronologies remain fail-closed regressions. For each engine and scenario, a
mock CLI runs the exact first command extracted from the real guest prompt,
using the fixture's published request-only file against the production proxy.
The test driver then reads diagnostics and performs correction or stops; this
checks the publication/submission boundary and both grading paths, **not a real
agent's interpretation or decisions**. Separate mock CLI process tests check
the three guest invocation contracts and Codex transport configuration. None
are live-agent acceptance. Build Verification also runs these provider-free
checks on Node 22; the manual workflow runs this gate before any live engine.

**Live acceptance remains pending until a separately authorized manual dispatch**
passes both scenarios for all three real CLIs. Local fixture/grader success must
not be reported as proof that a live agent recovered.
