/**
 * API proxy and credential configuration options.
 */

export interface ApiProxyOptions {
  /**
   * Model fallback policy for unresolved model selections in the API proxy.
   *
   * When enabled, if direct model selection and alias resolution both fail,
   * the proxy selects a "middle-power" model (median by capability tier) from
   * available provider models as a safety fallback.
   *
   * @default { enabled: true, strategy: 'middle_power' }
   */
  modelFallback?: {
    enabled?: boolean;
    strategy?: 'middle_power';
    excludeEngines?: string[];
  };

  /**
   * Enable API proxy sidecar for holding authentication credentials
   *
   * When true, deploys a Node.js proxy sidecar container that:
   * - Holds OpenAI, Anthropic, GitHub Copilot, and Google Gemini API keys securely
   * - Automatically injects authentication headers
   * - Routes all traffic through Squid to respect domain whitelisting
   * - Proxies requests to LLM providers
   *
   * The sidecar exposes four endpoints accessible from the agent container:
   * - http://api-proxy:10000 - OpenAI API proxy (for Codex) {@link API_PROXY_PORTS.OPENAI}
   * - http://api-proxy:10001 - Anthropic API proxy (for Claude) {@link API_PROXY_PORTS.ANTHROPIC}
   * - http://api-proxy:10002 - GitHub Copilot API proxy {@link API_PROXY_PORTS.COPILOT}
   * - http://api-proxy:10003 - Google Gemini API proxy {@link API_PROXY_PORTS.GEMINI}
   *
   * When the corresponding API key is provided, the following environment
   * variables are set in the agent container:
   * - OPENAI_BASE_URL=http://api-proxy:10000 (set when OPENAI_API_KEY is provided)
   * - ANTHROPIC_BASE_URL=http://api-proxy:10001 (set when ANTHROPIC_API_KEY is provided, or when AWF_AUTH_TYPE=github-oidc and AWF_AUTH_PROVIDER=anthropic)
   * - COPILOT_API_URL=http://api-proxy:10002 (set when COPILOT_GITHUB_TOKEN is provided)
   * - CLAUDE_CODE_API_KEY_HELPER=/usr/local/bin/get-claude-key.sh (set when ANTHROPIC_API_KEY is provided, or when AWF_AUTH_TYPE=github-oidc and AWF_AUTH_PROVIDER=anthropic)
   *
   * API keys are passed via environment variables:
   * - OPENAI_API_KEY - Optional OpenAI API key for Codex
   * - ANTHROPIC_API_KEY - Optional Anthropic API key for Claude
   * - COPILOT_GITHUB_TOKEN - Optional GitHub token for Copilot
   * - COPILOT_PROVIDER_API_KEY - Optional upstream BYOK API key for Copilot-compatible providers
   * - GEMINI_API_KEY - Optional Google Gemini API key
   *
   * @default false
   * @example
   * ```bash
   * # Enable API proxy with keys from environment
   * export OPENAI_API_KEY="sk-..."
   * export ANTHROPIC_API_KEY="sk-ant-..."
   * export COPILOT_GITHUB_TOKEN="ghp_..."
   * awf --enable-api-proxy --allow-domains api.openai.com,api.anthropic.com,api.githubcopilot.com -- command
   * ```
   * @see API_PROXY_PORTS for port configuration
   */
  enableApiProxy?: boolean;

  /**
   * OpenAI API key for Codex (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this key is injected into the Node.js sidecar
   * container and used to authenticate requests to api.openai.com.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   *
   * @default undefined
   */
  openaiApiKey?: string;

  /**
   * Anthropic API key for Claude (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this key is injected into the Node.js sidecar
   * container and used to authenticate requests to api.anthropic.com.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   *
   * @default undefined
   */
  anthropicApiKey?: string;

  /**
   * GitHub token for Copilot (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this token is injected into the Node.js sidecar
   * container and used to authenticate requests to api.githubcopilot.com.
   *
   * The token is NOT exposed to the agent container - only the proxy URL is provided.
   * The agent receives a placeholder value that is protected by the one-shot-token library.
   *
   * @default undefined
   */
  copilotGithubToken?: string;

