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
