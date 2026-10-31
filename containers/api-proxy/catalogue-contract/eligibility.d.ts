import { ModelIdentity } from './identity';
import { ModelScope } from './resolution';

export type VersionScheme = 'semver' | 'numeric-components';
export interface EligibilityEvidence {
  scope?: ModelScope;
  reason?: string;
  provenance?: Record<string, unknown>;
}
export interface HarnessRequirement extends EligibilityEvidence {
  scope: ModelScope;
  name: string;
  scheme: VersionScheme;
  minimum: string;
  reason: string;
  provenance: Record<string, unknown>;
  /** Explicit comparator conjunctions (>=1.0.0 <2.0.0) and || disjunctions. */
  excludedRanges?: string[];
}
export interface HarnessObservation {
  scope: ModelScope;
  name: string;
  scheme?: VersionScheme;
  version: string;
  /** Exact execution boundary identifier; host is not container/chroot/guest. */
  environment: string;
  verified: boolean;
  actual: boolean;
}
export interface EligibilityInput {
  identity: ModelIdentity | null;
  scope: ModelScope;
  discovery?: EligibilityEvidence & {
    status: 'available' | 'unavailable' | 'unknown';
    authoritative?: boolean;
  };
  lifecycle?: EligibilityEvidence & {
    status: 'active' | 'preview' | 'restricted' | 'retired' | 'removed';
  };
  policy?: EligibilityEvidence & { status: 'allow' | 'deny' | 'unknown' };
  harnesses?: HarnessRequirement[];
  observations?: HarnessObservation[];
  executionEnvironment?: string;
  /** Exact trusted harness selection; omission conservatively checks all scoped requirements. */
  selectedHarness?: string;
}
export interface EligibilityReason {
  readonly code: string;
  readonly scope: Readonly<ModelScope>;
  readonly name?: string;
  readonly required?: Readonly<{
    scheme: VersionScheme;
    minimum: string;
    excludedRanges: readonly string[];
  }>;
  readonly detected?: string;
  readonly environment?: string;
  readonly reason?: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
}
export interface EligibilityResult {
  readonly identity: Readonly<ModelIdentity> | null;
  readonly scope: Readonly<ModelScope>;
  readonly status: 'eligible' | 'incompatible' | 'unknown';
  readonly admitted: boolean;
  readonly reasons: readonly EligibilityReason[];
  readonly harness: 'unconstrained' | 'compatible' | 'incompatible' | 'unverified';
  readonly selectedHarness?: string;
}
export interface EligibilitySnapshot {
  readonly revision: number;
  evaluate(input: EligibilityInput): EligibilityResult;
}
export interface EligibilityState {
  models?: { identity: ModelIdentity; harnesses?: HarnessRequirement[] }[];
  observations?: HarnessObservation[];
  executionEnvironment?: string;
  selectedHarness?: string;
}
export function evaluateEligibility(input: EligibilityInput): EligibilityResult;
export function createEligibilityStore(initial?: EligibilityState): {
  pin(): EligibilitySnapshot;
  replace(next: EligibilityState): void;
};
