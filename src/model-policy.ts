/**
 * Model-selection policy types and validation for AWF.
 *
 * The policy is consumed by the gh-aw compiler (serialised into lock files)
 * and enforced by AWF at container startup via the AWF_MODEL_POLICY_B64
 * environment variable.
 *
 * Schema: schemas/model-policy.v1.json
 * Specification: docs/model-selection-policy.md
 */

/** Provider that hosts the model. */
export type ModelProvider = 'copilot' | 'anthropic' | 'openai' | 'custom';

/** Engine-specific reasoning-effort hint. */
export type ModelReasoningEffort = 'low' | 'medium' | 'high';

/** A discrete capability that a model may or may not support. */
export type ModelCapability = 'tool-use' | 'vision' | 'code-execution' | 'image-generation';

/** Billing tier bucket used to constrain model selection by cost. */
export type ModelCostTier = 'economy' | 'standard' | 'premium';

/** Behaviour when no candidate satisfies all constraints. */
export type ModelOnUnavailable = 'fail' | 'warn-and-use-best' | 'queue';

/**
 * Identifies a specific model to use.
 *
 * The `id` is interpreted by the named provider. AWF does not maintain a
 * registry of valid IDs; unknown IDs produce a warning at compile time but
 * do not block execution.
 */
export interface ModelSpec {
  /** Model identifier as understood by the provider (e.g. "gpt-5.2"). */
  id: string;
  /** Provider that hosts the model. */
  provider?: ModelProvider;
  /** Engine-specific reasoning-effort hint. */
  reasoning_effort?: ModelReasoningEffort;
}

/**
 * Sentinel fallback entry that instructs AWF to select the best available
 * model satisfying the active constraints.
 */
export interface ModelAutoStrategy {
  strategy: 'auto';
}

/** One entry in the fallback chain. */
export type ModelFallbackEntry = ModelSpec | ModelAutoStrategy;

/**
 * Constraints applied to every candidate in the resolution chain.
 *
 * A candidate that fails any constraint is skipped. Constraints are
 * evaluated after provider availability is confirmed.
 */
export interface ModelConstraints {
  /** Set of capabilities the resolved model MUST support. */
  capabilities?: ModelCapability[];
  /**
   * Maximum context-window size (tokens). `null` means no upper bound.
   * If omitted, no upper limit is applied.
   */
  max_context_window?: number | null;
  /** Minimum context-window size (tokens) the resolved model must provide. */
  min_context_window?: number;
  /** The resolved model's cost tier MUST equal this value. */
  cost_tier?: ModelCostTier;
}

/**
 * Controls which model-selection events are written to the audit log.
 */
export interface ModelPolicyAudit {
  /** When true, AWF emits an audit entry recording which model was selected. */
  log_selection?: boolean;
  /** When true, AWF emits an audit entry explaining why prior candidates were skipped. */
  log_fallback_reason?: boolean;
}

/**
 * Maximum allowed fallback chain depth.
 *
 * The gh-aw compiler rejects policies whose `fallback` array exceeds this
 * length. AWF enforces the same limit at runtime.
 */
export const MAX_FALLBACK_DEPTH = 5;

/**
 * Model-selection policy document (version 1).
 *
 * All fields except `version` and `model` are optional. When `fallback` and
 * `constraints` are absent, AWF uses the primary model directly and fails
 * if that model is unavailable (`on_unavailable` defaults to `"fail"`).
 */
export interface ModelPolicy {
  /** URI of the validating JSON Schema (optional, for tooling). */
  $schema?: string;
  /** Policy schema version. MUST be the string "1". */
  version: '1';
  /** Primary model to request. AWF attempts this model first. */
  model: ModelSpec;
  /**
   * Ordered fallback chain tried when the primary model is unavailable.
   * At most {@link MAX_FALLBACK_DEPTH} entries.
   */
  fallback?: ModelFallbackEntry[];
  /** Constraints applied to every candidate in the resolution chain. */
  constraints?: ModelConstraints;
  /**
   * Behaviour when no candidate satisfies all constraints.
   * Defaults to `"fail"`.
   */
  on_unavailable?: ModelOnUnavailable;
  /** Observability settings for model-selection decisions. */
  audit?: ModelPolicyAudit;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateKnownKeys(
  value: Record<string, unknown>,
  keys: string[],
  location: string,
  errors: string[]
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${location}.${key} is not supported`);
    }
  }
}

const VALID_PROVIDERS: readonly ModelProvider[] = ['copilot', 'anthropic', 'openai', 'custom'];
const VALID_REASONING_EFFORTS: readonly ModelReasoningEffort[] = ['low', 'medium', 'high'];
const VALID_CAPABILITIES: readonly ModelCapability[] = [
  'tool-use',
  'vision',
  'code-execution',
  'image-generation',
];
const VALID_COST_TIERS: readonly ModelCostTier[] = ['economy', 'standard', 'premium'];
const VALID_ON_UNAVAILABLE: readonly ModelOnUnavailable[] = ['fail', 'warn-and-use-best', 'queue'];

function validateModelSpec(value: unknown, location: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return;
  }
  validateKnownKeys(value, ['id', 'provider', 'reasoning_effort'], location, errors);
  if (typeof value.id !== 'string' || value.id.trim() === '') {
    errors.push(`${location}.id must be a non-empty string`);
  }
  if (value.provider !== undefined && !(VALID_PROVIDERS as readonly unknown[]).includes(value.provider)) {
    errors.push(`${location}.provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
  }
  if (
    value.reasoning_effort !== undefined &&
    !(VALID_REASONING_EFFORTS as readonly unknown[]).includes(value.reasoning_effort)
  ) {
    errors.push(
      `${location}.reasoning_effort must be one of: ${VALID_REASONING_EFFORTS.join(', ')}`
    );
  }
}

