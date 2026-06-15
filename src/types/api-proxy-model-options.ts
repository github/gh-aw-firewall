/**
 * API proxy model routing and selection options.
 */

export interface ApiProxyModelOptions {
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
}
