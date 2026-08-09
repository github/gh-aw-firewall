---
title: Authentication matrix
description: Provider-by-provider reference for static keys, OIDC federation, headers, targets, and credential isolation in the AWF API proxy.
---

# Authentication matrix

This document describes every authentication combination supported by AWF's api-proxy sidecar, including how each provider's auth works, what configuration is required, and how the proxy transforms credentials before forwarding to upstream APIs.

The [Auth Doctor Updater workflow](../.github/workflows/auth-doctor-updater.md) periodically compares this matrix with current default-branch implementation, recent issues and pull requests, and official provider guidance. It opens a deduplicated, file-bounded pull request only when an evidence-backed documentation correction is needed.

## Table of Contents

- [Dimensions Overview](#dimensions-overview)
- [Provider: OpenAI](#provider-openai)
- [Provider: Anthropic](#provider-anthropic)
- [Provider: GitHub Copilot](#provider-github-copilot)
- [Provider: Google Gemini](#provider-google-gemini)
- [Provider: Google Vertex AI](#provider-google-vertex-ai)
- [OIDC Providers](#oidc-providers)
- [GitHub Instance Types](#github-instance-types)
- [Custom Headers & Injection](#custom-headers--injection)
- [Coverage Matrix](#coverage-matrix)

---

## Dimensions Overview

Auth evaluation in the api-proxy is determined by the combination of these independent axes:

| # | Dimension | Controlled By | Values |
|---|-----------|--------------|--------|
| 1 | Engine | Port binding (10000–10004) | openai, anthropic, copilot, gemini, vertex |
| 2 | Auth Type | `AWF_AUTH_TYPE` | `api-key` (default), `github-oidc` |
| 3 | OIDC Provider | `AWF_AUTH_PROVIDER` | `azure`, `aws`, `gcp`, `anthropic` |
| 4 | Instance Type | `GITHUB_SERVER_URL` | github.com, GHEC (`*.ghe.com`), GHES |
| 5 | BYOK Mode | `COPILOT_PROVIDER_TYPE` | unset (standard), `azure` |
| 6 | Target Override | `{PROVIDER}_API_TARGET` | Any hostname |
| 7 | Custom Auth Header | `AWF_{PROVIDER}_AUTH_HEADER` | Any valid HTTP header name |
| 8 | Extra Injection | `AWF_BYOK_EXTRA_HEADERS`, `AWF_BYOK_EXTRA_BODY_FIELDS` | JSON objects |

:::note
The OIDC Provider dimension (`AWF_AUTH_PROVIDER`) only applies to the OpenAI, Anthropic, and Copilot adapters. The Gemini and Vertex adapters are static-API-key only in the current implementation — see [Provider: Google Vertex AI](#provider-google-vertex-ai) for how GCP workload identity federation reaches Vertex-compatible endpoints today.
:::

---

## Provider: OpenAI

**Port:** 10000  
**Implementation:** `containers/api-proxy/providers/openai.js`

### Static API Key

| Setting | Value |
|---------|-------|
| Env var | `OPENAI_API_KEY` |
| Header sent upstream | `Authorization: Bearer <key>` |
| Default target | `api.openai.com` |
| Default base path | `/v1` |

**Official docs:** https://platform.openai.com/docs/api-reference/authentication

### Azure OpenAI (BYOK via Copilot)

When `COPILOT_PROVIDER_TYPE=azure` and `COPILOT_PROVIDER_BASE_URL` is set:

| Setting | Value |
|---------|-------|
| Env var | `COPILOT_PROVIDER_API_KEY` |
| Header sent upstream | `api-key: <key>` (NOT `Authorization:`) |
| Target | Derived from `COPILOT_PROVIDER_BASE_URL` |
| Base path | Derived from URL path component |

**Official docs:** https://learn.microsoft.com/en-us/azure/foundry/openai/reference

### Azure OIDC (Entra ID)

When `AWF_AUTH_TYPE=github-oidc` and `AWF_AUTH_PROVIDER=azure`:

| Setting | Value |
|---------|-------|
| Header sent upstream | `Authorization: Bearer <token>` |
| Token exchange | GitHub JWT → Azure AD token endpoint |
| Scope | `https://cognitiveservices.azure.com/.default` (default; configurable via `AWF_AUTH_AZURE_SCOPE`) |
| OIDC audience | `api://AzureADTokenExchange` (configurable via `AWF_AUTH_OIDC_AUDIENCE`) |

Note: When Azure OIDC is active, the header switches from `api-key:` back to `Authorization: Bearer`.

:::note[Implementation vs. provider documentation]
`https://cognitiveservices.azure.com/.default` is AWF's hardcoded default scope and remains valid for Azure OpenAI/Foundry resources. Some newer Microsoft Foundry how-to guides show `https://ai.azure.com/.default` for certain data-plane operations — this is not a universal replacement, and either value may be required depending on your resource and API surface. Set `AWF_AUTH_AZURE_SCOPE` (or `apiProxy.auth.azureScope`) explicitly if your deployment needs a different scope; AWF does not infer the correct scope for you.
:::

**Official docs:** https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/managed-identity

:::note[Implementation vs. provider documentation]
OpenAI's own API now offers [native workload identity federation](https://developers.openai.com/api/docs/guides/workload-identity-federation), which exchanges an external OIDC/JWT identity at `https://auth.openai.com/oauth/token` for a short-lived OpenAI access token. **AWF does not implement this.** The `openai.js` adapter's `AWF_AUTH_PROVIDER` OIDC support (`azure`, `aws`, `gcp`) is for reaching Azure OpenAI/Foundry or GCP-fronted OpenAI-compatible endpoints using that cloud's own identity tokens — it is unrelated to OpenAI's native federation feature.
:::

### Custom Auth Header

`AWF_OPENAI_AUTH_HEADER` overrides the header name used for the API key. The raw key or token value is sent directly as the header value (no `Bearer` prefix is added), both for static keys and OIDC tokens.

---

## Provider: Anthropic

**Port:** 10001  
**Implementation:** `containers/api-proxy/providers/anthropic.js`

### Static API Key

| Setting | Value |
|---------|-------|
| Env var | `ANTHROPIC_API_KEY` |
| Header sent upstream | `x-api-key: <key>` |
| Default target | `api.anthropic.com` |
| Default base path | (none) |

Additional required headers: `anthropic-version: 2023-06-01`

**Official docs:** https://platform.claude.com/docs/en/api/overview

:::note[Implementation vs. provider documentation]
Anthropic SDKs officially support `ANTHROPIC_AUTH_TOKEN` for bearer-token authentication. AWF does not currently accept that variable as a host-side source credential: static Anthropic auth is read from `ANTHROPIC_API_KEY` and sent as `x-api-key`. In the agent container, AWF reserves `ANTHROPIC_AUTH_TOKEN` for the non-secret placeholder `sk-ant-placeholder-key-for-credential-isolation`; the real credential remains in the sidecar.
:::

### Workload Identity Federation (WIF)

When `AWF_AUTH_TYPE=github-oidc` and `AWF_AUTH_PROVIDER=anthropic`:

| Setting | Value |
|---------|-------|
| Header sent upstream | `Authorization: Bearer <wif_token>` (NOT `x-api-key`) |
| Token exchange endpoint | `POST https://api.anthropic.com/v1/oauth/token` |
| Grant type | `urn:ietf:params:oauth:grant-type:jwt-bearer` |
| Required config | `AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID`, `AWF_AUTH_ANTHROPIC_ORGANIZATION_ID`, `AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID` |
| Optional config | `AWF_AUTH_ANTHROPIC_WORKSPACE_ID`, `AWF_AUTH_ANTHROPIC_TOKEN_URL` |
| OIDC audience | `https://api.anthropic.com` (default, configurable) |
| Token format | `sk-ant-oat01-...` (short-lived) |

**Key behavior change:** When OIDC is active, the auth header switches from `x-api-key` to `Authorization: Bearer`.

:::note[Anthropic beta headers]
AWF follows Anthropic's SDK behavior: JWT-bearer `POST /v1/oauth/token` exchanges send `oauth-2025-04-20,oidc-federation-2026-04-01`, while API requests authenticated with the resulting bearer token send `oauth-2025-04-20`. The federation beta is never added to static `x-api-key` requests or forwarded refresh-token exchanges. Client-supplied `anthropic-beta` values are preserved and deduplicated with AWF-required values and the optional auto-cache beta.
:::

**Official references:** [Anthropic WIF documentation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) · [Anthropic TypeScript SDK federation exchange](https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/lib/credentials/oidc-federation.ts)

### Custom Auth Header

`AWF_ANTHROPIC_AUTH_HEADER` overrides the header name (default: `x-api-key`). Useful for enterprise gateways that expect a different header.

---

## Provider: GitHub Copilot

**Port:** 10002  
**Implementation:** `containers/api-proxy/providers/copilot.js`, `containers/api-proxy/providers/copilot-auth.js`

### GitHub OAuth Token (Standard)

| Instance | Env var | Header | Target |
|----------|---------|--------|--------|
| github.com | `COPILOT_GITHUB_TOKEN` | `Authorization: Bearer <token>` | `api.githubcopilot.com` |
| GHEC (`*.ghe.com`) | `COPILOT_GITHUB_TOKEN` | `Authorization: token <value>` ⚠️ | `copilot-api.<subdomain>.ghe.com` |
| GHES (on-prem) | `COPILOT_GITHUB_TOKEN` | `Authorization: token <value>` ⚠️ | `api.enterprise.githubcopilot.com` |
| Business tier | `COPILOT_GITHUB_TOKEN` | `Authorization: token <value>` ⚠️ | `api.business.githubcopilot.com` (must be set explicitly via `COPILOT_API_TARGET`; never auto-derived) |

:::note[Implementation vs. provider documentation]
GitHub's [REST API authentication docs](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api) state that both Bearer-prefixed and token-prefixed Authorization headers are generally accepted for PATs/OAuth tokens (only JWTs strictly require Bearer). The `token` prefix requirement documented here is **AWF-implementation-specific defensive behavior** for Copilot API requests, not a general GitHub REST API rule: the derived GHEC data-residency target (`copilot-api.<subdomain>.ghe.com`), the enterprise target (`api.enterprise.githubcopilot.com`), and the business target (`api.business.githubcopilot.com`) return `400 Bad Request: Authorization header is badly formatted` when sent the wrong prefix (see the regression fixed in [PR #6991](https://github.com/github/gh-aw-firewall/pull/6991) and covered by `copilot-adapter-enterprise.test.js`). AWF detects this via `copilotTargetRequiresGitHubTokenPrefix()` in `copilot-auth.js`, which matches on the specific target hostname (including an `isGhecCopilotApiTarget()` check for the `copilot-api.<subdomain>.ghe.com` shape) or GHES-detection heuristics (`AWF_PLATFORM_TYPE=ghes`, or a `GITHUB_SERVER_URL` that isn't `github.com`/`*.ghe.com`). BYOK keys always use the `Bearer` prefix regardless of target.
:::

All Copilot requests also include `Copilot-Integration-Id`. The default is `agentic-workflows`; set `COPILOT_INTEGRATION_ID` to override it.

### `/models` Endpoint (Special Case)

The `/models` endpoint prefers `COPILOT_GITHUB_TOKEN` (GitHub OAuth) over BYOK keys when both are configured, because model listing is a GitHub platform feature. However, when no GitHub token is available (typical for direct-BYOK/custom targets), `/models` will use the BYOK credential.

### BYOK (Bring Your Own Key)

| Setting | Value |
|---------|-------|
| Env var | `COPILOT_PROVIDER_API_KEY` |
| Header | `Authorization: Bearer <key>` (always Bearer, even on GHES) |
| Target | From `COPILOT_PROVIDER_BASE_URL` or `COPILOT_API_TARGET` |

### Azure BYOK through the OpenAI adapter

When `COPILOT_PROVIDER_TYPE=azure`, the OpenAI adapter on port 10000:
- Header switches to `api-key: <value>` (Azure convention)
- Unless OIDC is active, in which case it's `Authorization: Bearer`

The Copilot adapter on port 10002 does not emit `api-key`; its BYOK requests use `Authorization: Bearer`.

### Copilot OIDC (Azure Entra / GCP / AWS)

When `AWF_AUTH_TYPE=github-oidc` with Copilot:

| Provider | Header | Notes |
|----------|--------|-------|
| Azure | `Authorization: Bearer <entra_token>` | Via `oidc-token-provider.js` |
| GCP | `Authorization: Bearer <gcp_token>` | Via `gcp-oidc-token-provider.js` |
| AWS | SigV4 `Authorization` plus `x-amz-*` signing headers | Via `aws-oidc-token-provider.js` and `aws-sigv4.js` |

:::caution[Agent routing is credential-triggered]
Cloud OIDC configuration can initialize credentials in the sidecar, but the agent's OpenAI and Copilot base URLs/placeholders are currently configured only when the corresponding static OpenAI/Copilot credential is present. Anthropic WIF is the exception: its credential environment explicitly recognizes Anthropic OIDC. Treat Azure, GCP, and AWS OIDC support as sidecar authentication capability rather than a complete keyless agent-routing path until OIDC-aware agent routing is implemented.
:::

:::note[AWS OIDC + Copilot]
Selecting `AWF_AUTH_PROVIDER=aws` signs Copilot-adapter HTTP requests at final dispatch with the cached temporary STS credentials. The target must be the exact regional Bedrock Runtime hostname; credentials are never returned by `getAuthHeaders()` or exposed to the agent.
:::

**Official docs:**
- Copilot API: https://docs.github.com/en/rest/copilot (documents management endpoints; the inference/chat-completions endpoint AWF proxies to is not covered by public GitHub REST docs)
- REST API authentication: https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api

---

## Provider: Google Gemini

**Port:** 10003  
**Implementation:** `containers/api-proxy/providers/gemini.js`

### Static API Key

| Setting | Value |
|---------|-------|
| Env var | `GEMINI_API_KEY` |
| Header sent upstream | `x-goog-api-key: <key>` |
| Default target | `generativelanguage.googleapis.com` |
| Default base path | (none) |

The proxy also strips `?key=`, `?apiKey=`, and `?api_key=` query parameters from requests to prevent duplicate-key errors.

:::note
The native Gemini API supports OAuth, but the AWF Gemini adapter does not — only a static `GEMINI_API_KEY` is supported. There are two distinct ways to reach Google infrastructure with GCP workload identity federation:
1. **Native Vertex AI adapter** (port 10004, static key only) — see [Provider: Google Vertex AI](#provider-google-vertex-ai).
2. **OpenAI adapter with GCP OIDC** — point `OPENAI_API_TARGET` at a Vertex AI OpenAI-compatible endpoint and set `AWF_AUTH_TYPE=github-oidc`, `AWF_AUTH_PROVIDER=gcp`. This is a separate code path (`openai.js`) from the native Vertex adapter and is the only way to use GCP OIDC/WIF with Vertex-hosted models today.
:::

:::caution[Gemini API key migration]
Google says the Gemini API will reject standard API keys beginning in September 2026. Migrate `GEMINI_API_KEY` to Google's service-account-bound authorization key format before that deadline; AWF forwards either key type through the same `x-goog-api-key` header.
:::

**Official docs:** https://ai.google.dev/gemini-api/docs/api-key

---

## Provider: Google Vertex AI

**Port:** 10004
**Implementation:** `containers/api-proxy/providers/vertex.js` (shares `createGoogleApiKeyAdapter` with the Gemini adapter via `google-adapter.js`)

### Static API Key

| Setting | Value |
|---------|-------|
| Env var | `GOOGLE_API_KEY` |
| Header sent upstream | `x-goog-api-key: <key>` |
| Default target | `aiplatform.googleapis.com` |
| Default base path | (none) |

:::caution
Unlike the OpenAI, Anthropic, and Copilot adapters, the Vertex adapter does **not** call `createOidcAwareProviderAdapter` — it is always bound to port 10004 (returning `503` if `GOOGLE_API_KEY` is unconfigured) and supports only the static-key flow described above. There is no OIDC/WIF variant of this adapter. For GCP workload identity federation with Vertex-hosted models, use the OpenAI adapter pathway described in the [Google Gemini](#provider-google-gemini) section above instead.
:::

:::note[Implementation vs. provider documentation]
This adapter exists to support the [Gemini CLI](https://geminicli.com/)'s `GOOGLE_GENAI_USE_VERTEXAI=true` mode: setting `GOOGLE_VERTEX_BASE_URL` to point at this sidecar lets AWF isolate whatever credential the CLI is configured to send. Google's general Vertex AI guidance recommends Application Default Credentials, a service account key, or workload identity federation for Vertex AI endpoints, and treats a bare API key as unsupported for most Vertex AI surfaces (API keys are the norm for the separate Gemini Developer API at `generativelanguage.googleapis.com`). AWF does not attempt to validate that `aiplatform.googleapis.com` accepts a given key for a given operation — it forwards `x-goog-api-key` unconditionally. Confirm your specific Vertex AI project/API supports API-key auth (for example, Vertex AI Express Mode) before relying on this adapter in production.
:::

**Official docs:** https://geminicli.com/docs/get-started/authentication/

---

## OIDC Providers

All OIDC flows require GitHub Actions runtime tokens:
- `ACTIONS_ID_TOKEN_REQUEST_URL` — endpoint to mint OIDC JWTs
- `ACTIONS_ID_TOKEN_REQUEST_TOKEN` — auth token for the OIDC endpoint

Documentation audits treat both as non-observable credentials: they verify `id-token: write` and sidecar configuration but never request or print either value, a minted JWT, or exchanged cloud credentials.

AWF forwards these variables only to the api-proxy sidecar in `github-oidc` mode and excludes them from the agent container. GitHub Agentic Workflows independently passes them from its runner-owned **Start MCP Gateway** step directly to the MCP gateway when a remote HTTP MCP server uses `auth.type: github-oidc`; AWF does not launch or configure that gateway. [github/gh-aw#50053](https://github.com/github/gh-aw/issues/50053) is resolved by [github/gh-aw#50054](https://github.com/github/gh-aw/pull/50054), which enforces this boundary.

### Azure (Entra ID)

| Config | Env Var | Required |
|--------|---------|----------|
| Tenant ID | `AWF_AUTH_AZURE_TENANT_ID` | ✅ |
| Client ID | `AWF_AUTH_AZURE_CLIENT_ID` | ✅ |
| Scope | `AWF_AUTH_AZURE_SCOPE` | ❌ (default: `https://cognitiveservices.azure.com/.default`) |
| Cloud | `AWF_AUTH_AZURE_CLOUD` | ❌ (default: `public`; options: `public`, `usgovernment`, `china`) |
| Audience | `AWF_AUTH_OIDC_AUDIENCE` | ❌ (default: `api://AzureADTokenExchange`) |

**Token exchange endpoint:** `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`  
**Implementation:** `containers/api-proxy/oidc-token-provider.js`  
**Official docs:** https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust

### AWS (STS)

| Config | Env Var | Required |
|--------|---------|----------|
| Role ARN | `AWF_AUTH_AWS_ROLE_ARN` | ✅ |
| Region | `AWF_AUTH_AWS_REGION` | ✅ |
| Session Name | `AWF_AUTH_AWS_ROLE_SESSION_NAME` | ❌ (default: `awf-oidc-session`) |
| Audience | `AWF_AUTH_OIDC_AUDIENCE` | ❌ (default: `sts.amazonaws.com`) |

**Token exchange:** `GET https://sts.<region>.amazonaws.com/?Action=AssumeRoleWithWebIdentity`  
**Result:** Temporary credentials (AccessKeyId, SecretAccessKey, SessionToken), cached and refreshed by `AwsOidcTokenProvider`

**Request signing:** SigV4 with service `bedrock-runtime`, applied after body transforms and repeated for retries

**Implementation:** `containers/api-proxy/aws-oidc-token-provider.js`, `containers/api-proxy/aws-sigv4.js`

**Official docs:** https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_oidc.html

:::note[Signing boundary and fail-closed behavior]
The request layer signs the HTTP method, canonical path and sorted query, final body SHA-256, exact regional Bedrock Runtime host, region, and `bedrock-runtime` service. It includes the STS session token and re-signs retries. Missing/expired credentials return `503` without opening an upstream connection. To prevent credential disclosure, other target hosts and WebSocket upgrades are rejected.
:::

### GCP (Workload Identity Federation)

| Config | Env Var | Required |
|--------|---------|----------|
| WIF Provider | `AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER` | ✅ |
| Service Account | `AWF_AUTH_GCP_SERVICE_ACCOUNT` | ❌ (direct federation if omitted) |
| Scope | `AWF_AUTH_GCP_SCOPE` | ❌ (default: `https://www.googleapis.com/auth/cloud-platform`) |
| Audience | `AWF_AUTH_OIDC_AUDIENCE` | ❌ (default: derived from WIF provider) |

**Token exchange (2-step):**
1. `POST https://sts.googleapis.com/v1/token` — exchange GitHub JWT for federated token
2. `POST https://iamcredentials.googleapis.com/.../:generateAccessToken` — (optional) exchange for SA-scoped token

**Implementation:** `containers/api-proxy/gcp-oidc-token-provider.js`  
**Official docs:** https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines

### Anthropic (Native WIF)

| Config | Env Var | Required |
|--------|---------|----------|
| Federation Rule ID | `AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID` | ✅ |
| Organization ID | `AWF_AUTH_ANTHROPIC_ORGANIZATION_ID` | ✅ |
| Service Account ID | `AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID` | ✅ |
| Workspace ID | `AWF_AUTH_ANTHROPIC_WORKSPACE_ID` | ❌ |
| Token URL | `AWF_AUTH_ANTHROPIC_TOKEN_URL` | ❌ (default: `https://api.anthropic.com/v1/oauth/token`) |
| Audience | `AWF_AUTH_OIDC_AUDIENCE` | ❌ (default: `https://api.anthropic.com`) |

**Token exchange:** `POST https://api.anthropic.com/v1/oauth/token` (RFC 7523 jwt-bearer), with `anthropic-beta: oauth-2025-04-20,oidc-federation-2026-04-01`

**Bearer API requests:** `anthropic-beta: oauth-2025-04-20` (merged with client and auto-cache beta values)

**Implementation:** `containers/api-proxy/anthropic-oidc-token-provider.js`

**Official references:** [Anthropic WIF documentation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) · [Anthropic TypeScript SDK credential constants](https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/lib/credentials/types.ts)

---

## GitHub Instance Types

Detection logic in `containers/api-proxy/providers/copilot-auth.js`:

```
GITHUB_SERVER_URL → deriveCopilotApiTarget():
  *.ghe.com     → copilot-api.<subdomain>.ghe.com
  github.com    → api.githubcopilot.com
  (other)       → api.enterprise.githubcopilot.com
```

`api.business.githubcopilot.com` (Business tier) is never auto-derived from `GITHUB_SERVER_URL` — it must be set explicitly via `COPILOT_API_TARGET`.

### Auth Header Prefix Rules

| Target | Credential Type | Auth Header Format |
|--------|----------------|-------------------|
| `api.githubcopilot.com` | GitHub token | `Bearer <token>` |
| `copilot-api.*.ghe.com` | GitHub token | `token <value>` |
| `api.enterprise.githubcopilot.com` | GitHub token | `token <value>` |
| `api.business.githubcopilot.com` | GitHub token | `token <value>` |
| Any target | BYOK key | `Bearer <key>` (always) |
| Any target | OIDC token | `Bearer <token>` (always) |

The `token` prefix is used for GitHub OAuth tokens on the derived GHEC data-residency, enterprise, and business Copilot targets, or when GHES is otherwise detected (see `copilotTargetRequiresGitHubTokenPrefix()` in `copilot-auth.js`). BYOK and OIDC always use the standard prefix. As noted above, this is AWF-implementation-specific behavior driven by observed `400` errors from those targets — not a general GitHub REST API requirement.

---

## Custom Headers & Injection

### Protected Headers (cannot be overridden)

- `authorization`
- `x-api-key`
- `x-goog-api-key`
- `proxy-authorization`

### BYOK Extra Headers (`AWF_BYOK_EXTRA_HEADERS`)

JSON object of headers injected on BYOK inference requests:
- Only active when `COPILOT_PROVIDER_API_KEY` is set
- NOT injected on `/models` GET when GitHub OAuth token is available
- Protected headers are skipped with a `console.warn` message

### BYOK Extra Body Fields (`AWF_BYOK_EXTRA_BODY_FIELDS`)

JSON object of string fields merged into request body:
- Only active in BYOK mode
- Existing body fields are NOT overridden

### Session Tracking (`AWF_PROVIDER_SESSION_ID`)

Adds `x-session-id` header automatically in BYOK mode unless already present.

---

## Coverage Matrix

| Engine | Auth Mode | Instance | Tested | Implementation |
|--------|-----------|----------|--------|----------------|
| OpenAI | Static key | — | ✅ | `openai.js` |
| OpenAI | Azure BYOK | — | ✅ | `openai.js` |
| OpenAI | Azure OIDC | — | ✅ | `openai.js`, `oidc-token-provider.js` |
| OpenAI | AWS Bedrock OIDC + SigV4 | — | ✅ | `openai.js`, `aws-oidc-token-provider.js`, `aws-sigv4.test.js` |
| OpenAI | GCP OIDC | — | ✅ | `openai.js`, `gcp-oidc-token-provider.js` |
| Anthropic | Static key | — | ✅ | `anthropic.js` |
| Anthropic | WIF | — | ✅ | `anthropic.js`, `anthropic-oidc-token-provider.js` |
| Anthropic | Custom header | — | ✅ | `anthropic.js` |
| Copilot | GitHub token | github.com | ✅ | `copilot.js`, `copilot-auth.js` |
| Copilot | GitHub token | GHEC | ✅ | `copilot.js`, `copilot-auth.js` |
| Copilot | GitHub token | GHES | ✅ | `copilot.js`, `copilot-auth.js` |
| Copilot | GitHub token | Business tier | ✅ | `copilot-adapter-enterprise.test.js` |
| Copilot | BYOK key | — | ✅ | `copilot.js`, `copilot-byok.js` |
| Copilot | Azure BYOK | — | ✅ | via OpenAI adapter |
| Copilot | Azure OIDC | — | ✅ | `copilot-adapter-enterprise.test.js` |
| Copilot | AWS Bedrock OIDC + SigV4 | — | ✅ | `aws-oidc-token-provider.js`, `server.auth-matrix.test.js` |
| Copilot | GCP OIDC | — | ✅ | `gcp-oidc-token-provider.js`, `server.auth-matrix.test.js` |
| Copilot | GHES + BYOK | GHES | ✅ | `server.auth-matrix.test.js` |
| Gemini | Static key | — | ✅ | `gemini.js`, `google-adapter.js` |
| Gemini | GCP WIF | — | ❌ not impl | Use the OpenAI adapter with GCP OIDC pointed at a Vertex endpoint instead (see [Google Gemini](#provider-google-gemini)) |
| Vertex AI | Static key | — | ✅ | `vertex.js`, `google-adapter.js` |
| Vertex AI | GCP WIF | — | ❌ not impl | No OIDC support in `vertex.js`; see [Provider: Google Vertex AI](#provider-google-vertex-ai) |

:::note
"Implementation" column lists source files, not line numbers — line references go stale quickly as the code evolves. Use your editor's search to locate the relevant logic within each file.
:::
