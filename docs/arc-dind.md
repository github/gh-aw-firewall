# ARC + DinD Configuration

AWF supports ARC runners where the runner filesystem and Docker daemon filesystem are split (DinD sidecar patterns).

## Runner topology selector

The simplest way to configure AWF for ARC/DinD is through the `runner.topology` config key:

```json
{
  "runner": {
    "topology": "arc-dind"
  }
}
```

When `runner.topology` is set to `"arc-dind"`, AWF enables ARC/DinD-specific sysroot staging behavior:

| Behavior | Default | Override |
|----------|---------|----------|
| Sysroot image for `/host` base | `build-tools:<tag>` | `runner.sysrootImage` |
| Tool cache warning if under `/opt` | Emitted | Set `RUNNER_TOOL_CACHE` to shared path |

Other ARC/DinD settings (for example `network.isolation` and `dind.preStageDirs`) are configured explicitly through their own fields.

## Build-tools sysroot image

On ARC/DinD, the standard system mounts (`/usr:/host/usr:ro`, etc.) resolve to the runner container's filesystem, which is invisible to the Docker daemon's split filesystem. The `build-tools` sysroot image solves this by providing a pre-built Ubuntu 22.04 image containing system-level build infrastructure:

- **Compilers & linkers**: gcc, g++, make, cmake, autoconf, binutils
- **Dev libraries**: libssl-dev, libc6-dev, libicu-dev, zlib1g-dev
- **System utilities**: bash, coreutils, git, curl, wget, jq
- **Agent dependencies**: libcap2-bin (capsh), gosu, gnupg, gh

### How it works

1. AWF emits a `sysroot-stage` init service in the compose file
2. The init container copies the build-tools image FS into a named `sysroot` volume
3. The agent mounts the `sysroot` volume read-only at `/host`
4. `entrypoint.sh` finds `/host/bin/sh` and `capsh`, chroots successfully

```yaml
# Generated docker-compose.yml (simplified)
services:
  sysroot-stage:
    image: ghcr.io/github/gh-aw-firewall/build-tools:0.28.0
    volumes: ["sysroot:/sysroot"]
    entrypoint: ["/bin/sh", "-c"]
    command: ["cp -a /usr /lib /bin /sbin /etc /sysroot/ ..."]

  agent:
    depends_on:
      sysroot-stage: { condition: service_completed_successfully }
    volumes:
      - sysroot:/host:rw
      - /tmp/gh-aw/tool-cache:/host/tmp/gh-aw/tool-cache:ro

volumes:
  sysroot: {}
```

### Custom sysroot image

Override the default build-tools image:

```json
{
  "runner": {
    "topology": "arc-dind",
    "sysrootImage": "ghcr.io/my-org/custom-sysroot:latest"
  }
}
```

## Tool cache for language SDKs

Language SDKs (Go, Node, Java, .NET) are NOT baked into the sysroot image. They are installed on-demand by `setup-*` actions into a shared tool cache volume.

**Important**: On ARC, `RUNNER_TOOL_CACHE` must point to a shared path visible to both the runner container and the DinD daemon (e.g., `/tmp/gh-aw/tool-cache`). The default `/opt/hostedtoolcache` is invisible to the DinD daemon.

```yaml
# Early in workflow, before setup-* actions:
- run: echo "RUNNER_TOOL_CACHE=/tmp/gh-aw/tool-cache" >> "$GITHUB_ENV"
```

## Staging additional CLI tools (not just the invoking engine binary)

AWF never discovers or stages arbitrary tools that a sandboxed command invokes
(for example a threat-detection binary, a linter, or any helper CLI installed
by a separate workflow step). The only automatic staging is narrow:

- **First-command staging** copies the *first token* of the AWF command (the
  invoking engine binary — `copilot`, `claude`, `codex`, …) into a
  daemon-visible staging root and mounts it at `/tmp/awf-runner-bin/<name>`.
  It runs **only when `--docker-host-path-prefix` is a `/tmp`-rooted path**
  shared by the runner and the DinD daemon (for example `/tmp/gh-aw`). A
  `/host`-style prefix does **not** trigger it, so with that prefix even the
  engine binary must be staged explicitly.
- **`dind.stageEngineBinary`** is an explicitly configured fallback (you give
  it `path`/`targetPath`), not automatic discovery.

On `runner.topology: arc-dind`, a tool installed only onto the **runner's**
filesystem (via `actions/setup-*`, a manual `curl` install, or an action that
drops a binary under `$RUNNER_TOOL_CACHE`/`/opt`/`/usr/local/bin`) is invisible
to the sysroot the agent chroots into: that sysroot comes from the
`build-tools` image plus daemon-visible bind mounts, not from the runner pod's
filesystem. Calling such a tool inside AWF without staging it fails with exit
code 127 ("command not found").

### Staging recipe

Copy the tool into a shared, daemon-visible `/tmp`-rooted directory **and
mount that directory**, because staging alone does not expose a path —
`--docker-host-path-prefix` only rewrites bind-mount *sources*, it does not
publish arbitrary runner paths into the sandbox.

