import rawPolicy from './sandbox-mount-policy.json';

/**
 * Central, declarative allow/deny mount policy shared by every sandbox runtime
 * (Docker/runc compose, gVisor/runsc compose, and the sbx microVM).
 *
 * The data lives in {@link ./sandbox-mount-policy.json} so the security-relevant
 * allow lists (system dirs, `/etc` files, `$HOME` tool subdirs) and deny lists
 * (forbidden `$HOME` credential dirs, on-disk credential stores) have a single
 * source of truth and cannot drift between runtimes. This module loads,
 * validates, and exposes it through typed accessors.
 *
 * The JSON is imported statically (via `resolveJsonModule`) so it is emitted to
 * `dist/` by `tsc` and inlined by the esbuild release bundle — no runtime file
 * read or extra packaging step is required.
 */

/** How a credential entry's path is masked. */
export type CredentialType = 'file' | 'dir';

/** A single on-disk credential/token store to keep out of the sandbox. */
export interface CredentialEntry {
  /** `$HOME`-relative path to the credential store (file or directory). */
  readonly path: string;
  /** Whether {@link path} is a single file or a directory of secrets. */
  readonly type: CredentialType;
  /**
   * For `dir` entries, the specific secret files inside {@link path} that the
   * compose backend masks with `/dev/null` overlays (compose cannot mask a whole
   * directory). Omitted when the sensitive filenames are unknown/opaque — such
   * dirs are still fully protected by the sbx move-aside mechanism.
   */
  readonly files?: readonly string[];
  /** Human-readable justification (documentation only). */
  readonly reason: string;
}

/** The fully-typed, validated mount policy. */
export interface MountPolicy {
  readonly system: {
    readonly directories: {
      readonly default: readonly string[];
      readonly sysroot: readonly string[];
    };
    readonly etc: readonly string[];
  };
  readonly home: {
    readonly toolSubdirs: readonly string[];
    readonly forbiddenSubdirs: readonly string[];
  };
  readonly credentials: readonly CredentialEntry[];
}

function fail(message: string): never {
  throw new Error(`Invalid sandbox-mount-policy.json: ${message}`);
}

function assertStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    fail(`${label} must be an array of strings`);
  }
  return value as readonly string[];
}

/**
 * Validates an array of simple `$HOME`-relative directory names: each entry
 * must be a non-empty string with no `/` separator, no `..` component, and no
 * leading `/` or `~`. No duplicate entries are allowed.
 */
function assertHomeSubdirArray(value: unknown, label: string): readonly string[] {
  const arr = assertStringArray(value, label);
  const seen = new Set<string>();
  for (const v of arr) {
    if (v.length === 0) fail(`${label} must not contain empty strings`);
    if (v.startsWith('/') || v.startsWith('~'))
      fail(`${label} entries must be relative $HOME paths, not absolute: ${v}`);
    if (v.includes('/')) fail(`${label} entries must be simple directory names (no '/'): ${v}`);
    if (v.includes('..')) fail(`${label} entries must not contain '..': ${v}`);
    if (seen.has(v)) fail(`${label} has duplicate entry: ${v}`);
    seen.add(v);
  }
  return arr;
}

/**
 * Validates an array of absolute host paths: each entry must start with `/`,
 * must not be empty, must not contain `..`, and must be unique.
 */
function assertAbsolutePathArray(value: unknown, label: string): readonly string[] {
  const arr = assertStringArray(value, label);
  const seen = new Set<string>();
  for (const v of arr) {
    if (v.length === 0) fail(`${label} must not contain empty strings`);
    if (!v.startsWith('/')) fail(`${label} entries must be absolute paths (start with '/'): ${v}`);
    if (v.includes('..')) fail(`${label} entries must not contain '..': ${v}`);
    if (seen.has(v)) fail(`${label} has duplicate entry: ${v}`);
    seen.add(v);
  }
  return arr;
}

