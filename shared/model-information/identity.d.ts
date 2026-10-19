export interface ModelIdentity {
  key: string;
  provider: string;
  rawId: string;
  lookupId: string;
  family?: string;
  aliases?: unknown[];
}
export function identity(provider: string, rawId: string): ModelIdentity;
export function normalizeId(id: string, policy?: {
  caseInsensitive?: boolean;
  separators?: boolean;
  stripDate?: boolean;
}): string;
export function matchModel(record: unknown, candidate: string, scope: unknown, policy?: {
  providerPrefix?: boolean;
  caseInsensitive?: boolean;
  separators?: boolean;
  stripDate?: boolean;
}): { key: string; kind: string } | null;
export function matchFamilyRule(rule: unknown, candidate: string, scope: unknown, declaredModels?: unknown[]): {
  kind: string;
  rule: unknown;
} | null;