```yaml
- name: Stage my-tool and its output directory
  run: |
    mkdir -p /tmp/gh-aw/bin /tmp/gh-aw/my-tool
    cp "$(command -v my-tool)" /tmp/gh-aw/bin/my-tool
    chmod +x /tmp/gh-aw/bin/my-tool

- name: Run my-tool under AWF
  run: |
    sudo awf --docker-host-path-prefix /tmp/gh-aw \
      --mount /tmp/gh-aw/bin:/tmp/gh-aw/bin:ro \
      --mount /tmp/gh-aw/my-tool:/tmp/gh-aw/my-tool:rw \
      --allow-domains api.example.com \
      -- /tmp/gh-aw/bin/my-tool --output /tmp/gh-aw/my-tool/result.json
```

Notes on this recipe:

- **Every `--mount` host path must already exist** — AWF validates it before
  launch and aborts with `Host path does not exist` otherwise. Create both the
  staged bin directory and the output directory in the preceding step.
- **Copying the file returned by `command -v` is only sufficient for a
  self-contained executable** (a static binary, or one whose interpreter,
  shared libraries, Node/Python modules and data files already exist in the
  sysroot). Wrapper scripts, `setup-*`-installed SDK tools, and
  package-managed linters are typically shims over a runtime and support tree,
  so copying the entry point alone still fails — with a missing-interpreter,
  missing-`.so`, or missing-module error rather than exit 127. For those,
  stage/mount the whole install tree (and its runtime, e.g. the tool cache at
  `/tmp/gh-aw/tool-cache`) instead of a single file.
- **`chroot.binariesSourcePath`** is the alternative when you want staged
  tools on `PATH`: AWF mounts that runner-side directory at
  `/tmp/awf-runner-bin` inside the chroot and prepends it to `PATH`, so the
  command can be invoked by bare name.

### Output paths must be writable — and consistent

Staging the binary only fixes exit code 127. A tool that writes output also
needs its `--output`/destination path to resolve to a mount that is:

1. **writable** — a `:ro` mount used to expose staged inputs does not become
   writable just because the tool's output path lives underneath it. Add a
   more specific `:rw` mount for the output subdirectory, as in the recipe
   above:

   ```bash
   --mount /tmp/gh-aw/bin:/tmp/gh-aw/bin:ro \
   --mount /tmp/gh-aw/my-tool:/tmp/gh-aw/my-tool:rw
   ```

   Docker orders bind mounts by destination depth, so the more specific `rw`
   mount of the subdirectory is applied after (and therefore takes precedence
   over) a broader `ro` mount of its parent.

2. **the same path for the producer and the consumer** — pick one canonical
   sandbox path (e.g. always `/tmp/gh-aw/my-tool/result.json`) and use it for
   both the AWF-side write and the later step or artifact-upload read. AWF
   mounts custom targets under the chroot, so the in-sandbox path matches the
   `--mount` container path; the runner-side source is what
   `--docker-host-path-prefix` rewrites. A mismatch (writing under
   `${RUNNER_TEMP}/…` but reading `/tmp/gh-aw/…`, which
   `--docker-host-path-prefix` does **not** alias) produces no error — the
   tool "succeeds" but the output never appears where the consumer looks.

For gh-aw engine streaming logs (including Pi), do not write directly to
`/tmp/gh-aw/pi-streaming.jsonl` when its runner-side parent
`${RUNNER_TEMP}/gh-aw` is mounted `:ro`. The compiler should write Pi's log at
`/tmp/gh-aw/sandbox/agent/logs/pi-streaming.jsonl`, beneath the writable
`sandbox/agent` child mount (create `logs` before writing). The Pi command,
step-summary parser, session exporters, and artifact upload must all use the
corresponding path on their side of the mount. Mounting the child `:rw` does
not make the rest of the read-only parent writable.

Until the gh-aw compiler relocates Pi's log, a workflow-specific workaround is
to create the real log file at the runner-side source path in a pre-step,
symlink the compiled Pi `tee` path to that file, and bind-mount the real file
at its writable child path. Keep the symlink and bind-mount destination
separate: AWF rejects a symlink as a file bind-mount destination.

For example, when the compiled `tee` writes `/tmp/gh-aw/pi-streaming.jsonl`:

```yaml
- name: Prepare Pi streaming log
  run: |
    mkdir -p "${RUNNER_TEMP}/gh-aw/sandbox/agent/logs"
    touch "${RUNNER_TEMP}/gh-aw/sandbox/agent/logs/pi-streaming.jsonl"
    ln -sfn sandbox/agent/logs/pi-streaming.jsonl "${RUNNER_TEMP}/gh-aw/pi-streaming.jsonl"
```

Add this file entry under `sandbox.agent.mounts`:

```yaml
- "${RUNNER_TEMP}/gh-aw/sandbox/agent/logs/pi-streaming.jsonl:/tmp/gh-aw/sandbox/agent/logs/pi-streaming.jsonl:rw"
```

The real file is mounted at `/tmp/gh-aw/sandbox/agent/logs/pi-streaming.jsonl`;
the compatibility symlink remains at the runner-side counterpart of the
compiled `tee` path. Do not use the symlink path as the mount destination or
remount the entire `${RUNNER_TEMP}/gh-aw` parent writable. If the compiled
`tee` path differs, put the symlink at its actual runner-side counterpart.
Check both the runner-side source and sandbox-side destination when
`${RUNNER_TEMP}` differs from `/tmp`.

