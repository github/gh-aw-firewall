import { readEnvFile } from './github-env';
import { WrapperConfig } from './types';

/**
 * Options for {@link copyEnvEntries}.
 */
export interface CopyEnvEntriesOptions {
  /**
   * Keys to skip.  An entry whose key is in this set is omitted unless it
   * also appears in `allowKeys`.
   */
  excludedKeys?: Set<string>;
  /**
   * Keys that bypass `excludedKeys`.  An entry whose key is in both
   * `excludedKeys` and `allowKeys` is still copied.
   */
  allowKeys?: Set<string>;
  /**
   * When `true`, entries whose key is already present in `target` are not
   * overwritten.  Default: `false`.
   */
  noOverwrite?: boolean;
  /**
   * Additional predicate applied to each key before copying.  Only entries
   * for which the predicate returns `true` are copied.
   */
  keyPredicate?: (key: string) => boolean;
  /**
   * Maximum allowed value size in bytes (UTF-8).  Entries whose value
   * exceeds this limit are skipped; `onSkippedOversized` is called for each
   * skipped entry when provided.
   */
  maxValueSizeBytes?: number;
  /**
   * Called for each entry skipped because it exceeded `maxValueSizeBytes`.
   * @param key       - The environment variable name.
   * @param sizeBytes - The actual UTF-8 byte length of the value.
   */
  onSkippedOversized?: (key: string, sizeBytes: number) => void;
}

/**
 * Copies entries from `source` into `target` according to the given options.
 *
 * Entries with `undefined` values are always skipped, since they cannot be
 * represented in a `Record<string, string>`.
 *
 * This helper centralises the repeated env-filtering loop that would otherwise
 * be duplicated across sbx sanitization, host passthrough, OTEL forwarding,
 * and GitHub Actions env-file / additionalEnv merging.
 */
export function copyEnvEntries(
  source: Record<string, string | undefined>,
  target: Record<string, string | undefined>,
  options: CopyEnvEntriesOptions = {},
): void {
  const { excludedKeys, allowKeys, noOverwrite = false, keyPredicate, maxValueSizeBytes, onSkippedOversized } = options;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (excludedKeys?.has(key) && !(allowKeys?.has(key))) continue;
    if (keyPredicate !== undefined && !keyPredicate(key)) continue;
    if (noOverwrite && Object.prototype.hasOwnProperty.call(target, key)) continue;
    if (maxValueSizeBytes !== undefined) {
      const sizeBytes = Buffer.byteLength(value, 'utf8');
      if (sizeBytes > maxValueSizeBytes) {
        onSkippedOversized?.(key, sizeBytes);
        continue;
      }
    }
    target[key] = value;
  }
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  return normalizedValue || undefined;
}

export function getConfigEnvValue(config: WrapperConfig, key: string): string | undefined {
  const envFileValue = config.envFile
    ? readEnvFile(config.envFile)[key]
    : undefined;
  const value =
    config.additionalEnv?.[key] ??
    envFileValue ??
    (config.envAll ? process.env[key] : undefined);
  return normalizeEnvValue(value);
}

export function getLowerCaseProcessEnvValue(key: string): string | undefined {
  return normalizeEnvValue(process.env[key])?.toLowerCase();
}

/**
 * Returns an object containing only the specified environment variable names
 * that are currently set (non-empty) in `process.env`.
 *
 * This avoids the repetitive `...(process.env.X && { X: process.env.X })` pattern
 * while keeping the conditional-inclusion semantics: variables that are absent or
 * empty are simply omitted from the result.
 *
 * @example
 * // Instead of:
 * // ...(process.env.FOO && { FOO: process.env.FOO }),
 * // ...(process.env.BAR && { BAR: process.env.BAR }),
 * // Write:
 * // ...pickEnvVars('FOO', 'BAR'),
 */
export function pickEnvVars(...names: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of names) {
    const val = process.env[name];
    if (val) result[name] = val;
  }
  return result;
}