  /**
   * Upstream BYOK API key for Copilot-compatible providers (used by API proxy sidecar)
   *
   * When enableApiProxy is true and this key is provided, AWF routes Copilot CLI
   * through the sidecar in direct-BYOK mode (Azure Foundry, OpenRouter, etc.).
   * The real key is injected into the Node.js sidecar container and used to
   * authenticate requests to the user-supplied COPILOT_PROVIDER_BASE_URL.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   * The agent receives a placeholder value so Copilot CLI's startup auth check passes.
   *
   * Sourced from `process.env.COPILOT_PROVIDER_API_KEY` in build-config; matches the
   * pattern used by OPENAI_API_KEY, ANTHROPIC_API_KEY, COPILOT_GITHUB_TOKEN, and
   * GEMINI_API_KEY.
   *
   * @default undefined
   */
  copilotProviderApiKey?: string;

  /**
   * Google Gemini API key (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this key is injected into the Node.js sidecar
   * container and used to authenticate requests to generativelanguage.googleapis.com.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   * The agent receives a placeholder value so Gemini CLI's startup auth check passes.
   *
   * @default undefined
   */
  geminiApiKey?: string;

  /**
   * Target hostname for GitHub Copilot API requests (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this hostname is passed to the Node.js sidecar
   * as `COPILOT_API_TARGET`. The proxy will forward Copilot API requests to this host
   * instead of the default `api.githubcopilot.com`.
   *
   * Useful for GitHub Enterprise Server (GHES) deployments where the Copilot API
   * endpoint differs from the public default.
   *
   * Can be set via:
   * - CLI flag: `--copilot-api-target <host>`
   * - Environment variable: `COPILOT_API_TARGET`
   *
   * @default 'api.githubcopilot.com'
   * @example
   * ```bash
   * awf --enable-api-proxy --copilot-api-target api.github.mycompany.com -- command
   * ```
   */
  copilotApiTarget?: string;

  /**
   * Base path prefix for GitHub Copilot API requests (used by API proxy sidecar)
   *
   * When set, this path is prepended to upstream Copilot requests. This enables
   * BYOK providers that expose Copilot-compatible APIs behind a prefixed endpoint
   * (for example, `https://router.example.com/api/v1`).
   *
   * Can be set via:
   * - Environment variable: `COPILOT_API_BASE_PATH`
   * - Auto-derived from `COPILOT_PROVIDER_BASE_URL` path when present
   *
   * @default ''
   * @example '/api/v1'
   */
  copilotApiBasePath?: string;

  /**
   * Target hostname for OpenAI API requests (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this hostname is passed to the Node.js sidecar
   * as `OPENAI_API_TARGET`. The proxy will forward OpenAI API requests to this host
   * instead of the default `api.openai.com`.
   *
   * Useful for custom OpenAI-compatible endpoints (e.g., Azure OpenAI, internal
   * LLM routers, vLLM, TGI) where the API endpoint differs from the public default.
   *
   * Can be set via:
   * - CLI flag: `--openai-api-target <host>`
   * - Environment variable: `OPENAI_API_TARGET`
   *
   * @default 'api.openai.com'
   * @example
   * ```bash
   * awf --enable-api-proxy --openai-api-target llm-router.internal.example.com -- command
   * ```
   */
  openaiApiTarget?: string;

  /**
   * Base path prefix for OpenAI API requests (used by API proxy sidecar)
   *
   * When set, this path is prepended to every upstream request path so that
   * endpoints which require a URL prefix (e.g. Databricks serving endpoints,
   * Azure OpenAI deployments) work correctly.
   *
   * Can be set via:
   * - CLI flag: `--openai-api-base-path <path>`
   * - Environment variable: `OPENAI_API_BASE_PATH`
   *
   * @default ''
   * @example '/serving-endpoints'
   * @example '/openai/deployments/gpt-4'
   */
  openaiApiBasePath?: string;

