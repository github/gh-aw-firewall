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
| safe output validation failed in the workflow run | CI-001 | ci | workaround |
| The agent job succeeds but the safe-output collection step exits non-zero | CI-001 | ci | workaround |
| create-pull-request rejected: file not in allowed-files | CI-001 | ci | workaround |
| Enclave initialize returns 503 backend_unavailable | CI-002 | ci | workaround |
| AWF host gateway readiness fails before primary-agent startup | CI-002 | ci | workaround |
| cloud-hypervisor-enclave-admission-token-acquisition | CI-003 | ci | fixed |
| Cloud Hypervisor regression profiles reject before broker startup | CI-003 | ci | fixed |
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
- **Safe probe:** `grep '"operation":"preflight-session-log"' path/to/protected/enclave-session.log` → Read only the already projected, credential-redacted operation/category/errno event. Missing transcript evidence is not success and does not by itself prove a credential problem.
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
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/10776 · code: src/squid/api-proxy-upstreams.ts · test: src/squid/api-proxy-upstreams.test.ts · test: containers/api-proxy/server.target-ports.test.js · doc: docs/awf-config-spec.md
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
- **Discriminating conditions:** The authorized ordinary-workflow regression profile uses a regional HTTPS endpoint within .actions.githubusercontent.com · Older code accepts only the previously recognized Actions endpoint form · An old aggregate admission failure without a subreason does not prove this was its cause
- **Root cause:** The regression admission token acquisition guard was narrower than valid regional GitHub Actions OIDC endpoint shapes, so otherwise eligible runs could fail before broker or engine startup.
- **Safe probe:** `jq '.diagnostic.earlyFailure' path/to/protected/startup.json` → Use only the existing allowlisted admission subreason and source/workflow profile metadata. Do not read, decode, print or exchange the Actions token or request URL. Historical aggregate reasons remain unknown.
- **Action:** Use source containing regional endpoint validation and finite admission subreasons with the exact signed ordinary-workflow profile. Keep HTTPS namespace, signature, claims, source pins, runtime, artifact and storage requirements. Let AWF create its work directory so a harness-owned directory does not create secondary cleanup rejection. Hosted acceptance remains separate.
- **Related:** AUTH-002, RT-004
- **Provenance:** pull-request: https://github.com/github/gh-aw-firewall/pull/11223 · code: src/enclave/cloud-hypervisor-conformance-acceptance.ts · test: src/cloud-hypervisor/runtime-validation.test.ts · test: scripts/ci/enclave-agent-regression.test.ts · doc: docs/cloud-hypervisor-foundation.md
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2026-12-09

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
