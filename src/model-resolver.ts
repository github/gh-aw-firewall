/**
 * Model resolution logic for AWF.
 *
 * Walks the model-selection policy chain (primary → fallback[0..n] → auto)
 * and returns the first candidate that is both available and satisfies the
 * active constraints.
 *
 * See docs/model-selection-policy.md §5 for the normative processing model.
 */

import type {
  ModelConstraints,
  ModelFallbackEntry,
  ModelPolicy,
  ModelSpec,
} from './model-policy';

/**
 * A model known to be available at resolution time.
 *
 * This is typically populated by querying `GET /models` on the API-proxy
 * sidecar. The caller is responsible for ordering the array by preference
 * (most preferred first); the `auto` strategy picks the first candidate
 * that satisfies the active constraints.
 */
export interface AvailableModel {
  /** Model identifier (must match {@link ModelSpec.id}). */
  id: string;
  /** Provider hosting this model. */
  provider: string;
  /** Capabilities advertised by this model. */
  capabilities?: string[];
  /** Context-window size in tokens. */
  context_window?: number;
  /** Billing tier bucket. */
  cost_tier?: string;
}

/** Records where in the resolution chain a candidate was found. */
export type ModelResolutionSource = 'primary' | 'fallback' | 'auto';

/**
 * The outcome of a successful model resolution.
 */
export interface ModelResolutionResult {
  /** The resolved model specification to use. */
  model: ModelSpec;
  /** Which part of the policy chain supplied the winning candidate. */
  source: ModelResolutionSource;
  /**
   * Zero-based index into `policy.fallback` for the winning entry.
   * Set when `source` is `"fallback"` or `"auto"` (when the auto sentinel
   * was reached via the fallback array).
   */
  fallback_index?: number;
  /** Human-readable explanation of the resolution decision. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function modelSatisfiesConstraints(
  model: AvailableModel,
  constraints: ModelConstraints | undefined
): boolean {
  if (!constraints) return true;

  if (constraints.capabilities && constraints.capabilities.length > 0) {
    const modelCaps = model.capabilities ?? [];
    for (const required of constraints.capabilities) {
      if (!modelCaps.includes(required)) return false;
    }
  }

  if (constraints.min_context_window !== undefined) {
    if (
      model.context_window === undefined ||
      model.context_window < constraints.min_context_window
    ) {
      return false;
    }
  }

  if (constraints.max_context_window != null) {
    if (
      model.context_window === undefined ||
      model.context_window > constraints.max_context_window
    ) {
      return false;
    }
  }

  if (constraints.cost_tier !== undefined) {
    if (model.cost_tier !== constraints.cost_tier) return false;
  }

  return true;
}

function findAvailableModel(
  spec: ModelSpec,
  available: AvailableModel[]
): AvailableModel | undefined {
  return available.find(
    m => m.id === spec.id && (spec.provider === undefined || m.provider === spec.provider)
  );
}

function findBestAvailable(
  available: AvailableModel[],
  constraints: ModelConstraints | undefined
): AvailableModel | undefined {
  return available.find(m => modelSatisfiesConstraints(m, constraints));
}

function availableModelToSpec(m: AvailableModel): ModelSpec {
  return { id: m.id, provider: m.provider as ModelSpec['provider'] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves the effective model to use for a workflow run.
 *
 * ### Resolution algorithm (§5.2 of the specification)
 *
 * 1. **Primary** — If the primary model is in `available` and satisfies
 *    `constraints`, return it immediately.
 * 2. **Fallback chain** — Walk `policy.fallback` left to right:
 *    - For a concrete {@link ModelSpec} entry: if the model is in `available`
 *      and satisfies `constraints`, return it.
 *    - For the `{ strategy: "auto" }` sentinel: pick the first entry in
 *      `available` that satisfies `constraints` and return it.
 * 3. **on_unavailable** — If no candidate was found:
 *    - `"fail"` (default): throw an error.
 *    - `"warn-and-use-best"`: ignore constraints and return the first entry
 *      in `available` (constraints relaxed, a warning should be logged by
 *      the caller).
 *    - `"queue"`: throw an error indicating that queuing is not yet
 *      implemented at runtime.
 *
 * @param policy    The validated {@link ModelPolicy}.
 * @param available Preference-ordered list of models known to be available.
 *
 * @throws {Error} When no satisfying model can be found and
 *   `on_unavailable` is `"fail"` (the default) or `"queue"`.
 */
export function resolveModel(
  policy: ModelPolicy,
  available: AvailableModel[]
): ModelResolutionResult {
  const { model: primary, fallback, constraints, on_unavailable } = policy;

  // 1. Try primary model
  const primaryCandidate = findAvailableModel(primary, available);
  if (primaryCandidate && modelSatisfiesConstraints(primaryCandidate, constraints)) {
    return {
      model: primary,
      source: 'primary',
      reason: 'Primary model is available and satisfies constraints',
    };
  }

  // 2. Walk fallback chain
  if (fallback && fallback.length > 0) {
    for (let i = 0; i < fallback.length; i++) {
      const entry: ModelFallbackEntry = fallback[i];

      if ('strategy' in entry) {
        // Auto sentinel: pick best available model satisfying constraints
        const best = findBestAvailable(available, constraints);
        if (best) {
          return {
            model: availableModelToSpec(best),
            source: 'auto',
            fallback_index: i,
            reason: 'Auto-selected best available model satisfying constraints',
          };
        }
        // auto found nothing — fall through to on_unavailable
        break;
      } else {
        // Concrete model spec
        const candidate = findAvailableModel(entry, available);
        if (candidate && modelSatisfiesConstraints(candidate, constraints)) {
          return {
            model: entry,
            source: 'fallback',
            fallback_index: i,
            reason: `Primary unavailable; using fallback[${i}] (${entry.id})`,
          };
        }
      }
    }
  }

  // 3. on_unavailable handling
  const behavior = on_unavailable ?? 'fail';

  if (behavior === 'warn-and-use-best') {
    // Relax constraints and return whatever is available
    const best = available[0];
    if (best) {
      return {
        model: availableModelToSpec(best),
        source: 'auto',
        reason:
          'No constrained model available; using best available (warn-and-use-best — constraints relaxed)',
      };
    }
    throw new Error(
      `No models available at all. Primary requested: ${primary.id}`
    );
  }

  if (behavior === 'queue') {
    throw new Error(
      `No model satisfying policy constraints is available; ` +
        `runtime queuing is not yet supported. Primary requested: ${primary.id}`
    );
  }

  // Default: "fail"
  throw new Error(
    `No model satisfying policy constraints is available. Primary requested: ${primary.id}`
  );
}