  /**
   * Target hostname for Anthropic API requests (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this hostname is passed to the Node.js sidecar
   * as `ANTHROPIC_API_TARGET`. The proxy will forward Anthropic API requests to this host
   * instead of the default `api.anthropic.com`.
   *
   * Useful for custom Anthropic-compatible endpoints (e.g., internal LLM routers)
   * where the API endpoint differs from the public default.
   *
   * Can be set via:
   * - CLI flag: `--anthropic-api-target <host>`
   * - Environment variable: `ANTHROPIC_API_TARGET`
   *
   * @default 'api.anthropic.com'
   * @example
   * ```bash
   * awf --enable-api-proxy --anthropic-api-target llm-router.internal.example.com -- command
   * ```
   */
  anthropicApiTarget?: string;

  /**
   * Base path prefix for Anthropic API requests (used by API proxy sidecar)
   *
   * When set, this path is prepended to every upstream request path so that
   * endpoints which require a URL prefix work correctly.
   *
   * Can be set via:
   * - CLI flag: `--anthropic-api-base-path <path>`
   * - Environment variable: `ANTHROPIC_API_BASE_PATH`
   *
   * @default ''
   * @example '/anthropic'
   */
  anthropicApiBasePath?: string;

  /**
   * Custom auth header name for OpenAI API requests (used by API proxy sidecar)
   *
   * When set, the proxy uses this header name instead of the default
   * `Authorization: Bearer <key>` format. The key is sent as the raw header
   * value without a "Bearer" prefix.
   *
   * Useful for internal AI gateways (e.g. Azure OpenAI) that require a
   * different header name such as `api-key`.
   *
   * Can be set via:
   * - CLI flag: `--openai-api-auth-header <name>`
   * - Environment variable: `AWF_OPENAI_AUTH_HEADER`
   *
   * @default undefined (uses `Authorization: Bearer <key>`)
   * @example 'api-key'
   */
  openaiApiAuthHeader?: string;

  /**
   * Custom auth header name for Anthropic API requests (used by API proxy sidecar)
   *
   * When set, the proxy uses this header name instead of the default `x-api-key`.
   *
   * Useful for internal AI gateways that require a different header name.
   *
   * Can be set via:
   * - CLI flag: `--anthropic-api-auth-header <name>`
   * - Environment variable: `AWF_ANTHROPIC_AUTH_HEADER`
   *
   * @default 'x-api-key'
   * @example 'api-key'
   */
  anthropicApiAuthHeader?: string;

  /**
   * Anthropic OIDC token exchange endpoint override.
   *
   * When set, AWF passes this value to the API proxy as
   * `AWF_AUTH_ANTHROPIC_TOKEN_URL` for Anthropic WIF/OIDC exchange.
   *
   * Intended for non-sensitive endpoint customization and typically set via
   * config file (`apiProxy.auth.anthropicTokenUrl`).
   *
   * @default 'https://api.anthropic.com/v1/oauth/token'
   */
  anthropicTokenUrl?: string;

  /**
   * Target hostname for Google Gemini API requests (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this hostname is passed to the Node.js sidecar
   * as `GEMINI_API_TARGET`. The proxy will forward Gemini API requests to this host
   * instead of the default `generativelanguage.googleapis.com`.
   *
   * Can be set via:
   * - CLI flag: `--gemini-api-target <host>`
   * - Environment variable: `GEMINI_API_TARGET`
   *
   * @default 'generativelanguage.googleapis.com'
   * @example
   * ```bash
   * awf --enable-api-proxy --gemini-api-target custom-gemini-endpoint.example.com -- command
   * ```
   */
  geminiApiTarget?: string;

  /**
   * Base path prefix for Google Gemini API requests (used by API proxy sidecar)
   *
   * When set, this path is prepended to every upstream request path so that
   * endpoints which require a URL prefix work correctly.
   *
   * Can be set via:
   * - CLI flag: `--gemini-api-base-path <path>`
   * - Environment variable: `GEMINI_API_BASE_PATH`
   *
   * @default ''
   */
  geminiApiBasePath?: string;

