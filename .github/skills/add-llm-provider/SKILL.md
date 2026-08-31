---
name: add-llm-provider
description: Decide and implement how to support a new LLM provider or agent engine in AWF - either as a proxied provider (api-proxy adapter) or a direct-API engine (domain allowlist only), e.g. Cursor, Aider, or any tool that calls its own endpoint.
---

# Add LLM Provider

Use this skill whenever a new agent engine or LLM provider needs to work behind AWF and it is unclear how to "set it up." AWF supports two fundamentally different integration paths — picking the wrong one is the most common source of confusion (e.g. "why is `token_usage.jsonl` empty for this engine?").

## Step 1 — Determine how the engine talks to its LLM backend

Ask: **does the engine call the provider's API directly (its own base URL, its own auth), or is it expected to route through AWF's universal `--enable-api-proxy` sidecar** (`http://172.30.0.30:1000{0,1,2,3}` for OpenAI/Anthropic/Copilot/Gemini)?

- If the engine has built-in support for pointing at AWF's api-proxy ports (env vars like `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` rewritten to the sidecar) → **Path A: Proxied provider**.
- If the engine always calls its own hardcoded/native endpoint regardless of proxy env vars (e.g. Cursor CLI calling `api2.cursor.sh` / `api3.cursor.sh` directly), or manages its own credentials outside AWF → **Path B: Direct-API engine**.

When unsure, run the engine once with `--keep-containers` and inspect `docker exec awf-squid cat /var/log/squid/access.log` (see [docs/squid_log_filtering.md](../../../docs/squid_log_filtering.md)) to see which hosts it actually contacts and whether traffic reaches the api-proxy sidecar or goes straight out through Squid.

## Path A — Proxied provider (credentials injected by api-proxy)

Choose this when you want AWF to hold the API key/OIDC token and inject it, keeping secrets out of the agent container.

Follow **[containers/api-proxy/providers/ADDING-A-PROVIDER.md](../../../containers/api-proxy/providers/ADDING-A-PROVIDER.md)** step by step:

1. Create `containers/api-proxy/providers/<name>.js` implementing the `ProviderAdapter` interface.
2. Register it in `containers/api-proxy/providers/index.js`.
3. Update `containers/api-proxy/Dockerfile` (`COPY` list + `EXPOSE` port).
4. Update `src/types/ports.ts` and `src/host-iptables-rules.ts` for the new port.
5. Forward any new env vars from the host in `src/docker-manager.ts`.
6. Add the upstream domain(s) to the allowlist wherever the caller configures `--allow-domains` (AWF itself does not hardcode per-provider domains).
7. Document auth details in [docs/auth-matrix.md](../../../docs/auth-matrix.md) if it's a net-new auth pattern.
8. Write adapter unit tests (`providers/<name>.test.js`) and run them per the memory note below.

## Path B — Direct-API engine (no proxy adapter needed)

Choose this when the engine calls its own API directly and either manages its own credentials, or credential injection isn't feasible/needed through AWF.

1. **No api-proxy adapter is required.** `--enable-api-proxy` stays irrelevant for this engine; do not try to force it through the sidecar.
2. **Just allowlist the domain(s)** the engine needs, either via the CLI flag or config file:
   ```bash
   awf --allow-domains api2.cursor.sh,api3.cursor.sh -- cursor-agent ...
   ```
   or in the AWF config file under `network.allowDomains` (see [docs/awf-config-spec.md](../../../docs/awf-config-spec.md) and [docs/awf-config.schema.json](../../../docs/awf-config.schema.json)).
3. If the engine's real API key must reach the agent container as an env var, treat it the same as any other secret: prefer `sensitiveAllowedDomains` handling and redaction (see credential-isolation memory below) rather than plumbing it through the api-proxy.
4. **Telemetry caveat:** because traffic never passes through the api-proxy sidecar, AWF's `token_usage.jsonl` / token-tracking metrics will stay empty for this engine. Any downstream check that assumes all engines produce proxy telemetry (e.g. a "token usage present" CI gate) must exclude direct-API engines instead of trying to make them populate it.
5. Confirm the domains are correct by testing with `--keep-containers` and checking Squid's access log for `TCP_DENIED` entries, then iterating on the allowlist (see [docs/quickstart.md](../../../docs/quickstart.md) "Test Domain Blocking" section).

## Checklist

- [ ] Identified whether the engine is proxied (Path A) or direct-API (Path B)
- [ ] Path A: adapter created, registered, Dockerfile/ports/iptables updated, tests added
- [ ] Path B: domain(s) allowlisted, telemetry-dependent checks updated to exclude this engine
- [ ] Verified with `--keep-containers` + Squid access log that the engine's real traffic is allowed and nothing extraneous is
