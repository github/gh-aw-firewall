import { logger } from './logger';

/**
 * Validates a port specification string.
 * Accepts a single port (1-65535) or a port range ("N-M" where both are valid ports and N <= M).
 */
export function isValidPortSpec(spec: string): boolean {
  const rangeMatch = spec.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (String(start) !== rangeMatch[1] || String(end) !== rangeMatch[2]) return false;
    return start >= 1 && start <= 65535 && end >= 1 && end <= 65535 && start <= end;
  }
  const port = parseInt(spec, 10);
  return !isNaN(port) && String(port) === spec && port >= 1 && port <= 65535;
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const iptablesRulesTestHelpers = { isValidPortSpec };

export function getErrorStringProperty(error: unknown, property: string): string {
  return typeof error === 'object'
    && error !== null
    && property in error
    && typeof (error as Record<string, unknown>)[property] === 'string'
    ? (error as Record<string, unknown>)[property] as string
    : '';
}

export function isMissingIptablesError(error: unknown): boolean {
  const code = getErrorStringProperty(error, 'code');
  const message = error instanceof Error ? error.message : '';
  return code === 'ENOENT' || message.includes('ENOENT') || message.includes('not found');
}

export function parseValidPortSpecs(input: string | undefined, label: string): string[] {
  if (!input) {
    return [];
  }

  const validSpecs: string[] = [];
  for (const entry of input.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (!isValidPortSpec(trimmed)) {
      logger.warn(`Skipping invalid ${label}: ${trimmed}`);
      continue;
    }
    validSpecs.push(trimmed);
  }

  return validSpecs;
}
