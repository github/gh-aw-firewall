# AWF Configuration Specification

## Abstract

This specification defines the configuration model, processing rules, and
environment semantics for the Agentic Workflow Firewall (AWF). It is the
normative reference for:

- the `awf` CLI runtime (`--config`)
- tooling that compiles workflows into AWF invocations (e.g., `gh-aw`)
- IDE and static-analysis validation via JSON Schema

The machine-readable schema is published alongside this specification at
`docs/awf-config.schema.json` (live, tracking `main`) and as a versioned
release asset (e.g.,
`https://github.com/github/gh-aw-firewall/releases/download/v0.23.1/awf-config.schema.json`).

## Status of This Document

This document is normative. Informative notes are marked with **Note:** or
placed in blockquotes. All other text is normative unless stated otherwise.

## 1. Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A *conforming AWF configuration document* is one that:

1. is valid JSON or YAML;
2. satisfies all constraints defined by `docs/awf-config.schema.json`; and
3. contains no properties beyond those defined by the schema
   (closed-world assumption).

A *conforming AWF implementation* MUST accept every conforming configuration
document and MUST reject every non-conforming one.

## 2. Processing Model

When the user invokes `awf --config <path|-> -- <command>`, a conforming
implementation MUST execute the following steps in order:

1. If `<path>` is `-`, read configuration bytes from standard input.
2. Determine the serialisation format:
   - If `<path>` ends with `.json`, parse as JSON.
   - If `<path>` ends with `.yaml` or `.yml`, parse as YAML.
   - Otherwise, attempt JSON first; if that fails, attempt YAML.
3. Validate the parsed document against `docs/awf-config.schema.json`.
4. On validation failure, abort with non-zero exit status (see §7).
5. Map configuration fields to CLI-option semantics per §5.
6. Apply precedence rules per §3.

## 3. Precedence Rules

The effective value for any configuration parameter SHALL be determined by
the following precedence order (highest wins):

1. Explicit CLI flags
2. Config file (`--config`)
3. AWF internal defaults

> **Note:** This model enables reusable, checked-in configuration files
> with environment-specific CLI overrides.

## 4. Data Model

The root object of a conforming configuration document MAY contain the
following top-level properties. All are OPTIONAL:

| Property | Type | Description |
|----------|------|-------------|
| `$schema` | string | JSON Schema URI for IDE validation |
| `network` | object | Network egress configuration |
| `apiProxy` | object | API proxy sidecar configuration |
| `security` | object | Security and isolation settings |
| `container` | object | Container and Docker settings |
| `chroot` | object | Chroot execution overrides for split-filesystem ARC/DinD runners |
| `dind` | object | Bootstrap helpers for ARC/DinD split runner/daemon filesystems |
| `runner` | object | Runner topology declaration (standard vs. ARC/DinD) |
| `environment` | object | Environment variable propagation (see §8) |
| `logging` | object | Logging and diagnostics |
| `rateLimiting` | object | Egress rate limiting |
| `platform` | object | GitHub platform deployment type declaration |
| `boundedQueries` | object | Bounded-query sandbox subsystem (see §14) |

Property-level constraints, types, and descriptions are defined
normatively by `docs/awf-config.schema.json`.

## 5. CLI Mapping

*This section is normative.*

Tools generating AWF invocations (such as `gh-aw`) SHOULD use the mapping
below. The left side is the configuration-document path; the right side is
the corresponding CLI flag.

Security-sensitive values (API keys, tokens, and credential secrets) MUST be
provided via environment variables, not AWF config documents. Non-sensitive
AWF settings MAY be supplied via config files, including stdin (`--config -`).

