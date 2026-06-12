# Authentication Matrix

This document describes every authentication combination supported by AWF's api-proxy sidecar, including how each provider's auth works, what configuration is required, and how the proxy transforms credentials before forwarding to upstream APIs.

## Table of Contents

- [Dimensions Overview](#dimensions-overview)
- [Provider: OpenAI](#provider-openai)
- [Provider: Anthropic](#provider-anthropic)
- [Provider: GitHub Copilot](#provider-github-copilot)
- [Provider: Google Gemini](#provider-google-gemini)
- [OIDC Providers](#oidc-providers)
- [GitHub Instance Types](#github-instance-types)
- [Custom Headers & Injection](#custom-headers--injection)
- [Coverage Matrix](#coverage-matrix)

---

## Dimensions Overview

Auth evaluation in the api-proxy is determined by the combination of these independent axes:

| # | Dimension | Controlled By | Values |
|---|-----------|--------------|--------|
| 1 | Engine | Port binding (10000–10003) | openai, anthropic, copilot, gemini |
| 2 | Auth Type | `AWF_AUTH_TYPE` | `api-key` (default), `github-oidc` |
| 3 | OIDC Provider | `AWF_AUTH_PROVIDER` | `azure`, `aws`, `gcp`, `anthropic` |
| 4 | Instance Type | `GITHUB_SERVER_URL` | github.com, GHEC (`*.ghe.com`), GHES |
| 5 | BYOK Mode | `COPILOT_PROVIDER_TYPE` | unset (standard), `azure` |
| 6 | Target Override | `{PROVIDER}_API_TARGET` | Any hostname |
| 7 | Custom Auth Header | `AWF_{PROVIDER}_AUTH_HEADER` | Any valid HTTP header name |
| 8 | Extra Injection | `AWF_BYOK_EXTRA_HEADERS`, `AWF_BYOK_EXTRA_BODY_FIELDS` | JSON objects |

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

**Official docs:** https://learn.microsoft.com/en-us/azure/ai-services/openai/reference

### Azure OIDC (Entra ID)

When `AWF_AUTH_TYPE=github-oidc` and `AWF_AUTH_PROVIDER=azure`:

| Setting | Value |
|---------|-------|
| Header sent upstream | `Authorization: Bearer <entra_access_token>` |
| Token exchange | GitHub JWT → Azure AD token endpoint |
| Scope | `https://cognitiveservices.azure.com/.default` (configurable via `AWF_AUTH_AZURE_SCOPE`) |
| OIDC audience | `api://AzureADTokenExchange` (configurable via `AWF_AUTH_OIDC_AUDIENCE`) |

Note: When Azure OIDC is active, the header switches from `api-key:` back to `Authorization: Bearer`.

**Official docs:** https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/managed-identity

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

**Official docs:** https://docs.anthropic.com/en/api/getting-started

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

**Official docs:** https://docs.anthropic.com/en/docs/build-with-claude/workload-identity-federation

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
| GHEC (`*.ghe.com`) | `COPILOT_GITHUB_TOKEN` | `Authorization: Bearer <token>` | `copilot-api.<subdomain>.ghe.com` |
| GHES (on-prem) | `COPILOT_GITHUB_TOKEN` | `Authorization: token <value>` ⚠️ | `api.enterprise.githubcopilot.com` |

**⚠️ Critical:** GHES uses `token` prefix, NOT `Bearer`. This is the GitHub API v3 convention for OAuth tokens on Enterprise Server.

Additional header: `Copilot-Integration-Id: <integration-id>`

### `/models` Endpoint (Special Case)

The `/models` endpoint prefers `COPILOT_GITHUB_TOKEN` (GitHub OAuth) over BYOK keys when both are configured, because model listing is a GitHub platform feature. However, when no GitHub token is available (typical for direct-BYOK/custom targets), `/models` will use the BYOK credential.

### BYOK (Bring Your Own Key)

| Setting | Value |
|---------|-------|
| Env var | `COPILOT_PROVIDER_API_KEY` |
| Header | `Authorization: Bearer <key>` (always Bearer, even on GHES) |
| Target | From `COPILOT_PROVIDER_BASE_URL` or `COPILOT_API_TARGET` |

### Azure BYOK

When `COPILOT_PROVIDER_TYPE=azure`:
- Header switches to `api-key: <value>` (Azure convention)
- Unless OIDC is active, in which case it's `Authorization: Bearer`

### Copilot OIDC (Azure Entra / GCP / AWS)

When `AWF_AUTH_TYPE=github-oidc` with Copilot:

| Provider | Header | Notes |
|----------|--------|-------|
| Azure | `Authorization: Bearer <entra_token>` | Via `oidc-token-provider.js` |
| GCP | `Authorization: Bearer <gcp_token>` | Via `gcp-oidc-token-provider.js` |
| AWS | (SigV4 signing at request layer) | Via `aws-oidc-token-provider.js` |

**Official docs:**
- Copilot API: https://docs.github.com/en/copilot/building-copilot-extensions/building-a-copilot-agent
- GHES auth: https://docs.github.com/en/enterprise-server/rest/authentication/authenticating-to-the-rest-api

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

**Note:** Gemini does NOT currently support OIDC in this proxy. For GCP WIF access to Gemini, use Vertex AI endpoints (which go through the OpenAI adapter with GCP OIDC).

**Official docs:** https://ai.google.dev/gemini-api/docs/api-key

---

## OIDC Providers

All OIDC flows require GitHub Actions runtime tokens:
- `ACTIONS_ID_TOKEN_REQUEST_URL` — endpoint to mint OIDC JWTs
- `ACTIONS_ID_TOKEN_REQUEST_TOKEN` — auth token for the OIDC endpoint

### Azure (Entra ID)

| Config | Env Var | Required |
|--------|---------|----------|
| Tenant ID | `AWF_AUTH_AZURE_TENANT_ID` | ✅ |
| Client ID | `AWF_AUTH_AZURE_CLIENT_ID` | ✅ |
| Scope | `AWF_AUTH_AZURE_SCOPE` | ❌ (default: `https://cognitiveservices.azure.com/.default`) |
| Cloud | `AWF_AUTH_AZURE_CLOUD` | ❌ (default: public; options: `government`, `china`) |
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
**Result:** Temporary (AccessKeyId, SecretAccessKey, SessionToken) for SigV4 signing  
**Implementation:** `containers/api-proxy/aws-oidc-token-provider.js`  
**Official docs:** https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_oidc.html

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

**Token exchange:** `POST https://api.anthropic.com/v1/oauth/token` (RFC 7523 jwt-bearer)  
**Implementation:** `containers/api-proxy/anthropic-oidc-token-provider.js`  
**Official docs:** https://docs.anthropic.com/en/docs/build-with-claude/workload-identity-federation

---

## GitHub Instance Types

Detection logic in `containers/api-proxy/providers/copilot-auth.js`:

```
GITHUB_SERVER_URL → deriveCopilotApiTarget():
  *.ghe.com     → copilot-api.<subdomain>.ghe.com
  github.com    → api.githubcopilot.com
  (other)       → api.enterprise.githubcopilot.com
```

### Auth Header Prefix Rules

| Target | Credential Type | Auth Header Format |
|--------|----------------|-------------------|
| `api.githubcopilot.com` | GitHub token | `Bearer <token>` |
| `copilot-api.*.ghe.com` | GitHub token | `Bearer <token>` |
| `api.enterprise.githubcopilot.com` | GitHub token | `token <value>` |
| Any target | BYOK key | `Bearer <key>` (always) |
| Any target | OIDC token | `Bearer <token>` (always) |

The `token` prefix is ONLY used for GitHub OAuth tokens on GHES. BYOK and OIDC always use `Bearer`.

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
| OpenAI | Static key | — | ✅ | `openai.js:47-63` |
| OpenAI | Azure BYOK | — | ✅ | `openai.js:64-76` |
| OpenAI | Azure OIDC | — | ✅ | `openai.js:79-161` |
| OpenAI | AWS OIDC | — | ✅ | `cloud-oidc-init.js:19-37` |
| OpenAI | GCP OIDC | — | ✅ | `cloud-oidc-init.js:38-50` |
| Anthropic | Static key | — | ✅ | `anthropic.js:45-52` |
| Anthropic | WIF | — | ✅ | `anthropic.js:53-78` |
| Anthropic | Custom header | — | ✅ | `anthropic.js:52` |
| Copilot | GitHub token | github.com | ✅ | `copilot.js:245-258` |
| Copilot | GitHub token | GHEC | ✅ | `copilot.js:245-258` |
| Copilot | GitHub token | GHES | ✅ | `copilot.js:245-258` |
| Copilot | BYOK key | — | ✅ | `copilot.js:278-284` |
| Copilot | Azure BYOK | — | ✅ | via OpenAI adapter |
| Copilot | Azure OIDC | — | ✅ | `server.auth.test.js:749+` |
| Copilot | AWS OIDC | — | ✅ | `cloud-oidc-init.js:19-37`, `server.auth-matrix.test.js` |
| Copilot | GCP OIDC | — | ✅ | `cloud-oidc-init.js:38-50`, `server.auth-matrix.test.js` |
| Copilot | GHES + BYOK | GHES | ✅ | `server.auth-matrix.test.js` |
| Gemini | Static key | — | ✅ | `gemini.js:25-45` |
| Gemini | GCP WIF | — | ❌ not impl | Would need Vertex AI |
