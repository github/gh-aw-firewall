/**
 * @deprecated Thin compatibility shim. The canonical allow/deny mount policy now
 * lives in the declarative {@link ../../config/sandbox-mount-policy.json} and is
 * loaded by {@link ../../config/mount-policy}. This module re-exports the home
 * allow list so existing importers keep working; prefer importing from
 * `config/mount-policy` directly in new code.
 *
 * `HOME_TOOL_SUBDIRS` is the canonical whitelist of `$HOME` subdirectories that
 * agents legitimately need (tool caches, language toolchains, agent state),
 * shared by both sandbox backends:
 *
 * - **Compose / chroot mode** (`home-strategy.ts`) mounts an empty home volume
 *   and bind-mounts these subdirs on top, then blanks known credential files
 *   with `/dev/null` overlays (`credential-hiding.ts`, driven by the policy).
 * - **sbx microVM mode** (`sbx-manager.ts`) mounts these subdirs wholesale
 *   instead of the whole `$HOME`, then moves policy credential paths aside
 *   before `sbx create`.
 *
 * SECURITY: never add a directory whose primary purpose is storing credentials
 * — those belong in the policy's `home.forbiddenSubdirs` deny guard.
 */
export { HOME_TOOL_SUBDIRS, HOME_FORBIDDEN_SUBDIRS } from '../../config/mount-policy';
