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

/**
 * Basenames of directories that are known credential/token stores and must
 * never be exposed to the agent, even when they are nested inside an otherwise
 * whitelisted parent such as `~/.config`.
 *
 * Whitelisted dirs like `.config` are needed for legitimate tool settings, but
 * many CLIs stash their auth tokens in a subdirectory of `.config` (rather than
 * a top-level dotdir). Compose mode blanks the individual files via
 * `/dev/null` overlays; sbx cannot, so instead it mounts such parents
 * child-by-child and skips any child whose basename appears here.
 *
 * SECURITY: this is a deny-list of credential-centric tool directories. Each
 * entry's primary purpose is holding secrets, so excluding it wholesale does
 * not break general development tooling (an agent that needs that service's
 * credentials should receive them through the API proxy or environment, not by
 * reading the host's on-disk auth store).
 */
export const CREDENTIAL_SUBDIR_NAMES: readonly string[] = [
  'gh', // GitHub CLI: .config/gh/hosts.yml (oauth_token)
  'gcloud', // Google Cloud SDK: credentials.db, access_tokens.db, application_default_credentials.json
  'doctl', // DigitalOcean CLI: config.yaml (access token)
  'heroku', // Heroku CLI: credential store
  'hub', // legacy hub CLI: oauth token
  'rclone', // rclone.conf: remote credentials
  'containers', // containers/auth.json: registry credentials
  'pulumi', // Pulumi: credentials.json (access tokens)
  'op', // 1Password CLI state
  'helm', // repository auth (repositories.yaml can embed credentials)
];

/**
 * Whitelisted home subdirs whose contents may nest credential stores (see
 * {@link CREDENTIAL_SUBDIR_NAMES}). In sbx these must be mounted one child at a
 * time — filtering out the credential subdirs — because sbx cannot mask an
 * individual path once its parent is mounted wholesale.
 */
export const CREDENTIAL_NESTING_SUBDIRS: readonly string[] = ['.config'];
