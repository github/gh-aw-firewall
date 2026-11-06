import { ModelIdentity } from './identity';
import { ModelScope } from './resolution';

export type PricingSource = 'operator' | 'shared_catalog' | 'provider' | 'central_feed' |
  'curated' | 'models.dev' | 'dynamic_selector_fallback' | 'configured_default' | 'builtin_fallback' |
  'median_estimate';
export interface PricingEstimate {
  basis: 'family' | 'backend';
  family?: string;
  donorCount: number;
  componentDonors: Record<string, number>;
  sources: PricingSource[];
  tariffFingerprint?: string;
}
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
  estimate?: PricingEstimate;
  accountingPolicy?: string;
  dynamicSelector?: string;
  usedFallbackPricing?: boolean;
}
export interface PricingFact {
  source: PricingSource;
  /** Decimal strings retain source precision; Number inputs retain String(value) only. */
  default: Readonly<SourceTokenPrices>;
  longContext?: Readonly<SourceTokenPrices>;
  threshold?: number;
  tier?: string;
  metadata?: Readonly<PricingMetadata>;
  defaultMetadata?: Readonly<PricingMetadata>;
  longMetadata?: Readonly<PricingMetadata>;
}
export type SourceTokenPrices = {
  [P in keyof TokenPrices]: P extends 'threshold' ? TokenPrices[P] : TokenPrices[P] | string;
};
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
  /** Omitted is allowed only for unreachable sources. null = absent/inapplicable. */
  readonly sources: Readonly<Partial<Record<
    'operator' | 'configured' | 'runtime' | 'curated' | 'imported' | 'selector' |
    'configuredDefault' | 'median' | 'sentinel', PricingFact | null | (() => PricingFact | null)
  >> & { central?: CentralPricingFact | null | (() => CentralPricingFact | null) }>;
}
export interface PricingResult extends PricingMetadata {
  pricing: TokenPrices;
  source: PricingSource;
  tier: string;
}
export interface PricingResolution {
  identity: ModelIdentity | null;
  scope: ModelScope | null;
  capturedAt: number | null;
  result: PricingResult | null;
  /** Emit the existing missing-price warning outside the side-effect-free resolver. */
  missingModelPricing: boolean;
  componentSources: Record<string, {
    source: PricingSource;
    tier: string;
    observedAt?: string;
    apiVersion?: string;
    pricingCatalogId?: string;
    pricingCatalogVersion?: string;
    estimate?: PricingEstimate;
  }>;
}
export function resolvePricing(capture: PricingCapture): PricingResolution;
export function selectPricingFact(fact: PricingFact | null, tokens: number, preferredTier?: string): PricingResult | null;
export function resolveCentralTariff(
  capture: Pick<PricingCapture, 'scope' | 'inputTokens' | 'time' | 'maxAge'>,
  fact: CentralPricingFact | null,
):
  { result: PricingResult; componentSources: PricingResolution['componentSources'] } | null;
export function fresh(provenance: PricingProvenance, time: number, maxAge: number): boolean;
export function medianPricingFact(
  donors: readonly {
    result: PricingResult | null;
    family?: string;
    componentSources?: PricingResolution['componentSources'];
  }[], family?: string,
): PricingFact | null;
