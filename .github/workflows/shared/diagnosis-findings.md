# AWF Diagnosis Findings

<!-- Generated from docs/diagnostics/findings by scripts/diagnostics/cli.ts render. Do not edit by hand. -->

Canonical source: [`docs/diagnostics/`](../../../docs/diagnostics/README.md).
Match the narrowest finding ID. When nothing matches, say so and request the smallest read-only probe.

## Symptom lookup

| Observable symptom | Finding | Boundary | Status |
|---|---|---|---|
| Bind-mounted workspace or config files are empty or missing inside the agent container | A1 | runner | workaround |
| docker compose starts but the mounted path resolves to an empty directory | A1 | runner | workaround |
| no such file or directory for a path that exists on the runner | A1 | runner | workaround |
| Streaming log write fails with read-only file system | A28 | runner | workaround |
| tee: /tmp/gh-aw/pi-streaming.jsonl: Read-only file system | A28 | runner | workaround |
| A successful engine run becomes a failure under arc-dind | A28 | runner | workaround |
| Safe outputs are missing after a streaming engine run | A28 | runner | workaround |
| token-usage.jsonl is missing for post-run consumers on arc-dind | A29 | runner | workaround |
| gh-aw.aic / gen_ai.usage.* telemetry is absent on arc-dind | A29 | runner | workaround |
| The run succeeds but token-usage telemetry is missing | A29 | runner | workaround |
| capsh: not found | A4 | runner | workaround |
| /bin/bash: no such file or directory during chroot startup | A4 | runner | workaround |
| node: not found when the harness binary starts | A4 | runner | workaround |
| uv Permission denied under UV_CACHE_DIR | B36 | runner | fixed |
| uv Permission denied under UV_PYTHON_INSTALL_DIR | B36 | runner | fixed |
| The agent repeatedly chooses its own uv cache directory | B36 | runner | fixed |
| sudo -n fails removing root-owned /tmp/gh-aw during setup or cleanup | B37 | runner | unresolved |
| Copilot or threat-detect installer calls sudo because the compiled command lacks --rootless | B37 | runner | unresolved |
| MCP gateway or safeoutputs container cannot read runner-owned mode 0600 config | B37 | runner | unresolved |
| OCI runtime create failed | RT-001 | runtime | needs-evidence |
| unknown capability reported by the container runtime at start | RT-001 | runtime | needs-evidence |
| unsupported mount reported by the container runtime at start | RT-001 | runtime | needs-evidence |
| The agent container never starts while Squid is healthy | RT-001 | runtime | needs-evidence |
| storage-mount-multiple during artifact-snapshot | RT-002 | runtime | fixed |
| storage-verification/invocation-state fails with storage-mount-propagation | RT-002 | runtime | fixed |
| bounded-artifacts/rootfs-copy fails with ENOSPC | RT-003 | runtime | fixed |
| Cloud Hypervisor enclave stops before rootfs-digest and rootfs-attestation | RT-003 | runtime | fixed |
| preflight-session-log permission-denied | RT-004 | runtime | fixed |
| session-log preflight fails before the enclave engine launches | RT-004 | runtime | fixed |
| TCP_DENIED | NET-001 | network | workaround |
| 403 Forbidden returned by the proxy for an outbound request | NET-001 | network | workaround |
| curl: (56) Received HTTP code 403 from proxy after CONNECT | NET-001 | network | workaround |
| Could not resolve host | NET-002 | network | workaround |
| Temporary failure in name resolution | NET-002 | network | workaround |
| getaddrinfo EAI_AGAIN inside the agent container | NET-002 | network | workaround |
| Configured Ollama port 11434 is routed to port 80 | NET-003 | network | fixed |
| Trusted API-proxy custom-port request is rejected as an unsafe port | NET-003 | network | fixed |
| TLS handshake fails when the client ignores HTTPS_PROXY | NET-004 | network | workaround |
| Raw ClientHello reaches Squid instead of an HTTP CONNECT request | NET-004 | network | workaround |
| Connection to a host-published service (for example Redis or PostgreSQL) through the host gateway is rejected or times out | NET-005 | network | fixed |
| The port is listed in --allow-host-service-ports but a connectivity check still fails | NET-005 | network | fixed |
| Every CONNECT fails with 503 HIER_NONE after startup on OpenShift or ARO | NET-006 | network | workaround |
| The awf-net subnet contains the DNS resolver(s) | NET-006 | network | workaround |
| The awf-net subnet overlaps existing host route(s) | NET-006 | network | workaround |
| a network with name awf-net exists but was not created for project "awf-<timestamp>" | NET-007 | network | fixed |
| Compose fails before the agent or Squid starts, after a previous run was killed or timed out | NET-007 | network | fixed |
| Resolver or DNS-policy logs show lookups for a hostname the agent was denied (TCP_DENIED / 403) in default mode | NET-008 | network | fixed |
| A hostname is refused by Squid but its name still appears in DNS telemetry | NET-008 | network | fixed |
| Every CONNECT to an allowlisted API host fails with 503 TCP_TUNNEL:HIER_NONE and an empty server field (-:-) in network-isolation (topology) mode | NET-009 | network | workaround |
| The same workflow succeeds in host-access mode, or in isolation mode when no Tailscale step runs | NET-009 | network | workaround |
| Agent retries report 503 Service Unavailable from the model endpoint while the allowlist already contains the host | NET-009 | network | workaround |
| ports are not supported in domain entries | NET-010 | network | workaround |
| URL paths and queries are not supported in domain entries | NET-010 | network | workaround |
| unsupported scheme | NET-010 | network | workaround |
| user information is not supported | NET-010 | network | workaround |
| AWF resources remain (network:awf-net). Lease retained | NET-011 | network | fixed |
| docker compose down cannot remove awf-net because the network is still in use after the agent, detection and safe outputs succeeded | NET-011 | network | fixed |
| An empty awf-net is left on a self-hosted runner after the MCP gateway container was stopped | NET-011 | network | fixed |
| 400 Bad Request: Authorization header is badly formatted | AUTH-001 | auth | fixed |
| Copilot requests fail immediately against api.enterprise.githubcopilot.com or api.business.githubcopilot.com | AUTH-001 | auth | fixed |
| api-proxy reports that no OIDC token could be minted | AUTH-002 | auth | workaround |
| Provider requests fail with 401 while AWF_AUTH_TYPE=github-oidc is set | AUTH-002 | auth | workaround |
| ACTIONS_ID_TOKEN_REQUEST_URL is not available to the sidecar | AUTH-002 | auth | workaround |
| mcpg / HTTP MCP GitHub server returns 401 for github-oidc authentication | AUTH-003 | auth | workaround |
| Gateway configuration contains no OIDC auth metadata | AUTH-003 | auth | workaround |
| MCP GitHub tool calls fail while provider inference still works | AUTH-003 | auth | workaround |
| Anthropic OIDC initialization fails until the API-proxy token retry | AUTH-004 | auth | fixed |
| Agent exhausts early 503 retries while the API proxy has no token | AUTH-004 | auth | fixed |
| Client receives 502 with error "Upstream response could not be safely inspected" | AUTH-005 | auth | workaround |
| Client message "Unsupported upstream response content encoding" | AUTH-005 | auth | workaround |
| Upstream response is aborted mid-stream with a request_error log event while the provider is healthy | AUTH-005 | auth | workaround |
| Copilot Decisions (evals) request using the reported fine-grained PAT returns HTTP 400 with a plain-text body containing "Personal Access Tokens are not supported for this endpoint" | AUTH-006 | auth | workaround |
| A standalone gh-aw evals judge fails as an opaque "Decisions request failed (HTTP 400)" and the run stays green | AUTH-006 | auth | workaround |
| The same 400 occurs for every model name, including invalid ones, because the token is rejected before model validation | AUTH-006 | auth | workaround |
| awf config validation reports that config.apiProxy.auth.provider must be one of azure, aws, gcp, anthropic, databricks (openai is absent from the list) | AUTH-007 | auth | unresolved |
| OpenAI native WIF works when AWF_AUTH_PROVIDER=openai is set in the environment but fails when the same value is set through the AWF config file | AUTH-007 | auth | unresolved |
| Provider requests fail with 404 "OpenAI proxy not configured" (or the equivalent not-configured response) although AWF_AUTH_TYPE=github-oidc and AWF_AUTH_PROVIDER=azure, aws, gcp or databricks are set | AUTH-008 | auth | workaround |
| The api-proxy logs cloud_oidc_not_bound (info) for an unselected adapter or a target that does not match the selected origin, or cloud_oidc_target_refused (warn) for a selected target refused by first-party or Databricks workspace-origin checks | AUTH-008 | auth | workaround |
| safe output validation failed in the workflow run | CI-001 | ci | workaround |
| The agent job succeeds but the safe-output collection step exits non-zero | CI-001 | ci | workaround |
| create-pull-request rejected: file not in allowed-files | CI-001 | ci | workaround |
| Enclave initialize returns 503 backend_unavailable | CI-002 | ci | workaround |
| AWF host gateway readiness fails before primary-agent startup | CI-002 | ci | workaround |
| cloud-hypervisor-enclave-admission-token-acquisition | CI-003 | ci | fixed |
| Cloud Hypervisor regression profiles reject before broker startup | CI-003 | ci | fixed |
| AWF_ENCLAVE_REGRESSION_FINALIZATION | CI-004 | ci | fixed |
| Enclave agent regression fails although the invocation result validated | CI-004 | ci | fixed |
| AWF-REGRESSION-COMPLETE not found although the agent exited 0 | CI-005 | ci | fixed |
| Codex routing evidence rejected after successful inference | CI-005 | ci | fixed |
| Claude enclave agent exit 1 before stream initialization | CI-006 | ci | fixed |
| classification unknown-option or invalid-option-value in enclave startup diagnostics | CI-006 | ci | fixed |
| Enclave regression stops at gateway attachment before the agent starts | CI-007 | ci | fixed |
| Smoke enclave job times out because the gateway cannot resolve awf-enclave-mcp | CI-007 | ci | fixed |
| Host preflight gateway-attachment fails at network-membership | CI-007 | ci | fixed |
| Agentic workflow reports an engine crash or incomplete result although the agent never started | CI-008 | ci | fixed |
| Install GitHub Copilot CLI step fails after repeated HTTP 504 responses while downloading the checksum manifest | CI-008 | ci | fixed |
| Smoke workflow exhausts its execution timeout during a cold local Docker image build | CI-008 | ci | fixed |
| AWF invocation combines a compiler-pinned image manifest with --build-local | CI-008 | ci | fixed |
| Maintenance workflow npm ci fails certificate verification against a blocked package mirror | CI-008 | ci | fixed |
| Supply Chain Scan image-scans job cancelled after exhausting its 40-minute timeout | CI-009 | ci | workaround |
| PR-image scan stops during a container image build rather than at a Grype High/Critical finding | CI-009 | ci | workaround |
| Slow apt index or package downloads dominate a build-tools image layer | CI-009 | ci | workaround |
| bwrap: Failed to make / slave: Operation not permitted | CI-010 | ci | fixed |
| Codex enclave agent exit 0 with failure category result-empty | CI-010 | ci | fixed |
| Codex inference succeeds but the diagnostic shell command never runs | CI-010 | ci | fixed |
| Copilot credential is not isolated | CI-011 | ci | fixed |
| Copilot placeholder contract is unavailable | CI-011 | ci | fixed |
| Codex regression stalls on inherited stdin | CI-011 | ci | fixed |
| Codex attempts direct OpenAI inference with a placeholder credential under Cloud Hypervisor or NVX | CI-011 | ci | fixed |
| Failure classification: missing_terminal_safe_output with driver exit code 0 | CI-012 | ci | fixed |
| Safe-output MCP calls observed: 0 although the agent finished with a text response | CI-012 | ci | fixed |
| Scheduled optimizer run finishes with no issue, no noop and no report_incomplete | CI-012 | ci | fixed |
| The agent container can reach a domain that is not allowlisted | SEC-001 | security | needs-evidence |
| A provider credential is observable inside the agent environment while the api-proxy is enabled | SEC-001 | security | needs-evidence |
| Egress succeeds without a corresponding Squid access-log entry | SEC-001 | security | needs-evidence |

## Boundary: runner

### A1 — Bind-mounted files are missing inside containers on ARC / DinD split filesystems

