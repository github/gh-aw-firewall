import * as fs from 'fs';

/**
 * Expands `${VAR_NAME}` and `$VAR_NAME` references in a string using the
 * current process environment.  Returns `{ expanded: string, undefinedVar: null }`
 * on success or `{ expanded: null, undefinedVar: string }` when a referenced
 * variable is not set (so callers can produce a precise error message).
 */
function expandEnvVarsInMount(
  value: string
): { expanded: string; undefinedVar: null } | { expanded: null; undefinedVar: string } {
  let undefinedVar: string | null = null;

  // Single pass: match ${VAR} and $VAR in one alternation so that values
  // substituted by an earlier match are never re-scanned.
  const expanded = value.replace(
    /\$\{([^}]+)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g,
    (_match, braced: string | undefined, bare: string | undefined) => {
      if (undefinedVar !== null) return _match; // propagate earlier failure
      const varName = braced ?? bare!;
      const val = process.env[varName];
      if (val === undefined) {
        undefinedVar = varName;
        return _match;
      }
      return val;
    }
  );

  if (undefinedVar !== null) {
    return { expanded: null, undefinedVar };
  }
  return { expanded, undefinedVar: null };
}

/**
 * Parses and validates volume mount specifications
 */
export function parseVolumeMounts(
  mounts: string[]
): { success: true; mounts: string[] } | { success: false; invalidMount: string; reason: string } {
  const result: string[] = [];

  for (const mount of mounts) {
    // Expand environment variable references (e.g. ${TERRAFORM_CLI_PATH})
    // before splitting and validating.  The gh-aw compiler wraps mounts in
    // single quotes which prevents the shell from expanding them, so AWF must
    // handle expansion itself.
    const envExpansion = expandEnvVarsInMount(mount);
    if (envExpansion.undefinedVar !== null) {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Environment variable is not set: ${' + envExpansion.undefinedVar + '}'
      };
    }
    const expandedMount = envExpansion.expanded;

    // Parse mount specification: host_path:container_path[:mode]
    const parts = expandedMount.split(':');

    if (parts.length < 2 || parts.length > 3) {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Mount must be in format host_path:container_path[:mode]'
      };
    }

    const [hostPath, containerPath, mode] = parts;

    // Validate host path is not empty
    if (!hostPath || hostPath.trim() === '') {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Host path cannot be empty'
      };
    }

    // Validate container path is not empty
    if (!containerPath || containerPath.trim() === '') {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Container path cannot be empty'
      };
    }

    // Validate host path is absolute
    if (!hostPath.startsWith('/')) {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Host path must be absolute (start with /)'
      };
    }

    // Validate container path is absolute
    if (!containerPath.startsWith('/')) {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Container path must be absolute (start with /)'
      };
    }

    // Validate mode if specified
    if (mode && mode !== 'ro' && mode !== 'rw') {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Mount mode must be either "ro" or "rw"'
      };
    }

    // Validate host path exists
    try {
      if (!fs.existsSync(hostPath)) {
        return {
          success: false,
          invalidMount: mount,
          reason: `Host path does not exist: ${hostPath}`
        };
      }
    } catch (error) {
      return {
        success: false,
        invalidMount: mount,
        reason: `Failed to check host path: ${error}`
      };
    }

    // Add the expanded mount spec to the result so Docker receives resolved paths
    result.push(expandedMount);
  }

  return { success: true, mounts: result };
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const volumeParsersTestHelpers = { expandEnvVarsInMount };
