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

- `network.allowDomains[]` → `--allow-domains <csv>`
- `network.blockDomains[]` → `--block-domains <csv>`
- `network.dnsServers[]` → `--dns-servers <csv>`
- `network.upstreamProxy` → `--upstream-proxy`
- `apiProxy.enabled` → `--enable-api-proxy`
- `apiProxy.enableOpenCode` → `--enable-opencode`
- `apiProxy.anthropicAutoCache` → `--anthropic-auto-cache`
- `apiProxy.anthropicCacheTailTtl` → `--anthropic-cache-tail-ttl`
- `apiProxy.maxEffectiveTokens` → *(config-only; no CLI equivalent)*
- `apiProxy.modelMultipliers` → *(config-only; no CLI equivalent)*
- `apiProxy.models` → *(config-only; model alias rewriting)*
- `apiProxy.targets.<provider>.host` → `--<provider>-api-target`
- `apiProxy.targets.openai.basePath` → `--openai-api-base-path`
- `apiProxy.targets.anthropic.basePath` → `--anthropic-api-base-path`
- `apiProxy.targets.gemini.basePath` → `--gemini-api-base-path`
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
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot |
| `COPILOT_API_KEY` | GitHub Copilot (BYOK) |
| `GEMINI_API_KEY` | Google Gemini |

The following secondary aliases SHOULD also be recognized:
`OPENAI_KEY`, `CODEX_API_KEY`, `CLAUDE_API_KEY`,
`COPILOT_PROVIDER_API_KEY`.

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
   10002 (Copilot), 10003 (Gemini), 10004 (OpenCode).

### 9.3 API Proxy Disabled (`apiProxy.enabled = false`)

When the API proxy sidecar is disabled (the default):

1. Source credentials present in the host environment SHOULD be forwarded
   directly to the agent container.
2. No proxy-routing variables or placeholder values SHALL be injected.

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
ANTHROPIC_API_KEY, CLAUDE_API_KEY, CODEX_API_KEY, COPILOT_API_KEY,
COPILOT_PROVIDER_API_KEY
```

Placeholder compatibility values (§9.2 item 3) are not secrets and MUST
NOT be subject to one-shot protection.

### 9.5 DIFC Proxy Credential Isolation

When `security.difcProxy.host` is set, `GITHUB_TOKEN` and `GH_TOKEN` MUST
be excluded from the agent environment. These tokens SHALL be held
exclusively by the external DIFC proxy.

## Normative References

- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) — Key words for use in
  RFCs to Indicate Requirement Levels
- `docs/awf-config.schema.json` — Machine-readable JSON Schema (normative)

## Informative References

- [docs/environment.md](environment.md) — Usage guide for environment
  variables
- [docs/authentication-architecture.md](authentication-architecture.md) —
  Credential isolation architecture and diagrams
