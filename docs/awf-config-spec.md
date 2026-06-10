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
| `environment` | object | Environment variable propagation (see §8) |
| `logging` | object | Logging and diagnostics |
| `rateLimiting` | object | Egress rate limiting |

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
- `apiProxy.enabled` → `--enable-api-proxy`
- `apiProxy.enableTokenSteering` → `--enable-token-steering`
- `apiProxy.anthropicAutoCache` → `--anthropic-auto-cache`
- `apiProxy.anthropicCacheTailTtl` → `--anthropic-cache-tail-ttl <5m|1h>`
- `apiProxy.maxEffectiveTokens` → *(config-only; no CLI equivalent)*
- `apiProxy.modelMultipliers` → `--max-model-multiplier <model:multiplier,...>`
- `apiProxy.defaultModelMultiplier` → *(config-only; maps to `AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER`)*
- `apiProxy.maxTurns` → *(config-only; no CLI equivalent)*
- `apiProxy.maxModelMultiplierCap` → `--max-model-multiplier-cap <number>`
- `apiProxy.maxPermissionDenied` → `--max-permission-denied <number>`
- `apiProxy.requestedModel` → *(config-only; maps to `AWF_REQUESTED_MODEL` for pre-startup validation)*
- `apiProxy.modelFallback` → *(config-only; model fallback strategy)*
- `apiProxy.modelRouter.providerType` → *(config-only; maps to `COPILOT_PROVIDER_TYPE`)*
- `apiProxy.modelRouter.baseUrl` → *(config-only; maps to `COPILOT_PROVIDER_BASE_URL`)*
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
| Actions artifact tokens | `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RESULTS_URL` |
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
| Actions OIDC | `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` |
| Docker client | `DOCKER_HOST`, `DOCKER_TLS`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, `DOCKER_CONFIG`, `DOCKER_CONTEXT`, `DOCKER_API_VERSION`, `DOCKER_DEFAULT_PLATFORM` |
| User environment | `USER`, `XDG_CONFIG_HOME` |

When `--env-all` IS active, all host variables not in the excluded set
(§8.3) SHALL be forwarded, subject to credential isolation rules (§9).

### 8.5 Explicit Overrides

Variables passed via `-e` / `--env` MUST override all other sources,
including AWF-reserved variables. This is the only mechanism by which proxy
routing variables MAY be overridden.

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

5. The API proxy sidecar SHALL inject the real credentials into upstream
   requests. Sidecar port assignments: 10000 (OpenAI), 10001 (Anthropic),
   10002 (Copilot), 10003 (Gemini).

