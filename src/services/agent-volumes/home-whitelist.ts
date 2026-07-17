/**
 * Canonical whitelist of `$HOME` subdirectories that agents legitimately need
 * (tool caches, language toolchains, agent state).
 *
 * This list is the single source of truth shared by **both** sandbox backends
 * so their home-directory exposure stays in sync:
 *
 * - **Compose / chroot mode** (`home-strategy.ts`) mounts an empty home volume
 *   and then bind-mounts these subdirs on top, and additionally blanks known
 *   credential files with `/dev/null` overlays (`credential-hiding.ts`).
 * - **sbx microVM mode** (`sbx-manager.ts`) mounts these subdirs individually
 *   instead of the whole `$HOME`. sbx uses positional (host path == guest path)
 *   mounts and cannot express per-file `/dev/null` overlays, so directory
 *   curation is its only mechanism — which makes this whitelist the primary
 *   protection there.
 *
 * SECURITY: never add a directory whose primary purpose is storing credentials
 * (for example `.aws`, `.ssh`, `.docker`, `.kube`, `.azure`, `.gnupg`). Any such
 * store must stay OUT of the sandbox. Directories listed here can still contain
 * stray secret files; compose mode masks the known ones via
 * `buildCredentialHidingOverlays()`, but sbx cannot, so keep this list to
 * genuinely non-credential tooling paths.
 *
 * `.gemini` is intentionally NOT included: compose mode mounts it only when a
 * Gemini/Google API key is configured, so each caller handles it separately.
 */
export const HOME_TOOL_SUBDIRS = [
  '.cache',
  '.config',
  '.local',
  '.anthropic',
  '.claude',
  '.cargo',
  '.rustup',
  '.npm',
  '.nvm',
] as const;