function validateFallbackEntry(value: unknown, location: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return;
  }
  if ('strategy' in value) {
    validateKnownKeys(value, ['strategy'], location, errors);
    if (value.strategy !== 'auto') {
      errors.push(`${location}.strategy must be "auto"`);
    }
  } else {
    validateModelSpec(value, location, errors);
  }
}

function validateConstraints(value: unknown, location: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return;
  }
  validateKnownKeys(
    value,
    ['capabilities', 'max_context_window', 'min_context_window', 'cost_tier'],
    location,
    errors
  );

  if (value.capabilities !== undefined) {
    if (
      !Array.isArray(value.capabilities) ||
      value.capabilities.some(
        (c: unknown) => !(VALID_CAPABILITIES as readonly unknown[]).includes(c)
      )
    ) {
      errors.push(
        `${location}.capabilities must be an array of: ${VALID_CAPABILITIES.join(', ')}`
      );
    }
  }

  if (value.max_context_window !== undefined && value.max_context_window !== null) {
    if (
      typeof value.max_context_window !== 'number' ||
      !Number.isInteger(value.max_context_window) ||
      value.max_context_window < 1
    ) {
      errors.push(`${location}.max_context_window must be a positive integer or null`);
    }
  }

  if (value.min_context_window !== undefined) {
    if (
      typeof value.min_context_window !== 'number' ||
      !Number.isInteger(value.min_context_window) ||
      value.min_context_window < 1
    ) {
      errors.push(`${location}.min_context_window must be a positive integer`);
    }
  }

  if (
    value.cost_tier !== undefined &&
    !(VALID_COST_TIERS as readonly unknown[]).includes(value.cost_tier)
  ) {
    errors.push(`${location}.cost_tier must be one of: ${VALID_COST_TIERS.join(', ')}`);
  }
}

function validateAudit(value: unknown, location: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return;
  }
  validateKnownKeys(value, ['log_selection', 'log_fallback_reason'], location, errors);
  if (value.log_selection !== undefined && typeof value.log_selection !== 'boolean') {
    errors.push(`${location}.log_selection must be a boolean`);
  }
  if (value.log_fallback_reason !== undefined && typeof value.log_fallback_reason !== 'boolean') {
    errors.push(`${location}.log_fallback_reason must be a boolean`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates a parsed model-policy object and returns a list of validation
 * error messages. An empty array means the document is conforming.
 *
 * @param policy - Arbitrary value (e.g. the result of JSON.parse).
 * @returns Array of human-readable error strings; empty when valid.
 */
export function validateModelPolicy(policy: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(policy)) {
    return ['policy root must be an object'];
  }

  validateKnownKeys(
    policy,
    ['$schema', 'version', 'model', 'fallback', 'constraints', 'on_unavailable', 'audit'],
    'policy',
    errors
  );

  if (policy.$schema !== undefined && typeof policy.$schema !== 'string') {
    errors.push('policy.$schema must be a string');
  }

  if (policy.version !== '1') {
    errors.push('policy.version must be "1"');
  }

  if (policy.model === undefined) {
    errors.push('policy.model is required');
  } else {
    validateModelSpec(policy.model, 'policy.model', errors);
  }

  if (policy.fallback !== undefined) {
    if (!Array.isArray(policy.fallback)) {
      errors.push('policy.fallback must be an array');
    } else {
      if (policy.fallback.length > MAX_FALLBACK_DEPTH) {
        errors.push(`policy.fallback must not exceed ${MAX_FALLBACK_DEPTH} entries`);
      }
      for (let i = 0; i < policy.fallback.length; i++) {
        validateFallbackEntry(policy.fallback[i], `policy.fallback[${i}]`, errors);
      }
    }
  }

  if (policy.constraints !== undefined) {
    validateConstraints(policy.constraints, 'policy.constraints', errors);
  }

  if (
    policy.on_unavailable !== undefined &&
    !(VALID_ON_UNAVAILABLE as readonly unknown[]).includes(policy.on_unavailable)
  ) {
    errors.push(
      `policy.on_unavailable must be one of: ${VALID_ON_UNAVAILABLE.join(', ')}`
    );
  }

  if (policy.audit !== undefined) {
    validateAudit(policy.audit, 'policy.audit', errors);
  }

  return errors;
}

/**
 * Parses and validates an arbitrary value as a {@link ModelPolicy}.
 *
 * @throws {Error} When the document fails validation.
 */
export function parseModelPolicy(raw: unknown): ModelPolicy {
  const errors = validateModelPolicy(raw);
  if (errors.length > 0) {
    throw new Error(`Invalid model policy:\n- ${errors.join('\n- ')}`);
  }
  return raw as ModelPolicy;
}

/**
 * Decodes a base64-encoded JSON string and returns a validated
 * {@link ModelPolicy}.
 *
 * AWF passes the policy to the agent container via the
 * `AWF_MODEL_POLICY_B64` environment variable using this encoding.
 *
 * @throws {Error} When the base64 payload is not valid JSON or the resulting
 *   document fails validation.
 */
export function parseModelPolicyFromBase64(encoded: string): ModelPolicy {
  const json = Buffer.from(encoded, 'base64').toString('utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Failed to parse model policy JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return parseModelPolicy(parsed);
}

/**
 * Serialises a {@link ModelPolicy} to a base64-encoded JSON string suitable
 * for the `AWF_MODEL_POLICY_B64` environment variable.
 */
export function serializeModelPolicyToBase64(policy: ModelPolicy): string {
  return Buffer.from(JSON.stringify(policy), 'utf-8').toString('base64');
}