  /**
   * Model alias map for the API proxy sidecar
   *
   * When enableApiProxy is true and model aliases are configured, the proxy
   * intercepts POST/PUT/PATCH request bodies containing a "model" field and rewrites
   * the model name using the alias resolution chain before forwarding to upstream.
   *
   * Alias map format: each key is an alias name (or "" for the default policy),
   * and the value is an ordered list of candidates. Candidates can be:
   * - "provider/modelpattern" — match against available models for that provider
   *   using case-insensitive glob patterns (* wildcard)
   * - "alias-name" — recursively expand another alias (loop detection applies)
   *
   * Resolution picks the highest-version matching model (semver semantics).
   * Only models for the receiving provider's port are considered (e.g., the
   * Copilot proxy at port 10002 only matches "copilot/*" patterns).
   *
   * Set via the `apiProxy.models` section of the AWF config file.
   *
   * @example
   * ```json
   * {
   *   "sonnet": ["copilot/*sonnet*", "anthropic/*sonnet*"],
   *   "gpt-5-codex": ["copilot/gpt-5*-codex", "openai/gpt-5*-codex"],
   *   "": ["sonnet", "gpt-5-codex"]
   * }
   * ```
   */
  modelAliases?: Record<string, string[]>;

  /**
   * Expected model name for pre-startup validation.
   *
   * When set, the API proxy validates at startup that this model is available
   * in at least one configured provider's model catalogue. If the model is not
   * found (retired, restricted, or misspelled), a clear `model_unavailable_at_startup`
   * diagnostic is emitted. This does not block proxy startup.
   *
   * - Config: `apiProxy.requestedModel`
   * - Environment variable: `AWF_REQUESTED_MODEL` (internal; set by AWF CLI)
   *
   * @example 'gpt-4o'
   */
  requestedModel?: string;

  /**
   * Enable detailed token and model-alias diagnostic logging.
   *
   * When true, the API proxy writes diagnostic events to `token-diag.jsonl`
   * including:
   * - `MODEL_ALIAS_RESOLUTION_STEP` — each step of the alias resolution chain
   * - `MODEL_ALIAS_REWRITE` — final alias rewrite decision
   * - Token usage summaries and per-request diagnostics
   *
   * The `token-diag.jsonl` file is written alongside the `token-usage.jsonl`
   * in the directory specified by `tokenLogDir`.
   *
   * Set via:
   * - Config file: `apiProxy.logging.debugTokens: true`
   * - Environment variable: `AWF_DEBUG_TOKENS=1`
   *
   * @default false
   */
  debugTokens?: boolean;

  /**
   * Directory path for API proxy log files (`token-usage.jsonl` and
   * `token-diag.jsonl`). In the default AWF compose, this must be `/var/log/api-proxy`
   * (or a subdirectory) so logs are written to the mounted volume.
   *
   * Set via:
   * - Config file: `apiProxy.logging.tokenLogDir: "/var/log/api-proxy/custom"`
   * - Environment variable: `AWF_TOKEN_LOG_DIR=/var/log/api-proxy/custom`
   *
   * @default "/var/log/api-proxy"
   */
  tokenLogDir?: string;

  /**
   * Enable Anthropic prompt-cache optimizations in the API proxy sidecar.
   *
   * When true, the Anthropic proxy (port 10001) automatically mutates every
   * POST /v1/messages request before forwarding it to api.anthropic.com:
   *
   * - Injects prompt-cache breakpoints on tools, system, messages[0], and the
   *   rolling tail where they are missing — reducing the uncached token count
   *   for repetitive content to near zero.
   * - Upgrades existing ephemeral cache TTLs from the implicit 5-minute default
   *   to 1 hour on stable content (tools, system, messages[0]); the rolling tail
   *   stays at the shorter TTL configured by `anthropicCacheTailTtl`.
   * - Adds the `anthropic-beta: extended-cache-ttl-2025-04-11` header required
   *   by the Anthropic API to honour 1h TTLs.
   * - Strips ANSI SGR escape sequences from message text and tool results so
   *   terminal output with colour codes caches cleanly.
   *
   * Requires `enableApiProxy: true`. Has no effect without an `ANTHROPIC_API_KEY`.
   *
   * Set via:
   * - CLI flag: `--anthropic-auto-cache`
   * - Config file: `apiProxy.anthropicAutoCache: true`
   *
   * @default false
   */
  anthropicAutoCache?: boolean;

