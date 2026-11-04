import { ModelIdentity } from './identity';
import { ModelScope } from './resolution';

export type PricingSource = 'operator' | 'shared_catalog' | 'provider' | 'central_feed' |
  'curated' | 'models.dev' | 'dynamic_selector_fallback' | 'configured_default' | 'builtin_fallback';
export interface TokenPrices {
  input?: number;
  cachedInput?: number;
  cacheWrite?: number | null;
  output?: number;
  reasoning?: number;
  threshold?: number;
}
export interface PricingMetadata {
  observedAt?: string;
  apiVersion?: string;
  pricingCatalogId?: string;
  pricingCatalogVersion?: string;
  accountingPolicy?: string;
  dynamicSelector?: string;
  usedFallbackPricing?: boolean;
}
export interface PricingFact {
  source: PricingSource;
  default: Readonly<TokenPrices>;
  longContext?: Readonly<TokenPrices>;
  threshold?: number;
  tier?: string;
  metadata?: Readonly<PricingMetadata>;
  defaultMetadata?: Readonly<PricingMetadata>;
  longMetadata?: Readonly<PricingMetadata>;
}
export interface PricingProvenance {
  at: string;
  stale?: boolean;
  freshness?: string;
  freshUntil?: string;
}
export interface CentralPricingFact {
  source: string;
  revision: string;
  record: {
    identity: ModelIdentity;
    provenance: PricingProvenance;
    tariffs?: readonly {
      scope: ModelScope;
      unit: 'USD_PER_TOKEN' | 'USD_PER_1M_TOKENS';
      tier: string;
      promptTokensAbove?: number;
      effectiveFrom?: string;
      effectiveUntil?: string;
      provenance: PricingProvenance;
      components: Readonly<Record<string, {
        price: string | object;
        provenance: PricingProvenance;
      }>>;
    }[];
  } | null;
}
export interface PricingCapture {
  readonly identity: ModelIdentity | null;
  readonly scope: ModelScope | null;
  readonly inputTokens: number;
  /** null means the authoritative loader capture was absent/not reached. */
  readonly time: number | null;
  readonly maxAge: number | null;
  /** Omitted = not reached. null = reached but absent/inapplicable. */
  readonly sources: Readonly<Partial<Record<
    'operator' | 'configured' | 'runtime' | 'curated' | 'imported' | 'selector' |
    'configuredDefault' | 'sentinel', PricingFact | null
  >> & { central?: CentralPricingFact | null }>;
}
export interface PricingResult extends PricingMetadata {
  pricing: TokenPrices;
  source: PricingSource;
  tier: string;
}
export interface PricingCandidate {
  identity: ModelIdentity | null;
  scope: ModelScope | null;
  capturedAt: number | null;
  result: PricingResult | null;
  componentSources: Record<string, {
    source: PricingSource;
    tier: string;
    observedAt?: string;
    apiVersion?: string;
    pricingCatalogId?: string;
    pricingCatalogVersion?: string;
  }>;
}
export function resolvePricingCandidate(capture: PricingCapture): PricingCandidate;
/** Fixed sanitized difference paths, not source values. */
export function comparePricingResults(legacy: PricingResult | null, candidate: PricingResult | null): string[];
