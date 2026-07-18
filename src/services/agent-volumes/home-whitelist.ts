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
 * child basenames (directories **or** files) that are credential stores.
 *
 * Whitelisted dirs such as `.config`, `.cargo`, `.claude`, `.copilot` and
 * `.gemini` are needed for legitimate tool settings/state, but each also stashes
 * secrets in a well-known child:
 *
 * - `.config/gh`, `.config/gcloud`, … — per-CLI token stores
 * - `.cargo/credentials`, `.cargo/credentials.toml` — crates.io registry tokens
 * - `.claude/.credentials.json` — Claude Code OAuth tokens
 * - `.copilot/config.json` — Copilot CLI can persist its token here
 * - `.gemini/oauth_creds.json`, `.gemini/google_accounts.json` — Gemini OAuth
 *
 * Compose mode blanks these individual paths with `/dev/null` overlays
 * (`credential-hiding.ts`). sbx mounts are positional virtiofs passthroughs
 * (host path == guest path, directory-granular) and cannot overlay or mask an
 * individual nested path, nor mount a single file. So the sbx backend instead
 * mounts these parents **wholesale** (so their required files still work) but
 * temporarily **moves these credential paths aside on the host before
 * `sbx create` and restores them after the sandbox is torn down** — keeping the
 * secrets out of the VM without dropping the benign tool state the agent needs.
 *
 * SECURITY: entries here are credential-centric. The agent receives whatever
 * credentials it legitimately needs through the API proxy or environment, not by
 * reading the host's on-disk auth store, so hiding these paths is safe.
 */
export const CREDENTIAL_PATHS_BY_PARENT: Readonly<Record<string, readonly string[]>> = {
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
