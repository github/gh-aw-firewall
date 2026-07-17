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
 * Credential/token stores that live *inside* an otherwise-whitelisted `$HOME`
 * subdir, keyed by the parent subdir's basename. Each value lists the immediate
 * child basenames (directories **or** files) that must never be exposed to the
 * agent.
 *
 * Whitelisted dirs such as `.config`, `.cargo`, `.claude`, `.copilot` and
 * `.gemini` are needed for legitimate tool settings, but each also stashes
 * secrets in a well-known child:
 *
 * - `.config/gh`, `.config/gcloud`, … — per-CLI token stores
 * - `.cargo/credentials`, `.cargo/credentials.toml` — crates.io registry tokens
 * - `.claude/.credentials.json` — Claude Code OAuth tokens
 * - `.copilot/config.json` — Copilot CLI can persist its token here
 * - `.gemini/oauth_creds.json`, `.gemini/google_accounts.json` — Gemini OAuth
 *
 * Compose mode blanks these individual paths with `/dev/null` overlays
 * (`credential-hiding.ts`); sbx cannot mask a nested path once the parent is
 * mounted, so it instead mounts these parents **child-by-child** and skips the
 * basenames listed here. sbx recreates the parent mount point for the surviving
 * children, so the excluded secrets never exist inside the microVM while the
 * benign tool state still works.
 *
 * SECURITY: entries here are credential-centric, so excluding them wholesale
 * does not break general tooling — an agent that needs a service's credentials
 * should receive them through the API proxy or environment, not by reading the
 * host's on-disk auth store.
 */
export const CREDENTIAL_EXCLUSIONS_BY_PARENT: Readonly<Record<string, readonly string[]>> = {
  '.config': [
    'gh', // GitHub CLI: hosts.yml (oauth_token)
    'gcloud', // Google Cloud SDK: credentials.db, access_tokens.db, application_default_credentials.json
    'doctl', // DigitalOcean CLI: config.yaml (access token)
    'heroku', // Heroku CLI: credential store
    'hub', // legacy hub CLI: oauth token
    'rclone', // rclone.conf: remote credentials
    'containers', // containers/auth.json: registry credentials
    'pulumi', // Pulumi: credentials.json (access tokens)
    'op', // 1Password CLI state
    'helm', // repository auth (repositories.yaml can embed credentials)
  ],
  '.cargo': [
    'credentials', // crates.io registry token
    'credentials.toml', // crates.io registry token (newer cargo)
  ],
  '.claude': [
    '.credentials.json', // Claude Code OAuth tokens
  ],
  '.copilot': [
    'config.json', // Copilot CLI may persist its auth token here
  ],
  '.gemini': [
    'oauth_creds.json', // Gemini CLI OAuth access/refresh tokens
    'google_accounts.json', // Gemini CLI account identity
    'access_tokens.json', // Gemini CLI cached access tokens
  ],
};

/**
 * Whitelisted home subdirs that must be mounted one child at a time (filtering
 * {@link CREDENTIAL_EXCLUSIONS_BY_PARENT}) because they nest credential stores
 * that sbx cannot mask once the parent is mounted wholesale.
 */
export const CREDENTIAL_NESTING_SUBDIRS: readonly string[] = Object.keys(CREDENTIAL_EXCLUSIONS_BY_PARENT);
