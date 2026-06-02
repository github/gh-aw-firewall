import * as fs from 'fs';
import { logger } from './logger';

/**
 * Extracts the hostname from GITHUB_SERVER_URL to set GH_HOST for gh CLI.
 * Returns the hostname if GITHUB_SERVER_URL points to a non-github.com instance,
 * or null if it points to github.com (no GH_HOST needed).
 * @param serverUrl - The GITHUB_SERVER_URL environment variable value
 * @returns The hostname to use for GH_HOST, or null if not needed
 * @internal Exported for testing
 */
export function extractGhHostFromServerUrl(serverUrl: string | undefined): string | null {
  if (!serverUrl) {
    return null;
  }

  try {
    const url = new URL(serverUrl);
    const hostname = url.hostname;

    // If pointing to public GitHub, no GH_HOST needed
    if (hostname === 'github.com') {
      return null;
    }

    // For GHES/GHEC instances, return the hostname
    return hostname;
  } catch {
    // Invalid URL, return null
    return null;
  }
}

/**
 * Reads path entries from the $GITHUB_PATH file used by GitHub Actions.
 *
 * When setup-* actions (e.g., setup-ruby, setup-dart, setup-python) run before AWF,
 * they add tool paths to the $GITHUB_PATH file. The Actions runner prepends these
 * to $PATH for subsequent steps, but if `sudo` resets PATH (depending on sudoers
 * configuration), those entries may be lost by the time AWF reads process.env.PATH.
 *
 * This function reads the $GITHUB_PATH file directly and returns any path entries
 * found, so they can be merged into AWF_HOST_PATH regardless of sudo behavior.
 *
 * @returns Array of path entries from the $GITHUB_PATH file, or empty array if unavailable
 * @internal Exported for testing
 */
export function readGitHubPathEntries(): string[] {
  const githubPathFile = process.env.GITHUB_PATH;
  if (!githubPathFile) {
    logger.debug('GITHUB_PATH env var is not set; skipping $GITHUB_PATH file merge (tools installed by setup-* actions may be missing from PATH if sudo reset it)');
    return [];
  }

  try {
    const content = fs.readFileSync(githubPathFile, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch {
    // File doesn't exist or isn't readable — expected outside GitHub Actions
    logger.debug(`GITHUB_PATH file at '${githubPathFile}' could not be read; skipping file merge`);
    return [];
  }
}

/**
 * Reads key-value environment entries from the $GITHUB_ENV file.
 *
 * The Actions runner writes to this file when steps call `core.exportVariable()`.
 * When AWF runs via `sudo`, non-standard env vars may be stripped. This function
 * reads the file directly to recover them.
 *
 * Supports both formats used by the Actions runner:
 * - Simple: `KEY=VALUE` (value may contain `=`)
 * - Heredoc: `KEY<<DELIMITER\nVALUE_LINES\nDELIMITER`
 *
 * @returns Map of environment variable names to values
 * @internal Exported for testing
 */
export function readGitHubEnvEntries(): Record<string, string> {
  const githubEnvFile = process.env.GITHUB_ENV;
  if (!githubEnvFile) {
    logger.debug('GITHUB_ENV env var is not set; skipping $GITHUB_ENV file read');
    return {};
  }

  try {
    const content = fs.readFileSync(githubEnvFile, 'utf-8');
    return parseGitHubEnvFile(content);
  } catch {
    logger.debug(`GITHUB_ENV file at '${githubEnvFile}' could not be read; skipping`);
    return {};
  }
}

/**
 * Parses the content of a $GITHUB_ENV file into key-value pairs.
 */
function parseGitHubEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Normalize CRLF to LF
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Check for heredoc format: KEY<<DELIMITER
    const heredocMatch = line.match(/^([^=]+)<<(.+)$/);
    if (heredocMatch) {
      const key = heredocMatch[1];
      const delimiter = heredocMatch[2];
      const valueLines: string[] = [];
      i++;

      // Collect lines until we find the delimiter
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i]);
        i++;
      }
      // Skip the closing delimiter line
      if (i < lines.length) i++;

      result[key] = valueLines.join('\n');
      continue;
    }

    // Simple format: KEY=VALUE (split on first = only)
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      const key = line.slice(0, eqIdx);
      const value = line.slice(eqIdx + 1);
      result[key] = value;
    }

    i++;
  }

  return result;
}

/**
 * Toolchain environment variables that should be recovered from $GITHUB_ENV
 * when sudo strips them from process.env. These are set by setup-* actions
 * (setup-go, setup-java, setup-dotnet, etc.) and are needed for correct
 * tool resolution inside the agent container.
 */
export const TOOLCHAIN_ENV_VARS = [
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'JAVA_HOME',
  'DOTNET_ROOT',
  'BUN_INSTALL',
] as const;

/**
 * Merges path entries from the $GITHUB_PATH file into a PATH string.
 * Entries from $GITHUB_PATH are prepended (they have higher priority, matching
 * how the Actions runner processes them). Duplicate entries are removed.
 *
 * @param currentPath - The current PATH string (e.g., from process.env.PATH)
 * @param githubPathEntries - Path entries read from the $GITHUB_PATH file
 * @returns Merged PATH string with $GITHUB_PATH entries prepended
 * @internal Exported for testing
 */
export function mergeGitHubPathEntries(currentPath: string, githubPathEntries: string[]): string {
  if (githubPathEntries.length === 0) {
    return currentPath;
  }

  const currentEntries = currentPath ? currentPath.split(':') : [];
  const currentSet = new Set(currentEntries);

  // Only add entries that aren't already in the current PATH
  const newEntries = githubPathEntries.filter(entry => !currentSet.has(entry));

  if (newEntries.length === 0) {
    return currentPath;
  }

  // Prepend new entries (setup-* actions expect their paths to have priority)
  return [...newEntries, ...currentEntries].join(':');
}

/**
 * Reads environment variables from a KEY=VALUE file (like Docker's --env-file).
 *
 * Rules:
 * - Lines starting with '#' are comments and are ignored.
 * - Empty/whitespace-only lines are ignored.
 * - Each non-comment line must match the pattern KEY=VALUE where KEY starts with a
 *   letter or underscore and contains only letters, digits, or underscores.
 * - Values may be empty (KEY=).
 * - Values are taken literally; no quote-stripping or variable expansion is done.
 *
 * @param filePath - Absolute or relative path to the env file
 * @returns An object mapping variable names to their values
 * @throws {Error} If the file cannot be read
 */
export function readEnvFile(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const result: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    // Skip comments and blank lines
    if (line === '' || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      result[match[1]] = match[2];
    }
  }
  return result;
}