### Agent logs, threat detection, and safe-output ownership

The failures reported in [github/gh-aw#66926](https://github.com/github/gh-aw/issues/66926)
are tracked there for compiler/MCP Gateway fixes, with AWF-side tracking in
[github/gh-aw-firewall#9779](https://github.com/github/gh-aw-firewall/issues/9779):

- **Agent logs:** Copilot's `--log-dir`, the log parser's `GH_AW_AGENT_OUTPUT`,
  and artifact collection must refer to the same files. Writing to
  `${RUNNER_TEMP}/gh-aw/sandbox/agent/logs` does not populate the runner's
  `/tmp/gh-aw/sandbox/agent/logs`. AWF's internal `workDir/agent-logs` mount
  backs the default `~/.copilot/logs`; it does not override an explicit
  `--log-dir`. The compiler must align the producer and consumers with the
  runner-visible mount source. An explicit mount can give the sandbox a
  canonical target while retaining a different runner-side source; the
  runner's parser must still read the source, accounting for path translation.
  AWF does not create cross-root symlinks or copies, which can conflict with
  artifact consolidation.

  For ARC/DinD, the resolved-config JSON published via `AWF_RESOLVED_CONFIG`
  includes `runnerMountPaths`, an ordered array of
  `{ "sandboxPath": "...", "runnerPath": "..." }` entries for explicit bind
  mounts retained by the ARC sysroot filter. These paths account for the
  effective, including auto-detected, Docker host prefix and remove the
  container's `/host` chroot prefix.
  For example, a mount from `${RUNNER_TEMP}/gh-aw/sandbox/agent/logs` to
  `/tmp/gh-aw/sandbox/agent/logs` reports the latter as `sandboxPath` and the
  former as `runnerPath` with a daemon-only `/host` prefix. With a shared
  `/tmp` prefix, a source outside `/tmp` instead reports `/tmp<source>`.

  The gh-aw compiler/parser must consume this mapping to resolve its engine
  log path: choose the longest matching sandbox path on a directory boundary
  (the last entry wins for duplicate targets), then append the relative suffix
  to `runnerPath`. A compiler that rewrites the execution path to
  `${RUNNER_TEMP}/gh-aw/...` must resolve that rewritten path, not the original
  engine path. Use the resolved runner path for both parsing and artifact
  collection. This metadata does not change mounts, commands, or permissions,
  and does not itself update older gh-aw parsers. Consolidation can copy real
  directories without creating or removing a log-directory symlink.

  The agent-log path contract is:

  | Writer / reader | Path |
  | --- | --- |
  | Copilot with no explicit `--log-dir` | Sandbox `~/.copilot/logs`; backed by AWF's `workDir/agent-logs` in non-ARC compose runs, but not on ARC/DinD |
  | Copilot with an explicit `--log-dir` | The sandbox mount target, for example `/tmp/gh-aw/sandbox/agent/logs` |
  | Runner-side summary parser and artifact collection | The corresponding runner-visible mount source, for example `${RUNNER_TEMP}/gh-aw/sandbox/agent/logs` |

  `--log-dir` is a Copilot option, not an AWF `--agent-logs` option. AWF's
  default log mount does not collect logs written to an explicit engine path.
  In non-ARC compose runs, non-empty default logs are preserved as
  `/tmp/awf-agent-logs-<timestamp>` during normal cleanup. ARC/DinD removes
  the workDir-backed default mounts; use an explicit shared log mount and
  `--log-dir` for runner-side collection. Explicitly mounted logs remain at
  their mount source.

  **Agent log directory contract (Docker compose):** `agent-logs` is a
  subdirectory of `--work-dir`. Without ARC/DinD sysroot staging, AWF mounts
  `<workDir>/agent-logs` read-write at `/host<effectiveHome>/.copilot/logs`
  (the chrooted agent sees `~/.copilot/logs`). With a daemon-only
  `--docker-host-path-prefix /host`, the compose source becomes
  `/host<workDir>/agent-logs`; the destination stays unchanged and the runner
  still reads `<workDir>/agent-logs`. With the shared `/tmp` prefix, keep the
  work directory under `/tmp` so the source remains unchanged. With
  ARC/DinD sysroot staging, the sysroot filter removes these automatic
  work-directory mounts because the runner's work directory is not shared
  with the daemon; use an explicit log-directory mount on shared storage.

  An explicit Copilot `--log-dir /tmp/gh-aw/sandbox/agent/logs` instead
  requires a mount such as:

  ```bash
  --mount "${RUNNER_TEMP}/gh-aw/sandbox/agent/logs:/tmp/gh-aw/sandbox/agent/logs:rw"
  ```

  Prefix translation changes only the daemon-side source, not the sandbox
  destination or the Copilot command. For a daemon-only prefix, the runner's
  `parse_copilot_log.cjs`, `GH_AW_AGENT_OUTPUT`, and artifact collection must
  therefore read `${RUNNER_TEMP}/gh-aw/sandbox/agent/logs`, not the sandbox's
  `/tmp/gh-aw/sandbox/agent/logs`. With a shared `/tmp` prefix and a source
  outside `/tmp`, the runner-visible source is
  `/tmp${RUNNER_TEMP}/gh-aw/sandbox/agent/logs`; put the source under `/tmp`
  to avoid further source translation.

  The remaining compiler fix is tracked in
  [github/gh-aw#72896](https://github.com/github/gh-aw/issues/72896)
  ([AWF tracking](https://github.com/github/gh-aw-firewall/issues/10818)):
  `pkg/workflow/compiler_yaml_ai_execution.go` must set `GH_AW_AGENT_OUTPUT`
  for `parse_copilot_log.cjs` to the same runner-visible source used by
  execution and artifact collection, rather than the unadjusted engine path.
  Do not alias the two runner roots with a symlink: consolidation must merge
  real directories. End-to-end acceptance in gh-aw requires a populated agent
  summary and successful consolidation on ARC/DinD with no link/unlink steps.
  AWF's volume-mount integration test covers the write/read handoff and a
  directory-merge fixture; it does not execute gh-aw's summary parser.

- **Threat detection:** mounting the input directory only makes it visible to
  the process. `threat-detect` launches Copilot and must grant its input
  directory in Copilot's `--add-dir` scope; the absence of `--add-dir` in the
  compiled detection job alone does not show what the subprocess received.
  Detection must fail closed if required inputs cannot be read or no valid
  verdict is produced; a successful engine exit alone is not proof that inputs
  were analyzed. AWF passes the command through unchanged and cannot interpret
  an engine's permission denials or detection verdict.
  The upstream `Conclude threat detection` step must also honor
  `RUN_DETECTION=false` rather than requiring a deliberately skipped binary.
  To verify the reported strict-mode failure, reproduce on a throwaway PR
  with `CUSTOM_PROMPT` removed and other detection settings unchanged. Keep a
  redacted, non-payload-bearing record of the workflow commit, executed lock
  excerpt and full setup SHA, compiler/AWF/threat-detect pins, permission
  errors, non-secret conclusion environment, conclusion/reason/success outputs
  (mark unset outputs), exit status, and run/job IDs. Compare that old-version
  result separately from a current-version run: a required unreadable input
  must not yield a successful verdict in strict mode, while readable inputs
  must still produce a normal verdict. Neither a mount assertion nor the
  engine exit status establishes those end-to-end properties.
- **Safe outputs (findings 3–4):** the gateway's runner UID/GID does not
  establish the identity of its nested `safeoutputs` stdio container. That
  container is launched by MCP Gateway, not AWF; AWF's agent UID/GID mapping
  cannot repair its ownership. The reported root-owned `outputs.jsonl` and
  redaction warning were observed with older versions, not yet reproduced on
  the upgraded ARC topology. [Current gh-aw redaction
  code](https://github.com/github/gh-aw/issues/66926#issuecomment-6221802902)
  attempts atomic replacement of non-writable files and fails/removes the
  source on unrecoverable errors; neither source inspection nor a successful
  redaction on another runner proves this works with the actual ARC directory
  permissions. Do not make the file world-writable or bypass the compiler's
  safe-output-file access rule. Any necessary child identity propagation
  belongs in MCP Gateway; redaction and compiler changes belong in gh-aw.

The remaining nested-stdio identity fix is tracked in
[github/gh-aw#72898](https://github.com/github/gh-aw/issues/72898), with AWF
follow-up in [#10806](https://github.com/github/gh-aw-firewall/issues/10806).
The reporter says they upgraded to v0.92.0 and removed the fail-closed
post-step, but still need the pre-create workaround. Successful redaction
without pre-creation and fail-closed publication behavior are therefore both
unverified; this is not evidence that child ownership is fixed. Acceptance
upstream is runner-owned child-created files and successful redaction without
pre-creation, with publication blocked on unrecoverable redaction errors.

AWF's general and enclave API proxies and CLI proxy HTTP service use the host
UID/GID for shared log writes. Enclave executors retain their dedicated non-root
identities and private output staging; they must not gain runner access to
shared workflow outputs. The trusted enclave MCP broker retains its privileged
identity for AWF-private control, audit, and staging mounts, not shared
safe-output files. These AWF identity settings do not propagate to
gateway-launched stdio containers.

To verify findings 3–4, use an isolated ARC/DinD run with the current supported
gh-aw compiler and matching setup action. Remove the remaining pre-create step
from the candidate workflow before compiling it. Separately verify that an
unrecoverable redaction error still blocks publication, including artifacts,
and removes the unsafe source. Record the exact compiler, setup, MCP Gateway,
nested safeoutputs image, AWF, and DinD versions (including immutable SHAs or
digests where available). Before any output is written, record only the results
of `id -u`, `id -g`, and
`stat -c '%u:%g %a'` for the safeoutputs directory from the runner and the
nested container. Inspect the gateway and child container's configured user
with `docker inspect --format
'{{.Config.User}}' <container>`; an empty configured user needs an in-container
`id -u`/`id -g` check. Use an out-of-band observer to record the UID/GID and
mode of `outputs.jsonl` immediately after the child first writes it and before
the `Redact secrets in logs` step starts. Record the file's UID/GID and mode
again after redaction, or record that it is absent; the post-redaction state
does not establish the child's original ownership. Do not use workflow steps
that directly access the safe-output file to collect either observation.
Compare directory write/rename permissions as well as file write permissions:
atomic replacement requires permission on the parent directory. Never print
the file, secrets, container environment, or unredacted logs.

| Finding | Last reported version / result | Upgrade acceptance |
|---|---|---|
| 3 — child ownership and redaction | Compiler/setup v0.89.21, AWF v0.28.23; pre-create was still needed. Reporter says v0.92.0 removed the fail-closed post-step but retains pre-creation. Gateway and child versions/identities unknown; successful redaction without pre-creation and fail-closed publication behavior remain **unverified**. | With pre-create removed, capture the child's file metadata before redaction and the resulting metadata or absence afterward. For the success case, register an inert dummy value with the redactor and include it in safe output so `outputs.jsonl` must be rewritten; confirm the file-specific redaction diagnostic for `outputs.jsonl` (and the replacement diagnostic if emitted), without printing output content. In a separate isolated test, an induced unrecoverable redaction error must stop publication (including artifacts) and remove the unsafe source. Record step outcomes without output content. If ownership still blocks this, preserve redacted metadata and escalate child identity to MCP Gateway and redaction to gh-aw. |
| 4 — compiler upgrade | v0.91.4 rejected direct safe-output-file access in the workaround; reporter upgraded to v0.92.0, but compilation and execution without the remaining pre-create step are **not verified**. | With pre-create removed, the unmodified safe-output access restriction remains enabled, compilation succeeds, and the compiled workflow executes and publishes only successfully redacted safe outputs. If not, retain the compile diagnostic and escalate to gh-aw. |

The historical version details above come from the
[reporter's update](https://github.com/github/gh-aw/issues/66926#issuecomment-6264251052);
the historical ARC run logs have expired. Preserve a redacted record of the new
run ID, workflow commit, version pins, ownership/mode observations, compile
result, redaction step outcome, and publication outcome before considering
AWF tracking issue [#10271](https://github.com/github/gh-aw-firewall/issues/10271)
resolved. Use a non-closing reference (`Refs #10271`) until that evidence
exists; neither finding is verified fixed.

### Verifying the daily AIC guardrail on ARC/DinD

[Findings 6–7](https://github.com/github/gh-aw-firewall/issues/10273) concern
the **gh-aw actions setup** scan, not AWF's api-proxy credit limit. The upstream
changes in [gh-aw#67884](https://github.com/github/gh-aw/pull/67884),
[gh-aw#68056](https://github.com/github/gh-aw/pull/68056), and
[gh-aw#68079](https://github.com/github/gh-aw/pull/68079) need verification
against the *executed* workflow, not just the locally installed `gh aw` version.
The original ARC run logs have expired; upstream code inspection is not an ARC
runtime result.

1. Record the workflow commit, compiler version, and the resolved
   `github/gh-aw-actions/setup@<sha>` in its compiled lock and executed job log.
   Confirm that the setup SHA includes all three fixes before attributing an
   observation to them. Record the configured daily threshold and per-run
   `max-ai-credits` fallback (if any), without disclosing credentials or
   unredacted artifacts.
2. On the ARC runner, observe a *naturally* cancelled run. An unassigned agent
   alone does not establish zero: inspect the complete job history across all
   attempts, including detection and evaluation jobs, and assert
   `accountingReason: confirmed_zero` only if every AI-powered job was skipped
   or never started. If any AI-powered job ran in an earlier attempt, it may
   require accounting even when the latest agent did not start.

   Compare a cold scan, a scan after restoring the `aic-usage-scan-v2`
   observations, and another scan over the same completed attempt. Use a
   trigger on which the pinned workflow actually runs both restore and scan;
   for the planned v0.92.0 setup, manual dispatch, reusable-workflow,
   repository-dispatch, and slash/label-command runs skip both. Require a
   restored-cache comparison only when a trusted producer published a
   compatible post-upgrade snapshot, and verify from the run output or
   metadata that it was actually restored. Artifact-name equality is not
   sufficient: v0.89.21 writes coverage version 1, while v0.92.0 accepts only
   version 3. Without an eligible trigger and a verified compatible restore,
   treat the scan as skipped or cold, not as a cache regression.

   For a qualifying confirmed-zero run, the cold scan must record `aic: 0`,
   `source: recorded`, and `accountingReason: confirmed_zero`; subsequent scans
   must report a cache hit without repeating that run's jobs/artifact
   resolution. Compare `candidateRuns`, `countedRuns`, `cacheHits`, business
   API request counts, and elapsed times. A new attempt or changed
   completed-run metadata is a legitimate cache miss; a restored snapshot
   never replaces a fresh complete workflow-history listing.
3. Separately, inject a jobs-API 502 in a controlled test of the **pinned setup
   action** with fake API responses and a disposable cache, not by changing a
   production runner or replaying production credentials. Verify recovery
   within the bounded three read attempts. For exhausted transient per-run
   reads, verify an eligible positive per-run limit produces a conservative
   `source: estimated` fallback and is *not* treated as a recorded-zero hit
   on the next scan. Check both sides of the daily threshold, including equality:
   estimated credits must count towards `exceeded`, never permit downstream
   execution over budget. Without a positive fallback, or for quota and
   `Retry-After` responses, expect the guardrail to fail closed. A failed
   authoritative history listing is not eligible for per-run fallback. Use
   upstream's focused mocked `daily_aic_api_budget`, `daily_aic_scan`, and
   `check_daily_aic_workflow_guardrail` tests as a baseline, then compare the
   tested setup SHA to the executed one.
4. After an injected failure, inspect the persisted observations and run a
   fresh scan with healthy responses. Confirm the complete listing is repeated,
   valid recorded observations can be reused, estimated/failed observations
   cannot authorize a zero result, and no hour-long retry restriction appears
   for an ordinary 502. A server-supplied `Retry-After` or quota response is a
   separate case: record its actual retry deadline rather than treating it as
   the 502 regression. Also distinguish the independent workflow cooldown:
   test `check_cooldown` with a prior run whose agent job did and did not
   start; do not confuse its configured window with an AIC retry restriction.

Keep redacted logs, cache-entry metadata, step outputs, setup SHA, and scan
timings alongside the test revision. Label ARC observations versus injected
errors separately. Do not mark finding 6 resolved without repeated ARC scans,
or finding 7 resolved without controlled fallback/threshold and subsequent-scan
evidence; the two findings can be closed independently.

### Verify skipped threat detection on ARC/DinD

The conclusion fix is in `gh-aw` [#67810](https://github.com/github/gh-aw/pull/67810),
not AWF. Before testing, record the **executed** workflow commit, compiler and
AWF versions, and the `github/gh-aw-actions/setup@<SHA>` pin from its compiled
lock. For example, the v0.92.5 locks in this repository pin
`ebb97091a4afcc9bf2d594071dbabe861e9a34fc`; its
`setup/sh/conclude_threat_detection.sh` includes the explicit
`RUN_DETECTION=false`, `THREAT_DETECT_INSTALL_OUTCOME=skipped` branch. A pin in
the checkout alone does not establish which revision an ARC runner executed.

On an authorized ARC/DinD runner, run the pinned workflow with detection
deliberately skipped (no safe outputs or patches). Where authorized, repeat
using repository-owned Actions API cancellation, not a cancellation of another
repository's run. In each run, inspect the actual detection guard, installation
and conclusion steps: the guard must output `false`, installation must be
`skipped`, and the conclusion step must succeed with `conclusion=skipped`,
`success=true`, and an empty `reason`. It must not report a missing binary or
`reason=agent_failure`. A cancelled *job* may never reach the conclusion step;
record that separately rather than counting it as a successful skip.

To check the pinned script in isolation on the same runner **after setup has
staged the actions**, use a disposable output file (this does not replace the
end-to-end ARC run):

```bash
set -e
script="${RUNNER_TEMP}/gh-aw/actions/conclude_threat_detection.sh"
test -f "$script"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
ln -s "$(command -v dirname)" "$work/bin/dirname"
GITHUB_OUTPUT="$work/skipped" RUN_DETECTION=false \
  THREAT_DETECT_INSTALL_OUTCOME=skipped GH_AW_DETECTION_CONTINUE_ON_ERROR=false \
  PATH="$work/bin" /bin/bash "$script" "$work/absent-result.json"
grep -Fx 'conclusion=skipped' "$work/skipped"
grep -Fx 'success=true' "$work/skipped"
grep -Fx 'reason=' "$work/skipped"
if GITHUB_OUTPUT="$work/required" RUN_DETECTION=true \
  THREAT_DETECT_INSTALL_OUTCOME=success GH_AW_DETECTION_CONTINUE_ON_ERROR=false \
  PATH="$work/bin" /bin/bash "$script" "$work/absent-result.json"; then
  echo "Required detection unexpectedly succeeded" >&2
  exit 1
fi
grep -Fx 'conclusion=failure' "$work/required"
grep -Fx 'success=false' "$work/required"
```

The isolated `PATH` excludes `threat-detect` for both cases; the second case
confirms that a required detector still fails closed in strict mode. Preserve
only redacted conclusion outputs, step outcomes, exact versions/pins, and run
links. Do not close the ARC finding based on the isolated check or a compiled
pin alone; if the live conclusion disagrees, report the narrower failure to
`github/gh-aw` with that evidence.

## Locating API proxy token-usage logs

The api-proxy writes `token-usage.jsonl` into `<proxy-logs-dir>/api-proxy-logs/`
(or `<workDir>/api-proxy-logs/`, moved to `/tmp/api-proxy-logs-<ts>/` after
cleanup when `--proxy-logs-dir` is not set). Under `runner.topology: arc-dind`
the gh-aw compiler passes `${RUNNER_TEMP}/gh-aw/...` paths, so the file is
**not** at the literal `/tmp/gh-aw/sandbox/firewall/logs/...` path a post-run
step may hardcode.

After cleanup AWF logs the final runner-visible location
(`Token usage log available at: <path>`) and, when `$GITHUB_ENV` is available,
exports it for later steps of the same job:

```yaml
- name: Parse token usage
  run: |
    if [ -n "${AWF_TOKEN_USAGE_LOG:-}" ]; then
      jq -s 'length' "$AWF_TOKEN_USAGE_LOG"
    fi
```

`AWF_TOKEN_USAGE_LOG` is only exported when the file exists. Post-run consumers
should prefer it over hardcoded paths.

`--docker-host-path-prefix` translation is accounted for: with a daemon-only
prefix (`/host`, `/tmp/gh-aw`, ...) the daemon writes back to the runner path
unchanged. With a shared `/tmp` prefix, a `--proxy-logs-dir` **outside** `/tmp`
(for example under `${RUNNER_TEMP}`) is rewritten to `/tmp<dir>`; AWF warns at
startup, pre-creates that directory so the non-root api-proxy can write to it,
and reports/exports the `/tmp<dir>/api-proxy-logs/token-usage.jsonl` path.
Keep `--proxy-logs-dir` under the shared prefix to avoid the rewrite.

## Writable home under sysroot staging

Sysroot staging drops agent bind mounts whose sources the DinD daemon cannot
resolve, including AWF's own `${workDir}-chroot-home` volume for `/host$HOME`.
An explicitly supplied mount is exempt from that filter: if the caller passes
`--mount <daemon-visible-home>:$HOME:rw` (the gh-aw compiler does this for
`${RUNNER_TEMP}/gh-aw/home`), the resulting `/host$HOME` mount is kept, because
the caller vouches for the source being visible to the daemon. The exemption
matches on both source and target, so AWF's own mounts to the same target stay
subject to the filter.

A writable `/host$HOME` matters for two reasons:

- the `/dev/null` credential-hiding overlays are mounted under `/host$HOME`, and
  runc cannot create those mountpoints under a read-only parent;
- `entrypoint.sh` pre-seeds JVM build tool proxy config (`~/.m2`, `~/.gradle`)
  under the chroot home.

If no writable `/host$HOME` survives the filter, AWF logs a warning and skips
the `/host$HOME` credential overlays instead of failing container creation — the
overlays at the un-prefixed `$HOME` path (on the agent's own rootfs) are still
applied, but credential files under the chroot home are not masked for that run.
The entrypoint likewise warns and skips JVM proxy pre-seeding rather than
aborting.

## What AWF handles automatically

- Split-filesystem probing for `--docker-host-path-prefix`
- Chroot staging for:
  - invoking CLI binary (`copilot`, `claude`, `codex`, etc.)
  - `/etc/passwd`
  - `/etc/group`
  - generated chroot `/etc/hosts`
- DinD `DOCKER_HOST` propagation into agent/MCP environments when DinD is detected

## Explicit ARC/DinD config surface

For fine-grained control (or when not using `runner.topology`):

```json
{
  "container": {
    "enableDind": true,
    "dockerHostPathPrefix": "/tmp/gh-aw"
  },
  "chroot": {
    "binariesSourcePath": "/tmp/gh-aw/runner-bin",
    "identity": {
      "home": "/tmp/gh-aw/home",
      "user": "runner",
      "uid": 1001,
      "gid": 1001
    }
  },
  "dind": {
    "preStageDirs": true,
    "workDir": "/tmp/gh-aw",
    "stagingImage": "ghcr.io/github/gh-aw-firewall/agent:latest",
    "stageEngineBinary": {
      "path": "/usr/local/bin/copilot",
      "targetPath": "/usr/local/bin/copilot"
    }
  },
  "runner": {
    "topology": "arc-dind",
    "sysrootImage": "ghcr.io/github/gh-aw-firewall/build-tools:latest"
  }
}
```

## Field behavior

- `chroot.identity.*`: applied inside entrypoint **after** `chroot /host` to override HOME/USER/LOGNAME and identity mapping hints.
- `chroot.binariesSourcePath`: mounts a runner-side binaries directory at `/host/tmp/awf-runner-bin` (inside chroot: `/tmp/awf-runner-bin`) and prepends it to `PATH`, so runner-installed CLIs are visible even when `/usr` comes from the DinD daemon filesystem.
- `dind.preStageDirs`: runs a short-lived staging container in DinD mode to create required workdir tree with open permissions.
- `dind.stageEngineBinary`: copies an engine binary from the runner path into daemon-visible filesystem before compose startup.
- `dind.stagingImage`: image used for short-lived staging containers.
- `dind.workDir`: target root for DinD pre-staged directory tree (`/tmp/gh-aw` default).
- `runner.topology: "arc-dind"`: enables sysroot staging (`sysroot-stage` init service + `sysroot` volume mounted on agent at `/host:rw`).
- `runner.sysrootImage`: optional override for the sysroot image used by `runner.topology=arc-dind`.

## Sysroot staging lifecycle

When `runner.topology` is `arc-dind`, AWF starts a one-shot `sysroot-stage` service that copies
the filesystem from a build-tools image derived from the same `--image-registry` and `--image-tag`
settings as the other AWF containers (unless `runner.sysrootImage` overrides it) into a named
`sysroot` volume. The agent mounts that volume at `/host:rw`.

This image pre-installs root-required system build dependencies (for example gcc/make/cmake,
libssl-dev/libc6-dev/libicu-dev, capsh/gosu/gh) so ARC workflow steps can stay non-root.

## Tool cache path guidance for ARC

If `RUNNER_TOOL_CACHE` points under `/opt` (for example `/opt/hostedtoolcache`) AWF logs a warning
in `runner.topology=arc-dind` mode because `/opt` is commonly not visible from the DinD daemon
filesystem. Prefer a shared runner/daemon path under `/tmp/gh-aw` when possible.

## Auto-detection of split filesystem setups

AWF detects likely ARC/DinD environments at startup and warns when `--docker-host-path-prefix` is missing:

- non-default unix `DOCKER_HOST` socket paths (outside `/var/run/docker.sock` and `/run/docker.sock`)
- loopback TCP `DOCKER_HOST` endpoints (`tcp://localhost:*` or `tcp://127.0.0.1:*`) — the standard ARC RunnerScaleSet DinD sidecar configuration
- `AWF_DIND=1`

## Recommended DinD base image

For ARC DinD chroot workloads, prefer the glibc companion image:

- `ghcr.io/github/gh-aw-firewall/dind-ubuntu:latest`

It includes `docker-ce`, `libcap2-bin` (`capsh`), and Node.js preinstalled.

## Runtime prerequisite

Copilot CLI still requires `node` to be available inside the chrooted runtime PATH.

## Joining `services:` containers to `awf-net` for direct protocol access

On `runner.topology: arc-dind`, GitHub Actions `services:` containers are started
by the runner on the runner's own bridge network (`github_network_<hash>`), while
the AWF agent runs on AWF's isolated `awf-net`. These two bridges are not routed
to each other, so workloads inside the sandbox that need to speak a service's
native wire protocol (database drivers, migration tools, client libraries under
test, etc.) cannot reach `services:` containers — only HTTP(S) egress through
Squid is available from inside the agent.

The existing host-iptables-based service-port routing (`hostServicePorts`) does
not help here: on ARC/DinD, `network.isolation: true` uses the Docker-network
topology and never programs host iptables NAT rules, since network isolation is
enforced entirely at the Docker network level, not at the host firewall level.

### Verified pattern: join the *service* to `awf-net`

The supported workaround is to join the **service container** — never the
agent — onto `awf-net` after AWF creates it, using a pre-step "waiter" that
polls for the network's existence and then attaches the service container to it
with an alias the agent can resolve by name:

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: postgres

steps:
  - name: Attach postgres service to awf-net
    run: |
      # Remove a stale AWF network so the waiter cannot attach to a network
      # that AWF will reclaim. Do this only when no other AWF run is active.
      if docker network inspect awf-net >/dev/null 2>&1; then
        docker network rm awf-net >/dev/null 2>&1 || {
          echo "cannot replace stale awf-net; another AWF run may be active" >&2
          exit 1
        }
      fi

      # Keep the waiter running while the later generated AWF step creates the
      # network. job.services exposes the exact container ID; no image lookup
      # or label is required.
      service_container='${{ job.services.postgres.id }}'
      nohup bash -c '
        for i in $(seq 1 120); do
          if docker network inspect awf-net >/dev/null 2>&1; then
            docker network connect --alias postgres awf-net "$1" && exit 0
          fi
          sleep 1
        done
        echo "awf-net was not created" >&2
        exit 1
      ' -- "$service_container" >/tmp/awf-net-waiter.log 2>&1 &
```

The `nohup` background process must remain alive until the later generated AWF
step starts. Check `/tmp/awf-net-waiter.log` after that step if the service is
not reachable. Once joined, code running inside the AWF sandbox can connect directly to
`postgres:5432` (or whatever alias/port the service exposes) using the
service's native protocol, bypassing the Squid HTTP(S)-only egress path
entirely for that one container-to-container link.

This pattern has been end-to-end validated with 669/669 dotnet/Npgsql
integration tests passing against a Postgres `services:` container joined to
`awf-net` this way.

### Security note

**Only the service container may join `awf-net` — never the agent.** The whole
point of AWF is to restrict what the agent (the untrusted/AI-driven process)
can reach on the network. Joining the *agent* to the runner's own bridge
network (or otherwise bypassing Squid) would defeat the egress firewall
entirely, since traffic on that bridge is not subject to domain allowlisting.
Joining a *service* container is safer than attaching the agent to the runner
bridge, but it brings that service into the security boundary. A service that
supports proxying, outbound callbacks, or command execution can become an
application-layer pivot; for example, do not give the example database a
privileged role unless it is required. Use least-privileged credentials and
constrain the service's outbound access where possible. This attachment does
not itself give the agent a direct route to the runner bridge, but it is not a
guarantee that the service cannot provide an egress path.

### Future direction

A longer-term improvement under consideration is compiler sugar such as
`services.<name>.attach: true`, which would emit the waiter/join steps shown
above automatically instead of requiring hand-written shell in workflow
frontmatter. No such field exists yet — the manual pattern above is the only
currently supported mechanism.

## See also

- [docs/awf-config-spec.md](awf-config-spec.md) — Normative field reference and CLI mapping for all ARC/DinD config fields (`container.dockerHostPathPrefix`, `container.enableDind`, `container.dockerHost`, `chroot.*`, `dind.*`, `runner.*`)
- [docs/awf-config.schema.json](awf-config.schema.json) — Machine-readable JSON Schema for IDE validation
- [docs/environment.md](environment.md) — `DOCKER_HOST` handling, `AWF_DIND`, and split-filesystem guidance
- [docs/network-isolation-design.md](network-isolation-design.md) — `--network-isolation` design and ARC/DinD constraints
