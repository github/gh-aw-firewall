/**
 * API proxy upstream routing and target customization options.
 */

export interface ApiProxyRoutingOptions {
  /**
   * Copilot BYOK provider type hint forwarded to the API proxy sidecar.
   *
   * When set, the sidecar uses this hint to select provider-specific behavior
   * (for example, Azure OpenAI `api-key` header handling).
   *
   * Can be set via:
   * - Config path: `apiProxy.modelRouter.providerType`
   * - Environment variable: `COPILOT_PROVIDER_TYPE`
   *
   * @default undefined
   */
  copilotProviderType?: string;

  /**
   * Copilot BYOK provider base URL forwarded to the API proxy sidecar.
   *
   * This points the sidecar at a model router or Copilot-compatible upstream
   * endpoint (for example, OpenRouter or Azure OpenAI deployment URLs).
   *
   * Can be set via:
   * - Config path: `apiProxy.modelRouter.baseUrl`
   * - Environment variable: `COPILOT_PROVIDER_BASE_URL`
   *
   * @default undefined
   */
  copilotProviderBaseUrl?: string;

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
   * Supplemental headers for Copilot BYOK upstream requests (non-sensitive).
   *
   * When set, these headers are JSON-encoded and passed to the API proxy as
   * `AWF_BYOK_EXTRA_HEADERS`. They are only applied by the sidecar when
   * `COPILOT_PROVIDER_API_KEY` is in use.
   *
   * Set via config file path `apiProxy.targets.copilot.extraHeaders`.
   *
   * @default undefined
   */
  copilotByokExtraHeaders?: Record<string, string>;

  /**
   * Supplemental JSON body fields for Copilot BYOK upstream requests (non-sensitive).
   *
   * When set, these fields are JSON-encoded and passed to the API proxy as
   * `AWF_BYOK_EXTRA_BODY_FIELDS`. They are only applied by the sidecar when
   * `COPILOT_PROVIDER_API_KEY` is in use.
   *
   * Set via config file path `apiProxy.targets.copilot.extraBodyFields`.
   *
   * @default undefined
   */
  copilotByokExtraBodyFields?: Record<string, string>;

  /**
   * Opt-in session identifier injected on Copilot BYOK upstream requests.
   *
   * When set, this value is forwarded to the API proxy as
   * `AWF_PROVIDER_SESSION_ID`. The Copilot adapter then injects it as a
   * default `x-session-id` request header and `session_id` body field
   * (unless those keys are already set via `copilotByokExtraHeaders` /
   * `copilotByokExtraBodyFields`). This is a GitHub Copilot API
   * convention; strict OpenAI-compatible servers (e.g. Azure OpenAI) reject
   * the unknown `session_id` body field with HTTP 400, so this field must
   * be set explicitly by the caller and is never auto-derived from
   * `GITHUB_RUN_ID`.
   *
   * Set via config file path `apiProxy.targets.copilot.sessionId`.
   *
   * @default undefined
   */
  copilotByokSessionId?: string;

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
}