6. A conforming implementation MUST forward the following OpenTelemetry
   variables from the host into the **api-proxy sidecar** container so that
   the sidecar can participate in the distributed trace established by the
   workflow:

   | Variable | Description |
   |----------|-------------|
   | `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector URL. When present, activates span export via Squid proxy. |
   | `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` auth headers for the OTLP endpoint. |
   | `OTEL_SERVICE_NAME` | Service name tag. Defaults to `awf-api-proxy` when not set. |
   | `GITHUB_AW_OTEL_TRACE_ID` | W3C trace-id of the parent workflow trace. |
   | `GITHUB_AW_OTEL_PARENT_SPAN_ID` | W3C span-id of the parent workflow span. |

   These variables are NOT forwarded to the agent container via this mechanism;
   the agent receives OTEL variables through the standard `OTEL_*` prefix
   forwarding described in §8.4.

   When `OTEL_EXPORTER_OTLP_ENDPOINT` is absent, the sidecar writes span
   NDJSON to `/var/log/api-proxy/otel.jsonl` as a local fallback.
   When `GITHUB_AW_OTEL_TRACE_ID` / `GITHUB_AW_OTEL_PARENT_SPAN_ID` are
   present and valid hex, each sidecar span is created as a child of the
   specified parent span, enabling end-to-end distributed tracing from the
   GitHub Actions workflow through the api-proxy to the LLM provider.

### 9.3 API Proxy Disabled (`apiProxy.enabled = false`)

When the API proxy sidecar is disabled (the default):

1. Source credentials present in the host environment SHOULD be forwarded
   directly to the agent container.
2. No proxy-routing variables or placeholder values SHALL be injected.

### 9.4 Credential Exclusion Requires API Proxy

*This constraint is normative for tools generating AWF configurations.*

A conforming configuration MUST NOT exclude a source credential (§9.1) via
`environment.excludeEnv` unless `apiProxy.enabled` is `true`. Excluding a
credential without enabling the API proxy leaves the agent with no key and
no placeholder, causing authentication failures at runtime.

Tools that compile AWF configurations (e.g., `gh-aw`) MUST ensure that when
an LLM agent requires an API key (OpenAI, Anthropic, Gemini, etc.), **one**
of the following holds:

1. `apiProxy.enabled = true` — the real key is held by the sidecar, and a
   placeholder is injected for tool compatibility; or
2. The key is forwarded directly to the agent container (non-proxy mode).

Emitting `excludeEnv: ["OPENAI_API_KEY"]` without `apiProxy.enabled: true`
is a configuration error. A conforming implementation MAY emit a warning
when this condition is detected.

### 9.4 One-Shot Token Protection

Real credentials forwarded to the agent — whether source credentials in
non-proxy mode (§9.3) or GitHub tokens (`GITHUB_TOKEN`, `GH_TOKEN`) — MUST
be protected by the one-shot-token mechanism. Protected tokens are cached
on first access and removed from `/proc/self/environ` to prevent
environment variable inspection.

The default protected token list is:

```
COPILOT_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN, GITHUB_API_TOKEN,
GITHUB_PAT, GH_ACCESS_TOKEN, OPENAI_API_KEY, OPENAI_KEY,
ANTHROPIC_API_KEY, CLAUDE_API_KEY, CODEX_API_KEY,
COPILOT_PROVIDER_API_KEY
```

Placeholder compatibility values (§9.2 item 3) are not secrets and MUST
NOT be subject to one-shot protection.

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
   - **HTTP status**: `429 Too Many Requests`
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
   reject with `HTTP/1.1 429 Too Many Requests` and include the same JSON
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
(10000–10003). Each port returns the same aggregate reflection payload, whose
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
exceed `maxAiCredits`, subsequent requests MUST be rejected with HTTP `429`
and error type `ai_credits_limit_exceeded`.

Regardless of `maxAiCredits` configuration, AWF also enforces a non-overridable
hard cap of **10,000 AI credits**. When cumulative AI credits reach this hard
cap, subsequent requests MUST be rejected with HTTP `429` and error type
`ai_credits_limit_exceeded`, and the error/log payload MUST include
`hard_cap: true`.

If both limits are present, the effective enforcement threshold is the lower of:
- configured `maxAiCredits`
- the fixed hard cap (10,000)

Setting `maxAiCredits` above 10,000 MUST NOT raise the effective limit.

### 10.7.1 Model Name Resolution for Pricing

The AI credits guard resolves model names using a two-step lookup:

1. **Curated pricing table** — a built-in table of known models with exact pricing.
2. **Bundled models.dev catalog** — a bundled snapshot of the models.dev catalog used as a fallback when the model is not found in the curated table.

Model names are **canonicalized** before lookup: provider prefixes
(e.g. `copilot/`) are stripped, and separators (`.`, `_`, `-`) are treated
as interchangeable. For example, `copilot/claude-sonnet-4.6`,
`claude_sonnet_4_6`, and `claude-sonnet-4-6` all resolve to the same pricing
entry.

If neither source resolves the model, the `defaultAiCreditsPricing` fallback
(if configured) is used. If that is also absent, the request is rejected.
Models whose catalog entry carries zero-cost pricing are recognized as known
models with zero AI credit impact, so they are never rejected as "unknown".

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
   - **HTTP status**: `429 Too Many Requests`
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
   reject with `HTTP/1.1 429 Too Many Requests` and include the same JSON
   error body before destroying the socket.

4. **Finality**: Once the limit is reached, all subsequent requests in the
   same run MUST be rejected. The counter is not recoverable.

### 11.3 Introspection

The `/reflect` endpoint (available on all provider ports 10000–10003; see
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

The `/reflect` endpoint (available on all provider ports 10000–10003; see
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

## Normative References

- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) — Key words for use in
  RFCs to Indicate Requirement Levels
- `docs/awf-config.schema.json` — Machine-readable JSON Schema for
  configuration documents (normative)

## Runtime JSONL Schemas

AWF emits structured JSONL artifact files at runtime. Each record type has
a corresponding JSON Schema in the `schemas/` directory:

| Schema | JSONL file | Description |
|--------|------------|-------------|
| [`schemas/audit.schema.json`](../schemas/audit.schema.json) | `audit.jsonl` | L7 HTTP/HTTPS traffic decisions (allowed/denied) from the Squid proxy |
| [`schemas/token-usage.schema.json`](../schemas/token-usage.schema.json) | `token-usage.jsonl` | Per-API-call token usage records from the api-proxy sidecar |
| [`schemas/otel-span.schema.json`](../schemas/otel-span.schema.json) | `otel.jsonl` | OpenTelemetry span records emitted by the local file exporter |
| [`schemas/cli-proxy-access.schema.json`](../schemas/cli-proxy-access.schema.json) | `access.jsonl` (cli-proxy) | CLI proxy request audit records |
| *(inline, see §13.2)* | `token-diag.jsonl` | Model alias resolution steps and diagnostic events (opt-in via `apiProxy.logging.debugTokens`) |

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

- [docs/environment.md](environment.md) — Usage guide for environment
  variables
- [docs/authentication-architecture.md](authentication-architecture.md) —
  Credential isolation architecture and diagrams
- [docs/api-proxy-sidecar.md](api-proxy-sidecar.md) — API proxy sidecar
  configuration including OIDC authentication for Azure OpenAI
- [schemas/README.md](../schemas/README.md) — JSONL schema directory with
  validation examples and versioning policy
