/**
 * API proxy diagnostics, logging, and cache options.
 */

export interface ApiProxyDiagnosticsOptions {
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
   * Enable capture of body-shape diagnostics for guard-blocked requests.
   *
   * - `false` (default): Nothing written.
   * - `'summary'`: Counts, sizes, hashes — no message content.
   * - `'redacted'`: Summary plus first 200 chars per message.
   * - `'full'`: Full body up to `maxCapturedBytes`.
   * - `true`: Alias for `'summary'`.
   *
   * Set via:
   * - Config file: `apiProxy.diagnostics.captureBlockedRequests: "summary"`
   * - Environment variable: `AWF_CAPTURE_BLOCKED_LLM_REQUESTS=summary`
   *
   * @default false
   */
  captureBlockedRequests?: boolean | 'summary' | 'redacted' | 'full';

  /**
   * Maximum body bytes to include in a single `full`-mode blocked-request-diag record.
   *
   * Set via:
   * - Config file: `apiProxy.diagnostics.maxCapturedBytes: 250000`
   * - Environment variable: `AWF_MAX_BLOCKED_CAPTURE_BYTES=250000`
   *
   * @default 250000
   */
  maxCapturedBytes?: number;

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
}
