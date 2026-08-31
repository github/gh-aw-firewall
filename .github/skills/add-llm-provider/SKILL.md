---
name: add-llm-provider
description: Decide and implement how to support a new LLM provider or agent engine in AWF - either as a proxied provider (api-proxy adapter) or a direct-API engine (domain allowlist only), e.g. Cursor, Aider, or any tool that calls its own endpoint.
---

# Add LLM Provider

Use this skill whenever a new agent engine or LLM provider needs to work behind AWF and it is unclear how to "set it up." AWF supports two fundamentally different integration paths — picking the wrong one is the most common source of confusion (e.g. "why is `token-usage.jsonl` empty for this engine?").

## Step 1 — Determine how the engine talks to its LLM backend

Ask: **does the engine call the provider's API directly (its own base URL, its own auth), or can it be configured to route through AWF's API-proxy sidecar**? The sidecar is always enabled; `--enable-api-proxy` is deprecated and ignored. Its provider ports are `http://172.30.0.30:10000` (OpenAI), `:10001` (Anthropic), `:10002` (Copilot), `:10003` (Gemini), and `:10004` (Vertex AI).

- If the engine has built-in support for pointing at AWF's api-proxy ports (env vars like `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` rewritten to the sidecar) → **Path A: Proxied provider**.
- If the engine always calls its own hardcoded/native endpoint regardless of proxy env vars (e.g. Cursor CLI calling `api2.cursor.sh` / `api3.cursor.sh` directly), or manages its own credentials outside AWF → **Path B: Direct-API engine**.

When unsure, run the engine once with `--keep-containers` and inspect `docker exec awf-squid cat /var/log/squid/access.log` (see [docs/squid_log_filtering.md](../../../docs/squid_log_filtering.md)) to see which hosts it actually contacts and whether traffic reaches the api-proxy sidecar or goes straight out through Squid.

## Path A — Proxied provider (credentials injected by api-proxy)

Choose this when you want AWF to hold the API key/OIDC token and inject it, keeping secrets out of the agent container.

Use **[containers/api-proxy/providers/ADDING-A-PROVIDER.md](../../../containers/api-proxy/providers/ADDING-A-PROVIDER.md)** for the adapter interface, then:

1. Create `containers/api-proxy/providers/<name>.js` implementing the `ProviderAdapter` interface.
2. Register it in `containers/api-proxy/providers/index.js`.
3. Add its port to `src/config/sandbox-network-policy.json`, then extend the closed `NetworkPolicy` shape and validation in `src/config/network-policy.ts` and the compatibility mapping in `src/types/ports.ts`. Add it to the Dockerfile `EXPOSE` list; the whole `providers/` directory is already copied. `src/host-iptables-rules.ts` consumes `Object.values(API_PROXY_PORTS)`, so it normally needs no change.
4. Add each credential to the API-proxy environment pipeline in `src/services/api-proxy-env-config.ts` and explicitly exclude it from agent passthrough in `src/services/agent-environment/excluded-vars.ts`; never forward a provider credential generically or from `src/docker-manager.ts`.
5. Add the upstream domain(s) to the allowlist wherever the caller configures `--allow-domains` (AWF itself does not hardcode per-provider domains).
6. Document auth details in [docs/auth-matrix.md](../../../docs/auth-matrix.md) if it's a net-new auth pattern.
7. Write adapter unit tests (`providers/<name>.test.js`) and run `cd containers/api-proxy && npm test -- providers/<name>.test.js`.

## Path B — Direct-API engine (no proxy adapter needed)

Choose this when the engine calls its own API directly and either manages its own credentials, or credential injection isn't feasible/needed through AWF.

1. **No API-proxy adapter is required.** The API proxy remains enabled, but do not try to force an engine through it when it cannot use the sidecar.
2. **Just allowlist the domain(s)** the engine needs, either via the CLI flag or config file:
   ```bash
   awf --allow-domains api2.cursor.sh,api3.cursor.sh -- cursor-agent ...
   ```
   or in the AWF config file under `network.allowDomains` (see [docs/awf-config-spec.md](../../../docs/awf-config-spec.md) and [docs/awf-config.schema.json](../../../docs/awf-config.schema.json)).
3. If the engine requires its API key in the agent environment, it cannot receive API-proxy credential isolation. Pass only a minimally scoped credential by an intentional mechanism appropriate to the caller, and do **not** use `sensitiveAllowedDomains` for the key: that setting only redacts secret-derived endpoint hostnames in logs and audit artifacts.
4. **Telemetry caveat:** because traffic never passes through the API-proxy sidecar, AWF's `token-usage.jsonl` / token-tracking metrics will stay empty for this engine. Any downstream check that assumes all engines produce proxy telemetry (e.g. a "token usage present" CI gate) must exclude direct-API engines instead of trying to make them populate it.
5. Confirm the domains are correct by testing with `--keep-containers` and checking Squid's access log for `TCP_DENIED` entries, then iterating on the allowlist (see [docs/quickstart.md](../../../docs/quickstart.md) "Test Domain Blocking" section).

## Checklist

- [ ] Identified whether the engine is proxied (Path A) or direct-API (Path B)
- [ ] Path A: adapter created and registered; network policy, credential isolation, image port, and tests updated
- [ ] Path B: domain(s) allowlisted, telemetry-dependent checks updated to exclude this engine
- [ ] Verified with `--keep-containers` + Squid access log that the engine's real traffic is allowed and nothing extraneous is
