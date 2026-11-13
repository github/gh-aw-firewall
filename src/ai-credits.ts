export type AiCreditSuffixResult =
  | { recognized: false }
  | { recognized: true; value: number }
  | { recognized: true; error: string };

export function parseAiCreditSuffix(value: unknown): AiCreditSuffixResult {
  if (typeof value !== 'string') return { recognized: false };

  const trimmed = value.trim();
  if (!/[km]$/i.test(trimmed)) return { recognized: false };

  const match = /^([0-9]+)([km])$/i.exec(trimmed);
  if (!match) {
    return { recognized: true, error: 'must be a positive whole number followed by K or M' };
  }

  const base = Number(match[1]);
  const multiplier = match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
  const normalized = base * multiplier;
  if (base <= 0 || !Number.isSafeInteger(base) || !Number.isSafeInteger(normalized)) {
    return { recognized: true, error: 'must resolve to a positive safe integer' };
  }

  return { recognized: true, value: normalized };
}
