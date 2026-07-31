import type { BoundedQueryRuntime } from '../types';

export const BOUNDED_QUERY_RUNTIME_BACKENDS = ['docker', 'gvisor', 'sbx'] as const;

export type BoundedQueryPrimaryBackend = (typeof BOUNDED_QUERY_RUNTIME_BACKENDS)[number];
export type BoundedQueryCapabilityState = 'supported' | 'unavailable' | 'blocked';

export interface BoundedQueryRuntimeCapabilities {
  primary: Readonly<Record<BoundedQueryPrimaryBackend, BoundedQueryCapabilityState>>;
  query: Readonly<Record<BoundedQueryRuntime, BoundedQueryCapabilityState>>;
}

export interface BoundedQueryRuntimeCombination {
  primaryBackend: BoundedQueryPrimaryBackend;
  queryBackend: BoundedQueryRuntime;
  supported: boolean;
  capabilityState: BoundedQueryCapabilityState;
  blockedAt?: 'primary-preflight' | 'query-preflight';
  category: 'ready' | 'primary-runtime-unavailable' | 'query-runtime-unavailable' | 'query-security-block';
}

export interface BoundedQueryRuntimeTelemetry {
  primaryBackend: BoundedQueryPrimaryBackend;
  queryBackend: BoundedQueryRuntime;
  lifecycleClass: 'preflight' | 'startup' | 'query' | 'cleanup';
  capabilityState: BoundedQueryCapabilityState;
  category: string;
}

/** Maps AWF's execution setting to the independent primary-agent matrix axis. */
export function resolveBoundedQueryPrimaryBackend(
  containerRuntime: string | undefined,
): BoundedQueryPrimaryBackend {
  if (containerRuntime === 'gvisor' || containerRuntime === 'runsc') return 'gvisor';
  if (containerRuntime === 'sbx') return 'sbx';
  return 'docker';
}

/**
 * Evaluates one primary/query pair without fallback.
 *
 * Primary availability is checked first because the primary agent cannot be
 * started without it. Query availability is then checked before any repository
 * staging. A blocked query capability is distinct from an unavailable binary:
 * it means the runtime exists but cannot enforce AWF's mandatory controls.
 */
export function evaluateBoundedQueryRuntimeCombination(
  primaryBackend: BoundedQueryPrimaryBackend,
  queryBackend: BoundedQueryRuntime,
  capabilities: BoundedQueryRuntimeCapabilities,
): BoundedQueryRuntimeCombination {
  const primaryState = capabilities.primary[primaryBackend];
  if (primaryState !== 'supported') {
    return {
      primaryBackend,
      queryBackend,
      supported: false,
      capabilityState: primaryState,
      blockedAt: 'primary-preflight',
      category: 'primary-runtime-unavailable',
    };
  }

  const queryState = capabilities.query[queryBackend];
  if (queryState !== 'supported') {
    return {
      primaryBackend,
      queryBackend,
      supported: false,
      capabilityState: queryState,
      blockedAt: 'query-preflight',
      category: queryState === 'blocked' ? 'query-security-block' : 'query-runtime-unavailable',
    };
  }

  return {
    primaryBackend,
    queryBackend,
    supported: true,
    capabilityState: 'supported',
    category: 'ready',
  };
}

/** Serializes the intentionally narrow, path- and content-free telemetry shape. */
export function serializeBoundedQueryRuntimeTelemetry(
  event: BoundedQueryRuntimeTelemetry,
): string {
  return JSON.stringify({
    primaryBackend: event.primaryBackend,
    queryBackend: event.queryBackend,
    lifecycleClass: event.lifecycleClass,
    capabilityState: event.capabilityState,
    category: event.category,
  });
}