- `network.allowDomains[]` → `--allow-domains <csv>`
- `network.blockDomains[]` → `--block-domains <csv>`
- `network.dnsServers[]` → `--dns-servers <csv>`
- `network.upstreamProxy` → `--upstream-proxy`
- `network.isolation` → `--network-isolation` *(experimental; enforces egress via Docker network topology instead of host iptables)*
- `network.topologyAttach[]` → `--topology-attach <name>` *(repeatable; requires `network.isolation: true`)*
- `apiProxy.enabled` → `--enable-api-proxy` *([DEPRECATED] API proxy is always enabled; this flag is ignored)*
- `apiProxy.enableTokenSteering` → `--enable-token-steering`
- `apiProxy.anthropicAutoCache` → `--anthropic-auto-cache`
- `apiProxy.anthropicCacheTailTtl` → `--anthropic-cache-tail-ttl <5m|1h>`
- `apiProxy.maxEffectiveTokens` → *(config-only; no CLI equivalent)*
- `apiProxy.maxAiCredits` → *(config-only; maps to `AWF_MAX_AI_CREDITS`)*
- `apiProxy.defaultAiCreditsPricing` → *(config-only; maps to `AWF_DEFAULT_AI_CREDITS_PRICING`)*
- `apiProxy.providers` → *(config-only; maps to `AWF_API_PROXY_PROVIDERS`)*
- `apiProxy.modelMultipliers` → `--max-model-multiplier <model:multiplier,...>`
- `apiProxy.defaultModelMultiplier` → *(config-only; maps to `AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER`)*
- `apiProxy.maxTurns` → *(config-only; no CLI equivalent)*
- `apiProxy.maxRuns` → *(deprecated alias for `maxTurns`; maps to `AWF_MAX_RUNS`)*
- `apiProxy.maxModelMultiplierCap` → `--max-model-multiplier-cap <number>`
- `apiProxy.maxCacheMisses` → `--max-cache-misses <number>`
- `apiProxy.maxPermissionDenied` → `--max-permission-denied <number>`
- `apiProxy.requestedModel` → *(config-only; maps to `AWF_REQUESTED_MODEL` for pre-startup validation)*
- `apiProxy.modelFallback` → *(config-only; model fallback strategy)*
- `apiProxy.modelRouter.providerType` → *(config-only; maps to `COPILOT_PROVIDER_TYPE`)*
- `apiProxy.modelRouter.baseUrl` → *(config-only; maps to `COPILOT_PROVIDER_BASE_URL`)*
- `apiProxy.allowedModels` → *(config-only; maps to `AWF_ALLOWED_MODELS` — JSON array of glob patterns; only matching models are permitted)*
- `apiProxy.disallowedModels` → *(config-only; maps to `AWF_DISALLOWED_MODELS` — JSON array of glob patterns; matching models are rejected with HTTP 403)*
- `apiProxy.models` → *(config-only; model alias rewriting)*
- `apiProxy.logging.debugTokens` → *(config-only; maps to `AWF_DEBUG_TOKENS`)*
- `apiProxy.logging.tokenLogDir` → *(config-only; maps to `AWF_TOKEN_LOG_DIR`)*
- `apiProxy.diagnostics.captureBlockedRequests` → *(config-only; maps to `AWF_CAPTURE_BLOCKED_LLM_REQUESTS`)*
- `apiProxy.diagnostics.maxCapturedBytes` → *(config-only; maps to `AWF_MAX_BLOCKED_CAPTURE_BYTES`)*
- `apiProxy.auth.type` → *(config-only; maps to `AWF_AUTH_TYPE`)*
- `apiProxy.auth.provider` → *(config-only; maps to `AWF_AUTH_PROVIDER`)*
- `apiProxy.auth.oidcAudience` → *(config-only; maps to `AWF_AUTH_OIDC_AUDIENCE`)*
- `apiProxy.auth.azureTenantId` → *(config-only; maps to `AWF_AUTH_AZURE_TENANT_ID`)*
- `apiProxy.auth.azureClientId` → *(config-only; maps to `AWF_AUTH_AZURE_CLIENT_ID`)*
- `apiProxy.auth.azureScope` → *(config-only; maps to `AWF_AUTH_AZURE_SCOPE`)*
- `apiProxy.auth.azureCloud` → *(config-only; maps to `AWF_AUTH_AZURE_CLOUD`)*
- `apiProxy.auth.awsRoleArn` → *(config-only; maps to `AWF_AUTH_AWS_ROLE_ARN`)*
- `apiProxy.auth.awsRegion` → *(config-only; maps to `AWF_AUTH_AWS_REGION`)*
- `apiProxy.auth.awsRoleSessionName` → *(config-only; maps to `AWF_AUTH_AWS_ROLE_SESSION_NAME`)*
- `apiProxy.auth.gcpWorkloadIdentityProvider` → *(config-only; maps to `AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER`)*
- `apiProxy.auth.gcpServiceAccount` → *(config-only; maps to `AWF_AUTH_GCP_SERVICE_ACCOUNT`)*
- `apiProxy.auth.gcpScope` → *(config-only; maps to `AWF_AUTH_GCP_SCOPE`)*
- `apiProxy.auth.anthropicFederationRuleId` → *(config-only; maps to `AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID`)*
- `apiProxy.auth.anthropicOrganizationId` → *(config-only; maps to `AWF_AUTH_ANTHROPIC_ORGANIZATION_ID`)*
- `apiProxy.auth.anthropicServiceAccountId` → *(config-only; maps to `AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID`)*
- `apiProxy.auth.anthropicWorkspaceId` → *(config-only; maps to `AWF_AUTH_ANTHROPIC_WORKSPACE_ID`)*
- `apiProxy.auth.anthropicTokenUrl` → *(config-only; maps to `AWF_AUTH_ANTHROPIC_TOKEN_URL`)*
- `apiProxy.targets.<provider>.host` → `--<provider>-api-target` *(except `antigravity.host`, which maps to the Gemini flag below)*
- `apiProxy.targets.antigravity.host` → `--gemini-api-target`
- `apiProxy.targets.copilot.extraHeaders` → *(config-only; non-sensitive supplemental BYOK headers, maps to `AWF_BYOK_EXTRA_HEADERS`)*
- `apiProxy.targets.copilot.extraBodyFields` → *(config-only; non-sensitive supplemental BYOK body fields, maps to `AWF_BYOK_EXTRA_BODY_FIELDS`)*
- `apiProxy.targets.copilot.sessionId` → *(config-only; opt-in `x-session-id` header / `session_id` body field for Copilot BYOK requests, maps to `AWF_PROVIDER_SESSION_ID`. Never auto-derived from `GITHUB_RUN_ID`.)*
- `apiProxy.targets.openai.basePath` → `--openai-api-base-path`
- `apiProxy.targets.openai.authHeader` → `--openai-api-auth-header`
- `apiProxy.targets.anthropic.basePath` → `--anthropic-api-base-path`
- `apiProxy.targets.anthropic.authHeader` → `--anthropic-api-auth-header`
- `apiProxy.targets.gemini.basePath` → `--gemini-api-base-path`
- `apiProxy.targets.antigravity.basePath` → `--gemini-api-base-path`
- When both `apiProxy.targets.antigravity` and `apiProxy.targets.gemini` are set, `antigravity` takes precedence per field.
- `apiProxy.targets.vertex.host` → `--vertex-api-target`
- `apiProxy.targets.vertex.basePath` → `--vertex-api-base-path`
- `security.legacySecurity` → `--legacy-security`
- `security.securityMode` → `--security-mode <strict|compat>` *([DEPRECATED] Use `security.legacySecurity` instead)*
- `security.sslBump` → `--ssl-bump`
- `security.enableDlp` → `--enable-dlp`
- `security.enableHostAccess` → `--enable-host-access`
- `security.allowHostPorts` → `--allow-host-ports`
- `security.allowHostServicePorts` → `--allow-host-service-ports`
- `security.difcProxy.host` → `--difc-proxy-host`
- `security.difcProxy.caCert` → `--difc-proxy-ca-cert`
- `container.memoryLimit` → `--memory-limit`
- `container.agentTimeout` → `--agent-timeout`
- `container.enableDind` → `--enable-dind`
- `container.workDir` → `--work-dir`
- `container.containerWorkDir` → `--container-workdir`
- `container.imageRegistry` → `--image-registry`
- `container.imageTag` → `--image-tag`
- `container.skipPull` → `--skip-pull`
- `container.buildLocal` → `--build-local`
- `container.agentImage` → `--agent-image`
- `container.tty` → `--tty`
- `container.dockerHost` → `--docker-host`
- `container.dockerHostPathPrefix` → `--docker-host-path-prefix`
- `container.runnerToolCachePath` → *(config-only; checked first for optional read-only runner tool cache mount, before `RUNNER_TOOL_CACHE` and `/home/runner/work/_tool` auto-detection)*
- `container.mounts[]` → `-v, --mount` *(repeatable; each array entry maps to one Docker volume mount in `/host_path:/container_path[:ro|rw]` format (both paths must be absolute; host path must exist); in chroot mode, container paths are automatically prefixed with `/host`)*
- `container.containerRuntime` → `--container-runtime` *(user-facing runtime name: `"gvisor"` for OCI runtime in compose, `"sbx"` for Docker sbx microVM. For gvisor: translates to `"runsc"`, injects `extra_hosts` for DNS workaround. For sbx: agent runs in a hypervisor-isolated microVM, infra stays in compose, sbx proxy chains through AWF's Squid.)*
- `chroot.binariesSourcePath` → *(config-only; overlays a runner-side binaries directory at `/usr/local/bin` inside chroot mode)*
- `chroot.identity.home` → *(config-only; forwarded as `AWF_CHROOT_IDENTITY_HOME` and applied after chroot pivot)*
- `chroot.identity.user` → *(config-only; forwarded as `AWF_CHROOT_IDENTITY_USER` and applied to `USER`/`LOGNAME` after chroot pivot)*
- `chroot.identity.uid` → *(config-only; forwarded as `AWF_CHROOT_IDENTITY_UID` for chroot user mapping)*
- `chroot.identity.gid` → *(config-only; forwarded as `AWF_CHROOT_IDENTITY_GID` for chroot user mapping)*
- `dind.preStageDirs` → *(config-only; enables daemon-side pre-staging of the DinD work directory tree before compose startup)*
- `dind.workDir` → *(config-only; daemon-visible staging root, default `/tmp/gh-aw`)*
- `dind.stagingImage` → *(config-only; image used for short-lived DinD staging containers)*
- `dind.stageEngineBinary.path` → *(config-only; runner-side engine binary source path for DinD staging)*
- `dind.stageEngineBinary.targetPath` → *(config-only; daemon-side destination path for staged engine binary)*
- `environment.envFile` → `--env-file`
- `environment.envAll` → `--env-all`
- `environment.excludeEnv[]` → `--exclude-env` *(repeatable)*
- `logging.logLevel` → `--log-level`
- `logging.diagnosticLogs` → `--diagnostic-logs`
- `logging.auditDir` → `--audit-dir`
- `logging.proxyLogsDir` → `--proxy-logs-dir`
- `logging.sessionStateDir` → `--session-state-dir`
- `rateLimiting.enabled: false` → `--no-rate-limit`
- `rateLimiting.requestsPerMinute` → `--rate-limit-rpm`
- `rateLimiting.requestsPerHour` → `--rate-limit-rph`
- `rateLimiting.bytesPerMinute` → `--rate-limit-bytes-pm`
- `platform.type` → *(config-only; maps to `AWF_PLATFORM_TYPE`)*
- `runner.topology` → *(config-only; sets runner deployment model — `standard` or `arc-dind`; when `arc-dind`, enables sysroot staging and emits RUNNER_TOOL_CACHE warnings)*
- `runner.sysrootImage` → *(config-only; sysroot init-container image for `arc-dind` topology; defaults to `<container.imageRegistry>/build-tools:<container.imageTag>`, where `container.imageRegistry` defaults to `ghcr.io/github/gh-aw-firewall`)*
- `boundedQueries.enabled` → *(config-only; no CLI equivalent, see §14)*
- `boundedQueries.privateRepos[]` → *(config-only; no CLI equivalent, see §14)*
- `boundedQueries.runtime` → *(config-only; no CLI equivalent, see §14)*
- `boundedQueries.timeout` → *(config-only; no CLI equivalent, see §14)*
- `boundedQueries.memoryLimit` → *(config-only; no CLI equivalent, see §14)*
- `boundedQueries.interpreter` → *(config-only; no CLI equivalent, see §14)*
- `boundedQueries.maxInvocations` → *(config-only; no CLI equivalent, see §14)*
- `boundedAgents.enabled` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.privateRepos[]` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.runtime` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.profile` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.model` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.timeout` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.memoryLimit` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.cpuLimit` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.pidsLimit` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.tmpfsLimit` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.maxOutputBytes` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.maxTaskBytes` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.maxInvocations` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.maxModelRequests` → *(config-only; no CLI equivalent, see §15)*
- `boundedAgents.maxModelTokens` → *(config-only; no CLI equivalent, see §15)*

When `container.dockerHostPathPrefix` points at a daemon-visible shared `/tmp` path, the implementation stages the invoking CLI binary together with `/etc/passwd`, `/etc/group`, and the generated chroot `/etc/hosts` under that shared path so chroot mode can bootstrap on split-filesystem ARC/DinD hosts.

When DinD is detected, AWF preserves the detected `DOCKER_HOST` value for the agent environment (including MCP servers) so DinD-aware tooling can reach the correct daemon without manual workflow env overrides.

The following CLI flag has no config-file equivalent by design:

- `-e, --env <KEY=VALUE>` — inject a single environment variable into
  the agent container *(repeatable; CLI-only)*

## 6. Standard Input Mode

A conforming implementation MUST accept `--config -` to read configuration
from standard input, enabling programmatic and pipeline scenarios.

## 7. Error Reporting

On parse or validation failure, a conforming implementation MUST:

1. exit with a non-zero status code;
2. emit a diagnostic message identifying the location and nature of the
   error; and
3. refrain from partial execution of the agent command.

## 8. Environment Merge Semantics

*This section is normative.*

The agent container's environment is constructed by merging variables from
multiple sources. This section defines the merge order and exclusion rules.

> **Note:** For usage guidance, examples, and troubleshooting, see
> [docs/environment.md](environment.md).

### 8.1 Merge Precedence

Variables from the following sources are merged in order of increasing
precedence. A value set at a higher level MUST override the same-named
value from any lower level.

| Level | Source | Description |
|-------|--------|-------------|
| 1 (lowest) | AWF-reserved | Proxy routing, DNS, container paths |
| 2 | `--env-all` | Inherited host environment (when enabled) |
| 3 | `--env-file` | Variables read from a file |
| 4 (highest) | `-e` / `--env` | Explicit CLI key-value pairs |

### 8.2 AWF-Reserved Variables

A conforming implementation MUST set the following variables in the agent
container regardless of user configuration. Values from `--env-all` and
`--env-file` MUST NOT override these variables.

| Variable | Value | Purpose |
|----------|-------|---------|
| `HTTP_PROXY` | `http://<squid-ip>:3128` | Squid forward proxy for HTTP |
| `HTTPS_PROXY` | `http://<squid-ip>:3128` | Squid forward proxy for HTTPS |
| `https_proxy` | `http://<squid-ip>:3128` | Lowercase alias (Yarn 4, undici, Corepack) |
| `NO_PROXY` | `localhost,127.0.0.1,::1,...` | Loopback and container IPs bypassing Squid |
| `SQUID_PROXY_HOST` | `squid-proxy` | Proxy hostname (for tools requiring host separately) |
| `SQUID_PROXY_PORT` | `3128` | Proxy port |
| `PATH` | *(container default)* | MUST use the container's PATH, not the host's |
| `HOME` | *(host user's home)* | Derived via `sudo`-aware detection |

> **Note:** Lowercase `http_proxy` is intentionally NOT set. Certain curl
> builds on Ubuntu 22.04 ignore uppercase `HTTP_PROXY` for HTTP URLs
> (httpoxy mitigation), causing HTTP traffic to fall through to iptables
> DNAT interception — the intended defense-in-depth behavior.

### 8.3 Excluded Variables

The following variables MUST be excluded from `--env-all` and `--env-file`
passthrough. A conforming implementation MUST NOT inherit them from the host:

| Category | Variables |
|----------|-----------|
| System | `PATH`, `PWD`, `OLDPWD`, `SHLVL`, `_`, `SUDO_COMMAND`, `SUDO_USER`, `SUDO_UID`, `SUDO_GID` |
| Proxy | `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY`, `no_proxy`, `ALL_PROXY`, `all_proxy`, `FTP_PROXY`, `ftp_proxy` |
| Actions runtime credentials | `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RESULTS_URL`, `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` |
| AWF internal controls | `AWF_PREFLIGHT_BINARY`, `AWF_GEMINI_ENABLED` |

> **Note:** Host proxy variables are read for upstream proxy auto-detection
> (see `--upstream-proxy`) but MUST NOT propagate into the agent container.
> AWF sets its own proxy variables pointing to Squid.

### 8.4 Selectively Forwarded Variables

When `--env-all` is NOT active, a conforming implementation SHOULD forward
the following host variables into the agent container:

| Category | Variables |
|----------|-----------|
| GitHub authentication | `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN` |
| GitHub enterprise | `GITHUB_SERVER_URL`, `GITHUB_API_URL` |
| Docker client | `DOCKER_HOST`, `DOCKER_TLS`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, `DOCKER_CONFIG`, `DOCKER_CONTEXT`, `DOCKER_API_VERSION`, `DOCKER_DEFAULT_PLATFORM` |
| User environment | `USER`, `XDG_CONFIG_HOME` |

When `--env-all` IS active, all host variables not in the excluded set
(§8.3) SHALL be forwarded, subject to credential isolation rules (§9).

Actions OIDC request variables MUST be forwarded directly to the api-proxy
sidecar when `apiProxy.auth.type` is `github-oidc` and MUST NOT be forwarded
to the agent through any environment input path.

### 8.5 Explicit Overrides

Variables passed via `-e` / `--env` MUST override values from `--env-all`
and `--env-file`.

Reserved proxy routing variables MAY be overridden only via `-e` / `--env`.
Other AWF-reserved variables and source credentials protected by credential
isolation (§9) MUST NOT be overridden.

> **Note:** There is no config-file equivalent for `-e` / `--env`. Individual
> environment variable injection is a runtime concern, not a static
> configuration concern.

## 9. Credential Isolation Semantics

*This section is normative.*

AWF implements defense-in-depth credential isolation for LLM API keys.
Behavior is governed by the value of `apiProxy.enabled`.

> **Note:** For architectural diagrams and protocol-level details, see
> [docs/authentication-architecture.md](authentication-architecture.md).

### 9.1 Source Credentials

A conforming implementation MUST recognize the following environment
variables as *source credentials* — real API keys read from the host:

| Variable | Provider |
|----------|----------|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot — enables sidecar routing to `api.githubcopilot.com` (CAPI BYOK / offline mode) |
| `COPILOT_PROVIDER_API_KEY` | GitHub Copilot BYOK provider key (e.g., Azure OpenAI / OpenRouter API key); independently enables sidecar routing — typically combined with `COPILOT_PROVIDER_BASE_URL` to point at an arbitrary upstream |
| `GEMINI_API_KEY` | Google Gemini |
| `GOOGLE_API_KEY` | Google Vertex AI |

The following secondary aliases SHOULD also be recognized:
`OPENAI_KEY`, `CODEX_API_KEY`, `CLAUDE_API_KEY`.

### 9.2 API Proxy Enabled (`apiProxy.enabled = true`)

When the API proxy sidecar is enabled, the following rules apply:

1. Source credentials (§9.1) MUST NOT be exposed in the agent container's
   environment. They SHALL be passed exclusively to the API proxy sidecar.
2. The `--env-all` flag MUST NOT reintroduce excluded credentials into the
   agent environment.
3. A conforming implementation MAY inject *placeholder values* into the
   agent container for tool compatibility (e.g.,
   `OPENAI_API_KEY=sk-placeholder-for-api-proxy`). Placeholder values are
   not secrets and MUST NOT be treated as credentials.
4. A conforming implementation MUST inject *proxy-routing variables* so
   that agent tools reach the sidecar rather than upstream APIs:

   | Agent variable | Value | Purpose |
   |----------------|-------|---------|
   | `OPENAI_BASE_URL` | `http://172.30.0.30:10000` | Routes OpenAI calls to sidecar |
   | `ANTHROPIC_BASE_URL` | `http://172.30.0.30:10001` | Routes Anthropic calls to sidecar |
   | `COPILOT_API_URL` | `http://172.30.0.30:10002` | Routes Copilot calls to sidecar |
   | `GOOGLE_GEMINI_BASE_URL` | `http://172.30.0.30:10003` | Routes Gemini calls to sidecar |
   | `GEMINI_API_BASE_URL` | `http://172.30.0.30:10003` | Alias for compatibility |
   | `GOOGLE_VERTEX_BASE_URL` | `http://172.30.0.30:10004` | Routes Vertex AI calls to sidecar |

5. The API proxy sidecar SHALL inject the real credentials into upstream
   requests. Sidecar port assignments: 10000 (OpenAI), 10001 (Anthropic),
   10002 (Copilot), 10003 (Gemini), 10004 (Vertex AI).

6. A conforming implementation MUST forward the following OpenTelemetry
   variables from the host into the **api-proxy sidecar** container so that
   the sidecar can participate in the distributed trace established by the
   workflow:

   | Variable | Description |
   |----------|-------------|
   | `GH_AW_OTLP_ENDPOINTS` | JSON array of `{url, headers}` objects for fan-out export to multiple OTLP collectors. Takes priority over `OTEL_EXPORTER_OTLP_ENDPOINT`. |
   | `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector URL. Single-endpoint fallback when `GH_AW_OTLP_ENDPOINTS` is absent. |
   | `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` auth headers for the OTLP endpoint. Only used with `OTEL_EXPORTER_OTLP_ENDPOINT`. |
   | `OTEL_SERVICE_NAME` | Service name tag. Defaults to `awf-api-proxy` when not set. |
   | `GITHUB_AW_OTEL_TRACE_ID` | W3C trace-id of the parent workflow trace. |
   | `GITHUB_AW_OTEL_PARENT_SPAN_ID` | W3C span-id of the parent workflow span. |

   These variables are NOT forwarded to the agent container via this mechanism;
   the agent receives OTEL variables through the standard `OTEL_*` prefix
   forwarding described in §8.4.

   The sidecar selects its exporter using the following priority order:

   1. `GH_AW_OTLP_ENDPOINTS` (JSON array) — spans are exported concurrently to
      all listed endpoints (fan-out mode); partial failures on individual
      endpoints do not block others.
   2. `OTEL_EXPORTER_OTLP_ENDPOINT` (single URL) — legacy single-endpoint mode.
   3. Neither set — the sidecar writes span NDJSON to
      `/var/log/api-proxy/otel.jsonl` as a local fallback.

   When `GITHUB_AW_OTEL_TRACE_ID` / `GITHUB_AW_OTEL_PARENT_SPAN_ID` are
   present and valid hex, each sidecar span is created as a child of the
   specified parent span, enabling end-to-end distributed tracing from the
   GitHub Actions workflow through the api-proxy to the LLM provider.

### 9.3 `apiProxy.enabled` Deprecated

`apiProxy.enabled` is **deprecated and ignored**. The API proxy sidecar is always started; there is no disabled mode. Setting `apiProxy.enabled: false` in a config file is silently ignored for backward compatibility. The CLI flag `--enable-api-proxy` is similarly ignored; `--no-enable-api-proxy` is rejected at runtime with an error.

Credential isolation described in §9.2 therefore always applies: source credentials are never forwarded directly to the agent container.

### 9.4 Credential Exclusion

*This constraint is normative for tools generating AWF configurations.*

Because the API proxy sidecar is always active, source credentials (§9.1) are always excluded from the agent environment and held in the sidecar. A conforming implementation MUST NOT rely on `environment.excludeEnv` to suppress API keys — the sidecar handles exclusion automatically.

Tools that compile AWF configurations (e.g., `gh-aw`) MUST ensure that when an LLM agent requires an API key (OpenAI, Anthropic, Gemini, etc.), the real key is held by the sidecar and a placeholder is injected for tool compatibility.

### 9.4 One-Shot Token Protection

Real credentials forwarded to the agent — GitHub tokens (`GITHUB_TOKEN`, `GH_TOKEN`) and any non-LLM credentials — MUST
be protected by the one-shot-token mechanism. Protected tokens are cached
on first access and removed from `/proc/self/environ` to prevent
environment variable inspection.

The default protected token list is:

```
COPILOT_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN, GITHUB_API_TOKEN,
GITHUB_PAT, GH_ACCESS_TOKEN, OPENAI_API_KEY, OPENAI_KEY,
ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_API_KEY,
CODEX_API_KEY, COPILOT_PROVIDER_API_KEY
```

Placeholder compatibility values (§9.2 item 3) are not secrets. However,
provider credential variable names such as `ANTHROPIC_AUTH_TOKEN` MAY remain
on the protection list as defense-in-depth so unexpectedly forwarded real
credentials are still scrubbed on first read.

### 9.5 OIDC Authentication

When `apiProxy.auth.type` is set to `github-oidc`, the API proxy sidecar
exchanges a GitHub Actions OIDC token for a provider-specific access token.
The `apiProxy.auth.provider` field (default: `azure`) selects the token
exchange protocol. A conforming implementation MUST:

1. Forward the common OIDC configuration to the sidecar via the following
   environment variables:

   | Config path | Environment variable | Required | Default |
   |-------------|----------------------|----------|---------|
   | `apiProxy.auth.type` | `AWF_AUTH_TYPE` | ✅ | — |
   | `apiProxy.auth.provider` | `AWF_AUTH_PROVIDER` | No | `azure` |
   | `apiProxy.auth.oidcAudience` | `AWF_AUTH_OIDC_AUDIENCE` | No | *(provider-specific)* |

2. Forward the GitHub Actions OIDC runtime tokens
   (`ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`) to
   the sidecar when `AWF_AUTH_TYPE=github-oidc`. These are injected
   automatically by the Actions runner when the workflow declares
   `permissions: id-token: write`.

   If OIDC is requested for a provider but these runtime variables are not
   present in the sidecar environment, the provider adapter MUST fail closed
   and return an explicit configuration error (rather than falling back to
   static-key mode).

3. NOT expose the exchanged provider token in the agent container
   environment. The sidecar SHALL inject it into upstream request headers.

#### 9.5.1 Azure Provider (`provider: azure`)

Exchanges the GitHub OIDC JWT for an Azure AD / Microsoft Entra access
token via workload identity federation. The sidecar injects the resulting
token as a Bearer `Authorization` header on upstream requests.

| Config path | Environment variable | Required | Default |
|-------------|----------------------|----------|---------|
| `apiProxy.auth.azureTenantId` | `AWF_AUTH_AZURE_TENANT_ID` | ✅ | — |
| `apiProxy.auth.azureClientId` | `AWF_AUTH_AZURE_CLIENT_ID` | ✅ | — |
| `apiProxy.auth.azureScope` | `AWF_AUTH_AZURE_SCOPE` | No | `https://cognitiveservices.azure.com/.default` |
| `apiProxy.auth.azureCloud` | `AWF_AUTH_AZURE_CLOUD` | No | `public` |

Default OIDC audience: `api://AzureADTokenExchange`

> **Note:** `azureTenantId` and `azureClientId` are required for Azure AD
> federated credential exchange but MAY be omitted when using managed
> identity. See
> [docs/api-proxy-sidecar.md](api-proxy-sidecar.md#oidc-authentication-for-azure-openai)
> for protocol-level details.

#### 9.5.2 AWS Provider (`provider: aws`)

Exchanges the GitHub OIDC JWT for temporary AWS credentials via
`sts.amazonaws.com` `AssumeRoleWithWebIdentity`. The sidecar uses these
credentials to sign upstream requests to AWS Bedrock using SigV4.

| Config path | Environment variable | Required | Default |
|-------------|----------------------|----------|---------|
| `apiProxy.auth.awsRoleArn` | `AWF_AUTH_AWS_ROLE_ARN` | ✅ | — |
| `apiProxy.auth.awsRegion` | `AWF_AUTH_AWS_REGION` | ✅ | — |
| `apiProxy.auth.awsRoleSessionName` | `AWF_AUTH_AWS_ROLE_SESSION_NAME` | No | `awf-oidc-session` |

Default OIDC audience: `sts.amazonaws.com`

> **Note:** AWS Bedrock uses IAM/SigV4 request signing rather than Bearer
> tokens. This means the sidecar MUST sign the complete request (method,
> path, headers, body hash) with the temporary credentials — it is not
> sufficient to inject a single `Authorization` header.

#### 9.5.3 GCP Provider (`provider: gcp`)

Exchanges the GitHub OIDC JWT for a GCP access token via the Security
Token Service (`sts.googleapis.com`), optionally followed by service
account impersonation via `iamcredentials.googleapis.com`. The sidecar
injects the resulting token as a Bearer `Authorization` header.

| Config path | Environment variable | Required | Default |
|-------------|----------------------|----------|---------|
| `apiProxy.auth.gcpWorkloadIdentityProvider` | `AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER` | ✅ | — |
| `apiProxy.auth.gcpServiceAccount` | `AWF_AUTH_GCP_SERVICE_ACCOUNT` | No | — |
| `apiProxy.auth.gcpScope` | `AWF_AUTH_GCP_SCOPE` | No | `https://www.googleapis.com/auth/cloud-platform` |

Default OIDC audience: the `gcpWorkloadIdentityProvider` value

When `gcpServiceAccount` is provided, the sidecar performs a two-step
exchange:

1. Exchange GitHub OIDC JWT for a federated access token via GCP STS
2. Impersonate the service account to obtain a short-lived OAuth2 token

When `gcpServiceAccount` is omitted, only step 1 is performed and the
federated token is used directly. This requires that the federated
principal has direct access grants on the target resource.

#### 9.5.4 Anthropic Provider (`provider: anthropic`)

Exchanges the GitHub OIDC JWT for an Anthropic Workload Identity Federation
token via Anthropic OAuth token endpoint (default:
`https://api.anthropic.com/v1/oauth/token`). The sidecar injects
the resulting token as an `Authorization` header on upstream requests.

| Config path | Environment variable | Required | Default |
|-------------|----------------------|----------|---------|
| `apiProxy.auth.anthropicFederationRuleId` | `AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID` | ✅ | — |
| `apiProxy.auth.anthropicOrganizationId` | `AWF_AUTH_ANTHROPIC_ORGANIZATION_ID` | ✅ | — |
| `apiProxy.auth.anthropicServiceAccountId` | `AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID` | ✅ | — |
| `apiProxy.auth.anthropicWorkspaceId` | `AWF_AUTH_ANTHROPIC_WORKSPACE_ID` | Conditional¹ | — |
| `apiProxy.auth.anthropicTokenUrl` | `AWF_AUTH_ANTHROPIC_TOKEN_URL` | ❌ | `https://api.anthropic.com/v1/oauth/token` |

¹ `AWF_AUTH_ANTHROPIC_WORKSPACE_ID` is required when the federation rule covers
multiple workspaces. When the rule is scoped to a single workspace, it may be
omitted.

`anthropicTokenUrl` is non-sensitive and SHOULD be supplied via AWF config (including stdin config via `--config -`); env var support exists for compatibility.

Default OIDC audience: `https://api.anthropic.com`

### 9.6 DIFC Proxy Credential Isolation

When `security.difcProxy.host` is set, `GITHUB_TOKEN` and `GH_TOKEN` MUST
be excluded from the agent environment. These tokens SHALL be held
exclusively by the external DIFC proxy.

## 10. Effective Token Budget Enforcement

*This section is normative.*

When `apiProxy.maxEffectiveTokens` is configured, the API proxy MUST enforce
a cumulative effective-token budget across all LLM API requests in a single
run. The budget limits total *weighted* token consumption, not raw token
counts.

### 10.1 Token Weighting

Each upstream response's `usage` object is decomposed into four categories,
each with a fixed weight:

| Category | Weight | Usage field |
|----------|--------|-------------|
| Input | 1.0 | `input_tokens` / `prompt_tokens` |
| Cache read | 0.1 | `cache_read_input_tokens` / `prompt_tokens_details.cached_tokens` |
| Output | 4.0 | `output_tokens` / `completion_tokens` |
| Reasoning | 4.0 | `reasoning_tokens` / `completion_tokens_details.reasoning_tokens` |

The base weighted tokens for a single response are:

```
base = (1.0 × input) + (0.1 × cache_read) + (4.0 × output) + (4.0 × reasoning)
```

### 10.2 Model Multipliers

When `apiProxy.modelMultipliers` is configured, each model name MAY have
an associated positive multiplier. The effective tokens for a response are:

```
effective_tokens = model_multiplier × base_weighted_tokens
```

If no exact multiplier is configured, AWF MUST attempt to match
`apiProxy.modelMultipliers` keys against the request model using a hyphen-suffix
prefix match so family keys like `claude-opus-4.7` apply to concrete model IDs
like `claude-opus-4.7-20260501`.

If no exact or prefix match is found, and `apiProxy.defaultModelMultiplier` is
configured, that default multiplier MUST be used.

Otherwise, if no exact or prefix match is found, the multiplier MUST default to
the highest configured model multiplier. If no model multipliers are configured
at all, the multiplier defaults to `1`.

When AWF falls back to the default multiplier because no configured model key
matched, it MUST emit a warning log entry.

### 10.3 Enforcement Behavior

The API proxy MUST enforce the budget as follows:

1. **Accumulation**: After each successful upstream response, the proxy
   extracts the `usage` object, computes effective tokens, and adds them
   to a running total for the session.

2. **Pre-request check**: Before forwarding each subsequent request to the
   upstream provider, the proxy checks whether the cumulative total has
   reached or exceeded `maxEffectiveTokens`.

3. **Rejection**: When the budget is reached or exceeded, the proxy MUST reject the
   request with:
   - **HTTP status**: `403 Forbidden`
   - **Content-Type**: `application/json`
   - **Response body**:
     ```json
     {
       "error": {
         "type": "effective_tokens_limit_exceeded",
         "message": "Maximum effective tokens exceeded (1234.56 / 1000).",
         "total_effective_tokens": 1234.56,
         "max_effective_tokens": 1000
       }
     }
     ```

4. **WebSocket rejection**: For WebSocket upgrade requests, the proxy MUST
   reject with `HTTP/1.1 403 Forbidden` and include the same JSON
   error body before destroying the socket.

5. **Finality**: Once the budget is reached or exceeded, all subsequent requests in
   the same run MUST be rejected. The budget is not recoverable.

### 10.4 Threshold Tracking

The proxy MUST track when cumulative effective tokens cross the following
percentage thresholds of `maxEffectiveTokens`:

| Threshold |
|-----------|
| 80% |
| 90% |
| 95% |
| 99% |

Each threshold MUST be recorded at most once per run.

### 10.5 Token Steering

Token steering is **opt-in**. It is active only when `apiProxy.enableTokenSteering`
is `true` (CLI: `--enable-token-steering`). When disabled (the default), thresholds
are still tracked (for introspection) but no warning messages are injected.

When token steering is enabled and a threshold is first crossed, the proxy MUST
inject a budget-warning system message into the **body** of the very next eligible
request sent by the agent, then discard the pending message so that it is injected
at most once per threshold per run.

The injected message has the format:

```
[AWF TOKEN WARNING] <threshold-specific text>
```

| Threshold | Injected text |
|-----------|---------------|
| 80% | You have used 80% of your effective token budget. Begin planning to wrap up your current work. |
| 90% | You have used 90% of your effective token budget. Complete your current task and prepare final output. |
| 95% | You have used 95% of your effective token budget. Finalize and submit your work now. |
| 99% | You have used 99% of your effective token budget. You are about to be cut off. Submit immediately. |

If multiple thresholds are crossed simultaneously (e.g. a single large
response crosses both 80% and 90%), the proxy MUST inject only the highest
crossed threshold on the next request and queue the remaining thresholds for
subsequent requests (one per request).

**Provider-specific injection rules:**

- **OpenAI / Copilot** — the proxy inserts a `{ "role": "system", "content": "<message>" }` entry into the `messages` array immediately after any pre-existing system messages.
- **Anthropic** — the proxy appends the warning to the `system` field: if `system` is a string it is concatenated (separated by `\n\n`); if `system` is an array of content blocks a `{ "type": "text", "text": "<message>" }` block is appended; if `system` is absent it is created as the warning string.
- **Gemini** — the proxy appends a `{ "text": "<message>" }` part to `systemInstruction.parts`; if `systemInstruction` is absent it is created.

If the request body cannot be parsed as JSON, or if the body format does not
match the expected structure, the proxy MUST silently skip injection for that
request and NOT re-queue the message.

When token steering is enabled **and** `container.agentTimeout` is configured,
the proxy MUST also inject runtime warnings at 80/90/95/99% of elapsed run time
using the same queueing behavior (highest crossed threshold first, then one
pending warning per subsequent request):

```
[AWF TIME WARNING] <threshold-specific text>
```

### 10.6 Introspection

The API proxy exposes a `GET /reflect` endpoint on every provider port
(10000–10004). Each port returns the same aggregate reflection payload, whose
`endpoints` array lists all provider adapters. Only the management port
(10000, OpenAI) serves `/metrics` and the aggregate `/health`; non-management
ports still serve provider-local `/health` responses.

### 10.7 Max AI Credits Configuration

`maxAiCredits` is a positive number. It is supplied via the AWF config file
(including stdin config via `--config -`) and maps to the
`AWF_MAX_AI_CREDITS` environment variable injected into the api-proxy
container.

When configured, the proxy MUST enforce this budget in addition to any
configured `maxEffectiveTokens` budget. Once cumulative AI credits reach or
exceed `maxAiCredits`, subsequent requests MUST be rejected with HTTP `403`
and error type `ai_credits_limit_exceeded`.

Regardless of `maxAiCredits` configuration, AWF also enforces a non-overridable
hard cap of **10,000 AI credits**. When cumulative AI credits reach this hard
cap, subsequent requests MUST be rejected with HTTP `403` and error type
`ai_credits_limit_exceeded`, and the error/log payload MUST include
`hard_cap: true`.

If both limits are present, the effective enforcement threshold is the lower of:
- configured `maxAiCredits`
- the fixed hard cap (10,000)

Setting `maxAiCredits` above 10,000 MUST NOT raise the effective limit.

### 10.7.1 Model Name Resolution for Pricing

The AI credits guard resolves model names using this lookup order:

1. **Operator provider overlay** — model prices configured under
   `apiProxy.providers`.
2. **Runtime provider metadata** — authoritative token prices discovered from
   the configured provider. Copilot supports this today.
3. **Curated pricing table** — a built-in table of known models with exact pricing.
4. **Bundled models.dev catalog** — a bundled snapshot of the models.dev catalog used as a fallback when the model is not found in the curated table.

Model names are **canonicalized** before lookup: provider prefixes
(e.g. `copilot/`) are stripped, and separators (`.`, `_`, `-`) are treated
as interchangeable. For example, `copilot/claude-sonnet-4.6`,
`claude_sonnet_4_6`, and `claude-sonnet-4-6` all resolve to the same pricing
entry.

If none of these sources resolves the model, the `defaultAiCreditsPricing` fallback
(if configured) is used. If that is also absent, the request is rejected.
Models whose catalog entry carries zero-cost pricing are recognized as known
models with zero AI credit impact, so they are never rejected as "unknown".

Runtime tiered pricing uses the provider's default-tier prompt threshold. When
the total input exceeds that threshold, all token categories use the
long-context tier. Pricing source, API version, observation time, selected
tier, and any provider-advertised promotion are retained in provenance.
Promotions are informational only because provider discovery does not prove
that a discount applies to a specific request; they never reduce accounting.
Failed or empty discovery responses do not replace the last successful runtime
snapshot.

Provider overlays use the models.dev provider structure and per-token dollar
rates:

```yaml
apiProxy:
  providers:
    github-copilot:
      models:
        custom-model:
          cost:
            input: "3e-06"
            output: "1.5e-05"
            cache_read: "3e-07"
            cache_write: "3.75e-06"
```

The overlay is passed to both normal and threat-detection API proxy instances
through `AWF_API_PROXY_PROVIDERS`. Provider aliases `github-copilot` and
`copilot` resolve to the Copilot proxy.

### 10.7.2 Default AI Credits Pricing (Fallback)

`defaultAiCreditsPricing` is an optional object with `input` and `output`
fields (both required, in $/1M tokens), plus optional `cachedInput` and
`cacheWrite` fields.

It is supplied via the AWF config file and maps to the
`AWF_DEFAULT_AI_CREDITS_PRICING` environment variable (JSON string) injected
into the api-proxy container.

When configured, any model not found in the curated built-in pricing table or
the bundled models.dev catalog uses these rates as a fallback for AI credits
calculation.

### 10.7.3 Unknown Model Rejection

When `maxAiCredits` is active and the proxy encounters a request whose model
cannot be resolved from the curated built-in pricing table or the bundled
models.dev catalog:

1. **If `defaultAiCreditsPricing` is configured**: the fallback rates are used
   and the request proceeds normally.

2. **If `defaultAiCreditsPricing` is NOT configured**: the proxy MUST reject
   the request with HTTP `400` and error type `unknown_model_ai_credits`. The
   error payload includes:
   - `model`: the unresolved model name
   - `message`: human-readable instructions to configure
     `apiProxy.defaultAiCreditsPricing`

   This fail-closed behavior prevents unaccounted spending from models whose
   pricing is unknown to the proxy.

Note: Requests without a `model` field in the body (e.g. non-chat endpoints)
are not subject to this check.

### 10.7.4 Token Usage JSONL Schema Extensions

When AI credits and/or effective tokens are computed, the `token-usage.jsonl`
records include additional optional fields:

| Field | Type | Description |
|-------|------|-------------|
| `effective_tokens_this_response` | number | Weighted tokens for this request |
| `effective_tokens_total` | number | Running total of effective tokens |
| `model_multiplier` | number | Cost multiplier applied for this model |
| `ai_credits_this_response` | number | AI credits consumed by this request |
| `ai_credits_total` | number | Running total of AI credits |

These fields are only present when the respective guard is active.

## 11. Max-Runs Enforcement

*This section is normative.*

When `apiProxy.maxTurns` is configured, the API proxy MUST enforce an absolute
maximum number of LLM invocations per run.

### 11.1 Counting Invocations

An invocation is counted each time the proxy receives a successful (`2xx`)
HTTP response from an upstream LLM provider. Each response increments a
per-run counter by one, regardless of the number of tokens consumed.

### 11.2 Enforcement Behavior

The API proxy MUST enforce the max-runs limit as follows:

1. **Pre-request check**: Before forwarding each request to the upstream
   provider, the proxy checks whether the invocation count has reached or
   exceeded `maxTurns`.

2. **Rejection**: When the limit is reached or exceeded, the proxy MUST reject
   the request with:
   - **HTTP status**: `403 Forbidden`
   - **Content-Type**: `application/json`
   - **Response body**:
     ```json
     {
       "error": {
         "type": "max_runs_exceeded",
         "message": "Maximum LLM invocations exceeded (5 / 5).",
         "invocation_count": 5,
         "max_runs": 5
       }
     }
     ```

3. **WebSocket rejection**: For WebSocket upgrade requests, the proxy MUST
   reject with `HTTP/1.1 403 Forbidden` and include the same JSON
   error body before destroying the socket.

4. **Finality**: Once the limit is reached, all subsequent requests in the
   same run MUST be rejected. The counter is not recoverable.

### 11.3 Introspection

The `/reflect` endpoint (available on all provider ports 10000–10004; see
§10.6) MUST include the current max-runs state:

```json
{
  "runs": {
    "enabled": true,
    "max_runs": 5,
    "invocation_count": 3,
    "remaining_runs": 2
  }
}
```

When `maxTurns` is not configured, the `enabled` field MUST be `false` and
`max_runs` and `remaining_runs` MUST be `null`.

## 11a. Permission-Denied Guard

*This section is normative.*

When `apiProxy.maxPermissionDenied` is configured, the API proxy MUST halt
further LLM requests after the upstream returns a configurable number of
`401` or `403` responses, preventing token waste when API credentials are
misconfigured or expired.

### 11a.1 Counting Permission Errors

A permission error is counted each time the proxy receives an HTTP `401` or
`403` response from an upstream LLM provider. Each such response increments
a per-run counter by one.

### 11a.2 Enforcement Behavior

The API proxy MUST enforce the permission-denied limit as follows:

1. **Post-response counting**: After receiving a `401` or `403` from upstream,
   the proxy increments the denied count.

2. **Pre-request check**: Before forwarding each subsequent request to the
   upstream provider, the proxy checks whether the denied count has reached or
   exceeded `maxPermissionDenied`.

3. **Rejection**: When the limit is reached or exceeded, the proxy MUST reject
   the request with:
   - **HTTP status**: `403 Forbidden`
   - **Content-Type**: `application/json`
   - **Response body**:
     ```json
     {
       "error": {
         "type": "permission_denied_limit_exceeded",
         "message": "Permission denied limit exceeded (3 / 3). The run has been stopped due to repeated permission errors — check that all API keys and tokens are correctly configured.",
         "denied_count": 3,
         "max_permission_denied": 3
       }
     }
     ```

4. **Finality**: Once the limit is reached, all subsequent requests in the
   same run MUST be rejected until the configured limit changes (changing `AWF_MAX_PERMISSION_DENIED` resets the counter).

### 11a.3 Introspection

The `/reflect` endpoint (available on all provider ports 10000–10004; see
§10.6) MUST include the current permission-denied guard state:

```json
{
  "permission_denied": {
    "enabled": true,
    "max_permission_denied": 3,
    "denied_count": 1
  }
}
```

When `maxPermissionDenied` is not configured, the `enabled` field MUST be
`false`, `max_permission_denied` MUST be `null`, and `denied_count` MUST be `0`.

### 11a.4 Configuration

`maxPermissionDenied` is a positive integer. It is supplied via the AWF
config file (stdin config) or the `--max-permission-denied` CLI flag, and
maps to the `AWF_MAX_PERMISSION_DENIED` environment variable injected into
the api-proxy container.

**Example**:

```yaml
apiProxy:
  maxPermissionDenied: 3   # stop run after 3 upstream 401/403 responses
```

## 11b. Cache-Miss Guard

*This section is normative.*

When `apiProxy.maxCacheMisses` is configured, the API proxy MUST halt further
LLM requests after the configured number of consecutive responses that had no
prompt-cache hits, preventing runaway token spend caused by a broken or expired
cache (e.g., mismatched cache keys, context window overflow, or prompt drift).

### 11b.1 Counting Cache Misses

A cache miss is counted for a response when **all** of the following are true:

- The response is a successful upstream completion (not a proxy-level error).
- `input_tokens > 0` (zero-input responses such as empty tool calls are
  excluded so they do not inflate the streak counter).
- `cache_read_tokens === 0` (no prompt-cache hit occurred).

A cache *hit* (`cache_read_tokens > 0`) resets the consecutive miss streak to
zero.

### 11b.2 Enforcement Behavior

The API proxy MUST enforce the cache-miss limit as follows:

1. **Post-response counting**: After receiving each successful upstream
   response, the proxy inspects the normalized token usage and increments or
   resets the miss streak counter.

2. **Pre-request check**: Before forwarding each subsequent request to the
   upstream provider, the proxy checks whether the miss streak has reached or
   exceeded `maxCacheMisses`.

3. **Rejection**: When the limit is reached or exceeded, the proxy MUST reject
   the request with:
   - **HTTP status**: `403 Forbidden`
   - **Content-Type**: `application/json`
   - **Response body**:
     ```json
     {
       "error": {
         "type": "max_cache_misses_exceeded",
         "message": "Maximum consecutive cache misses exceeded (3 / 3).",
         "consecutive_cache_misses": 3,
         "max_cache_misses": 3
       }
     }
     ```

4. **WebSocket rejection**: For WebSocket upgrade requests, the proxy MUST
   reject with `HTTP/1.1 403 Forbidden` and include the same JSON error body
   before destroying the socket.

5. **Finality**: Once the streak limit is reached, all subsequent requests in
   the same run MUST be rejected. Changing `AWF_MAX_CACHE_MISSES` resets the
   streak counter.

### 11b.3 Introspection

The `/reflect` endpoint (available on all provider ports 10000–10004; see
§10.6) MUST include the current cache-miss guard state:

```json
{
  "cache_misses": {
    "enabled": true,
    "max_cache_misses": 3,
    "consecutive_cache_misses": 1,
    "remaining_cache_misses": 2
  }
}
```

When `maxCacheMisses` is not configured, the `enabled` field MUST be `false`,
`max_cache_misses` MUST be `null`, `consecutive_cache_misses` MUST be `0`, and
`remaining_cache_misses` MUST be `null`.

### 11b.4 Configuration

`maxCacheMisses` is a positive integer. It is supplied via the AWF config file
(stdin config) or the `--max-cache-misses` CLI flag, and maps to the
`AWF_MAX_CACHE_MISSES` environment variable injected into the api-proxy
container.

**Example**:

```yaml
apiProxy:
  maxCacheMisses: 3   # stop run after 3 consecutive cache misses
```

## 12. Model Multiplier Cap

*This section is normative.*

When `apiProxy.maxModelMultiplierCap` is configured, the API proxy MUST
reject any request whose resolved model multiplier exceeds the cap before
forwarding the request to the upstream provider.

### 12.1 Multiplier Resolution

The proxy resolves the effective multiplier for the requested model using the
same algorithm as the effective-token guard:

1. **Exact match**: if `apiProxy.modelMultipliers` contains the exact model
   name, use its multiplier.
2. **Longest-prefix match**: if any configured model name is a prefix of the
   requested model name (followed by `-`), use the multiplier of the
   longest-matching prefix.
3. **Default**: use `apiProxy.defaultModelMultiplier` if configured, otherwise
   default to `1`.

### 12.2 Enforcement Behavior

Before forwarding each POST/PUT/PATCH request to an upstream LLM provider,
the proxy MUST:

1. Extract the `model` field from the request body.
2. Resolve the model's effective multiplier (§12.1).
3. If the multiplier exceeds `maxModelMultiplierCap`, reject the request with:
   - **HTTP status**: `400 Bad Request`
   - **Content-Type**: `application/json`
   - **Response body**:
     ```json
     {
       "error": {
         "type": "model_multiplier_cap_exceeded",
         "message": "Model multiplier cap exceeded: model \"claude-opus-4.7\" has multiplier 27 which exceeds the configured maximum of 5.",
         "model": "claude-opus-4.7",
         "model_multiplier": 27,
         "max_model_multiplier": 5
       }
     }
     ```

4. If the model field is absent or the multiplier is within the cap, the
   request MUST be forwarded normally.

### 12.3 Configuration

`maxModelMultiplierCap` is a positive number. It is supplied via the AWF
config file (stdin config) and maps to the `AWF_MAX_MODEL_MULTIPLIER`
environment variable injected into the api-proxy container. The CLI flag
`--max-model-multiplier-cap <number>` may also be used.

**Example**:

```yaml
apiProxy:
  maxModelMultiplierCap: 5       # reject any model with multiplier > 5
  modelMultipliers:
    claude-opus-4.7: 27
    gpt-4o: 2
```

## 13. Model Fallback

*This section is normative.*

When `apiProxy.modelFallback` is configured, the API proxy provides automatic
model selection when a requested model is unavailable. The fallback mechanism
ensures requests complete gracefully without requiring explicit agent-side
handling.

### 12.1 Configuration

Model fallback is controlled via `apiProxy.modelFallback`:

```json
{
  "apiProxy": {
    "modelFallback": {
      "enabled": true,
      "strategy": "middle_power"
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the fallback mechanism |
| `strategy` | string | `middle_power` | Selection strategy (`middle_power` is currently the only strategy) |
| `excludeEngines` | string[] | `[]` | Engines for which middle-power fallback is suppressed (e.g. `["openai"]`). Excluded engines receive native model-unavailable errors instead of silent rewrites. |

### 12.2 Middle-Power Strategy

When `strategy` is `middle_power`, the proxy selects the median capability-tier
model from the available models for the current provider.

**Capability tiers** are assigned based on model family and version:

| Provider | Tier 5 | Tier 4 | Tier 3 | Tier 1 |
|----------|--------|--------|--------|--------|
| Anthropic | `claude-opus*` | `claude-sonnet*` | `claude-haiku*` | (other) |
| OpenAI / Copilot | `gpt-5*` | `gpt-4*`, `gpt-4o*` | `gpt-3.5*` | (other) |
| Gemini | (reserved) | (reserved) | (reserved) | (all) |

**Selection algorithm:**
1. Sort available models by capability tier (highest first), then lexicographically
2. Select the median model from the sorted list
3. Log the selection with the reason and full candidate list

**Example:**
```
Available: ['gpt-3.5-turbo', 'gpt-5.2', 'gpt-4.1']
Sorted:   ['gpt-5.2' (tier 5), 'gpt-4.1' (tier 4), 'gpt-3.5-turbo' (tier 3)]
Median:   gpt-4.1 (index 1 of 0-2)
```

### 12.3 Activation Conditions

The fallback is activated when:

1. **Direct match fails**: The requested model is not found in the available
   models list for the provider.
2. **Family version fallback doesn't apply**: For `gpt-5.*` models on OpenAI,
   if a lower `gpt-5.*` version is available, use that before triggering
   middle-power fallback.
3. **Alias has no candidates**: An alias pattern matched but produced no
   resolvable models on the current provider.

The fallback is **NOT** activated when:
- A direct model match is found (return it immediately)
- A family version fallback is available (for `gpt-5.*` only)
- The fallback is disabled (`enabled: false`)
- An alias has `fallback: false` (see §12.4)
- The provider is in the `excludeEngines` list
- Copilot engine in standard mode (no BYOK env vars): the Copilot CLI is
  authoritative for its own model catalogue, so retired/restricted model names
  should fail fast with a clear upstream error rather than being silently
  rewritten to a middle-power fallback
- Copilot BYOK that still targets a GitHub Copilot catalog host (for example
  `api.githubcopilot.com`): the catalog remains authoritative, so fallback is
  still suppressed
- Copilot is configured for a BYOK non-`githubcopilot` target (for example Azure
  OpenAI deployment endpoints), where deployment names are provider-local and
  must not be rewritten to catalog model IDs

### 12.4 Extended Alias Syntax

Model aliases now support an extended syntax that permits per-alias fallback
control:

**Legacy syntax** (string array):
```json
{
  "models": {
    "sonnet": ["copilot/*sonnet*", "openai/*sonnet*"]
  }
}
```
Fallback is **enabled** by default for legacy syntax.

**Extended syntax** (object with patterns):
```json
{
  "models": {
    "sonnet": {
      "patterns": ["copilot/*sonnet*"],
      "fallback": false
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `patterns` | string[] | — | Glob patterns to match against available models |
| `fallback` | boolean | `true` | Enable fallback for this alias if no candidates are found |

When `fallback: false`, if the alias patterns produce no candidates, the
resolution returns `null` instead of activating middle-power fallback.

### 12.5 Introspection

The health endpoint (`GET /health`) includes a `model_fallback` field in the
response:

```json
{
  "status": "healthy",
  "service": "awf-api-proxy",
  "model_fallback": {
    "enabled": true,
    "strategy": "middle_power"
  }
}
```

The `/reflect` endpoint does not include fallback state by design (it is static
per run).

### 12.6 Pre-Startup Model Validation

When `apiProxy.requestedModel` is configured, the API proxy validates at startup
that the specified model is available in at least one provider's model catalogue.

**Configuration:**

```json
{
  "apiProxy": {
    "requestedModel": "gpt-4o"
  }
}
```

**Mapping:** `apiProxy.requestedModel` → `AWF_REQUESTED_MODEL` *(config-only; set by AWF CLI)*

**Behavior:**

1. After `fetchStartupModels()` completes, the proxy checks `AWF_REQUESTED_MODEL`
   against all cached provider model lists.
2. If the model is found directly or resolves via model aliases, a confirmation
   `model_validation` log is emitted.
3. If the model is NOT found, a `model_unavailable_at_startup` error log is
   emitted listing available models as a diagnostic aid.
4. Validation is **non-blocking** — the proxy continues serving requests regardless
   of the outcome, so agents that ignore the model hint are not affected.

This enables workflow authors to get clear, early feedback when a retired or
misspelled model is specified, rather than waiting for the first API request to
fail with an opaque error.

## 13. Model Alias Logging

The API proxy emits structured logging events during model alias resolution.
These events are critical for debugging model routing decisions in production.

### 13.1 Always-On Events (stdout)

The following events are emitted as JSON lines to the API proxy's stdout
(captured by Docker logging). They are **always active** when model aliases
are configured (`apiProxy.models`):

| Event | Trigger | Key fields |
|-------|---------|------------|
| `model_resolution` | Every request where a model alias resolves | `requested_model`, `resolved_model`, `provider`, `resolution_log[]` |
| `model_rewrite` | Every request where the model field is rewritten | `original_model`, `rewritten_model`, `provider` |
| `model_fallback_activated` | Fallback strategy selected a replacement | `reason`, `selected`, `candidates[]` |
| `model_fallback_skipped` | Fallback was available but explicitly suppressed | `reason`, `requested_model` |
| `model_fallback_candidates` | Informational: available fallback models | `candidates[]`, `strategy` |

These events are written by `logRequest()` in `containers/api-proxy/logging.js`.

### 13.2 Diagnostic Events (token-diag.jsonl)

When `apiProxy.logging.debugTokens` is `true` (or `AWF_DEBUG_TOKENS=1`),
additional diagnostic events are written to `token-diag.jsonl` in the directory
specified by `apiProxy.logging.tokenLogDir` (default: `/var/log/api-proxy`):

| Event | Description |
|-------|-------------|
| `model_alias_resolution_step` | Each step in the alias resolution chain (input → pattern match → candidate) |
| `model_alias_rewrite` | Final rewrite decision with before/after model names and matched pattern |

Each diagnostic record follows the `token-diag/v<version>` schema:

```json
{
  "_schema": "token-diag/v0.25.40",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "event": "model_alias_resolution_step",
  "data": {
    "alias": "sonnet",
    "pattern": "anthropic/*sonnet*",
    "candidate": "claude-sonnet-4-5",
    "provider": "anthropic"
  }
}
```

### 13.3 Configuration

```yaml
apiProxy:
  models:
    sonnet: ["copilot/*sonnet*", "anthropic/*sonnet*"]
  logging:
    debugTokens: true
    tokenLogDir: "/var/log/api-proxy"
  diagnostics:
    captureBlockedRequests: summary  # false | summary | redacted | full
    maxCapturedBytes: 250000
```

| Property | Type | Default | Env var | Description |
|----------|------|---------|---------|-------------|
| `apiProxy.logging.debugTokens` | boolean | `false` | `AWF_DEBUG_TOKENS` | Enable diagnostic token/model-alias logging to file |
| `apiProxy.logging.tokenLogDir` | string | `/var/log/api-proxy` | `AWF_TOKEN_LOG_DIR` | Directory for `token-usage.jsonl` and `token-diag.jsonl` |
| `apiProxy.diagnostics.captureBlockedRequests` | string \| boolean | `false` | `AWF_CAPTURE_BLOCKED_LLM_REQUESTS` | Capture body-shape info for guard-blocked requests (`false`/`true`/`summary`/`redacted`/`full`; `true` is an alias for `summary`) |
| `apiProxy.diagnostics.maxCapturedBytes` | integer | `250000` | `AWF_MAX_BLOCKED_CAPTURE_BYTES` | Max bytes per record in `full` capture mode |

### 13.4 Log File Inventory

AWF produces the following structured and unstructured log files at runtime.
All JSONL files use the `.jsonl` extension.

All AWF JSONL records **MUST** include the following top-level fields:

- `timestamp` (string, required): ISO 8601 UTC with milliseconds (`YYYY-MM-DDTHH:mm:ss.SSSZ`).
- `event` (string, required): Stable snake_case record discriminator.
- `_schema` (string, required): Schema identifier in the form `<record-type>/v<version>`.

#### Squid Proxy Logs

Directory: configured by `logging.proxyLogsDir` (default: `<workDir>/squid-logs/`)

| File | Format | Description | Always written |
|------|--------|-------------|----------------|
| `access.log` | Custom text (`firewall_detailed` logformat) | L7 HTTP/HTTPS traffic decisions with timestamps, client IP, domain, status, and decision codes | Yes |
| `audit.jsonl` | JSONL (`audit/v<version>` schema) | Structured version of access log; preferred for programmatic consumption | Yes |
| `cache.log` | Squid native text | Squid internal diagnostics (startup, shutdown, errors) | Yes |

#### API Proxy Logs

Directory: configured by `apiProxy.logging.tokenLogDir` / `AWF_TOKEN_LOG_DIR`
(default: `/var/log/api-proxy/`; must be `/var/log/api-proxy` or a subdirectory to be preserved by AWF's default bind mount)
| File | Format | Description | Always written |
|------|--------|-------------|----------------|
| `token-usage.jsonl` | JSONL (`token-usage/v<version>` schema) | Per-API-call token usage and cost records | Yes (when API proxy is active) |
| `token-diag.jsonl` | JSONL (`token-diag/v<version>` schema) | Diagnostic events: model resolution steps, alias rewrites, token budget decisions | Only when `apiProxy.logging.debugTokens: true` |
| `blocked-request-diag.jsonl` | JSONL (`blocked-request-diag/v<version>` schema) | Body-shape diagnostics for guard-blocked requests (effective tokens, AI credits, etc.) | Only when `apiProxy.diagnostics.captureBlockedRequests` is set |
| `otel.jsonl` | JSONL (OpenTelemetry spans) | Distributed tracing spans; written as local fallback when no OTLP collector is configured | Only when OTEL is active and no collector endpoint set |

#### CLI Proxy Logs

Directory: `/var/log/cli-proxy/` (or `AWF_CLI_PROXY_LOG_DIR`)

| File | Format | Description | Always written |
|------|--------|-------------|----------------|
| `access.jsonl` | JSONL | CLI proxy request audit records (gh CLI invocations routed through DIFC proxy) | Yes (when CLI proxy is active) |

#### API Proxy stdout (Docker logs)

The API proxy also emits JSON lines to stdout (captured by `docker logs`).
These are always active and include model resolution events (`model_resolution`,
`model_rewrite`, `model_fallback_*`). Use `docker logs awf-api-proxy` or
the AWF diagnostic log collection to access them.

### 13.5 Availability

Model alias logging was introduced in **v0.25.40** (PR #2329). The diagnostic
file mechanism (`token-persistence.js`) was refactored into a dedicated module
in v0.25.50 but the logging events and their format have been stable since
initial release.

### 13.6 Blocked Request Diagnostics (blocked-request-diag.jsonl)

When a guard hard-rails a request (e.g. `effective_tokens_limit_exceeded`,
`ai_credits_limit_exceeded`, `max_runs_exceeded`), the api-proxy can write a
structured diagnostic record to `blocked-request-diag.jsonl`.  This is
**opt-in and disabled by default**.

#### Enabling

Set the environment variable or config key before starting the container:

```sh
# Minimal (body-shape only, no content):
AWF_CAPTURE_BLOCKED_LLM_REQUESTS=summary

# Include first 200 chars of each message (for debugging over-large tool results):
AWF_CAPTURE_BLOCKED_LLM_REQUESTS=redacted

# Full body up to AWF_MAX_BLOCKED_CAPTURE_BYTES (default 250 000 bytes):
AWF_CAPTURE_BLOCKED_LLM_REQUESTS=full
AWF_MAX_BLOCKED_CAPTURE_BYTES=250000
```

Or via config YAML:

```yaml
apiProxy:
  diagnostics:
    captureBlockedRequests: summary   # false | summary | redacted | full
    maxCapturedBytes: 250000
```

#### Capture modes

| Mode | Content | Use case |
|------|---------|----------|
| `false` (default) | Nothing written | Production default |
| `summary` | Counts, sizes, hashes — **no content** | Safe for normal debugging; identify which message/tool-result was large |
| `redacted` | Summary + first 200 chars per message | Debug prompt growth without full disclosure |
| `full` | Full body up to `maxCapturedBytes` | Local/private runs only; explicitly document and review |

#### Record format

Each record follows the `blocked-request-diag/v<version>` schema:

```json
{
  "_schema": "blocked-request-diag/v0.26.0",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "event": "blocked_request_diag",
  "capture_mode": "summary",
  "request_id": "bc446626-a67b-4a78-a8c3-7293a2bc7306",
  "provider": "anthropic",
  "path": "/v1/messages",
  "guard_type": "effective_tokens_limit_exceeded",
  "guard_totals": {
    "total_effective_tokens": 27198679,
    "max_effective_tokens": 25000000
  },
  "body_transformed": true,
  "inbound_bytes": 184320,
  "body_bytes": 185040,
  "body_sha256": "a3f2b1c8d9e0f1a2",
  "model": "claude-opus-4.7",
  "streaming": true,
  "message_count": 52,
  "tool_result_count": 14,
  "message_sizes": [
    { "role": "user",      "content_type": "text",        "chars": 312,   "bytes": 312,   "estimated_tokens": 78 },
    { "role": "assistant", "content_type": "text",        "chars": 1840,  "bytes": 1840,  "estimated_tokens": 460 },
    { "role": "user",      "content_type": "tool_result", "chars": 94321, "bytes": 94321, "estimated_tokens": 23580, "tool_blocks": 3 }
  ]
}
```

#### Security considerations

- `summary` mode captures **no message content** and is safe for shared/public
  workflow runs.
- `redacted` mode includes short previews; review before attaching to public
  issues.
- `full` mode captures potentially sensitive prompt and tool-result content.
  Use only for private runs and rotate or delete the artifact promptly.
- The file is written to `AWF_TOKEN_LOG_DIR` alongside `token-usage.jsonl`
  and is governed by the same artifact-retention policy.

## 14. Bounded Queries

### 14.1 Purpose

A *bounded query* lets an agent ask a trusted broker to run a short,
agent-authored Python 3 script against a private repository and get back a
value conforming to a finite response schema the agent declares up front —
without the agent ever gaining network or filesystem access to that
repository.

Every private repository configured for bounded queries carries one of four
fixed **sensitivity categories**, each with an immutable maximum number of
bits the broker may reveal about that repository across an entire AWF run
(not per query):

| Sensitivity | Run budget | Notes |
|-------------|-----------:|-------|
| `public` | unmetered | Still schema/operationally bounded, but responses are never debited against a ledger. |
| `internal` | 64 bits/run | Default for legacy bare-string entries (§14.2). |
| `confidential` | 8 bits/run | |
| `sealed` | 0 bits/run | Can never fund even the cheapest possible query — never copies a seed or launches Python. |

There is **no per-query cap**. Every invocation may declare an arbitrarily
different response schema; the broker computes that invocation's maximum
complete-transcript information charge (§14.3) and debits it from the
repository's shared run balance *before* copying a seed or launching Python.
An invocation is allowed iff its charge fits the remaining balance — a cheap
boolean question and an expensive high-cardinality question both draw from
the same budget, just at different rates. Charges are never refunded,
regardless of outcome (success, failure, or timeout).
`boundedQueries.maxInvocations` is a separate, independent operational limit
(§14.2) unrelated to the bit ledger.

### 14.2 Configuration

The root object MAY contain a `boundedQueries` section:

```json
{
  "boundedQueries": {
    "enabled": true,
    "privateRepos": [
      { "repo": "my-org/my-private-repo", "sensitivity": "internal" },
      { "repo": "my-org/public-docs", "sensitivity": "public" }
    ],
    "runtime": "docker",
    "timeout": 30,
    "memoryLimit": "512m",
    "interpreter": "python3",
    "maxInvocations": 32
  }
}
```

| Field | Type | Constraints | Default |
|-------|------|-------------|---------|
| `enabled` | boolean | — | `false` |
| `privateRepos` | array | Non-empty and unique (by repo slug, case-insensitively) when `enabled` is `true`. Each entry is either an object `{ "repo": "owner/repo", "sensitivity": "public" \| "internal" \| "confidential" \| "sealed" }`, or (one-release legacy compatibility) a bare `owner/repo` string, normalized to `{ repo, sensitivity: "internal" }` with a warning. Each `repo` MUST be a bare `owner/repo` slug — no scheme/host (`://`), path traversal (`..`), query string (`?`), fragment (`#`), wildcard (`*`), or extra path segments. | `[]` |
| `runtime` | string | One of `"docker"`, `"gvisor"`, `"sbx"`. The `sbx` value is a fail-closed preview blocked unless its executable capability proof satisfies every mandatory isolation control. | `"docker"` |
| `timeout` | integer | `1`–`540` seconds (the final minute of the 10-minute response bucket is reserved for termination, validation, and cleanup; §14.3) | `30` |
| `memoryLimit` | string | Docker-style memory limit, e.g. `"512m"`, `"1g"` | `"512m"` |
| `interpreter` | string | Only `"python3"` is currently supported | `"python3"` |
| `maxInvocations` | integer | `1`–`10000`; an independent operational cap, unrelated to the per-repository bit ledger | `32` |

Property-level constraints are defined normatively by the `boundedQueries`
subschema in `docs/awf-config.schema.json`.

**Legacy `privateRepos` string entries.** A bare `owner/repo` string is
accepted for one release for backward compatibility and is normalized to
`{ repo, sensitivity: "internal" }`, emitting a warning
(`boundedQueries.privateRepos entry "..." is a legacy bare string...`) through
the same warning channel other config normalization uses. New configuration
SHOULD use the explicit object form so the intended sensitivity is never
left implicit.

**Mapping:** every `boundedQueries.*` field is *(config-only; no CLI
equivalent)*. There is no `--bounded-queries-*` CLI flag family. The config-file
value is passed through `config-mapper.ts` and normalized (defaults applied
via `src/types/bounded-query-options.ts`'s `BOUNDED_QUERY_DEFAULTS`, legacy
string entries normalized in `src/parsers/bounded-query-parser.ts`) into
`WrapperConfig.boundedQueries`. Only an explicit `enabled: true` normalizes to
an enabled config; omission or any other value normalizes to
`enabled: false`.

When `enabled` is `false` or the section is absent, AWF stages nothing, starts
no broker, mounts no socket, sets no environment variable, installs no CLI,
and generates no skill: behaviour is byte-identical to a run without the
section.

**Preflight (fail-closed).** With `enabled: true`, AWF aborts before the
primary agent starts when: `privateRepos` is empty or contains an unsafe or
duplicated slug; `runtime` is `"gvisor"` and the `runsc` OCI runtime is not
registered with the Docker daemon; `runtime` is `"sbx"` and the executable
capability proof cannot establish every mandatory no-network and resource
bound; a Docker/gVisor query resolves to a non-`unix://` Docker host, which a
`network_mode: none` broker cannot reach; the interpreter or a limit is
unsupported; `timeout` exceeds 540
seconds — the 10-minute response bucket reserves its final minute for Docker
termination, result validation, container removal, and workspace cleanup; no
staging credential is present in
`GH_TOKEN`/`GITHUB_TOKEN`; or any seed cannot be materialized and verified.

**`sbx` query backend status.** The configuration value and broker-owned
`SbxQueryRunner` boundary are present, but support is fail-closed as of the
audited Docker Sandboxes CLI `v0.37.1`. The executable broker capability probe
uses `sbx version`, `sbx create --help`, and `sbx exec --help`, exits non-zero,
and reports missing guarantees as JSON. Although this release supports
`sbx create --name --cpus --memory --template`, read-only same-path mounts,
`sbx exec --user --workdir`, `sbx ls --json`, `sbx stop`, and
`sbx rm --force`, it has no enforceable per-VM `network=none`, PID, disk,
per-file size, or explicit guest mount-target control. Local/kit network denies
are not sufficient because organization governance can replace them. AWF
therefore aborts before staging or Compose assembly, passes no Docker socket or
sbx credential to the broker, and never falls back to Docker/gVisor. Enabling
launch requires all missing controls plus a digest-pinned, Python
standard-library-only AWF query template/bootstrap.

**Independent runtime matrix.** `container.containerRuntime` selects the primary
agent while `boundedQueries.runtime` independently selects a fresh query
sandbox. Every accepted invocation creates one new sandbox and destroys it
before response. The current capability matrix is:

| Primary agent | Docker query | gVisor query | sbx query |
|---|---|---|---|
| Docker | Supported with Docker | Supported with registered `runsc` | Blocked |
| gVisor | Supported with primary `runsc` | Supported with registered `runsc` | Blocked |
| sbx | Supported after primary ingress probe | Supported after primary ingress and `runsc` probes | Blocked |

Unavailable cells abort at preflight and never stage. A blocked sbx query is an
expected security result, not runtime success. `"runtime": "sbx"` is both the
explicit experimental selection and a requirement to pass every executable
probe; it never authorizes fallback.

**Runtime telemetry.** Telemetry records contain exactly `primaryBackend`,
`queryBackend`, `lifecycleClass`, `capabilityState`, and `category`. They MUST
NOT contain repository data or identifiers, scripts, outputs, paths, tokens,
ingress capabilities, or daemon credentials.

Promotion of sbx queries requires real-VM proof of no network/lateral access,
all resource bounds, mount-target isolation, credential/state separation,
canonical output behavior, and cleanup after timeout, resource failure, and
interruption, plus a digest-pinned AWF Python-only template. Version/help
probing alone is insufficient.

The seed map the broker reads carries each repository's trusted
`sensitivity` alongside its opaque seed id — the map is built entirely from
AWF configuration, so a request can never choose or override its own
repository's sensitivity or run budget.

### 14.3 Request/Result Protocol (v2)

`src/bounded-query/protocol.ts` defines the wire protocol. The broker restates
it in `containers/bounded-query/broker/protocol.js` because it runs from its
own container image and cannot import AWF's TypeScript sources; the two
implementations are pinned together by
`src/bounded-query/protocol-parity.test.ts`, which runs one large shared
vector table (schemas, values, requests, and query results) through both.

**Request.** A bounded-query request is a JSON object with exactly three
fields:

```json
{
  "privateRepo": "my-org/my-private-repo",
  "schema": { "type": "boolean" },
  "script": "<query script source>"
}
```

- `privateRepo` MUST match the same `owner/repo` slug rule as
  `boundedQueries.privateRepos` entries (§14.2).
- `schema` MUST be a valid document in the finite schema DSL below.
- `script` MUST be non-empty and at most 64 KiB (`MAX_SCRIPT_BYTES`). Script
  and schema sizes are enforced independently on their raw UTF-8 bytes; JSON
  escaping does not reduce either allowance.

**Result.** A successful query result is the canonical envelope
`{"status":"ok","result":<value>}`, where `<value>` conforms exactly to the
request's declared `schema`. Every failure mode — invalid request,
disallowed repository, exhausted bit budget, launch failure, timeout, crash,
non-conformant query output, or internal error — collapses to the single
canonical `{"status":"error"}`, indistinguishable from one another by
design.

#### The finite schema DSL

The response schema is a deliberately finite, agent-authored algebra — **not**
general JSON Schema. Every invocation may use a different schema. Supported
node types:

| type | shape | notes |
|------|-------|-------|
| `const` | `{"type":"const","value":<literal>}` | exactly one fixed value |
| `boolean` | `{"type":"boolean"}` | `true` or `false` |
| `enum` | `{"type":"enum","values":[<literal>,...]}` | unique literals, all the same JSON type |
| `integer` | `{"type":"integer","minimum":N,"maximum":M}` | inclusive bounded range, safe-integer bounds only |
| `object` | `{"type":"object","fields":{"name":<schema>,...}}` | every declared field required; no extra properties |
| `tuple` | `{"type":"tuple","items":[<schema>,...]}` | fixed-length, independently-typed positions |
| `array` | `{"type":"array","items":<schema>,"length":N}` | fixed length, single uniform item schema |
| `union` | `{"type":"union","variants":{"tag":<schema>,...}}` | value is `{"tag":"<name>","value":<...>}`; variants are disjoint by tag |

A literal (in `const`/`enum`) is a JSON string (at most `MAX_LITERAL_STRING_BYTES`
= 64 bytes UTF-8, no control characters), a safe integer, a boolean, or
`null`. There is no way to express an unbounded string, a float, a regex,
recursion, `$ref`, an optional field, `additionalProperties`, or an
untagged/overlapping union — these are structurally impossible to write, not
merely disallowed by a validator.

This is a deliberately safe *subset* of what a general schema language could
express, chosen so every schema has a computable, bounded cardinality and a
linear-time validator with no backtracking. If a future requirement needs a
richer construct, it must justify a new bounded primitive rather than
weakening these bounds. Every schema is additionally bounded structurally:

| Bound | Constant | Value |
|-------|----------|------:|
| Max nesting depth | `MAX_SCHEMA_DEPTH` | 6 |
| Max total schema nodes | `MAX_SCHEMA_NODES` | 64 |
| Max serialized schema size | `MAX_SCHEMA_BYTES` | 4096 bytes |
| Max `enum` values | `MAX_ENUM_VALUES` | 4096 |
| Max `object` fields | `MAX_OBJECT_FIELDS` | 16 |
| Max `tuple` items | `MAX_TUPLE_ITEMS` | 16 |
| Max `array` length | `MAX_ARRAY_LENGTH` | 64 |
| Max `union` variants | `MAX_UNION_VARIANTS` | 16 |
| Max literal string length | `MAX_LITERAL_STRING_BYTES` | 64 bytes |

In practice, `MAX_SCHEMA_BYTES` is often the binding constraint for wide
`enum`/`object`/`tuple` schemas well before the corresponding count bound is
reached (e.g. a numeric `enum` of exactly `MAX_ENUM_VALUES` values already
exceeds `MAX_SCHEMA_BYTES` once serialized).

#### Budget: cardinality and bit charge

"Schema cardinality" is the number of distinguishable values a schema
admits — 2 for `boolean`, `N` for an `N`-member `enum`, the product of field
cardinalities for `object`/`tuple`/`array`, the sum of variant cardinalities
for `union`, and 1 for `const`. Cardinality is computed with unbounded
(`BigInt`) arithmetic so no schema can overflow it into an incorrect small
number.

Every accepted invocation's information charge is:

```text
charge = RESULT_STATUS_BIT_COST            (1  — ok/error is itself observable)
       + ceil(log2(schema cardinality))    (the declared response schema)
       + TIMING_BUCKET_BITS                (3  — six timing buckets, §14.3.1)
```

`RESULT_STATUS_BIT_COST` is `1`; `TIMING_BUCKET_BITS` is
`ceil(log2(TIMING_BUCKETS_MS.length))` = `ceil(log2(6))` = `3`. The cheapest
possible schema (`const`, cardinality 1) still charges `1 + 0 + 3 = 4` bits —
this is the practical floor a repository's remaining balance is checked
against to decide whether it can fund *any* further invocation at all.

The charge is computed and the ledger is debited **before** a seed is
copied or Python is launched (§14.2, §14.7); it is never refunded regardless
of the invocation's outcome, because the broker committed to revealing up to
that many bits of signal the moment it decided to run.

#### 14.3.1 Response-timing buckets

A query's raw completion latency is itself a secret-dependent signal — a
script that raises early on one code path and runs to completion on another
leaks information purely through wall-clock time, independent of the
declared schema. The broker makes every *launched* invocation's observable
response time land on one of six fixed boundaries, using a monotonic clock
(`process.hrtime.bigint()`, never `Date.now()`, so system clock adjustments
cannot shift a response across a boundary):

```text
TIMING_BUCKETS_MS = [10ms, 100ms, 1s, 10s, 60s, 600s]
```

The broker returns at the first bucket boundary at or after the invocation's
processing (execution + output validation + container removal + workspace
teardown) actually completes. A public 5ms host-scheduler tolerance covers
ordinary timer jitter. If a selected boundary has already passed, or a timer
wakes more than 5ms late, the broker re-resolves and pads to the next fixed
boundary rather than responding at the late, continuously varying time. This is
included in the information budget as `TIMING_BUCKET_BITS` (3 bits — for six
buckets) whether or not the script's own answer would otherwise convey any
signal, because latency alone is observable and must be paid for like any
other channel.

**Cleanup is included in the bucketed measurement.** Repository size and
tree shape can affect container and workspace teardown, so the broker
completes cleanup before measuring elapsed time and selecting the response
bucket. Invocations are serialized; consequently a queued request cannot
observe a preceding invocation's unaccounted cleanup duration. Cleanup
failure maps to canonical error and is recorded only in the protected audit
log.

**Fail-closed timing overflow.** `boundedQueries.timeout` is capped at 540
seconds, reserving the final minute before the 600-second boundary for Docker
termination, result validation, container removal, and workspace cleanup. If
pathological infrastructure overhead nevertheless pushes total processing or
a late scheduler wake past the last boundary, the broker discards even an
otherwise-valid successful result and returns the canonical error. This is a
deliberate, tested (`broker.test.ts`) fallback, not a normal code path.

### 14.4 Canonical Failure Closure

Every failure mode — an invalid request, a disallowed repository, an
exhausted bit budget, an exhausted `maxInvocations` count, a launch failure,
a timeout, a script crash, non-conformant query output, a timing-bucket
overflow, or an internal broker error — collapses to the single canonical
`{"status":"error"}`. Failures are indistinguishable from each other by
design: the agent cannot infer which failure mode occurred from the
response alone.

### 14.5 Strict, Non-Schema Result Parsing and Post-Execution Validation

Result parsing intentionally does **not** execute a general-purpose JSON
Schema validator against the (potentially attacker-influenced) raw query
output text. `strictParseJson` enforces well-formedness with a small,
linear-time, non-backtracking hand-written grammar — rejecting, rather than
throwing, on:

- malformed JSON of any kind;
- duplicate object keys;
- any leading or trailing content outside the single JSON value; and
- invalid UTF-8 or invalid JSON string escapes.

The parsed value is then validated against the **exact** schema the request
declared (`validateValueAgainstSchema`) — wrong type, out-of-range integer,
an undeclared enum member, extra or missing object fields, the wrong
tuple/array length, or an unrecognized union tag are all rejected. A value
that passes validation is canonically re-serialized
(`canonicalizeSchemaValue`) before being wrapped in the `{"status":"ok",...}`
envelope, so the exact byte layout the query wrote (whitespace, key order,
duplicate-safe encoding) never reaches the agent — only a canonical
re-encoding of the validated value does.

Raw query bytes, stdout, stderr, and exit status never reach the agent under
any circumstance, success or failure.

### 14.6 Offline Staging

Before any configuration is generated and before any container exists, AWF
runs a trusted host-side staging phase (`src/bounded-query/staging.ts`):

1. resolves the staging credential from `GH_TOKEN` or `GITHUB_TOKEN`;
2. clones each configured repository from an AWF-constructed
   `https://github.com/<owner>/<repo>.git` URL into a run-unique, opaque seed
   directory under a dedicated per-run private root outside `/tmp`, the
   workspace, mounted home/tool directories, and configured agent mounts. The
   credential is passed
   only through a `GIT_ASKPASS` helper reading it from the child process
   environment — never in argv, never in the URL, never in a log line, and
   never in the generated compose file;
3. records the staged commit for protected audit state;
4. scrubs the seed: remotes, remote-tracking refs, credential helpers, hooks,
   alternates, worktree links, reflogs, and `FETCH_HEAD` are removed and
   `.git/config` is replaced with a minimal, credential-free file;
5. rejects repositories that declare submodules (`.gitmodules` or
   `.git/modules`) and any checkout whose `.git` is a symlink or a gitdir
   pointer — both are external references a query must never resolve;
6. strips every write bit from the seed and verifies the result;
7. deletes the askpass helper and the isolated staging `HOME`, so no staging
   artifact survives into the broker/agent phase.

The generated seed map (`{ repo, seedId, sensitivity }` per entry) carries
each repository's trusted `sensitivity` alongside its opaque seed id; this
map is the broker's *only* source of sensitivity information — a request
field can never supply or override it.

Staging failure aborts the run. There is no fallback clone or fetch anywhere
else in the system: neither the broker nor a query has a network path. A
`sealed` (0-bit) repository is still staged like any other (so its
configuration is validated the same way), but its run budget structurally
guarantees the broker never copies that seed or launches Python for it.

### 14.7 Trusted Broker and Query Sandbox

The broker runs as an optional Docker Compose service
(`bounded-query-broker`, container `awf-bounded-query-broker`). For Compose
agents it uses `network_mode: none`; its entire surface is one Unix socket in a
directory bind-mounted into the agent. For an sbx primary agent, trusted
preflight first executes a disposable-sandbox probe of Unix-socket passthrough.
If that probe succeeds, the same socket transport is used. Otherwise the
broker is attached only to a dedicated Docker `internal` network with one
ephemeral port narrowly published on host `127.0.0.1`. It is never attached to
`awf-net`, `awf-ext`, Squid, DNS, or an internet-routed network. It also
receives the resolved Docker socket so it can launch queries; that path is
never placed in the agent's environment or volumes.

The sbx endpoint requires a random per-run capability read by the broker from
broker-private control state. A separate one-shot probe capability proves the
actual sandbox can reach the endpoint before the primary agent starts. Both
capabilities are absent from generated skills, Compose and audit artifacts,
logs, query environments, and query launch arguments. The broker exposes no
health or diagnostic route: both transports use the exact same `POST /query`
framing, limits, canonical result bytes, scheduler/timing buckets, and audit
path. Authentication, malformed framing, oversized requests, and internal
failures all collapse to `{"status":"error"}`.

The broker maps a normalized `owner/repo` id through the AWF-generated seed
map to an opaque seed directory and its trusted sensitivity. Callers never
supply a path, URL, ref, mount, image, command, environment, runtime, limit,
or sensitivity. For each request that passes schema validation and clears
its repository's remaining bit ledger (in that order — an invalid schema or
an unaffordable charge is rejected before any seed is touched), the broker
creates a fresh, full, private writable copy of exactly one seed and
launches one query container with a fixed argument vector:

- `--network none`, `--read-only`, `--user 65534:65534`, `--cap-drop ALL`,
  `--security-opt no-new-privileges:true`, and a restrictive seccomp profile
  (`containers/bounded-query/query-seccomp.json`);
- memory, swap, CPU, PID, open-file, and file-size bounds plus the configured
  wall-clock timeout;
- exactly two mounts: the invocation's private tree at `/query` (containing
  `repo/`, and where the query writes `out`) and the submitted script at the
  fixed read-only path `/awf/query-script.py`;
- no Docker socket, no seed parent, no other repository, no workspace, no
  credentials, and no prior invocation's data.

The invocation's workspace is torn down before the fixed timing bucket is
selected (§14.3.1), so cleanup duration remains inside the charged timing
channel. A cleanup failure produces canonical error and is recorded in the
protected audit log (`reason: 'cleanup-failed'`). Repository mutations are
ephemeral and are never returned or persisted. The result file is opened
with `O_NOFOLLOW` and must
be a regular file within the size cap, so replacing `/query/out` with a
symlink, FIFO, device, or socket cannot make the broker read anything else.

Query stdout/stderr is capped and discarded — never parsed, never returned,
never logged in a form reachable by the agent. Failure reasons (with
protected detail, e.g. `repo-not-allowed`, `bit-budget-exhausted`,
`invalid-request`, `query-launch-failed`, `timing-bucket-overflow`,
`cleanup-failed`) are written only below the dedicated broker-private root,
which is mounted into the broker alone.

### 14.8 Agent Interface

When bounded queries are enabled, a Compose agent receives exactly two bind
mounts — the broker socket directory (read-write) and a generated skill/wrapper
directory (read-only) — plus three environment variables
(`AWF_BOUNDED_QUERY_SOCKET`, `AWF_BOUNDED_QUERY_SKILL`,
`AWF_BOUNDED_QUERY_REPOS`, the last a comma-separated list of configured repo
slugs only — never sensitivities or budgets). GitHub tokens are removed from
the agent environment whenever bounded queries are enabled, independently of
the API and DIFC proxies.

`containers/agent/bounded-query-wrapper.sh` is installed on the agent's `PATH`
as `bounded-query` (protocol v2). It accepts only `--repo` once, `--schema`
once (a JSON document, at most `MAX_SCHEMA_BYTES` bytes), and the script on
stdin; every other option, the `--flag=value` form, and positional arguments
are rejected without contacting the broker. It always prints exactly one
canonical JSON line, writes nothing to stderr, and exits `0` — for both
outcomes and for every failure, including transport failures, which produce
`{"status":"error"}` locally. The wrapper cannot itself validate the
schema's structure, cardinality, or bit charge (that is the trusted
broker's job, enforced before it copies a seed or launches Python); its only
responsibilities are enforcing the fixed CLI shape, base64url-encoding the
schema into a request header, transporting the script body unmodified, and
passing the broker's response through unmodified.

An sbx agent receives only the generated skill/wrapper directory as a read-only
mount. If Unix passthrough was proven, it additionally receives the socket
directory read-only and `AWF_BOUNDED_QUERY_SOCKET`. Otherwise it receives
`AWF_BOUNDED_QUERY_ENDPOINT` and `AWF_BOUNDED_QUERY_CAPABILITY`. It never
receives the broker-private root, Docker socket, seeds, work/control/audit
state, seed map, probe capability, or query launch authority.

The generated `SKILL.md` is written under the run-specific ingress root and
mounted read-only at `/run/awf-bounded-query-skill/SKILL.md`. It documents,
per configured repository, its sensitivity and run budget (e.g. `` `octo/alpha`
— 64 bits/run (`internal`) ``), the finite schema DSL, the bit-charge
formula, the timing buckets, and the operational `maxInvocations` limit —
so an agent can design informed, low-cardinality questions. AWF deliberately
does **not** mount it into `$HOME/.copilot/skills` or the workspace's
`.github/skills`: Docker would create the mount point inside host user state
or inside the checked-out workspace. Agents therefore discover it through
`AWF_BOUNDED_QUERY_SKILL` rather than through automatic skill discovery. This
is a documented limitation, not an oversight.

All seeds, invocation workspaces, the seed map, broker control state, and
protected audit data live below
`/var/tmp/awf-bounded-query-private-<uid>-<workDir digest>/`. Only the disjoint
`/var/tmp/awf-bounded-query-ingress-<uid>-<workDir digest>/run/` (when Unix
transport is selected) and generated skill/wrapper directory are agent-visible
through explicit bind mounts. Before
credential-bearing staging, AWF resolves each path through
its longest existing ancestor (following symlinks) and rejects any private-root
overlap with the union of Docker, gVisor, and sbx agent-visible mounts,
including `/tmp`, the workspace, custom volumes, and whitelisted home tool
directories. Docker-in-Docker host-path translation is checked and applied to
the private broker mounts and ingress mounts symmetrically.

An sbx host that cannot create the disposable capability probe or cannot reach
the selected ingress from the actual primary sandbox fails preflight before
the agent command starts. Transport never silently downgrades after selection.
Query execution remains limited to the Docker and gVisor runners; this ingress
support does not execute query sandboxes inside sbx.

### 14.9 Protocol v1 Compatibility

Protocol v1 (three fixed outcomes plus the reserved `"ERROR"` sentinel, no
schema, no sensitivity, no bit ledger) is superseded by v2. There is no
runtime v1/v2 auto-negotiation in the current wrapper or broker — both are
deployed together as part of the same AWF release, and the wrapper always
sends `X-AWF-Query-Version: 2`. A safe compatibility translation for legacy
v1 three-outcome calls (mapping a fixed three-value `enum` schema to the old
`outcomes` shape) is a natural extension point if a future release needs to
accept both wire versions from mismatched wrapper/broker builds, but is not
implemented today because AWF always deploys the wrapper and broker as a
matched pair.

### 14.10 Residual Channels and Limits

- Every launched invocation's disclosure is bounded by its own declared
  schema's charge (§14.3) — not a fixed per-invocation cap — debited from its
  repository's run budget; `public` repositories are schema/operationally
  bounded but not bit-metered.
- `maxInvocations` counts every response, including rejections, as an
  independent operational limit unrelated to the bit ledger.
- Response timing is bucketed to one of six fixed boundaries and charged as
  part of the budget (§14.3.1); container and workspace cleanup complete
  before the bucket is selected (§14.3.1, §14.7).
- Per-invocation aggregate disk usage is bounded by the wall-clock timeout and
  a per-file size limit rather than a hard filesystem quota.
- The query rootfs is the broker image, so it also contains a Node runtime and
  the Docker CLI. Both are inert inside a query: there is no network, no
  Docker socket, no capability, and the entrypoint is fixed to `python3`.

## 15. Bounded Agents

### 15.1 Purpose

A *bounded agent* is the agentic sibling of a bounded query (§14). Instead of
running an agent-authored Python script, a trusted broker runs a **fixed,
AWF-authored model loop** inside a single-use *enclave* that reads one
immutable repository seed read-only, may call a configured model a bounded
number of times through the AWF API proxy, and must reduce its work to one
value conforming to a finite response schema the caller declared up front.

Bounded agents exist for questions that need judgment or multi-step reading
rather than a deterministic script, while keeping exactly the same disclosure
bound: the caller observes only `{"status":"ok","result":<value>}` or
`{"status":"error"}`.

Bounded agents reuse §14's sensitivity categories and budget table verbatim,
but they never share a **ledger**: each subsystem runs its own broker with its
own seed map in its own private root, so spending on one can never consume the
other's remaining balance. The remaining balance is never disclosed to the
caller in any form.

The feature is **config-only**: there are no `--bounded-agents-*` CLI flags.

### 15.2 Configuration

The root object MAY contain a `boundedAgents` section:

```json
{
  "boundedAgents": {
    "enabled": true,
    "privateRepos": [
      { "repo": "my-org/private-service", "sensitivity": "internal" }
    ],
    "runtime": "docker",
    "profile": "openai",
    "model": "gpt-4o-mini",
    "timeout": 120,
    "memoryLimit": "512m",
    "cpuLimit": "1",
    "pidsLimit": 128,
    "tmpfsLimit": "64m",
    "maxOutputBytes": 8192,
    "maxTaskBytes": 4096,
    "maxInvocations": 8,
    "maxModelRequests": 8,
    "maxModelTokens": 1024
  }
}
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `enabled` | boolean | `false` | Only an explicit `true` enables the subsystem. |
| `privateRepos` | array | — | Required when enabled. Each entry is `{ repo, sensitivity }`; `repo` MUST be a bare `owner/repo` slug and MUST be unique case-insensitively. There is no legacy bare-string form. |
| `runtime` | `docker` \| `gvisor` \| `sbx` | `docker` | `docker` and `gvisor` are implemented; `sbx` is capability-blocked (§15.7). |
| `profile` | `openai` \| `anthropic` | `openai` | Trusted provider protocol the enclave speaks to the API proxy. |
| `model` | string | — | Required when enabled. A request can never choose or override it. |
| `timeout` | integer (1–540) | `120` | Wall-clock bound for one enclave invocation. Capped so the 10-minute response bucket reserves its final minute for termination, validation, and cleanup. |
| `memoryLimit` | string | `"512m"` | Docker memory limit; swap disabled at the same value. |
| `cpuLimit` | string | `"1"` | Docker `--cpus`. |
| `pidsLimit` | integer | `128` | Docker `--pids-limit`. |
| `tmpfsLimit` | string | `"64m"` | Size bound for each writable tmpfs (`/tmp` and the `/agent` work/result root). |
| `maxOutputBytes` | integer (1–8192) | `8192` | Exact size bound on the dedicated result file. |
| `maxTaskBytes` | integer (1–65536) | `4096` | Byte bound on the caller-supplied task text. |
| `maxInvocations` | integer | `8` | Per-run response cap; every response, including a rejection, counts. |
| `maxModelRequests` | integer (1–64) | `8` | Model requests one invocation may issue. |
| `maxModelTokens` | integer (1–32768) | `1024` | `max_tokens` per model call. |

Every default is deliberately conservative: a bounded agent is a *model*
reading confidential source, so the safe posture is a small, short-lived,
low-token enclave that an operator must explicitly widen.

Bounded agents additionally REQUIRE, at preflight:

- the AWF API proxy to be enabled — the enclave holds no credentials and the
  API proxy is its only permitted upstream egress;
- a supported configured API target for the selected `profile` (an OpenAI
  credential for `openai`, an Anthropic credential for `anthropic`);
- a staging credential in `GH_TOKEN`/`GITHUB_TOKEN` on the AWF host;
- a Unix-socket Docker host;
- the **primary agent** runtime to be proven available — `docker`,
  `runsc` registration for `gvisor`, or a proven ingress path (Unix
  passthrough or authenticated `sbx-http`) for a primary `sbx` runtime. There
  is no blanket rejection of a primary microVM runtime; availability is
  proven independently for each run (§15.7.1);
- the selected **bounded-agent enclave** `runtime` to be proven available;
- `enableDind` to be disabled, because primary-agent access to the enclave's
  Docker daemon would bypass every finite-disclosure boundary. This holds
  regardless of primary or enclave backend — there is no runtime combination
  in which exposing that socket to the primary agent is safe.

Any failure aborts the run before the primary agent starts.

### 15.3 Request/Result Protocol

A bounded-agent request selects exactly three things:

| Field | Meaning |
|-------|---------|
| `privateRepo` | One configured repository, by `owner/repo` slug. |
| `schema` | A finite response schema, using the same algebra as §14.3. |
| `task` | Byte-bounded task text, forwarded verbatim into the enclave prompt. |

The `task` is byte-bounded *input*, never configuration: it cannot add a tool,
change the model, reach an endpoint, or alter any limit.

Everything else is fixed trusted configuration and MUST be rejected if it
appears in a request — image, command, executable, mount, path, environment,
endpoint, network, proxy, credential, timeout, resource limit, runtime, or
tool definition — as MUST any unknown key. Rejecting explicitly named controls
in addition to the generic unknown-key rule is redundant by construction; it
is retained so an accidental future widening of the accepted key set fails a
test rather than silently granting a capability.

The canonical success/error envelopes, the finite schema algebra, the
information charge (`1` status bit + `ceil(log2(cardinality))` + `3` timing
bits), the six fixed timing buckets, strict JSON parsing, and canonical
re-serialization are all the shared bounded-execution primitives introduced
for bounded queries (§14.3–§14.5) and are reused unchanged.

The charge is debited from the repository's run balance **before** any
workspace is materialized or any container is created, and is never refunded.

### 15.4 Trusted Host Lifecycle

Identical in shape to §14.6, against a disjoint private root:

1. **Preflight before staging.** Configuration validation and the enclave
   runtime capability proof run first, so a run that could never launch an
   enclave never clones a private repository.
2. **Sanitized seeds.** One immutable seed per configured repository is cloned
   with the staging credential, scrubbed of remotes, credential helpers,
   hooks, alternates, worktree links, and reflogs, rejected outright if it
   declares submodules, made read-only, and verified read-only.
3. **Credential scrub before launch.** The `GIT_ASKPASS` helper, the 0600
   token file, and the isolated staging `HOME` are removed before any
   container exists. The credential never appears in argv, a URL, a log line,
   the compose file, or any container environment.
4. **Protected directories and audit.** Seeds, per-invocation workspaces,
   control state, and the audit log live under a `0700` broker-private root at
   `/var/tmp/awf-bounded-agent-private-<uid>-<digest>`, which is asserted not
   to alias, contain, or be contained by any path visible to a primary agent
   in any supported backend. Only a separate ingress root (broker socket +
   generated `SKILL.md`/wrapper) is mounted into the agent.
5. **Deterministic orphan cleanup.** Every enclave carries
   `awf.bounded-agent.run=<runId>`; teardown force-removes every container with
   that label, including under `--keep-containers`, and the broker reconciles
   the same label at startup and shutdown.

### 15.5 Enclave Execution

For each accepted request the broker launches a fresh, uniquely named,
labelled container with a frozen argument vector:

- `--network <bounded-agent network>` — the enclave joins **only** the
  dedicated network (§15.6);
- `--read-only` root filesystem, with the immutable seed bind-mounted `ro` at
  `/awf/seed` (there is no writable copy of private source anywhere);
- the caller's task and schema bind-mounted `ro`; the result file bind-mounted
  `rw`;
- bounded `--tmpfs` mounts for `/tmp` and the `/agent` work/result root;
- fixed non-root uid/gid `65534:65534`, `--cap-drop ALL`,
  `--security-opt no-new-privileges:true`, a seccomp profile, and
  memory/memory-swap/CPU/PID/`RLIMIT_FSIZE`/`RLIMIT_NOFILE` bounds plus the
  wall-clock timeout;
- `--pull never`.

Cleanup runs before the response: the container is force-removed and the
workspace destroyed, and only then is the timing bucket selected.

The result MUST be a single JSON value in the dedicated bounded result file,
of at most `maxOutputBytes`. The broker reads it with `O_NOFOLLOW` plus an
explicit regular-file check, rejects invalid UTF-8, validates it strictly
against the declared schema, and canonically re-serializes it before
returning. Enclave stdout and stderr are captured only so the child cannot
block on a full pipe, and are then discarded.

The protected audit log never records the task, the repository name, the
transcript, the raw result, host paths, tokens, or provider payloads — only an
invocation id, the trusted sensitivity class, the charge, the timing bucket,
and a failure category.

### 15.6 Network Topology

Bounded agents introduce one dedicated Docker network, `awf-bounded-agent`,
declared `internal: true` with an explicit `name:` (the broker launches
enclaves with a fixed `docker run --network <name>` argument and must not have
to derive a Compose project prefix at runtime).

- The **enclave** is a member of that network and of nothing else. It is not on
  `awf-net` or `awf-ext`, has no Squid route and no general proxy, and cannot
  reach the primary agent, the broker, the safe-outputs collector, the MCP
  gateway, or the CLI proxy.
- A **dedicated API-proxy instance** joins `awf-bounded-agent` at a fixed
  address/alias and a separate egress bridge that no agent can join. It is the
  enclave's only upstream egress and the sole holder of a real provider
  credential. Its token logs, metrics, and quota state live under the
  bounded-agent private root, so enclave request metadata cannot form a side
  channel through the primary agent's API-proxy telemetry.
- The **broker** runs with `network_mode: none` and never joins the enclave
  network. It receives the Docker socket only because it launches enclaves;
  that path never enters the agent's environment or volumes. When the
  runtime-backend proof requires it (a primary `sbx` runtime unable to prove a
  direct Unix-socket passthrough, §15.7.1), the broker instead exposes a
  dedicated ingress network with one ephemeral port published only on the
  Docker host-gateway address, gated by a random, single-run capability token
  proven reachable before the primary agent starts; the broker itself never
  joins the enclave's `awf-bounded-agent` network either way.

### 15.7 Runtime Backends

`docker` uses the daemon's default OCI runtime. `gvisor` requires the `runsc`
OCI runtime to be registered with the daemon; availability is proven exactly at
preflight and again at broker startup, and an unavailable `runsc` NEVER
downgrades to the default runtime.

`sbx` is accepted by the JSON Schema but is **capability-blocked**: AWF ships a
dedicated bounded-agent sbx capability probe (host-side
`src/bounded-agent/sbx-capability.ts`, container-side
`containers/bounded-agent/broker/sbx-capability-probe.js`) that inspects the
exact audited Docker Sandboxes CLI surface using `sbx version`, authenticated
non-mutating `sbx ls`, and `create --help` / `exec --help` against the audited
version (`v0.37.1`). It reports every missing capability in structured JSON —
never a single collapsed boolean, and never a "not yet implemented"
placeholder. The blocked runner defines `create`, `exec`, `stop`, and
`rm --force`, but preflight does not claim to execute that lifecycle.

The bounded-agent enclave's network requirement is strictly harder than a
bounded query's: it must reach *exactly one* peer (the dedicated API proxy),
not "no network at all". Current `sbx create` exposes `--cpus`, `--memory`,
`--name`, `--template`, and read-only same-path mounts, but no enforceable,
mandatory API-proxy-only network policy (an advisory `HTTP_PROXY` env var is
not a hard network policy and is never treated as one), no PID limits, no disk
limits, no per-file size limits, and no pinned, digest-verified AWF
bounded-agent template/bootstrap. The probe therefore always reports these
missing and `supported` can never be `true` for the currently audited
version — an intentional, structural "no false pass" design, not an
oversight. AWF rejects this runtime before staging or compose assembly, mounts
neither the Docker socket nor any sbx daemon credential, and the broker's
`SbxEnclaveRunner.assertAvailable()` throws immediately if ever invoked.
Support remains blocked until sbx provides enforceable versions of all
controls and AWF publishes a digest-pinned, standard-library-only enclave
bootstrap.

#### 15.7.1 Primary-agent and bounded-agent runtime matrix

The primary agent runtime and the bounded-agent enclave runtime are separate,
independently-proven sandbox decisions — mirroring §14's primary-agent/query
matrix. `container.containerRuntime` selects the primary agent;
`boundedAgents.runtime` selects the single-use enclave. The broker never
reuses the primary agent sandbox; every accepted invocation creates a new
container with a unique run identity and destroys it before returning. No
combination ever falls back to a weaker or different backend.

`src/bounded-agent/runtime-matrix.ts` evaluates all nine
`primaryBackend` × `boundedAgentBackend` combinations independently and
records `lifecycleClass: 'invocation'`, `capabilityState`, and `category` per
cell for telemetry — never the task, repository name, provider payload, or
capability token.

| Primary agent | Docker enclave | gVisor enclave | sbx enclave |
|---|---|---|---|
| Docker | Supported when Docker is available | Supported when `runsc` is registered | **Blocked** by mandatory sbx enclave probes |
| gVisor | Supported when the primary `runsc` runtime is available | Supported when `runsc` is registered | **Blocked** by mandatory sbx enclave probes |
| sbx | Supported when primary sbx ingress (Unix passthrough or authenticated `sbx-http`) is proven | Supported when primary sbx ingress and `runsc` are proven | **Blocked** by mandatory sbx enclave probes |

Six of the nine cells are supported once the relevant runtime(s) are proven
available; the three `sbx`-enclave cells are not, and remain blocked until the
capability proof in §15.7 can report `supported: true` for an audited sbx
version. An unavailable primary runtime fails at primary preflight, before any
repository is staged; an unavailable enclave runtime fails at enclave
preflight, for the same reason.

`scripts/ci/report-bounded-agent-runtime-matrix.js` renders this matrix from
live host probes for CI/local use and reports an explicit `BLOCKED` result —
exiting non-zero under `--require <primary>/<boundedAgent>` — rather than a
false pass when no real sbx binary is present.

### 15.8 Agent Interface

When enabled, AWF generates two agent-visible artifacts in the ingress root:

- a `bounded-agent` CLI (installed at `/tmp/awf-lib/bounded-agent`, added to
  `PATH` by the agent entrypoint), and
- a read-only `SKILL.md` installed under `~/.github/skills/bounded-agent/`.

The CLI accepts exactly `--repo owner/repo`, `--schema '<json>'`, and the task
text on stdin. It always prints exactly one line of canonical JSON, writes
nothing to stderr, and exits `0` — for every outcome and every failure.

The enclave image is minimal and fixed: standard-library Python 3 plus one
AWF-authored bootstrap. There is no shell tooling for the model to reach, no
`gh`, no git, no package manager, no host state, and no credential. The model
gets three read-only repository tools (list, read, search) confined to the
seed, plus one terminal tool that records the final answer. Safe outputs and
MCP are not available inside the enclave.

### 15.9 Provider Disclosure Caveat

A bounded agent necessarily sends repository-derived content — file listings,
file excerpts, and search hits selected by the model — to the configured model
provider through the AWF API proxy. **The information-budget ledger bounds what
the *calling agent* learns, not what the *provider* sees.**

This is a materially different exposure from a bounded query, whose Python
sandbox has no network at all. Operators MUST treat the configured provider as
an authorized recipient of repository contents before enabling bounded agents
for a repository, and SHOULD prefer bounded queries when a deterministic script
can answer the question.

### 15.10 Residual Channels and Limits

- Disclosure to the calling agent is bounded by the declared schema's charge
  plus the status and timing channels, debited before any workspace or
  container exists; `public` repositories are schema/operationally bounded but
  not bit-metered.
- `maxInvocations` counts every response, including rejections.
- Response timing is bucketed to one of six fixed boundaries and charged;
  container and workspace cleanup complete before the bucket is selected.
- Model requests per invocation, completion tokens per request, task bytes, and
  result bytes are all separately bounded, but a model that is told to encode
  data in its final answer is still limited only by the declared schema's
  cardinality — which is exactly what the ledger charges for.
- Provider-side exposure is out of scope for the ledger (§15.9).
- The enclave shares the audited no-network sandbox seccomp profile with
  bounded queries; unlike a bounded query it does have a network interface, to
  the API proxy only.

## Normative References

- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) — Key words for use in
  RFCs to Indicate Requirement Levels
- `docs/awf-config.schema.json` — Machine-readable JSON Schema for
  configuration documents (normative)

## Runtime JSONL Schemas

AWF emits structured JSONL artifact files at runtime. Most record types have
a corresponding JSON Schema in the `schemas/` directory; opt-in diagnostic
formats are documented inline in this spec instead:

| Schema | JSONL file | Description |
|--------|------------|-------------|
| [`schemas/audit.schema.json`](../schemas/audit.schema.json) | `audit.jsonl` | L7 HTTP/HTTPS traffic decisions (allowed/denied) from the Squid proxy |
| [`schemas/token-usage.schema.json`](../schemas/token-usage.schema.json) | `token-usage.jsonl` | Per-API-call token usage records from the api-proxy sidecar |
| [`schemas/otel-span.schema.json`](../schemas/otel-span.schema.json) | `otel.jsonl` | OpenTelemetry span records emitted by the local file exporter |
| [`schemas/cli-proxy-access.schema.json`](../schemas/cli-proxy-access.schema.json) | `access.jsonl` (cli-proxy) | CLI proxy request audit records |
| *(inline, see §13.2)* | `token-diag.jsonl` | Model alias resolution steps and diagnostic events (opt-in via `apiProxy.logging.debugTokens`) |
| *(inline, see §13.6)* | `blocked-request-diag.jsonl` | Body-shape diagnostics for guard-blocked requests (opt-in via `apiProxy.diagnostics.captureBlockedRequests`) |

### Versioning

Schema files do not carry an independent version. The repository release
tag serves as the version:

- The `$id` field in each schema resolves to a stable release download URL.
- Each JSONL record includes a `_schema` wire-format field encoding the
  record type and AWF version (e.g., `"_schema": "audit/v0.26.0"`).
- Consumers SHOULD use a prefix match (`_schema.startsWith("audit/")`)
  rather than an exact match to handle future versions gracefully.

### Published locations

**Versioned (release assets):**
```
https://github.com/github/gh-aw-firewall/releases/download/<tag>/awf-config.schema.json
https://github.com/github/gh-aw-firewall/releases/download/<tag>/audit.schema.json
https://github.com/github/gh-aw-firewall/releases/download/<tag>/token-usage.schema.json
https://github.com/github/gh-aw-firewall/releases/download/<tag>/otel-span.schema.json
https://github.com/github/gh-aw-firewall/releases/download/<tag>/cli-proxy-access.schema.json
```

**Latest (main branch):**
```
https://raw.githubusercontent.com/github/gh-aw-firewall/main/docs/awf-config.schema.json
https://raw.githubusercontent.com/github/gh-aw-firewall/main/schemas/audit.schema.json
https://raw.githubusercontent.com/github/gh-aw-firewall/main/schemas/token-usage.schema.json
https://raw.githubusercontent.com/github/gh-aw-firewall/main/schemas/otel-span.schema.json
https://raw.githubusercontent.com/github/gh-aw-firewall/main/schemas/cli-proxy-access.schema.json
```

## Informative References

- [docs/arc-dind.md](arc-dind.md) — ARC/DinD split-filesystem architecture, sysroot
  staging, and end-to-end configuration examples
- [docs/environment.md](environment.md) — Usage guide for environment
  variables
- [docs/authentication-architecture.md](authentication-architecture.md) —
  Credential isolation architecture and diagrams
- [docs/api-proxy-sidecar.md](api-proxy-sidecar.md) — API proxy sidecar
  configuration including OIDC authentication for Azure OpenAI
- [schemas/README.md](../schemas/README.md) — JSONL schema directory with
  validation examples and versioning policy
