# AWF Configuration Specification (W3C-style)

## Status of This Document

This document defines the canonical configuration model for AWF (`awf`) and is intended for:

- `awf` CLI runtime loading (`--config`)
- tooling that compiles workflows to AWF invocations (including `gh-aw`)
- IDE/static validation via JSON Schema

The machine-readable schema is published at:

- `docs/awf-config.schema.json` — live schema (always reflects latest `main`)
- `docs/awf-config.v1.schema.json` — stable versioned copy of schema v1 (tracks `main`)
- GitHub release asset `awf-config.schema.json` — versioned stable URL per release (latest alias)
- GitHub release asset `awf-config.v1.schema.json` — versioned stable URL per release
  (e.g. `https://github.com/github/gh-aw-firewall/releases/download/v0.23.1/awf-config.v1.schema.json`)

External consumers (e.g. the `gh-aw` compiler) should pin to the versioned URL for stability:

| Reference | URL |
|-----------|-----|
| Pinned to a specific release tag | `https://github.com/github/gh-aw-firewall/releases/download/<tag>/awf-config.v1.schema.json` |
| Always-latest from `main` branch | `https://raw.githubusercontent.com/github/gh-aw-firewall/main/docs/awf-config.v1.schema.json` |

## 1. Conformance

The normative keywords in this document are to be interpreted as described in RFC 2119.

An AWF config document is conforming when:

1. It is valid JSON or YAML.
2. Its data model satisfies `docs/awf-config.schema.json`.
3. Unknown properties are not present (closed-world schema).

## 2. Processing Model

1. The user invokes `awf --config <path|-> -- <command>`.
2. If `<path>` is `-`, AWF reads configuration bytes from stdin.
3. If `<path>` ends with `.json`, AWF parses as JSON.
4. If `<path>` ends with `.yaml` or `.yml`, AWF parses as YAML.
5. Otherwise, AWF attempts JSON parse first, then YAML parse.
6. AWF validates the parsed document and fails fast on validation errors.
7. AWF maps config fields to CLI option semantics.
8. **CLI options MUST take precedence over config file values**.

## 3. Precedence Rules

The effective configuration order is:

1. AWF internal defaults
2. Config file (`--config`)
3. Explicit CLI flags

This precedence model allows reusable checked-in configs with environment-specific CLI overrides.

## 4. Data Model

The root object MAY contain:

- `$schema`
- `network`
- `apiProxy`
- `security`
- `container`
- `environment`
- `logging`
- `rateLimiting`

Section semantics and constraints are defined by `docs/awf-config.schema.json`.

## 5. CLI Mapping (Normative)

Tools generating AWF invocations (such as `gh-aw`) SHOULD use this mapping:

- `network.allowDomains[]` → `--allow-domains <csv>`
- `network.blockDomains[]` → `--block-domains <csv>`
- `network.dnsServers[]` → `--dns-servers <csv>`
- `network.upstreamProxy` → `--upstream-proxy`
- `apiProxy.enabled` → `--enable-api-proxy`
- `apiProxy.enableOpenCode` → `--enable-opencode`
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
- `environment.excludeEnv[]` → repeated `--exclude-env`
- `logging.logLevel` → `--log-level`
- `logging.diagnosticLogs` → `--diagnostic-logs`
- `logging.auditDir` → `--audit-dir`
- `logging.proxyLogsDir` → `--proxy-logs-dir`
- `logging.sessionStateDir` → `--session-state-dir`
- `rateLimiting.enabled: false` → `--no-rate-limit`
- `rateLimiting.requestsPerMinute` → `--rate-limit-rpm`
- `rateLimiting.requestsPerHour` → `--rate-limit-rph`
- `rateLimiting.bytesPerMinute` → `--rate-limit-bytes-pm`

## 6. Stdin Mode

AWF MUST support `--config -` for programmatic/pipeline scenarios.

## 7. Error Reporting

On parse or validation failure, AWF MUST:

1. exit non-zero
2. print an error describing location and reason
3. avoid partial execution