function parseCredentials(value: unknown): readonly CredentialEntry[] {
  if (typeof value !== 'object' || value === null) {
    fail('credentials must be an object');
  }
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    fail('credentials.entries must be an array');
  }

  const seen = new Set<string>();
  return entries.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      fail(`credentials.entries[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const path = e.path;
    if (typeof path !== 'string' || path.length === 0) {
      fail(`credentials.entries[${i}].path must be a non-empty string`);
    }
    if (path.startsWith('/') || path.startsWith('~') || path.includes('..')) {
      fail(`credentials.entries[${i}].path must be a relative $HOME path without '..': ${path}`);
    }
    if (seen.has(path)) {
      fail(`duplicate credential entry path: ${path}`);
    }
    seen.add(path);

    if (e.type !== 'file' && e.type !== 'dir') {
      fail(`credentials.entries[${i}].type must be 'file' or 'dir'`);
    }
    let files: readonly string[] | undefined;
    if (e.files !== undefined) {
      if (e.type !== 'dir') {
        fail(`credentials.entries[${i}].files is only valid for type 'dir'`);
      }
      const rawFiles = assertStringArray(e.files, `credentials.entries[${i}].files`);
      const seenFiles = new Set<string>();
      for (const f of rawFiles) {
        if (f.length === 0)
          fail(`credentials.entries[${i}].files must not contain empty strings`);
        if (f.includes('/'))
          fail(`credentials.entries[${i}].files entries must be plain filenames (no '/'): ${f}`);
        if (f.includes('..'))
          fail(`credentials.entries[${i}].files entries must not contain '..': ${f}`);
        if (seenFiles.has(f))
          fail(`credentials.entries[${i}].files has duplicate entry: ${f}`);
        seenFiles.add(f);
      }
      files = rawFiles;
    }
    if (typeof e.reason !== 'string' || e.reason.length === 0) {
      fail(`credentials.entries[${i}].reason must be a non-empty string`);
    }
    return { path, type: e.type, files, reason: e.reason };
  });
}

function validate(input: unknown): MountPolicy {
  if (typeof input !== 'object' || input === null) {
    fail('root must be an object');
  }
  const p = input as Record<string, unknown>;

  const system = p.system as Record<string, unknown> | undefined;
  const directories = system?.directories as Record<string, unknown> | undefined;
  if (!system || !directories) {
    fail('system.directories is required');
  }
  const home = p.home as Record<string, unknown> | undefined;
  if (!home) {
    fail('home is required');
  }

  return {
    system: {
      directories: {
        default: assertAbsolutePathArray(directories.default, 'system.directories.default'),
        sysroot: assertAbsolutePathArray(directories.sysroot, 'system.directories.sysroot'),
      },
      etc: assertAbsolutePathArray(system.etc, 'system.etc'),
    },
    home: {
      toolSubdirs: assertHomeSubdirArray(home.toolSubdirs, 'home.toolSubdirs'),
      forbiddenSubdirs: assertHomeSubdirArray(home.forbiddenSubdirs, 'home.forbiddenSubdirs'),
    },
    credentials: parseCredentials(p.credentials),
  };
}

/** The validated, frozen mount policy loaded from the JSON config. */
export const mountPolicy: MountPolicy = validate(rawPolicy);

/**
 * Canonical allow list of `$HOME` subdirectories agents legitimately need
 * (tool caches, language toolchains, agent state). Shared by both backends.
 */
export const HOME_TOOL_SUBDIRS: readonly string[] = mountPolicy.home.toolSubdirs;

/**
 * `$HOME` subdirectories whose primary purpose is storing credentials. These
 * must NEVER appear in {@link HOME_TOOL_SUBDIRS}; the export exists so tests can
 * assert the invariant against a single source of truth.
 */
export const HOME_FORBIDDEN_SUBDIRS: readonly string[] = mountPolicy.home.forbiddenSubdirs;

/** All credential stores the policy hides from the sandbox. */
export const CREDENTIAL_ENTRIES: readonly CredentialEntry[] = mountPolicy.credentials;

/**
 * The `$HOME`-relative credential FILE paths the compose backend masks with
 * `/dev/null` overlays. For `dir` entries this expands the enumerated `files`;
 * for `file` entries it is the path itself. `dir` entries without known files
 * are omitted (compose cannot mask a whole directory — sbx covers those).
 */
export function credentialFilesToHide(): string[] {
  const files: string[] = [];
  for (const entry of mountPolicy.credentials) {
    if (entry.type === 'file') {
      files.push(entry.path);
    } else if (entry.files) {
      for (const f of entry.files) {
        files.push(`${entry.path}/${f}`);
      }
    }
  }
  return files;
}

/**
 * Credential entries the sbx backend should move aside before `sbx create`:
 * those whose top-level parent directory is one of the wholesale-mounted home
 * dirs in {@link mountedTopLevelParents}. Entries under never-mounted dirs (e.g.
 * `.ssh`, `.aws`) are excluded because they never enter the microVM anyway.
 */
export function credentialEntriesUnderMountedParents(
  mountedTopLevelParents: ReadonlySet<string>,
): CredentialEntry[] {
  return mountPolicy.credentials.filter((entry) => {
    const top = entry.path.split('/')[0];
    return mountedTopLevelParents.has(top);
  });
}

/** Read-only host system directories mounted under /host for compose runtimes. */
export function systemDirectories(useSysroot: boolean): readonly string[] {
  return useSysroot
    ? mountPolicy.system.directories.sysroot
    : mountPolicy.system.directories.default;
}

/** Always-mounted read-only host `/etc` paths for compose runtimes. */
export function etcAllowlist(): readonly string[] {
  return mountPolicy.system.etc;
}