  /**
   * TTL for the rolling-tail cache breakpoint when `anthropicAutoCache` is enabled.
   *
   * The rolling tail is the last cacheable block across all messages; it moves every
   * turn so a shorter TTL is more cost-effective than 1h (avoids paying the 2.0×
   * write multiplier for a breakpoint that will expire before reuse).
   *
   * - `"5m"` (default): 5-minute TTL. Suitable for interactive sessions with
   *   fast back-and-forth turns.
   * - `"1h"`: 1-hour TTL. Better for long-running agentic tasks where individual
   *   turns may take minutes.
   *
   * Only used when `anthropicAutoCache` is true.
   *
   * Set via:
   * - CLI flag: `--anthropic-cache-tail-ttl <5m|1h>`
   * - Config file: `apiProxy.anthropicCacheTailTtl: "1h"`
   *
   * @default "5m"
   */
  anthropicCacheTailTtl?: '5m' | '1h';

  /**
   * Enable CLI proxy sidecar for secure gh CLI access
   *
   * When true, deploys a CLI proxy sidecar container that:
   * - Routes gh CLI invocations through an external DIFC proxy (mcpg)
   * - The DIFC proxy enforces guard policies (min-integrity, repo restrictions)
   * - Generates audit logs via mcpg's JSONL output
   *
   * The agent container gets a /usr/local/bin/gh wrapper script that
   * forwards invocations to the CLI proxy sidecar at http://172.30.0.50:11000.
   *
   * The DIFC proxy (mcpg) is started externally by the gh-aw compiler on the
   * host. AWF only launches the cli-proxy container and connects it to the
   * external DIFC proxy via a TCP tunnel for TLS hostname matching.
   *
   * @example 'host.docker.internal:18443'
   */
  difcProxyHost?: string;

  /**
   * Path to the TLS CA certificate written by the external DIFC proxy.
   *
   * The DIFC proxy generates a self-signed TLS cert. This path points to
   * the CA cert on the host filesystem, which is bind-mounted into the
   * cli-proxy container for TLS verification.
   *
   * @example '/tmp/gh-aw/difc-proxy-tls/ca.crt'
   */
  difcProxyCaCert?: string;

  /**
   * GitHub token for the CLI proxy sidecar
   *
   * When difcProxyHost is set, GitHub tokens are excluded from the agent
   * container environment. The token is held by the external DIFC proxy.
   *
   * Read from GITHUB_TOKEN environment variable when not specified.
   *
   * @default undefined
   */
  githubToken?: string;

  /**
   * Docker host (socket) to use for AWF's own container operations
   *
   * When set, overrides the `DOCKER_HOST` environment variable for all
   * docker CLI calls made by AWF itself (compose up/down, docker wait, etc.).
   *
   * Use this when you need to point AWF at a specific local Unix socket that
   * is not the system default (`/var/run/docker.sock`).
   *
   * When not set, AWF auto-detects the Docker host:
   * - If `DOCKER_HOST` is a Unix socket, it is used as-is.
   * - If `DOCKER_HOST` is a TCP address (e.g. a Docker-in-Docker (DinD) daemon),
   *   AWF clears it and falls back to the system default socket.
   *
   * The original `DOCKER_HOST` value (if any) is always forwarded into the
   * agent container so the agent workload can still reach the DinD daemon.
   *
   * @example 'unix:///var/run/docker.sock'
   * @example 'unix:///run/user/1000/docker.sock'
   */
  awfDockerHost?: string;

  /**
   * Prefix runner-visible bind-mount source paths for Docker daemon resolution
   *
   * Use this when the Docker daemon runs in a different filesystem namespace
   * than the AWF process (for example, ARC + DinD sidecar setups). AWF will
   * prepend this prefix to bind-mount source paths before generating compose.
   *
   * @example '/host'
   */
  dockerHostPathPrefix?: string;
}
