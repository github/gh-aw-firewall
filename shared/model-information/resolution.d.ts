import { ModelIdentity } from './identity';

export interface ModelScope {
  provider: string;
  channel: string;
  deployment?: string;
}

export interface ResolutionPolicy {
  /** Strip only the current provider's prefix (default true). */
  providerPrefix?: boolean;
  caseInsensitive?: boolean;
  separators?: boolean;
  stripDate?: boolean;
}

export interface CanonicalView {
  models: { identity: ModelIdentity }[];
  rules?: unknown[];
}

export interface IdentityResolution {
  requestedModel: string;
  identity: ModelIdentity | null;
  /** Canonical raw ID, or the unchanged unmatched raw ID, without parameters. */
  wireId: string;
  matchKind: 'exact' | 'alias' | 'family' | 'unmatched';
  parameterSuffix: string;
  /** wireId with the original parameter suffix reattached. */
  model: string;
  family?: string;
}

export function resolveIdentity(
  requestedModel: string,
  scope: ModelScope,
  view: CanonicalView,
  policy?: ResolutionPolicy,
): IdentityResolution;
export function stripRedundantProviderPrefix(model: string, provider: string): string;
