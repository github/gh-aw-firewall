import * as fs from 'fs';
import * as path from 'path';

/**
 * Reads the last value of an environment variable key from one or more env
 * files.  Files are processed in order; the last file that defines the key
 * wins (mirrors shell `source` semantics).
 *
 * Non-string, empty, or blank entries in `envFile` are silently skipped.
 * Unreadable files are silently ignored (pre-flight check only).
 *
 * @param envFile - A single file path string, an array of file path strings,
 *   or any other value (treated as empty).
 * @param key - The environment variable name to search for (exact match).
 * @returns The trimmed value if found, or `undefined` if the key was not seen.
 */
export function readEnvVarFromEnvFiles(envFile: unknown, key: string): string | undefined {
  const envFiles = Array.isArray(envFile) ? envFile : envFile ? [envFile] : [];
  let lastSeen: string | undefined;
  const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.*)$`);
  for (const candidate of envFiles) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    try {
      const envFilePath = path.isAbsolute(candidate)
        ? candidate
        : path.resolve(process.cwd(), candidate);
      const envFileContents = fs.readFileSync(envFilePath, 'utf8');
      for (const line of envFileContents.split(/\r?\n/)) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#')) continue;
        const match = trimmedLine.match(pattern);
        if (match) {
          lastSeen = match[1]?.trim() || '';
        }
      }
    } catch {
      // Ignore unreadable env files here; this check is only for a pre-flight warning.
    }
  }
  return lastSeen;
}

/**
 * Parses environment variables from an array of KEY=VALUE strings
 */
export function parseEnvironmentVariables(
  envVars: string[]
): { success: true; env: Record<string, string> } | { success: false; invalidVar: string } {
  const result: Record<string, string> = {};

  for (const envVar of envVars) {
    const match = envVar.match(/^([^=]+)=(.*)$/);
    if (!match) {
      return { success: false, invalidVar: envVar };
    }
    const [, key, value] = match;
    result[key] = value;
  }

  return { success: true, env: result };
}
