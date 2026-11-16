import { ModelIdentity } from './identity';

export type ReadonlyPricing<T> = T extends object
  ? { readonly [K in keyof T]: ReadonlyPricing<T[K]> } : T;

export interface PricingProvenance {
  authority: 'maintained' | 'operator' | 'configured_catalog' | 'central_feed' |
    'runtime' | 'imported' | 'policy';
  source: string;
  revision?: string;
  catalogId?: string;
  catalogVersion?: string;
  at?: string;
  freshUntil?: string;
  confidence?: 'verified' | 'imported' | 'estimated' | 'policy_fallback';
  freshness?: 'fresh' | 'stale' | 'unknown';
  stale?: boolean;
}

/** Decimal text is lossless; unavailable and absent are not zero. */
export interface PricingComponent {
  price: string | { unavailable: true };
  provenance: PricingProvenance;
}

export interface PricingTariff {
  scope: {
    provider: string;
    channel: 'native-api' | 'copilot-api' | 'copilot-cli' | 'byok' | 'internal';
    deployment?: string;
  };
  currency: 'USD';
  unit: 'USD_PER_1M_TOKENS' | 'USD_PER_TOKEN' | 'USD_PER_REQUEST' |
    'USD_PER_IMAGE' | 'USD_PER_SECOND';
  tier: string;
  promptTokensAbove?: number;
  effectiveFrom?: string;
  effectiveUntil?: string;
  promotion?: string;
  successor?: string;
  components: Partial<Record<
    'input' | 'output' | 'cachedInput' | 'cacheWrite' | 'reasoning' | 'request' | 'image' | 'second',
    PricingComponent
  >>;
  provenance: PricingProvenance;
}

export interface CompatibilityRates {
  input: string;
  cachedInput: string;
  cacheWrite: string | null;
  output: string;
  reasoning?: string;
  longContext?: Omit<CompatibilityRates, 'longContext'> & { threshold: number };
}

export type PricingSnapshot = ReadonlyPricing<{
  kind: 'awf-pricing-consumer';
  schemaVersion: 1;
  schemaHash: string;
  catalogRevision: string;
  revision: string;
  generatedAt: string;
  maintained: {
    identity: Pick<ModelIdentity, 'key' | 'provider' | 'rawId' | 'lookupId'>;
    tariffs: PricingTariff[];
    provenance: PricingProvenance;
  }[];
  compatibility: {
    policy: 'legacy_native_compatibility';
    channel: 'native-api';
    authority: 'policy';
    confidence: 'policy_fallback';
    sourceProvenance: PricingProvenance;
    providers: Partial<Record<string, Partial<Record<string, CompatibilityRates>>>>;
  };
  imported: {
    scope: { provider: 'openrouter'; channel: 'native-api' };
    prices: Partial<Record<string, {
      sourceNamespace: string;
      currency: 'USD';
      unit: 'USD_PER_1M_TOKENS';
      components: {
        input: PricingComponent;
        output: PricingComponent;
        cachedInput?: PricingComponent;
        cacheWrite?: PricingComponent;
      };
      provenance: PricingProvenance;
    }>>;
  }[];
}>;

/** Cached, deeply frozen bundled data. Does not resolve a request's charge. */
export function getPricingSnapshot(): PricingSnapshot;
/** Validate a pinned offline JSON copy and return deeply frozen data; throws on error. */
export function readPricingSnapshot(bytes: string): PricingSnapshot;
/** Integrity check after authenticating the pointer's source commit against reviewed main. */
export function readPublishedPricingSnapshot(
  snapshotBytes: string,
  pointerBytes: string,
  reviewedSourceBytes: string,
): ReadonlyPricing<{
  snapshot: PricingSnapshot;
  pointer: {
    schemaVersion: 1;
    revision: string;
    sourceCommit: string;
    snapshot: string;
    sha256: string;
  };
}>;
export const schemaHash: string;