- **Boundary:** runner · **Status:** workaround
- **Affects:** runner=arc-dind, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Bind-mounted workspace or config files are empty or missing inside the agent container · docker compose starts but the mounted path resolves to an empty directory · no such file or directory for a path that exists on the runner
- **Discriminating conditions:** Runner and Docker daemon do not share a filesystem (ARC with a DinD sidecar) · DOCKER_HOST points at the sidecar daemon rather than the runner's own socket · No --docker-host-path-prefix / container.dockerHostPathPrefix is configured
- **Root cause:** Bind-mount sources are runner filesystem paths that the DinD Docker daemon cannot resolve, so the daemon creates empty directories instead of mounting the runner's content.
- **Safe probe:** `docker -H "$DOCKER_HOST" run --rm -v /tmp:/tmp alpine ls /tmp` → The listing is missing a sentinel file created on the runner under /tmp, confirming a split filesystem.
- **Action:** Set --docker-host-path-prefix (for example /tmp/gh-aw) or container.dockerHostPathPrefix so bind-mount sources are rewritten to paths the daemon can resolve. Kernel virtual filesystems (/dev, /sys, /proc) are intentionally not prefixed.
- **Related:** A4
- **Provenance:** issue: ARC split-filesystem bind mounts (https://github.com/github/gh-aw-firewall/issues/5753) · doc: ARC / DinD split filesystem support (docs/arc-dind.md) · code: translateBindMountHostPath() (src/services/agent-volumes.ts) · test: src/services/agent-volumes-arc-dind-staging.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### A28 — ARC/DinD streaming logs target a read-only parent mount

- **Boundary:** runner · **Status:** workaround
- **Affects:** runner=arc-dind, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Streaming log write fails with read-only file system · tee: /tmp/gh-aw/pi-streaming.jsonl: Read-only file system · A successful engine run becomes a failure under arc-dind · Safe outputs are missing after a streaming engine run
- **Discriminating conditions:** runner.topology is arc-dind · Pi writes its streaming log directly beneath ${RUNNER_TEMP}/gh-aw · The parent ${RUNNER_TEMP}/gh-aw mount is read-only
- **Root cause:** Pi's tee targets a streaming log beneath a read-only parent mount; pipefail turns an otherwise successful Pi run into a failure.
- **Safe probe:** `findmnt -T "${RUNNER_TEMP}/gh-aw" -o TARGET,OPTIONS; findmnt -T "${RUNNER_TEMP}/gh-aw/sandbox/agent" -o TARGET,OPTIONS` → The parent mount is read-only and the sandbox/agent mount is writable; no files are created or modified.
- **Action:** The gh-aw compiler must place Pi's log at /tmp/gh-aw/sandbox/agent/logs/pi-streaming.jsonl and update the step-summary parser, session exporters, and artifact paths to match the runner-visible mount source. Until then, create the real log file at the runner-side sandbox/agent/logs path in a pre-step, symlink the compiled tee path to that file, and add an explicit :rw sandbox.agent.mounts file entry whose destination is /tmp/gh-aw/sandbox/agent/logs/pi-streaming.jsonl. Keep the compatibility symlink separate from the mount destination: AWF rejects a symlink as a bind-mount target. Do not make the parent mount writable. AWF's writable child mount is available since github/gh-aw-firewall#9188.
- **Provenance:** issue: ARC/DinD streaming log write failure (https://github.com/github/gh-aw-firewall/issues/9183) · issue: Pi streaming log on ARC/DinD (https://github.com/github/gh-aw/issues/69406) · pull-request: Retain writable sandbox/agent mount (https://github.com/github/gh-aw-firewall/pull/9188) · doc: ARC / DinD documentation (docs/arc-dind.md) · test: src/services/agent-volumes-arc-dind-staging.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### A29 — ARC/DinD api-proxy token-usage log not found at /tmp/gh-aw

- **Boundary:** runner · **Status:** workaround
- **Affects:** runner=arc-dind, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** token-usage.jsonl is missing for post-run consumers on arc-dind · gh-aw.aic / gen_ai.usage.* telemetry is absent on arc-dind · The run succeeds but token-usage telemetry is missing
- **Discriminating conditions:** runner.topology is arc-dind · The compiler passes ${RUNNER_TEMP}/gh-aw log directories but the consumer hardcodes /tmp/gh-aw · A second sub-case uses --docker-host-path-prefix /tmp with --proxy-logs-dir outside /tmp, rewriting the bind source to /tmp<dir>
- **Root cause:** The token-usage file lives under the runner/daemon-visible log directory, not a fixed /tmp/gh-aw path. Consumers cannot predict that path. With a shared /tmp prefix and a log directory outside /tmp, AWF also reported and repaired the original, empty directory rather than the rewritten bind source.
- **Safe probe:** `printf '%s\n' "${AWF_TOKEN_USAGE_LOG:-unset}"; ls -l "${AWF_TOKEN_USAGE_LOG:-/dev/null}"` → After a patched AWF run that writes token usage, AWF_TOKEN_USAGE_LOG is set in a later job step and the file exists; no file contents or credentials are printed.
- **Action:** Upgrade AWF to v0.28.31 or newer, which includes github/gh-aw-firewall#9357. Read $AWF_TOKEN_USAGE_LOG (or the 'Token usage log available at:' log line) instead of hardcoding /tmp/gh-aw. AWF exports the path to $GITHUB_ENV only when the file exists and pre-creates the rewritten api-proxy log directory with mode 0777 and a warning. gh-aw's parse_token_usage.cjs must still adopt AWF_TOKEN_USAGE_LOG; the end-to-end fix remains unresolved.
- **Provenance:** issue: Missing token-usage telemetry on ARC/DinD (https://github.com/github/gh-aw-firewall/issues/9352) · pull-request: Report and export the api-proxy token-usage log path (released in v0.28.31) (https://github.com/github/gh-aw-firewall/pull/9357) · doc: Locating API proxy token-usage logs (docs/arc-dind.md#locating-api-proxy-token-usage-logs) · test: src/artifact-preservation-token-usage.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### A4 — capsh, /bin/bash, or node missing inside the DinD chroot

- **Boundary:** runner · **Status:** workaround
- **Affects:** runner=arc-dind, runtime=chroot, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** capsh: not found · /bin/bash: no such file or directory during chroot startup · node: not found when the harness binary starts
- **Discriminating conditions:** The Docker daemon host image is Alpine/musl based · Chroot mode is active (default agent execution mode)
- **Root cause:** The musl-based daemon host lacks the glibc tooling that chroot mode expects to bind into the agent container.
- **Safe probe:** `docker info --format '{{.OperatingSystem}}'` → Read the configured daemon's OS label and compare with the operator-managed DinD image. A generic label is inconclusive; starting an Alpine probe container would describe that container, not prove the daemon host's libc.
- **Action:** Use a glibc DinD image such as ghcr.io/github/gh-aw-firewall/dind-ubuntu:latest for the Docker-in-Docker sidecar.
- **Related:** A1
- **Provenance:** doc: DinD image requirements (docs/arc-dind.md) · doc: Runner failure-mode catalog (A4) (.github/workflows/shared/self-hosted-failure-modes.md) · code: chroot setup (containers/agent/entrypoint.sh)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### B36 — setup-uv paths under RUNNER_TEMP are unwritable with --env-all

- **Boundary:** runner · **Status:** fixed
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** uv Permission denied under UV_CACHE_DIR · uv Permission denied under UV_PYTHON_INSTALL_DIR · The agent repeatedly chooses its own uv cache directory
- **Discriminating conditions:** The workflow uses runtimes: uv and AWF is invoked with --env-all · setup-uv sets UV_CACHE_DIR or UV_PYTHON_INSTALL_DIR beneath RUNNER_TEMP outside the mounted gh-aw subtree
- **Root cause:** --env-all forwarded setup-uv cache and Python-install paths beneath RUNNER_TEMP into the agent, but only RUNNER_TEMP/gh-aw is mounted and that mount is read-only, leaving those paths unwritable.
- **Safe probe:** `printf '%s\n' "${UV_CACHE_DIR:-unset}" "${UV_PYTHON_INSTALL_DIR:-unset}"` → On unpatched AWF, the variables point beneath RUNNER_TEMP outside the mounted gh-aw subtree; on patched AWF they are unset unless explicitly overridden. When unset on Linux without XDG overrides, UV_CACHE_DIR defaults to $HOME/.cache/uv and UV_PYTHON_INSTALL_DIR defaults to $HOME/.local/share/uv/python. No files are written.
- **Action:** Upgrade AWF to include github/gh-aw-firewall#9705. AWF drops unmounted absolute paths beneath RUNNER_TEMP when forwarding host variables; explicit --env values still override the filter. Keep these cache directories unwritable so setup-uv cannot save agent-written files into the repository-wide Actions cache. Disabling setup-uv caching is tracked on the gh-aw compiler side.
- **Provenance:** issue: setup-uv cache paths are unwritable inside AWF (https://github.com/github/gh-aw-firewall/issues/9701) · pull-request: Drop unmounted RUNNER_TEMP paths from --env-all (https://github.com/github/gh-aw-firewall/pull/9705) · code: Filter unmounted runner-temp environment paths (src/services/agent-environment/env-passthrough.ts) · test: Covers setup-uv paths and --env-all filtering (src/services/agent-environment/env-passthrough.test.ts)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### B37 — No-sudo self-hosted VM blocked by gh-aw compiler and setup commands

- **Boundary:** runner · **Status:** unresolved
- **Affects:** runner=self-hosted, runtime=runc|chroot, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** sudo -n fails removing root-owned /tmp/gh-aw during setup or cleanup · Copilot or threat-detect installer calls sudo because the compiled command lacks --rootless · MCP gateway or safeoutputs container cannot read runner-owned mode 0600 config
- **Discriminating conditions:** Shared self-hosted Linux VM without passwordless sudo; not ARC/DinD and runner.topology is unset · Concurrent runners have separate work directories but share /tmp/gh-aw · Compiled install_copilot_cli.sh or install_threat_detect_binary.sh commands lack --rootless · Reported with gh-aw 1.0.1 and AWF v0.29.0; AWF already preserves the runner primary GID
- **Root cause:** These are gh-aw compiler/setup behaviors, not AWF runtime defects. Merged gh-aw#75443 fixes the confirmed safeoutputs child-container identity omission while preserving owner-only config permissions; #75445 adds runner.installation and #75446 adds automatic rootless fallback when passwordless sudo is unavailable. The reported gateway failure remains unverified because the v1.0.1 gateway generator already emits --user ${MCP_GATEWAY_UID}:${MCP_GATEWAY_GID}; reconcile it with the original lock and compiler metadata. Merged #75444 improves unprivileged cleanup but leaves legacy /tmp/gh-aw cleanup and full per-run private runtime-root isolation unresolved. Keep release bounds unknown.
- **Safe probe:** `for installer in install_copilot_cli.sh install_threat_detect_binary.sh; do printf '%s total/rootless:\n' "$installer"; grep -h -F -- "$installer" .github/workflows/*.lock.yml | awk 'BEGIN { total = 0; rootless = 0 } { total++; if (index($0, "--rootless")) rootless++ } END { print total, rootless }'; done` → For each installer, compare total matching command lines with those carrying --rootless. A smaller rootless count identifies commands to inspect on a no-sudo runner, not proof of a cleanup or container-identity defect. Only names and counts are printed; no files are changed. The 2026-11-08 scan reported 81 Copilot and 17 threat-detect installs with zero --rootless matches; counts are snapshot evidence, not invariants.
- **Action:** On gh-aw revisions containing PRs #75445 and #75446, set runner.installation: rootless when rootless installation is required; #75446 also falls back to rootless installation when passwordless sudo is unavailable. PR #75443 fixes the confirmed safeoutputs child identity omission; retain mode 0600 config permissions. These changes do not establish that shared /tmp/gh-aw cleanup or full per-run private runtime-root isolation is resolved: #75444 leaves legacy cleanup and runtime-path migration incomplete. Verify the compiled lock and compiler metadata, keep release bounds unknown, and reconcile any reported gateway identity failure with the original artifact because the v1.0.1 generator already emits --user. Do not add passwordless sudo or widen permissions, and do not treat a renamed shared directory as run-scoped isolation.
- **Provenance:** issue: Self-hosted VM without sudo still needs four post-compile workarounds (https://github.com/github/gh-aw-firewall/issues/11130) · issue: MCP container identity and owner-only config access (https://github.com/github/gh-aw/issues/75439) · issue: Rootless threat-detect installation on native self-hosted runners (https://github.com/github/gh-aw/issues/75440) · issue: Private runtime root and run-scoped cleanup without sudo (https://github.com/github/gh-aw/issues/75441) · issue: No-sudo Copilot installation in agent and detection jobs (https://github.com/github/gh-aw/issues/75442) · pull-request: Use effective runner identity for safeoutputs child containers (https://github.com/github/gh-aw/pull/75443) · pull-request: Improve unprivileged cleanup; full runtime isolation remains incomplete (https://github.com/github/gh-aw/pull/75444) · pull-request: Add runner.installation rootless option (https://github.com/github/gh-aw/pull/75445) · pull-request: Automatically fall back to rootless installation without sudo (https://github.com/github/gh-aw/pull/75446) · doc: ARC/DinD topology differs from native self-hosted runners (docs/arc-dind.md)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

## Boundary: runtime

### RT-001 — Alternative container runtime rejects the AWF agent container configuration

- **Boundary:** runtime · **Status:** needs-evidence
- **Affects:** runner=self-hosted, runtime=gvisor|kata, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** OCI runtime create failed · unknown capability reported by the container runtime at start · unsupported mount reported by the container runtime at start · The agent container never starts while Squid is healthy
- **Discriminating conditions:** AWF explicitly selects an alternative OCI runtime, or the Docker daemon defaults to one; docker info alone does not prove a per-service selection · The failure happens at container create/start time, before any user command runs
- **Root cause:** unknown - alternative runtimes implement mounts, capabilities, and seccomp differently from runc; the specific unsupported feature must be identified from the runtime error before a fix is asserted.
- **Safe probe:** `docker info --format '{{.DefaultRuntime}} {{range $k,$v := .Runtimes}}{{$k}} {{end}}'` → Shows daemon runtime availability/default only. Compare the explicit containerRuntime setting and selected service runtime before attributing the error; a non-runc default alone is not proof.
- **Action:** Record the selected runtime, exact create/start error and runtime version, then consult docs/gvisor-integration.md and docs/compatibility.md. gVisor uses static service DNS and proxy-only egress rather than the iptables-init path; do not infer identical behavior for Kata or microVM backends. Collect evidence rather than disabling seccomp or capabilities.
- **Related:** A4
- **Provenance:** doc: gVisor integration (docs/gvisor-integration.md) · doc: Supported platforms (docs/compatibility.md) · code: Runtime detection (src/container-runtime.ts) · test: src/container-lifecycle-gvisor.test.ts · test: src/container-runtime.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### RT-002 — Cloud Hypervisor enclave storage inherits shared mount propagation

- **Boundary:** runtime · **Status:** fixed
- **Affects:** runner=github-hosted, runtime=cloud-hypervisor, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** storage-mount-multiple during artifact-snapshot · storage-verification/invocation-state fails with storage-mount-propagation
- **Discriminating conditions:** Cloud Hypervisor host enclave storage is beneath a shared allocation parent or separate shared invocation destination · For the invocation case, sourceBeforeBind is private, destinationBeforeBind is shared, and invocationVerified is [1,1,1,0] while other verified roles are private · A generic storage-mount-propagation reason alone does not distinguish shared, missing or ambiguous entries
- **Root cause:** Nested binds in an overlapping shared allocation can propagate duplicate mounts. Independently, a private state source bound beneath a shared external destination inherits shared propagation; privatizing only the allocation does not privatize that destination bind.
- **Safe probe:** `jq '.enclaveStartup | {startupChecks, mountTopology, storagePropagation}' path/to/protected/awf-startup-error.json` → As the owning host operator, read only the bounded startup-error descriptor projection. One exact shared invocation entry distinguishes destination inheritance from missing or duplicate matches. Collected startup.json preserves the checklist but can omit topology/propagation; absence is unknown.
- **Action:** Use source containing both allocation-private and invocation-state-private fixes, with release-matched trusted artifacts. Current code verifies the journal, privatizes only the captured mount and rechecks exact identity/options. Never change host-wide propagation, choose a topmost duplicate, or relax cleanup. Fixed source does not prove a released version or guest acceptance.
- **Related:** RT-003
- **Provenance:** pull-request: Allocation propagation fix (https://github.com/github/gh-aw-firewall/pull/9530) · pull-request: Invocation destination fix and v0.28.44 evidence (https://github.com/github/gh-aw-firewall/pull/9536) · code: src/cloud-hypervisor/trusted-enclave-storage.ts · test: src/cloud-hypervisor/trusted-enclave-storage.test.ts · test: Privileged Linux cases; not macOS acceptance (src/cloud-hypervisor/enclave-trusted-storage.integration.test.ts) · doc: docs/cloud-hypervisor-foundation.md#private-invocation-state-mount
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### RT-003 — Shared enclave rootfs exceeds the host verification storage ceiling

- **Boundary:** runtime · **Status:** fixed
- **Affects:** runner=github-hosted, runtime=cloud-hypervisor, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** bounded-artifacts/rootfs-copy fails with ENOSPC · Cloud Hypervisor enclave stops before rootfs-digest and rootfs-attestation
- **Discriminating conditions:** The shared rootfs copy allocates more than the older 2 GiB host verification domain · The explicit rootfs-copy check reports ENOSPC; generic rsync failure or logical file size alone is insufficient
- **Root cause:** The shared toolchain rootfs required about 2.44 GiB of allocated copy storage, exceeding the previous 2 GiB host-only verification ceiling before digest or attestation could run.
- **Safe probe:** `jq '.diagnostic.enclaveStartup.startupChecks' path/to/protected/startup.json` → Find failed bounded-artifacts/rootfs-copy with ENOSPC and later not-attempted checks; read bounded-cleanup separately. EACCES, EIO or an absent copy check does not establish capacity exhaustion.
- **Action:** Use source with the 4 GiB host verification/image-staging ceiling and per-role temporary-copy release, keeping guest writable limits, immutable artifacts, digest/attestation checks and cleanup guards unchanged. Preserve startup and cleanup evidence even when verification fails; do not infer a fixed release tag.
- **Related:** RT-002
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11239 · code: src/cloud-hypervisor/trusted-enclave-storage.ts · code: src/cloud-hypervisor/enclave-artifact-preflight.ts · test: src/cloud-hypervisor/trusted-enclave-preflight.test.ts · test: src/cloud-hypervisor/host-enclave-executor.test.ts · doc: docs/cloud-hypervisor-foundation.md
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### RT-004 — Cloud Hypervisor enclave transcript writer fails session-log preflight

- **Boundary:** runtime · **Status:** fixed
- **Affects:** runner=github-hosted, runtime=cloud-hypervisor, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** preflight-session-log permission-denied · session-log preflight fails before the enclave engine launches
- **Discriminating conditions:** A static public-only eligible Cloud Hypervisor invocation retains a protected operation-error for preflight-session-log · The legacy session-state ownership or virtio-fs mapping does not match the fixed trusted entrypoint writer identity
- **Root cause:** The trusted transcript writer previously encountered storage owned for a different identity, while virtio-fs squashed guest root into the non-root engine identity. Append-open preflight failed before any inference or engine exit.
- **Safe probe:** `jq '{primaryFailure: (.primaryFailure | {stage, status, operation, category, errno}), stages: [.stages[] | select(.operation == "preflight-session-log") | {stage, status, operation, category, errno}]}' path/to/protected/diagnostics.json` → Read only the protected projection's operation/category/errno fields for preflight-session-log. The protected diagnostics.json primaryFailure and stages remain useful when enclave-session.log is empty; missing projected evidence is not success and does not by itself prove a credential problem.
- **Action:** Use matching staging and guest code from the writer-identity fix: root-owned 0700 session-state, 0600 transcript, exact trusted transcript export and append-open validation. Engine children remain permanently non-root. Do not chmod arbitrary host paths, broaden exports or disable root squashing globally. Live VM/provider acceptance remains separate.
- **Related:** CI-003
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11275 · code: src/cloud-hypervisor/enclave-invocation-staging.ts · code: containers/enclave/agent-entrypoint.py · code: guest/microvm-supervisor/runtime_linux.go · test: guest/microvm-supervisor/session_log_linux_test.go · test: src/enclave/invocation-staging.test.ts · doc: docs/cloud-hypervisor-foundation.md#public-fixture-enclave-debugging
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

## Boundary: network

### NET-001 — Squid denies a request because the domain is not in the allowlist

- **Boundary:** network · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** TCP_DENIED · 403 Forbidden returned by the proxy for an outbound request · curl: (56) Received HTTP code 403 from proxy after CONNECT
- **Discriminating conditions:** The destination host resolves but Squid logs TCP_DENIED:HIER_NONE for it · The domain (or its parent domain) is absent from --allow-domains / network.allowDomains
- **Root cause:** Egress filtering is working as designed: the requested domain is not covered by the generated Squid domain ACL.
- **Safe probe:** `docker exec awf-squid awk '/TCP_DENIED/ { print $1, $2, $3, $7, $8 }' /var/log/squid/access.log | tail -20` → Shows timestamp, client, host, status, and decision for denied traffic; the host is absent from the allowlist.
- **Action:** Add the specific required domain (not a broad wildcard) to the allowlist after confirming it is expected traffic. Keep egress filtering on; if the denial looks like exfiltration, route to SEC-001.
- **Related:** NET-002, SEC-001
- **Provenance:** doc: Domain allowlisting (docs/egress-filtering.md) · doc: Squid log queries (docs/logging_quickref.md) · code: generateSquidConfig() domain ACLs (src/squid-config.ts) · test: src/squid-config-domains.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### NET-002 — DNS resolution fails because the resolver is not in the trusted DNS server list

- **Boundary:** network · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Could not resolve host · Temporary failure in name resolution · getaddrinfo EAI_AGAIN inside the agent container
- **Discriminating conditions:** The configured resolver is not 127.0.0.11 and not listed in --dns-servers / AWF_DNS_SERVERS · HTTP/HTTPS to allowlisted domains also fails before any proxy log entry appears
- **Root cause:** Host and container iptables rules only permit DNS to the trusted resolvers configured through --dns-servers, so traffic to any other resolver is dropped to prevent DNS-based exfiltration.
- **Safe probe:** `docker exec awf-agent sh -c 'if [ -f /host/etc/resolv.conf ]; then cat /host/etc/resolv.conf; else cat /etc/resolv.conf; fi'` → Read the chroot-visible resolver file when present and compare with the explicit trusted DNS list. A matching resolver rules out this particular mismatch; EAI_AGAIN or SERVFAIL alone does not establish a filtering cause.
- **Action:** For a proven resolver-list mismatch, pass the environment's resolver explicitly with --dns-servers instead of disabling DNS filtering. If resolvers match, investigate reachability, daemon topology and upstream SERVFAIL separately. Current Squid config limits negative DNS caching to one second and DNS timeout to ten seconds; an allowlisted-domain failure is not automatically an ACL denial.
- **Related:** NET-001
- **Provenance:** doc: Network issues (docs/troubleshooting.md) · code: DNS restriction rules (src/host-iptables.ts) · code: AWF_DNS_SERVERS handling (containers/agent/setup-iptables.sh) · test: src/host-iptables-network.test.ts · pull-request: https://github.com/github/gh-aw-firewall/pull/8171 · code: src/squid/config-sections.ts · test: src/squid/config-sections.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### NET-003 — Custom provider upstream port is lost or rejected by Squid

- **Boundary:** network · **Status:** fixed
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Configured Ollama port 11434 is routed to port 80 · Trusted API-proxy custom-port request is rejected as an unsafe port
- **Discriminating conditions:** An operator configures a provider URL with an explicit non-default HTTP or HTTPS port · The request originates from the trusted API-proxy sidecar and the exact configured host/port is authorized; agent-origin custom-port denial remains expected
- **Root cause:** Older provider target handling discarded explicit ports. Preserving the port also requires an exact trusted-sidecar Squid exception; broad Safe_ports changes would incorrectly change agent policy.
- **Safe probe:** `grep -E '^(acl api_upstream_[0-9]+_(host|port)|http_access allow api_upstream_source)' path/to/squid.conf` → Compare the generated exact destination/port ACLs with the redacted operator configuration; inspect no provider credentials, raw URLs or request headers.
- **Action:** Use source containing end-to-end scheme/port/base-path preservation and exact API-proxy-source host/port ACLs, then regenerate configuration. Keep Safe_ports, dangerous-port rejection, agent isolation, destination blocklists and DLP unchanged. A denial from an untrusted source or mismatched host/port is not this regression.
- **Related:** NET-001
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/10776 · code: src/squid/api-proxy-upstreams.ts · test: src/squid/api-proxy-upstreams.test.ts · test: containers/api-proxy/server.target-ports.test.js · doc: docs/awf-config-spec.md · pull-request: Trusted LLM service routing keeps the sidecar upstream exact and proxy-only (https://github.com/github/gh-aw-firewall/pull/11345) · pull-request: Azure Foundry target shares the exact custom-port sidecar upstream path (https://github.com/github/gh-aw-firewall/pull/11363) · code: resolveApiProxyUpstreams() emits custom-port and trusted-service proxyOnly upstreams (src/services/api-proxy-env-config.ts) · test: Trusted service admits only the proxy source to the exact HTTPS service (src/trusted-service.test.ts)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### NET-004 — Proxy-unaware HTTPS client sends raw TLS to the forward proxy

- **Boundary:** network · **Status:** workaround
- **Affects:** runner=any, runtime=runc|chroot, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** TLS handshake fails when the client ignores HTTPS_PROXY · Raw ClientHello reaches Squid instead of an HTTP CONNECT request
- **Discriminating conditions:** The Compose runtime uses iptables DNAT for port 443 as defense in depth · The client does not use the configured forward proxy; this is not the gVisor proxy-only path · A TLS error alone does not prove a domain ACL denial or certificate failure
- **Root cause:** Squid's explicit forward-proxy listener expects HTTP CONNECT, not a raw TLS ClientHello. DNAT blocks bypass attempts but cannot translate TLS into CONNECT.
- **Safe probe:** `grep -nE 'HTTPS_PROXY|https_proxy|JAVA_TOOL_OPTIONS' containers/agent/entrypoint.sh` → Review checked-in proxy setup and the client's documented proxy support without dumping its environment or sending traffic; verify whether the client uses CONNECT.
- **Action:** Configure the client to use AWF's explicit HTTPS forward proxy. JVM clients can use injected system properties, while Maven needs settings.xml proxy configuration. Do not treat raw-TLS rejection as a reason to bypass Squid, open direct egress or disable certificate checks.
- **Related:** NET-001, RT-001
- **Provenance:** code: containers/agent/setup-iptables.sh · code: containers/agent/entrypoint.sh · code: src/services/agent-environment/core-environment.ts · doc: docs/troubleshooting.md
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### NET-005 — Published host-service port is rejected after Docker DNAT despite --allow-host-service-ports

- **Boundary:** network · **Status:** fixed
- **Affects:** runner=any, runtime=runc|chroot, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Connection to a host-published service (for example Redis or PostgreSQL) through the host gateway is rejected or times out · The port is listed in --allow-host-service-ports but a connectivity check still fails
- **Discriminating conditions:** Host access is enabled and the service port is allowed for the AWF gateway · Docker translates the published port before the DOCKER-USER chain, so the filter sees the container address and port rather than the gateway tuple · Observed on Ubuntu 26.04 / Docker 29 runners; other Docker versions are unknown · A rejection of a port that is not allowed, or of a direct container address, is expected policy rather than this defect
- **Root cause:** Gateway-destination ACCEPT rules matched the post-DNAT destination, so published-service traffic fell through to the default reject. Matching conntrack's original gateway IP and port restores access without allowing direct container destinations.
- **Safe probe:** `grep -n -- '--ctorigdst' src/host-iptables-rules.ts` → Confirm the checked-out source adds a conntrack DNAT rule scoped to the original gateway IP and allowed port; compare with the redacted operator port list without sending traffic or dumping environments.
- **Action:** Use source containing the original-gateway-tuple conntrack rule and re-run with the required ports in --allow-host-service-ports. Keep host access gateway-scoped and limited to the listed ports. A failure for a port outside the configured list is expected.
- **Related:** NET-001
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11083 · code: src/host-iptables-rules.ts · test: src/host-iptables-host-access.test.ts · doc: docs/usage.md
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### NET-006 — awf-net subnet collides with host or cluster DNS resolver or routes

- **Boundary:** network · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Every CONNECT fails with 503 HIER_NONE after startup on OpenShift or ARO · The awf-net subnet contains the DNS resolver(s) · The awf-net subnet overlaps existing host route(s)
- **Discriminating conditions:** The default awf-net subnet 172.30.0.0/24 sits inside a cluster service CIDR (for example 172.30.0.0/16) whose CoreDNS ClusterIP is 172.30.0.10, the address AWF assigns to Squid · A nameserver from --dns-servers or the host resolv.conf falls inside the awf-net subnet, or a non-Docker host route overlaps it · Routes owned by Docker bridges (br-, docker, veth, awf, fw-bridge) are ignored by the collision check; the default route is ignored
- **Root cause:** The awf-net subnet and Squid address were hardcoded to 172.30.0.0/24 and 172.30.0.10. Squid templated its DNS nameserver from the host resolver, so a resolver inside the subnet made Squid query its own peer address and every CONNECT failed. Relocation via --network-subnet and a fail-loud startup check remove the silent breakage.
- **Safe probe:** `grep -n nameserver /etc/resolv.conf; cat /proc/net/route; docker network inspect awf-net --format '{{json .IPAM.Config}}'` → Compare resolver addresses and any awf-net subnet with the chosen --network-subnet, and decode destination/mask entries in /proc/net/route to check for overlapping non-Docker host routes. Resolver and Docker network output alone cannot rule out a route conflict; Docker bridge routes and the default route are ignored by the collision check. These reads expose no credentials.
- **Action:** Relocate the network to a free RFC1918 block with --network-subnet (config key network.subnet), for example --network-subnet 10.88.0.0/24, and re-run. Do not disable the collision check or switch off DNS filtering. The check reports a collision as a startup error, so an error is the expected signal rather than a defect in the current code.
- **Related:** NET-002, NET-001
- **Provenance:** issue: awf-net hardcoded subnet collides with OpenShift service CIDR, breaking Squid DNS (https://github.com/github/gh-aw-firewall/issues/8390) · pull-request: Add --network-subnet to relocate awf-net off colliding host/cluster subnets (https://github.com/github/gh-aw-firewall/pull/8398) · code: assertNetworkSubnetUsable() resolver and route collision check (src/network-subnet.ts) · code: Startup call site for the subnet check (src/commands/validators/network-options.ts) · test: Subnet collision and override tests (src/network-subnet.test.ts)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-11-16

### NET-007 — Compose refuses to start because a leftover awf-net belongs to another project

- **Boundary:** network · **Status:** fixed
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** a network with name awf-net exists but was not created for project "awf-<timestamp>" · Compose fails before the agent or Squid starts, after a previous run was killed or timed out
- **Discriminating conditions:** A previous AWF run was killed or timed out before its awf-net network was removed · The leftover network carries a different or no com.docker.compose.project label than the current run · The generated compose file declares a pinned, non-external network name (host-iptables external mode is not affected)
- **Root cause:** Compose does not scope fixed network names per project, so an orphaned awf-net from an earlier run is treated as foreign and refused. AWF attempts to reclaim the network before compose up and retries after detaching stale endpoints it can identify from the network's Compose project label. If that label is absent, stale endpoints carrying the old project label may not be identified or detached, so reclaim and automatic recovery are not guaranteed.
- **Safe probe:** `docker network inspect awf-net --format '{{index .Labels "com.docker.compose.project"}} {{len .Containers}}'` → Shows the owning compose project label and attached container count. A label that differs from the current run's project with no live containers identifies an orphan that the reclaim path should remove. This read reveals no container environment or credentials.
- **Action:** AWF attempts to reclaim an orphaned awf-net before startup. Do not assume automatic recovery when the network has no Compose project label or reclaim logs removal/detach warnings: inspect attached containers, disconnect or remove only confirmed stale endpoints, and re-run. For a labeled network whose stale endpoints can be identified, reclamation should proceed automatically. Do not change the network name to a broad wildcard or disable the reclaim.
- **Related:** NET-006, NET-011
- **Provenance:** issue: awf-net Docker network collision breaks container startup (https://github.com/github/gh-aw-firewall/issues/7809) · pull-request: Reclaim orphaned fixed-name Docker networks before compose up (https://github.com/github/gh-aw-firewall/pull/7817) · code: removeConflictingComposeNetworks() orphan reclaim (src/compose-network-conflicts.ts) · code: Reclaim call before compose up (src/container-startup.ts) · test: Orphaned and unlabelled network reclaim tests (src/compose-network-conflicts.test.ts)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-11-16

### NET-008 — Denied hostname lookups reach the resolver because a Squid IP exception resolves names

- **Boundary:** network · **Status:** fixed
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Resolver or DNS-policy logs show lookups for a hostname the agent was denied (TCP_DENIED / 403) in default mode · A hostname is refused by Squid but its name still appears in DNS telemetry
- **Discriminating conditions:** The generated squid.conf contains a destination-IP ACL declared as dst without -n: an API-proxy or explicit-IP exception (allow_api_proxy_ip, allow_ip_*), the TLS SNI guard (tls_sni_guard_allowed_ip), or an API-proxy upstream, broker splice or broker logging ACL for an IP-literal endpoint · The ACL is evaluated before the domain deny or in a splice/logging decision, so Squid may resolve the requested hostname to test it against the IP · Direct DNS queries from the agent, and lookups of allowlisted names, are outside this finding; they are governed by the trusted --dns-servers policy (NET-002)
- **Root cause:** A Squid dst ACL without -n resolves a hostname destination before matching it against an IP, so evaluating the exception ahead of the domain deny issued a DNS query for an unlisted name even though HTTP access was then refused. dst -n matches literal IPs only, so a hostname is never resolved and does not inherit the IP exception. Current main emits dst -n for the API-proxy and explicit-IP exceptions (config-sections.ts), the SSL-bump SNI guard (ssl-bump.ts) and IP-literal API-proxy upstream, broker splice and broker logging ACLs (api-proxy-upstreams.ts); hostname upstreams use dstdom_regex -i -n instead. The emitter changes were verified only by generated-configuration tests, not by observing Squid lookups, and the release range containing them is unknown.
- **Safe probe:** `grep -nE '^acl [A-Za-z0-9_]+ dst ' path/to/squid.conf` → Every matched ACL line carries -n (for example 'dst -n 172.30.0.30'), including TLS SNI guard and broker access, splice and logging ACLs. A line without -n identifies an unscoped destination-IP ACL. This checks emitted configuration only, not runtime lookup behavior; no traffic is sent and no credentials or environment are read. Redact paths before sharing.
- **Action:** Use source containing numeric-only (dst -n) API-proxy and explicit-IP exceptions and regenerate the configuration. Keep the domain allowlist, raw-IP deny rules and rule ordering unchanged, and do not widen the allowlist or disable DNS filtering. This does not filter direct DNS queries or lookups of allowlisted names; use a policy-enforcing resolver through --dns-servers if those need control. If a denied name reaches the resolver with the fixed ACLs in place, escalate with redacted evidence under SEC-001 instead of reproducing it publicly.
- **Related:** NET-001, NET-002, SEC-001
- **Provenance:** pull-request: Prevent DNS leaks from Squid IP access exceptions (https://github.com/github/gh-aw-firewall/pull/11562) · issue: https://github.com/github/gh-aw-firewall/issues/11561 · pull-request: Make remaining destination-IP ACLs numeric-only (https://github.com/github/gh-aw-firewall/pull/12119) · code: generateApiProxySection() and generateAllowedIpSection() emit dst -n (src/squid/config-sections.ts) · test: Literal-only api-proxy and allowlisted-IP ACL assertions (src/squid/config-sections.test.ts) · code: SNI guard tls_sni_guard_allowed_ip emits dst -n (src/squid/ssl-bump.ts) · code: destinationAcl() emits dst -n for IP-literal upstream, broker splice and broker logging ACLs (src/squid/api-proxy-upstreams.ts) · test: Every emitted dst ACL carries -n for IPv4/IPv6 and SSL-bump modes (src/squid/api-proxy-upstreams.test.ts) · test: SNI guard allowed-IP ACL is numeric-only (src/squid/ssl-bump.test.ts) · test: src/squid-config-core.test.ts · doc: Squid IP exceptions and DNS lookups (docs/egress-filtering.md)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-11-17

### NET-009 — Network-isolation egress fails with HIER_NONE after the host accepts Tailscale routes

- **Boundary:** network · **Status:** workaround
- **Affects:** runner=any, runtime=docker, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Every CONNECT to an allowlisted API host fails with 503 TCP_TUNNEL:HIER_NONE and an empty server field (-:-) in network-isolation (topology) mode · The same workflow succeeds in host-access mode, or in isolation mode when no Tailscale step runs · Agent retries report 503 Service Unavailable from the model endpoint while the allowlist already contains the host
- **Discriminating conditions:** AWF runs with network isolation, so Squid egresses through the dual-homed awf-ext bridge and the host routing tables · A Tailscale step runs on the runner and accepts advertised subnet routes (--accept-routes), which add policy routes in table 52 consulted before the main table · An accepted subnet may capture Squid's traffic to a resolver or API destination via the tailnet interface · A policy denial (TCP_DENIED / 403) or an awf-net subnet collision (NET-006) is a different cause and does not match · The route-capture mechanism comes from one reporter's analysis; only the routing-acceptance change below was validated
- **Root cause:** In network-isolation mode AWF delegates egress to the host network stack and does not install or pin host policy routes. A Tailscale step that accepts advertised subnet routes inserts policy-routing entries ahead of the main table; the reporter suspected an accepted subnet captured Squid's outbound connections or name lookups into the tailnet interface. The earlier theory that a non-portable resolver such as 168.63.129.16 was the sole cause was not sufficient: the resolver-filtering change was merged and later reverted, and the failure persisted until route acceptance was disabled. The mechanism rests on one reporter's investigation.
- **Safe probe:** `ip rule show; ip route show table main; ip route show table 52` → Compare the policy rules and table 52 with the main routes; this is preliminary evidence, not proof that Squid's traffic is captured or unaffected. For each affected resolver and API destination IP, perform a host-side `ip route get <destination-ip> from <squid-awf-ext-ip> iif <awf-ext-host-bridge>` lookup using Squid's actual source address and ingress bridge; include any applicable policy marks. A tailnet interface in the result supports route capture, but packet marks, NAT and firewall rules can affect the actual path. No matching route or an absent table 52 alone does not rule out routing or other causes such as NET-002 and NET-006. These lookups send no traffic; redact routing details before sharing.
- **Action:** Before the AWF step, if policy permits, disable acceptance of advertised subnet routes with `tailscale set --accept-routes=false`, preserving other Tailscale preferences. Direct tailnet peer connectivity for private MCP servers was reported to keep working. Deployments requiring subnet routes or exit-node egress must use a policy-approved alternative; consult the network administrator about routes covering affected resolver and API destinations or an approved isolated runner. Do not reset unrelated Tailscale settings or bypass a required exit node. Keep the domain allowlist and DNS filtering unchanged, do not switch to a wildcard allowlist, and do not run AWF with extra host network capabilities to rewrite host routes. Report persistent HIER_NONE with redacted routing output instead of widening egress.
- **Related:** NET-002, NET-006, NET-001
- **Provenance:** issue: Isolation/topology mode with Tailscale returns Squid 503 HIER_NONE (closed as not planned) (https://github.com/github/gh-aw-firewall/issues/6704) · pull-request: Non-portable DNS filtering for Tailscale (necessary-but-insufficient, later reverted) (https://github.com/github/gh-aw-firewall/pull/6705) · pull-request: Preserve detected DNS resolvers in network isolation (https://github.com/github/gh-aw-firewall/pull/7499) · code: buildComposeNetworks() isolation topology with dual-homed Squid on awf-ext (src/compose-network.ts) · code: filterForNetworkIsolation() preserves detected resolvers (src/dns-resolver.ts) · test: Tailscale Magic DNS preserved in network-isolation mode (src/dns-resolver.test.ts) · doc: Network-isolation topology (docs/network-isolation-design.md)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-05-19

### NET-010 — Domain allowlist entry rejected before startup

- **Boundary:** network · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** ports are not supported in domain entries · URL paths and queries are not supported in domain entries · unsupported scheme · user information is not supported
- **Discriminating conditions:** AWF rejects a --allow-domains or network.allowDomains entry during validation, before Squid starts · Entries containing a port, URL path or query, user information, or a non-HTTP(S) scheme are rejected on current main; before #11952 some could instead produce a non-matching ACL and a 403 (affected release range unknown) · HTTP and HTTPS prefixes are recognized case-insensitively and a single trailing slash is accepted
- **Root cause:** The supplied domain entry contains a scheme or URL component that cannot be represented as a Squid domain ACL. AWF rejects it during validation rather than starting with a non-matching rule.
- **Safe probe:** `awf --help | grep -E -- '--allow-domains|--allow-urls|--ssl-bump|--enable-host-access|--allow-host-ports'` → Compare the rejected entry in the startup error with the allowlist configuration and available options; redact sensitive details before sharing. Squid logs are not expected for this pre-start failure.
- **Action:** Use a specific bare domain or valid wildcard (optionally prefixed by http:// or https://), without a port, path, query or user information. For URL path filtering use --allow-urls with --ssl-bump. For a trusted HTTP/HTTPS host service on a non-standard port, allowlist its host and use --enable-host-access with --allow-host-ports; host access exposes services on permitted ports, so enable it only when appropriate. Keep egress filtering enabled.
- **Related:** NET-001
- **Provenance:** pull-request: Reject invalid domain allowlist forms and normalize scheme casing (https://github.com/github/gh-aw-firewall/pull/11952) · code: checkDomainSyntax() rejects schemes, paths, user information and ports (src/domain-validation.ts) · test: Rejected domain forms and case-insensitive protocol prefixes (src/domain-patterns.test.ts) · doc: Domain syntax and host-access options (docs/usage.md)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### NET-011 — awf-net remains after teardown because a topology-attached peer is still connected

- **Boundary:** network · **Status:** fixed
- **Affects:** runner=self-hosted, runtime=docker, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** AWF resources remain (network:awf-net). Lease retained · docker compose down cannot remove awf-net because the network is still in use after the agent, detection and safe outputs succeeded · An empty awf-net is left on a self-hosted runner after the MCP gateway container was stopped
- **Discriminating conditions:** AWF ran with network isolation and --topology-attach, so an external peer such as the MCP gateway was attached to awf-net outside Compose · The peer remained connected to awf-net while Compose tore the project down, then was stopped or removed by the caller, leaving an empty network · A runner-side cleanup check treats any leftover awf-* network as a failure without checking whether it has endpoints · A leftover network owned by another Compose project is NET-007, and --keep-containers intentionally retains the network and peers
- **Root cause:** Topology peers are attached to awf-net with docker network connect, but older teardown had no matching disconnect, so Compose could not remove the network while a peer was attached. Once the caller removed the peer, an empty awf-net remained and failed the runner's resource check. The failure was reported on one workflow-compiler/AWF/gateway version combination; the affected AWF release range is unverified. Current main force-disconnects each configured peer before compose down without removing the peer container, and afterwards removes awf-net only when inspection reports zero endpoints.
- **Safe probe:** `docker network inspect awf-net --format '{{len .Containers}}'` → Run after the AWF step. 0 on a leftover network indicates an empty orphan that current teardown should reclaim, so a failure points to older AWF or a teardown that was skipped. A positive count means endpoints are still attached, so inspect the container names rather than removing the network. No traffic is sent and no container environment or credentials are read; redact container names before sharing.
- **Action:** Use AWF source in which stopContainers() disconnects configured topology peers before compose down and removes an empty awf-net afterwards. Pass the same --topology-attach names to teardown, and do not disconnect or remove peers you do not own. If the network is still occupied, stop the owning peer first and only then remove an empty network; do not force-remove a network with live endpoints. A runner check that ignores empty awf-* networks is a separate caller-side change.
- **Related:** NET-007
- **Provenance:** issue: awf-net left behind after topology-attached peers (closed) (https://github.com/github/gh-aw-firewall/issues/12107) · pull-request: Detach topology peers before network teardown (https://github.com/github/gh-aw-firewall/pull/12118) · code: stopContainers() disconnects peers before compose down and reclaims an empty network in finally (src/container-stop.ts) · code: disconnectTopologyContainers() and removeEmptyTopologyNetwork() (src/topology.ts) · test: Peer disconnect ordering, missing peers, compose-down failure and keep-containers cases (src/container-stop.test.ts) · test: Disconnect tolerance and empty-network-only removal (src/topology.test.ts) · doc: Network-isolation topology (docs/network-isolation-design.md)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-11-26

## Boundary: auth

### AUTH-001 — Enterprise or Business Copilot target rejects the Authorization header prefix

- **Boundary:** auth · **Status:** fixed
- **Affects:** runner=any, runtime=any, provider=copilot, auth=github-token
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** 400 Bad Request: Authorization header is badly formatted · Copilot requests fail immediately against api.enterprise.githubcopilot.com or api.business.githubcopilot.com
- **Discriminating conditions:** The resolved Copilot target is the enterprise or business host, or GHES is detected (AWF_PLATFORM_TYPE=ghes, or GITHUB_SERVER_URL is neither github.com nor *.ghe.com) · A classic PAT or OAuth GitHub token is used (fine-grained github_pat_* tokens and BYOK keys always use Bearer)
- **Root cause:** The enterprise and business Copilot targets require the 'token' Authorization prefix for classic PAT/OAuth tokens; AWF selects the prefix in copilotTargetRequiresGitHubTokenPrefix(), so a target or platform-type misdetection produces the wrong prefix.
- **Safe probe:** `awf --version && server_url=${GITHUB_SERVER_URL:-} && server_host=${server_url#*://} && server_host=${server_host%%/*} && echo "GITHUB_SERVER_URL host: ${server_host:-unset}" && echo "AWF_PLATFORM_TYPE is ghes: $([ "${AWF_PLATFORM_TYPE:-}" = ghes ] && echo yes || echo no)"` → Shows the AWF version, parsed server host, and whether AWF_PLATFORM_TYPE explicitly selects GHES. Never print token values or Authorization headers.
- **Action:** Confirm the target host and platform detection inputs (AWF_PLATFORM_TYPE, GITHUB_SERVER_URL) are set for the enterprise/GHES deployment so the documented prefix is selected. See docs/auth-matrix.md for the supported combinations; do not paste tokens into the diagnosis.
- **Related:** AUTH-002
- **Provenance:** doc: Provider: GitHub Copilot (docs/auth-matrix.md) · pull-request: Fine-grained PATs always use Bearer (https://github.com/github/gh-aw-firewall/pull/8038) · code: copilotTargetRequiresGitHubTokenPrefix() (containers/api-proxy/providers/copilot-auth.js) · test: containers/api-proxy/copilot-adapter-enterprise.test.js
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### AUTH-002 — API-proxy OIDC mode is configured but the Actions token request variables are missing

- **Boundary:** auth · **Status:** workaround
- **Affects:** runner=github-hosted, runtime=any, provider=any, auth=github-oidc
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** api-proxy reports that no OIDC token could be minted · Provider requests fail with 401 while AWF_AUTH_TYPE=github-oidc is set · ACTIONS_ID_TOKEN_REQUEST_URL is not available to the sidecar
- **Discriminating conditions:** AWF_AUTH_TYPE=github-oidc with AWF_AUTH_PROVIDER set · The workflow job does not declare permissions: id-token: write, or the lock file predates runner-to-sidecar propagation of the Actions OIDC variables
- **Root cause:** The sidecar mints the GitHub OIDC JWT itself, so it needs the Actions token-request variables forwarded to it; without permissions.id-token: write those variables never exist, and the agent is intentionally excluded from receiving them.
- **Safe probe:** `grep -n 'id-token' .github/workflows/<workflow>.lock.yml` → Shows whether the job declares permissions: id-token: write. Check configuration shape only - never print the token or perform a token exchange.
- **Action:** Declare permissions: id-token: write on the job and recompile the workflow so the Actions OIDC request variables reach the api-proxy sidecar. Never work around this by exposing those variables to the agent container or by widening the agent environment.
- **Related:** AUTH-003, SEC-001
- **Provenance:** doc: OIDC authentication (keyless credential exchange) (docs/authentication-architecture.md) · doc: OIDC providers (docs/auth-matrix.md) · code: Sidecar token provider (containers/api-proxy/github-oidc.js) · test: containers/api-proxy/providers/cloud-oidc-init.test.js
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### AUTH-003 — gh-aw-launched HTTP MCP GitHub server fails the OIDC boundary check

- **Boundary:** auth · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=github-mcp, auth=github-oidc
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** mcpg / HTTP MCP GitHub server returns 401 for github-oidc authentication · Gateway configuration contains no OIDC auth metadata · MCP GitHub tool calls fail while provider inference still works
- **Discriminating conditions:** The GitHub MCP server is configured as an HTTP MCP server with github-oidc auth · The lock file was compiled before the runner-to-gateway OIDC propagation fix, or the job lacks permissions: id-token: write
- **Root cause:** The Actions OIDC request variables must travel from the runner to the gh-aw-launched gateway, never through the AWF agent; stale lock files or a missing id-token permission break that path.
- **Safe probe:** `grep -n 'id-token\|github-oidc' .github/workflows/<workflow>.lock.yml` → Shows whether the compiled lock declares id-token: write and github-oidc auth metadata. Inspect shape only - no JWTs, headers, or token exchanges.
- **Action:** Recompile the workflow with a gh-aw version that enforces the runner-to-gateway OIDC path and declare permissions: id-token: write. Never edit lock files by hand and never forward the Actions OIDC variables into the agent container.
- **Related:** AUTH-002
- **Provenance:** issue: HTTP MCP github-oidc boundary (https://github.com/github/gh-aw/issues/50053) · pull-request: Enforce runner-to-gateway OIDC path (https://github.com/github/gh-aw/pull/50054) · doc: OIDC-authenticated MCP servers (docs/authentication-architecture.md)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### AUTH-004 — Primary API-proxy OIDC initialization races Squid readiness

- **Boundary:** auth · **Status:** fixed
- **Affects:** runner=github-hosted, runtime=any, provider=anthropic, auth=github-oidc
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Anthropic OIDC initialization fails until the API-proxy token retry · Agent exhausts early 503 retries while the API proxy has no token
- **Discriminating conditions:** The primary API-proxy sidecar starts before Squid is healthy · Actions OIDC configuration is present; missing id-token permission is AUTH-002, not this startup-ordering defect
- **Root cause:** OIDC initialization requires outbound access through Squid. Starting the primary API proxy before that proxy is healthy can leave it without a token until a later retry while agents already attempt requests.
- **Safe probe:** `node -e 'console.log(require("js-yaml").load(require("fs").readFileSync(process.argv[1],"utf8")).services["api-proxy"].depends_on)' path/to/docker-compose.yml` → Using the repository's installed js-yaml, project only the dependency mapping for squid-proxy condition service_healthy; never print the compose environment or use docker compose config. Source tests confirm the dependency survives model-routing configuration.
- **Action:** Use source with the primary API-proxy healthy-Squid dependency and regenerate Compose. Do not increase agent permissions, expose OIDC variables to the agent, or assume every 503 is an auth failure. This does not diagnose the dedicated enclave proxy or prove a released fixed version.
- **Related:** AUTH-002
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/10495 · code: src/services/api-proxy-service-config.ts · test: src/services/api-proxy-service-config.test.ts · test: src/compose-generator.test.ts · doc: docs/auth-matrix.md
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### AUTH-005 — API-proxy refuses an upstream response it cannot safely inspect for credential echoes

- **Boundary:** auth · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Client receives 502 with error "Upstream response could not be safely inspected" · Client message "Unsupported upstream response content encoding" · Upstream response is aborted mid-stream with a request_error log event while the provider is healthy
- **Discriminating conditions:** The API proxy injected a credential into the request, so response masking is active · A body-bearing upstream response has a Content-Encoding other than identity, gzip, deflate or br, or a corrupt or truncated compressed body · This is a response-inspection failure, not a provider 401/403; do not rotate keys or change auth mode for it
- **Root cause:** The API proxy masks any injected credential value an upstream echoes in response bodies, headers or errors. It must decode body-bearing compressed responses to do so, and it fails closed with 502 rather than forwarding bytes it cannot inspect. An unsupported encoding or a damaged compressed body therefore surfaces as a proxy error even though the provider authenticated the request. Bodyless responses are not decoded or encoding-validated.
- **Safe probe:** `docker logs awf-api-proxy 2>&1 | grep -E 'request_error|Unsupported upstream response content encoding'` → Run while the containers are kept (--keep-containers). Matches show request_error events with credential-masked error text; compare the matched request's provider and path with the failing call. Do not print request headers, docker inspect output or the container environment.
- **Action:** Retry the request; a truncated or corrupt compressed body is usually transient. For a persistent unsupported encoding on a body-bearing response, have the client send Accept-Encoding limited to identity, gzip, deflate or br (the proxy already narrows the header for most requests) or report the provider and endpoint. Never disable masking, expose provider keys to the agent, or treat the 502 as an authentication failure. A shipped release containing this behavior is not verified here.
- **Related:** AUTH-002
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11471 · code: containers/api-proxy/credential-protection.js · code: containers/api-proxy/upstream-http.js · test: containers/api-proxy/server.credential-isolation.test.js · test: containers/api-proxy/credential-protection.test.js · doc: Upstream credential-echo masking (docs/api-proxy-sidecar.md)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### AUTH-006 — Copilot /v1/decisions rejects a personal access token with a plain-text HTTP 400

- **Boundary:** auth · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=copilot, auth=github-token
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Copilot Decisions (evals) request using the reported fine-grained PAT returns HTTP 400 with a plain-text body containing "Personal Access Tokens are not supported for this endpoint" · A standalone gh-aw evals judge fails as an opaque "Decisions request failed (HTTP 400)" and the run stays green · The same 400 occurs for every model name, including invalid ones, because the token is rejected before model validation
- **Discriminating conditions:** The request targets the Copilot listener (port 10002) or the Copilot Decisions endpoint at api.githubcopilot.com/v1/decisions · The configured credential is a personal access token in COPILOT_GITHUB_TOKEN; the reported reproduction used a fine-grained PAT (github_pat_*), and classic PAT acceptance is unverified · The upstream response is a fully captured, decoded 4xx plain-text body; truncated or uninspectable bodies do not receive the reason code
- **Root cause:** In the reported reproduction, a fine-grained PAT configured as COPILOT_GITHUB_TOKEN was rejected by the Copilot /v1/decisions endpoint. AWF forwards the configured credential unchanged and does not exchange it for an OAuth or GitHub App token, so the upstream rejection is returned to the caller. The sidecar classifies a fully captured matching body as pat_unsupported in logs only. Classic PAT acceptance remains unverified. Standalone gh-aw evals run on the host runner outside AWF and cannot be fixed by proxy changes.
- **Safe probe:** `docker logs awf-api-proxy 2>&1 | grep -F '"event":"upstream_error_response"' | grep -F '"provider":"copilot"' | grep -E '"endpoint":"/v1/decisions([?"]|$)' | grep -F '"status":400' | grep -F '"reason_code":"pat_unsupported"'` → Run while containers are kept (--keep-containers). A match requires one upstream_error_response record from provider copilot with the /v1/decisions endpoint (optionally with a query string), status 400, and reason_code pat_unsupported. Compare only the path and status with the failing evals call. Do not print request headers, docker inspect output, or the container environment, and do not issue a Decisions request to test acceptance.
- **Action:** Do not switch models, change the Authorization prefix, or route through AWF as a remedy; the rejection precedes model validation. Use an authentication method the endpoint accepts (the Actions job token with copilot-requests: write is the only accepted credential observed, and only for one live request). Keep fine-grained PAT, classic PAT, OAuth, and GitHub App acceptance unverified until a maintainer confirms it. If the evals job runs outside AWF, the classification belongs in gh-aw's client, not the sidecar. Allowlisting api.githubcopilot.com only permits host egress and is not an authentication fix.
- **Related:** AUTH-001
- **Provenance:** pull-request: Clarify Copilot Decisions PAT support and rejection diagnostics (https://github.com/github/gh-aw-firewall/pull/11289) · pull-request: docs: clarify Copilot Decisions authentication and egress scope (https://github.com/github/gh-aw-firewall/pull/11310) · issue: evals: /v1/decisions rejects fine-grained PATs, and the opaque HTTP 400 hides why (https://github.com/github/gh-aw/issues/75637) · code: pat_unsupported reason classification (containers/api-proxy/upstream-log.js) · test: containers/api-proxy/server.decisions.test.js · test: containers/api-proxy/upstream-log.test.js · doc: /v1/decisions (evals) (docs/auth-matrix.md)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### AUTH-007 — Config-file apiProxy.auth.provider rejects openai although the runtime supports OpenAI native WIF

- **Boundary:** auth · **Status:** unresolved
- **Affects:** runner=any, runtime=any, provider=openai, auth=github-oidc
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** awf config validation reports that config.apiProxy.auth.provider must be one of azure, aws, gcp, anthropic, databricks (openai is absent from the list) · OpenAI native WIF works when AWF_AUTH_PROVIDER=openai is set in the environment but fails when the same value is set through the AWF config file
- **Discriminating conditions:** apiProxy.auth.type is github-oidc in the AWF config file · apiProxy.auth.provider is set to openai · The failure is schema validation of the config file; the environment-variable path is not affected by this schema enum
- **Root cause:** The canonical config schema (docs/awf-config.schema.json) enumerates apiProxy.auth.provider as azure, aws, gcp, anthropic, and databricks (databricks was added later; openai is still missing); src/awf-config-schema.json is the generated runtime-validation copy. validateAwfFileConfig() runs validateWithSchema() before any mapping, so a config file selecting openai is rejected even though the sidecar's cloud-oidc-init provider and the openai-credential-env agent routing accept AWF_AUTH_PROVIDER=openai.
- **Safe probe:** `node -p 'JSON.stringify(require("./src/awf-config-schema.json").properties.apiProxy.properties.auth.properties.provider.enum)'` → Prints ["azure","aws","gcp","anthropic","databricks"] on a checkout that lacks openai in the schema enum. This reads only the bundled schema and never prints environment values, tokens, or Authorization headers.
- **Action:** Use the environment-variable form (AWF_AUTH_TYPE=github-oidc, AWF_AUTH_PROVIDER=openai, with AWF_AUTH_OPENAI_IDENTITY_PROVIDER_ID and AWF_AUTH_OPENAI_SERVICE_ACCOUNT_ID) until the schema enum is extended. The fix belongs in the canonical docs/awf-config.schema.json; run npm run generate:schema to update src/awf-config-schema.json, and add schema tests. This fix is not verified here. Do not put the OpenAI IDs into the agent environment or edit the generated runtime schema directly.
- **Related:** AUTH-002
- **Provenance:** pull-request: Add OpenAI workload identity federation to the API proxy (https://github.com/github/gh-aw-firewall/pull/11364) · code: src/awf-config-schema.json · code: src/config-file.ts · code: containers/api-proxy/providers/cloud-oidc-init.js · doc: docs/auth-matrix.md#openai-native-workload-identity-federation
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-01-31

### AUTH-008 — Azure, AWS, GCP or Databricks OIDC is configured but the API-proxy adapter does not bind it to its upstream

- **Boundary:** auth · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=any, auth=github-oidc
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Provider requests fail with 404 "OpenAI proxy not configured" (or the equivalent not-configured response) although AWF_AUTH_TYPE=github-oidc and AWF_AUTH_PROVIDER=azure, aws, gcp or databricks are set · The api-proxy logs cloud_oidc_not_bound (info) for an unselected adapter or a target that does not match the selected origin, or cloud_oidc_target_refused (warn) for a selected target refused by first-party or Databricks workspace-origin checks
- **Discriminating conditions:** AWF_AUTH_PROVIDER is azure, aws, gcp or databricks (native openai and anthropic workload identity are not affected) · The adapter is left at its default upstream, uses a refused first-party host (api.openai.com, api.anthropic.com, *.githubcopilot.com, copilot-api.*.ghe.com), or its origin does not match the selected cloud target; these cases prevent OIDC initialization but do not by themselves disable an available static credential · For Databricks, a selected adapter target must have at least one explicit target configured, and every explicit target, including COPILOT_PROVIDER_BASE_URL, must match the AWF_AUTH_DATABRICKS_HOST origin; only this selected-target workspace refusal emits cloud_oidc_target_refused and disables static-key fallback · This is a configuration-shape problem, not a token-exchange or Actions permission failure; do not change id-token permissions or rotate credentials for it
- **Root cause:** The sidecar attaches cloud-issued OIDC credentials only to an adapter whose upstream is the explicitly configured cloud target, so a cloud token is never sent to a first-party provider host. resolveCloudOidcProviders() first checks adapter selection: an adapter that does not opt in (allowCloudOidc), or whose target origin does not match the selected origin, logs cloud_oidc_not_bound and does not initialize cloud OIDC; an available static credential remains usable. A selected target on a refused first-party host logs cloud_oidc_target_refused. GCP is the exception: with no explicit target it remains available to the default Gemini and Vertex endpoints. Databricks has no default-endpoint exception: after adapter selection, it requires at least one explicit target and every explicit target, including COPILOT_PROVIDER_BASE_URL, to match the AWF_AUTH_DATABRICKS_HOST origin. A selected Databricks target that reaches this workspace-origin check and fails it logs cloud_oidc_target_refused and disables static-key fallback.
- **Safe probe:** `docker logs awf-api-proxy 2>&1 | grep -E 'cloud_oidc_not_bound|cloud_oidc_target_refused'` → Run while the containers are kept (--keep-containers). cloud_oidc_not_bound indicates the adapter was not selected or its target did not match the selected origin; cloud_oidc_target_refused indicates a selected target was rejected by the first-party or Databricks workspace-origin check. Do not print request headers, docker inspect output or the container environment.
- **Action:** Set the upstream for the adapter that should use the cloud credential (for example COPILOT_PROVIDER_BASE_URL for Azure BYOK, or an OPENAI_API_TARGET / ANTHROPIC_API_TARGET target) to the cloud origin. Gemini and Vertex targets, including their no-explicit-target exception, apply only to GCP. Databricks requires at least one explicit OpenAI, Anthropic, or Copilot target, and every explicit target including COPILOT_PROVIDER_BASE_URL must match the AWF_AUTH_DATABRICKS_HOST origin; it has no Gemini/Vertex default-target exception. Do not point cloud OIDC at a first-party provider host. Native OpenAI and Anthropic workload identity use AWF_AUTH_PROVIDER=openai or anthropic instead. Never work around this by exposing the Actions OIDC variables or exchanged credentials to the agent. A shipped release containing this behavior is not verified here.
- **Related:** AUTH-002
- **Provenance:** pull-request: api-proxy: bind cloud OIDC credentials to the configured upstream (https://github.com/github/gh-aw-firewall/pull/12000) · code: containers/api-proxy/providers/cloud-oidc-init.js · test: containers/api-proxy/providers/cloud-oidc-init.test.js · doc: docs/api-proxy-sidecar.md#cloud-oidc-target-binding · doc: docs/auth-matrix.md#cloud-oidc-target-binding
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

## Boundary: ci

### CI-001 — gh-aw safe-output step fails because the emitted payload violates the declared contract

- **Boundary:** ci · **Status:** workaround
- **Affects:** runner=github-hosted, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** safe output validation failed in the workflow run · The agent job succeeds but the safe-output collection step exits non-zero · create-pull-request rejected: file not in allowed-files
- **Discriminating conditions:** The workflow declares safe-outputs in its .md source · The failure occurs in the post-agent safe-output step, not inside the AWF sandbox
- **Root cause:** Safe outputs are validated against the compiled contract (max counts, labels, title prefix, allowed-files); an agent that writes outside that contract fails the step rather than the GitHub API call.
- **Safe probe:** `gh aw logs <workflow-name>` → Shows the safe-output validation error and which declared constraint was violated.
- **Action:** Fix the workflow .md source (safe-outputs constraints or prompt) and recompile with gh aw compile; never hand-edit the .lock.yml. Widening permissions is not a fix for a contract violation.
- **Provenance:** doc: AWF in GitHub Actions (docs/github_actions.md) · doc: Debugging agentic workflows (.github/skills/debugging-workflows/SKILL.md) · test: Compiled workflow contract checks (scripts/ci/ready-for-aw-workflows.test.ts)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### CI-002 — Compiler-owned enclave gateway is unavailable or violates the handoff contract

- **Boundary:** ci · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Enclave initialize returns 503 backend_unavailable · AWF host gateway readiness fails before primary-agent startup
- **Discriminating conditions:** The compiler launches mcpg and hands AWF the private enclave endpoint and gateway identity · Only documented retryable backend_unavailable responses qualify for bounded initialize retries; other auth, protocol or tool-contract failures are terminal · Host handshake readiness does not establish guest network or workload success
- **Root cause:** The compiler-owned backend can still be coming up, or the compiled gateway identity/tools/protocol contract can differ from AWF's expected contract. The exact bounded AWF-host phase/code is needed to distinguish these causes.
- **Safe probe:** `jq '.diagnostic.enclaveStartup' path/to/protected/startup.json` → Inspect the projected awf-host readiness phase, code, HTTP status, attempts and checklist. Preserve not-attempted stages; a separate harness handshake or healthy broker is not AWF-host readiness.
- **Action:** Match compiler, AWF and mcpg contracts using checked-in lock metadata and current integration docs. Static entries require the documented gateway spec floor; dynamic repository admission requires mcpg v0.4.18 or newer because earlier duration decoding used nanoseconds. Preserve the bounded retry deadline and terminal failures; do not bypass the gateway or infer that a larger timeout fixes a contract mismatch.
- **Related:** AUTH-003
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/9488 · code: src/enclave/gateway.ts · test: src/enclave/gateway.test.ts · test: src/enclave/github-gateway.test.ts · doc: docs/enclaves-architecture.md#topology-and-readiness
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### CI-003 — Cloud Hypervisor regression admission rejects a regional Actions OIDC endpoint

- **Boundary:** ci · **Status:** fixed
- **Affects:** runner=github-hosted, runtime=cloud-hypervisor, provider=any, auth=github-oidc
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** cloud-hypervisor-enclave-admission-token-acquisition · Cloud Hypervisor regression profiles reject before broker startup
- **Discriminating conditions:** The authorized ordinary-workflow regression profile uses a regional HTTPS endpoint within .actions.githubusercontent.com · Older code accepts only the previously recognized Actions endpoint form · An earlier admission guard expected reusable-job OIDC claims that an ordinary workflow job does not present; current code requires the signed workflow_ref, workflow_sha, job_workflow_ref and job_workflow_sha to match the regression workflow at the compiled commit and rejects a differing (reusable) job workflow identity · An old aggregate admission failure without a subreason does not prove this was its cause
- **Root cause:** The regression admission token acquisition guard was narrower than valid regional GitHub Actions OIDC endpoint shapes, so otherwise eligible runs could fail before broker or engine startup.
- **Safe probe:** `jq '.diagnostic.earlyFailure' path/to/protected/startup.json` → Use only the existing allowlisted admission subreason and source/workflow profile metadata. Do not read, decode, print or exchange the Actions token or request URL. Historical aggregate reasons remain unknown.
- **Action:** Use source containing regional endpoint validation and finite admission subreasons with the exact signed ordinary-workflow profile. Keep HTTPS namespace, signature, claims, source pins, runtime, artifact and storage requirements. Let AWF create its work directory so a harness-owned directory does not create secondary cleanup rejection. Hosted acceptance remains separate.
- **Related:** AUTH-002, RT-004
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11192 · pull-request: https://github.com/github/gh-aw-firewall/pull/11223 · code: src/enclave/cloud-hypervisor-conformance-acceptance.ts · test: src/cloud-hypervisor/runtime-validation.test.ts · test: scripts/ci/enclave-agent-regression.test.ts · doc: docs/cloud-hypervisor-foundation.md
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### CI-004 — Enclave regression fails after a successful invocation at a finalization gate

- **Boundary:** ci · **Status:** fixed
- **Affects:** runner=github-hosted, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** AWF_ENCLAVE_REGRESSION_FINALIZATION · Enclave agent regression fails although the invocation result validated
- **Discriminating conditions:** The finalization record has resultValidated: true and primaryFailure.gate is a finalization gate other than result · Older code deleted the harness audit directory with AWF work-directory shutdown, so audit validation could fail after a successful invocation · An old aggregate failure without a finalization record does not identify the failing gate
- **Root cause:** Finalization previously conflated result validation with AWF stop/exit, audit retention, audit schema/invocation checks and cleanup, and shutdown could remove the audit before validation. The failing gate was therefore hidden behind one aggregate error.
- **Safe probe:** `jq '{checks, primaryFailure, secondaryFailures, resultValidated}' path/to/protected/finalization.json` → Read the first failed gate (primaryFailure) separately from later secondaryFailures; each carries a closed gate and reason code. Startup and invocation evidence are exported independently, and a missing finalization.json is unknown, not success.
- **Action:** Use source that retains audit outside the AWF work directory and emits the bounded finalization record. Fix the gate named by primaryFailure; treat secondary failures (for example cleanup) as separate causes. Do not relax audit, ownership or cleanup checks, and do not retain raw exception text or audit payloads. Hosted acceptance remains separate.
- **Related:** CI-002, CI-003
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11194 · code: scripts/ci/run-enclave-agent-regression.js · code: scripts/ci/collect-enclave-smoke-debug.cjs · test: scripts/ci/collect-enclave-smoke-debug.test.ts · test: scripts/ci/enclave-agent-regression.test.ts · doc: docs/cloud-hypervisor-foundation.md
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### CI-005 — Daily agent regression rejects an exit-0 run at a completion or routing evidence gate

- **Boundary:** ci · **Status:** fixed
- **Affects:** runner=github-hosted, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** AWF-REGRESSION-COMPLETE not found although the agent exited 0 · Codex routing evidence rejected after successful inference
- **Discriminating conditions:** The agent exit code is 0 but the host-side evidence gate (completion marker or Codex routing audit) fails · Older code required the marker on its own line without tolerating a preceding terminal control sequence, and required token-usage records that can be absent after successful inference · An old aggregate failure without marker-check.json or codex-routing.json status/diagnostics does not identify the failing gate
- **Root cause:** Success evidence was coupled to terminal output formatting (a cursor-show sequence prefixed the marker line) and to token-usage records. The gates now require an exact standalone LF/CRLF marker line and, for Codex, a persisted api-proxy audit with an HTTP 2xx upstream status or WebSocket 101 handshake.
- **Safe probe:** `jq -s '{marker: (.[0] | {proof, response, completion}), routing: (.[1] | {status, diagnostics, requests})}' path/to/protected/marker-check.json path/to/protected/codex-routing.json` → Read the bounded marker proof/response and completion classifications together with Codex routing status, diagnostics and projected requests. Raw private log bytes are not retained, so historical failures remain unknown.
- **Action:** Use source that emits the marker on its own line and collects marker-check.json and the routing audit projection. Fix the classified gate; do not loosen exact marker, proof/response or nonzero-exit checks, and do not accept start/close events as routing success. Hosted acceptance remains separate.
- **Related:** CI-004
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11158 · pull-request: https://github.com/github/gh-aw-firewall/pull/11191 · code: scripts/ci/collect-agent-regression-evidence.cjs · code: scripts/ci/run-agent-regression-guest.sh · test: scripts/ci/collect-agent-regression-evidence.test.ts · test: scripts/ci/agent-runtime-regression.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### CI-006 — Claude enclave agent exits 1 before initialization with an invalid launch option

- **Boundary:** ci · **Status:** fixed
- **Affects:** runner=any, runtime=any, provider=anthropic, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Claude enclave agent exit 1 before stream initialization · classification unknown-option or invalid-option-value in enclave startup diagnostics
- **Discriminating conditions:** The Claude enclave fails before initialization, not by timeout · Older code passed --permission-prompts auto, which Claude Code 2.1.280 rejects, and omitted unattended shell/file approvals · Only the bounded classification is retained; raw stderr, prompts and model output are not
- **Root cause:** The launch policy used a permission-prompts value rejected by the installed Claude Code CLI and the production environment builder did not supply the fixed unattended approvals, so the process failed at argument parsing.
- **Safe probe:** `jq '.session.claudeStartupFailure.classification // "unknown"' path/to/protected/diagnostics.json` → Read the finite Claude session classification (unknown-option, invalid-option-value, missing-option-value, invalid-settings, invalid-mcp-config or unknown). A classification identifies a configuration class, not the offending value; absence is unknown, not success.
- **Action:** Use source whose trusted child-environment builder fixes the policy (host default; none with a closed Read/Write/Edit/Bash/Glob/Grep allowlist for unattended runs). Do not allow request-controlled policy or broad environment passthrough. Hosted acceptance remains separate.
- **Related:** CI-004
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11222 · code: containers/enclave/agent-entrypoint.py · test: src/enclave/claude-unattended.test.ts · test: src/enclave/agent-entrypoint-diagnostics.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

### CI-007 — Prestarted enclave gateway cannot resolve the private enclave service after network attachment

- **Boundary:** ci · **Status:** fixed
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Enclave regression stops at gateway attachment before the agent starts · Smoke enclave job times out because the gateway cannot resolve awf-enclave-mcp · Host preflight gateway-attachment fails at network-membership
- **Discriminating conditions:** The compiler-launched mcpg container started on Docker's default bridge and AWF later attached it to the private awf-enclave-mcp-control network · The gateway resolver does not use Docker's private-network service discovery, so AWF validates exact network membership and writes the awf-enclave-mcp alias into the gateway's /etc/hosts · Older code used sed -i, which renames over Docker's bind-mounted /etc/hosts and fails; the current code rewrites the existing inode · A failed mapping is fail-closed and detaches the gateway; it is distinct from a retryable 503 backend_unavailable
- **Root cause:** The prestarted gateway's resolver cannot see the AWF-created private network alias, and the first hosts-file update could not replace Docker's bind-mounted /etc/hosts. Without the alias, initialize could not reach the enclave MCP server.
- **Safe probe:** `jq '.diagnostic.enclaveStartup.hostPreflight' path/to/protected/startup.json` → Find the gateway-attachment preflight and the phase that failed (contract, identity, network-connect or network-membership). The protected record does not retain the raw error message; pair a network-membership failure with separate run-symptom or source evidence of the gateway-resolution failure. Network-membership failure alone is insufficient; an absent record is unknown, not success. Do not read container environments.
- **Action:** Use AWF source that validates exact control-network membership and an IPv4 server address, then rewrites the gateway hosts entry in place, keeping identity checks and disconnect-on-failure. Do not widen the network, skip membership validation or extend timeouts. Hosted acceptance remains separate.
- **Related:** CI-002
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11393 · pull-request: https://github.com/github/gh-aw-firewall/pull/11472 · code: src/enclave/gateway.ts · test: src/enclave/gateway.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-02-12

### CI-008 — Agentic workflow fails in pre-agent setup before the engine starts

- **Boundary:** ci · **Status:** fixed
- **Affects:** runner=github-hosted, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Agentic workflow reports an engine crash or incomplete result although the agent never started · Install GitHub Copilot CLI step fails after repeated HTTP 504 responses while downloading the checksum manifest · Smoke workflow exhausts its execution timeout during a cold local Docker image build · AWF invocation combines a compiler-pinned image manifest with --build-local · Maintenance workflow npm ci fails certificate verification against a blocked package mirror
- **Discriminating conditions:** The failure occurs in a setup step (installer download, local image build, dependency install, awf image selection) before the timed engine execution; the agent exit code is absent rather than nonzero · Cold local image builds share the engine execution budget when image preparation is not a separate step · Maintenance workflows listed in publishedAwfWorkflowLockFiles must keep the compiler-selected AWF binary and digest-pinned images; local validation workflows keep --build-local · Only curl download failures of the Copilot installer are retried; checksum, version and installation errors fail immediately · A job-level timeout, an installer 504 and a blocked package host are different causes that share the symptom of no agent output
- **Root cause:** Setup work was coupled to the timed agent execution or to an incompatible AWF image mode. Smoke workflows now prepare run-tagged local images in a separate 35-minute step and select them with --image-registry awf-smoke --image-tag "${AWF_SMOKE_IMAGE_TAG:?}" --skip-pull; maintenance workflows in the published-release list preserve the compiler-pinned binary and images instead of --build-local; the Copilot installer is retried up to three times on curl download failures only; and the Test Quality Improver prepares root dependencies from the public registry before sandbox startup.
- **Safe probe:** `grep -n -e '--build-local' -e 'install_awf_binary' -e 'Build local AWF smoke images' .github/workflows/<workflow>.lock.yml` → Classify the failing step first: installer download, local image preparation, dependency install, or awf image selection. A published-release maintenance workflow should show install_awf_binary and no --build-local; a prepared-image smoke workflow should show a separate Build local AWF smoke images step before execution. Match the failing run's step name from existing run metadata; absent evidence of the failing step is unknown.
- **Action:** Use source whose lock was regenerated and post-processed so the affected workflow is in the correct group (published release, prepared smoke images, or retried installer). Fix the classified setup step; do not widen the network allowlist, loosen checksum or version pins, add --build-local to a published-release workflow, or raise the execution timeout to absorb image builds. Hosted acceptance remains separate.
- **Related:** CI-001
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11317 · pull-request: https://github.com/github/gh-aw-firewall/pull/11318 · pull-request: https://github.com/github/gh-aw-firewall/pull/11314 · pull-request: https://github.com/github/gh-aw-firewall/pull/11311 · pull-request: https://github.com/github/gh-aw-firewall/pull/11383 · pull-request: https://github.com/github/gh-aw-firewall/pull/11473 · pull-request: https://github.com/github/gh-aw-firewall/pull/11569 · pull-request: https://github.com/github/gh-aw-firewall/pull/11558 · pull-request: https://github.com/github/gh-aw-firewall/pull/11326 · code: scripts/ci/build-smoke-images.sh · code: scripts/ci/workflow-patches/network-and-install.ts · code: scripts/ci/workflow-patches/engine-lifecycle.ts · test: scripts/ci/smoke-image-preparation.test.ts · test: scripts/ci/copilot-token-optimizer-workflow.test.ts · test: scripts/ci/apply-general-workflow-patches.test.ts · test: scripts/ci/refactoring-scanner-workflow.test.ts · test: scripts/ci/test-quality-improver-workflow.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-02-12

### CI-009 — Supply-chain PR-image scan is cancelled at its job timeout during a slow package-mirror build

- **Boundary:** ci · **Status:** workaround
- **Affects:** runner=github-hosted, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Supply Chain Scan image-scans job cancelled after exhausting its 40-minute timeout · PR-image scan stops during a container image build rather than at a Grype High/Critical finding · Slow apt index or package downloads dominate a build-tools image layer
- **Discriminating conditions:** The failure is a job-level timeout or cancellation in a PR-image scan job, not a scanner finding: the build-tools build may complete and Grype may run before the job is cancelled during the next image build · Older workflow code built all nine PR images sequentially in one job sharing a single 40-minute budget · Current code runs three PR-image shards (build-tools + enclave-agent, agent, and six service images), each with a 60-minute budget; published-image CVE and license scans keep 40 minutes · enclave-agent must share a shard with build-tools because it consumes the exact locally built base image · A slow mirror, a cache-export failure and a blocking High/Critical vulnerability are different causes that must be classified from the failing step
- **Root cause:** Package retrieval from a slow mirror consumed most of one shared 40-minute budget (the originating PR measured a 36-minute build-tools layer), so the remaining image builds were cancelled. Sharding gives each independent set of images its own budget and runner; it does not make the upstream mirror faster, and no hosted run has yet shown the 60-minute budgets are sufficient under a slow mirror.
- **Safe probe:** `grep -n -e 'scan: pr-' -e 'timeout:' -e 'images:' .github/workflows/supply-chain-scan.yml` → The command checks workflow topology only: current source lists pr-toolchain, pr-agent and pr-services with a 60-minute timeout. From existing run metadata and bounded build-log timing evidence, confirm cancellation at the job limit and distinguish package retrieval, compilation, cache export and Grype execution within the combined build-and-scan step. Match the slow-mirror cause only when apt index or package-download timings show that retrieval consumed most of the shared 40-minute budget. Cancellation without a Grype finding alone is insufficient; absent timing or cancellation-reason evidence leaves the cause unknown.
- **Action:** Use source with the sharded PR-image matrix. Fix the classified step; do not disable or downgrade the blocking High/Critical gate, merge shards in a way that separates enclave-agent from build-tools, ignore cache-export failures, or raise one shared timeout to absorb all builds. Hosted acceptance remains separate; a repeat timeout at 60 minutes is new evidence, not covered by this finding.
- **Related:** CI-008
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11399 · code: .github/workflows/supply-chain-scan.yml · test: scripts/ci/docker-registry-ci.test.ts · doc: docs/INTEGRATION-TESTS.md#ci-image-retrieval
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-02-12

### CI-010 — Codex enclave exits 0 but its shell tool fails in nested bubblewrap

- **Boundary:** ci · **Status:** fixed
- **Affects:** runner=any, runtime=any, provider=openai, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** bwrap: Failed to make / slave: Operation not permitted · Codex enclave agent exit 0 with failure category result-empty · Codex inference succeeds but the diagnostic shell command never runs
- **Discriminating conditions:** The engine is Codex and the pinned CLI (0.159.3 in the enclave image) runs its default nested sandbox inside the hardened enclave · The CLI exit code is 0 and inference succeeded, but no schema-valid result reaches /awf/out, so the invocation fails with the canonical result-empty category · Older launches omitted the trusted external-sandbox opt-in, so the enclave entrypoint did not add --dangerously-bypass-approvals-and-sandbox · Raw bwrap text is not retained in diagnostics; only the finite failure category is, so an old aggregate failure alone does not identify this cause
- **Root cause:** Codex's default nested bubblewrap sandbox cannot run inside the already hardened, zero-capability enclave, so its shell tool fails while the CLI still exits 0. The fix makes AWF the sole owner of the execution policy: the shared provider environment sets AWF_ENCLAVE_AGENT_CODEX_BYPASS_APPROVALS=true for Docker, gVisor and Cloud Hypervisor, and the entrypoint then runs codex exec with --dangerously-bypass-approvals-and-sandbox. Task text, request fields and ambient environment cannot select or override it.
- **Safe probe:** `jq '{failure: .session.failure, engineResults: [.session.events[]? | select(.event == "engine-result") | {event, exitCode}], dropped: .session.dropped}' path/to/protected/diagnostics.json` → For a Codex enclave, an observed engine-result with exitCode 0 and a result-empty failure is consistent with this failure mode, but also occurs for other missing-output failures; it does not establish a nested-bubblewrap cause or successful inference. Corroborate the affected launch's missing trusted external-sandbox opt-in before selecting this finding. Missing engine-result evidence, including events dropped by the retention limit, leaves the engine outcome unknown. The projection contains only allowlisted metadata, never raw engine output or bwrap text.
- **Action:** Use source whose shared provider environment sets the trusted bypass flag and whose entrypoint inserts --dangerously-bypass-approvals-and-sandbox. Keep the outer confinement (non-root identity, zero capabilities, no-new-privileges, read-only root and seed, bounded noexec writable paths, proxy-only network) and keep treating a missing or invalid /awf/out result as a failure even when the CLI exits 0. Do not accept a result-empty run as success and do not let a task or request field select the policy. Hosted acceptance remains separate.
- **Related:** CI-004, CI-006
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11190 · pull-request: https://github.com/github/gh-aw-firewall/pull/11224 · code: containers/enclave/agent-executor/agent-provider-environment.js · code: containers/enclave/agent-entrypoint.py · test: src/enclave/agent-provider-environment.test.ts · test: src/enclave/agent-entrypoint-diagnostics.test.ts · doc: docs/enclaves-architecture.md
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-02-12

### CI-011 — Daily primary-agent regression fails at the guest credential or Codex invocation contract

- **Boundary:** ci · **Status:** fixed
- **Affects:** runner=github-hosted, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Copilot credential is not isolated · Copilot placeholder contract is unavailable · Codex regression stalls on inherited stdin · Codex attempts direct OpenAI inference with a placeholder credential under Cloud Hypervisor or NVX
- **Discriminating conditions:** The failure occurs in the primary-agent regression guest before a proof/response can be validated, not at the later completion or routing evidence gate · Older Copilot guest checks compared credential variables with the log-redacted placeholder text instead of the canonical COPILOT_PLACEHOLDER_TOKEN, so the intended placeholder was rejected before inference · Older Codex invocations inherited an open stdin and selected no explicit provider, so Codex stalled under Docker or used the default OpenAI endpoint with a placeholder credential under Cloud Hypervisor and NVX · The pinned Codex CLI is 0.159.3; other versions are unknown
- **Root cause:** The shared guest harness encoded the Copilot placeholder as a duplicated, log-redacted literal and invoked Codex without closing stdin or pinning its Responses provider to the AWF sidecar. The guest now loads the compiled canonical placeholder constant and accepts only an absent, empty or exact-placeholder value for all three Copilot credential variables, and runs Codex with stdin closed and an explicit awf provider (sidecar base URL, placeholder key, WebSocket support) so both transports use the sidecar and real credentials stay in the proxy.
- **Safe probe:** `grep -n -e 'COPILOT_PLACEHOLDER_TOKEN' -e 'model_provider' -e 'dev/null' scripts/ci/run-agent-regression-guest.sh` → Source that contains the canonical placeholder load, the explicit awf provider selection and the closed-stdin Codex invocation carries the fix. The probe inspects source only; it does not read credential values. A historical run without guest output is unknown.
- **Action:** Use source whose guest loads the compiled canonical placeholder, accepts only absent, empty or exact-placeholder Copilot credential values, and launches Codex non-interactively against the sidecar URL. Keep the exact proof and response checks and the nonzero-exit rejection. Do not weaken isolation to accept a real credential, and do not point Codex at a non-sidecar endpoint. Use codex-routing.json to judge routing (see CI-005). Hosted acceptance remains separate.
- **Related:** CI-005
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11159 · pull-request: https://github.com/github/gh-aw-firewall/pull/11161 · code: scripts/ci/run-agent-regression-guest.sh · code: scripts/ci/collect-agent-regression-evidence.cjs · test: scripts/ci/agent-runtime-regression.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-02-12

### CI-012 — Agentic workflow exits 0 without a terminal safe output, so completion is unconfirmed

- **Boundary:** ci · **Status:** fixed
- **Affects:** runner=any, runtime=any, provider=copilot, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Failure classification: missing_terminal_safe_output with driver exit code 0 · Safe-output MCP calls observed: 0 although the agent finished with a text response · Scheduled optimizer run finishes with no issue, no noop and no report_incomplete
- **Discriminating conditions:** The workflow's successful exit paths (no eligible target, no report, or no recommendation) produce no create_issue, noop, or report_incomplete call · The driver exit code is 0 and the last tool call succeeded, so the run is not a crash or timeout · The workflow declares safe-outputs in its .md source but omits a noop output for successful no-issue exits · The failure is detected after the agent job, in the completion signal, not inside the AWF sandbox
- **Root cause:** The Claude token optimizer configured create_issue but no noop output, and its prompt gave no completion guidance for no-issue exits. When no eligible workflow was staged or no usage report existed, the agent exited cleanly with no terminal safe output, so the completion signal was missing even though the requested analysis had finished. The fix declares noop (max 1, report-as-issue false) and requires exactly one terminal output on every successful path: create_issue for recommendations, noop otherwise.
- **Safe probe:** `grep -n -A3 -E '^  noop:' .github/workflows/claude-token-optimizer.md` → A fixed source declares noop with max 1 and report-as-issue false. A run that still reports missing_terminal_safe_output with exit code 0 on a workflow without a noop output is consistent with this cause. Other causes also produce a missing terminal output (for example, an agent that stopped before its final tool call), so inspect the agent's last actions before selecting this finding. The probe reads only committed source and makes no network or inference call.
- **Action:** Declare a noop safe output for successful no-issue exits and require exactly one terminal safe output on every successful path. Do not treat a text-only exit 0 as completion, and do not widen the safe-output allowlist or permissions to make the signal appear. Recompile the affected workflow with gh aw compile and never hand-edit its .lock.yml. Hosted acceptance remains separate.
- **Related:** CI-001, CI-005
- **Provenance:** issue: Daily Claude Token Optimization Advisor finished without a terminal safe output (https://github.com/github/gh-aw-firewall/issues/11523) · pull-request: Require terminal output from Claude token optimizer (https://github.com/github/gh-aw-firewall/pull/11535) · code: safe-outputs.noop and terminal-output contract (.github/workflows/claude-token-optimizer.md) · test: claude-token-optimizer reports successful no-issue exits with noop (scripts/ci/smoke-copilot-workflow.test.ts)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-02-17

## Boundary: security

### SEC-001 — Suspected isolation or credential-boundary regression must go to security review, not a bypass

- **Boundary:** security · **Status:** needs-evidence
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** The agent container can reach a domain that is not allowlisted · A provider credential is observable inside the agent environment while the api-proxy is enabled · Egress succeeds without a corresponding Squid access-log entry
- **Discriminating conditions:** The observed behaviour weakens an AWF isolation guarantee rather than blocking legitimate work · The failure is a capability that should not exist, not a missing allowlist entry
- **Root cause:** unknown - a suspected regression in the egress or credential-isolation boundary requires verification against current main before any cause is asserted.
- **Safe probe:** `docker exec awf-squid awk '{ print $1, $2, $3, $7, $8 }' /var/log/squid/access.log | tail -50` → Shows timestamp, client, host, status, and decision only; absence of a matching entry for successful egress indicates a bypass worth escalating.
- **Action:** Escalate through the repository security review process with the redacted evidence. Remediation is never a bypass: do not widen the agent environment, weaken isolation, or broaden the domain allowlist.
- **Related:** NET-001, AUTH-002
- **Provenance:** doc: Security model (docs/security.md) · doc: Trust boundaries (docs/architecture.md) · code: Generated egress policy (src/squid-config.ts) · test: src/squid-config-security.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31
