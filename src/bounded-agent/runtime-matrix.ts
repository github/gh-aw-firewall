import type { BoundedAgentRuntime } from '../types';

export const BOUNDED_AGENT_RUNTIME_BACKENDS = ['docker', 'gvisor', 'sbx'] as const;

export type BoundedAgentPrimaryBackend = (typeof BOUNDED_AGENT_RUNTIME_BACKENDS)[number];
export type BoundedAgentCapabilityState = 'supported' | 'unavailable' | 'blocked';

export interface BoundedAgentRuntimeCapabilities {
  primary: Readonly<Record<BoundedAgentPrimaryBackend, BoundedAgentCapabilityState>>;
  enclave: Readonly<Record<BoundedAgentRuntime, BoundedAgentCapabilityState>>;
}

export interface BoundedAgentRuntimeCombination {
  primaryBackend: BoundedAgentPrimaryBackend;
  boundedAgentBackend: BoundedAgentRuntime;
  supported: boolean;
  capabilityState: BoundedAgentCapabilityState;
  blockedAt?: 'primary-preflight' | 'enclave-preflight';
  category: 'ready' | 'primary-runtime-unavailable' | 'enclave-runtime-unavailable' | 'enclave-security-block';
}

export interface BoundedAgentRuntimeTelemetry {
  primaryBackend: BoundedAgentPrimaryBackend;
  boundedAgentBackend: BoundedAgentRuntime;
  lifecycleClass: 'preflight' | 'startup' | 'invocation' | 'cleanup';
  capabilityState: BoundedAgentCapabilityState;
  category: string;
}

/** Maps AWF's execution setting to the independent primary-agent matrix axis. */
export function resolveBoundedAgentPrimaryBackend(
  containerRuntime: string | undefined,
): BoundedAgentPrimaryBackend {
  if (containerRuntime === 'gvisor' || containerRuntime === 'runsc') return 'gvisor';
  if (containerRuntime === 'sbx') return 'sbx';
  return 'docker';
}

/**
 * Evaluates one primary/enclave pair without fallback.
 *
 * Primary availability is checked first because the primary agent cannot be
 * started without it. Enclave availability is then checked before any
 * repository staging. A blocked enclave capability is distinct from an
 * unavailable binary: it means the runtime exists but cannot enforce AWF's
 * mandatory isolation and API-proxy-only network controls.
 *
 * All nine (primary x boundedAgent) combinations are evaluated independently:
 * a supported primary backend never implies a supported enclave backend, and
 * vice versa.
 */
export function evaluateBoundedAgentRuntimeCombination(
  primaryBackend: BoundedAgentPrimaryBackend,
  boundedAgentBackend: BoundedAgentRuntime,
  capabilities: BoundedAgentRuntimeCapabilities,
): BoundedAgentRuntimeCombination {
  const primaryState = capabilities.primary[primaryBackend];
  if (primaryState !== 'supported') {
    return {
      primaryBackend,
      boundedAgentBackend,
      supported: false,
      capabilityState: primaryState,
      blockedAt: 'primary-preflight',
      category: 'primary-runtime-unavailable',
    };
  }

  const enclaveState = capabilities.enclave[boundedAgentBackend];
  if (enclaveState !== 'supported') {
    return {
      primaryBackend,
      boundedAgentBackend,
      supported: false,
      capabilityState: enclaveState,
      blockedAt: 'enclave-preflight',
      category: enclaveState === 'blocked' ? 'enclave-security-block' : 'enclave-runtime-unavailable',
    };
  }

  return {
    primaryBackend,
    boundedAgentBackend,
    supported: true,
    capabilityState: 'supported',
    category: 'ready',
  };
}

/** Evaluates every (primary x boundedAgent) combination independently. */
export function evaluateBoundedAgentRuntimeMatrix(
  capabilities: BoundedAgentRuntimeCapabilities,
): BoundedAgentRuntimeCombination[] {
  const combinations: BoundedAgentRuntimeCombination[] = [];
  for (const primaryBackend of BOUNDED_AGENT_RUNTIME_BACKENDS) {
    for (const boundedAgentBackend of BOUNDED_AGENT_RUNTIME_BACKENDS) {
      combinations.push(
        evaluateBoundedAgentRuntimeCombination(primaryBackend, boundedAgentBackend, capabilities),
      );
    }
  }
  return combinations;
}

/** Serializes the intentionally narrow, path- and content-free telemetry shape. */
export function serializeBoundedAgentRuntimeTelemetry(
  event: BoundedAgentRuntimeTelemetry,
): string {
  return JSON.stringify({
    primaryBackend: event.primaryBackend,
    boundedAgentBackend: event.boundedAgentBackend,
    lifecycleClass: event.lifecycleClass,
    capabilityState: event.capabilityState,
    category: event.category,
  });
}
