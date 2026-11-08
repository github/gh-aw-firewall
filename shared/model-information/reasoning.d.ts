import { ModelIdentity } from './identity';
import { ModelScope } from './resolution';

export type ReasoningSupport = 'absent' | 'unknown' | 'supported' | 'unsupported';
export type ReasoningMode = 'optional' | 'required' | 'forbidden' | 'unknown';
export interface ReasoningFact {
  identity: ModelIdentity;
  scope: ModelScope;
  active: boolean;
  authority: 'provider' | 'maintained';
  support: Exclude<ReasoningSupport, 'absent'> | 'conditional';
  rawEfforts?: readonly string[];
  mode?: ReasoningMode;
  default?: string;
  provenance?: Record<string, unknown>;
}
export interface ReasoningInput {
  identity: ModelIdentity | null;
  scope: ModelScope;
  facts?: readonly ReasoningFact[];
}
export interface ReasoningReason {
  readonly code: string;
}
export interface ReasoningDecision {
  readonly identity: Readonly<Pick<ModelIdentity, 'key' | 'provider' | 'rawId'>> | null;
  readonly scope: Readonly<ModelScope>;
  readonly support: ReasoningSupport;
  readonly mode: ReasoningMode;
  readonly supportedEfforts: readonly string[];
  readonly selectableEfforts: readonly string[];
  readonly default?: string;
  readonly observations: readonly Readonly<{
    authority: string;
    rawEfforts: readonly string[];
    provenance: Readonly<Record<string, string>>;
    selected: boolean;
  }>[];
  readonly reasons: readonly ReasoningReason[];
}
export function resolveReasoning(input: ReasoningInput): ReasoningDecision;
export function assessReasoningEffort(
  decision: ReasoningDecision, effort: string | undefined,
  options?: { automatic?: boolean; directMaintainedEfforts?: readonly string[] },
): Readonly<{ admitted: boolean; reasons: readonly ReasoningReason[] }>;
