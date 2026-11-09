# Sandbox Mount Policy

For component identities, host permissions, final mounts and backend-specific
exports, see the [Filesystem Sharing Contract](filesystem-sharing-contract.md).

AWF exposes a curated slice of the host filesystem to the agent. The **allow
lists** (what gets mounted in) and **deny lists** (what must stay out) used to be
hand-maintained in several TypeScript modules, one per runtime, which let them
drift. They are now centralized in a single declarative config:

- **Config:** [`src/config/sandbox-mount-policy.json`](../src/config/sandbox-mount-policy.json)
- **Loader / typed accessors:** [`src/config/mount-policy.ts`](../src/config/mount-policy.ts)

The Docker/runc compose agent, the gVisor/runsc compose agent, the sbx
microVM, and the NVX microVM (`--container-runtime nvx`) all read from this one
source of truth, so they can no longer diverge.
The Cloud Hypervisor microVM does not currently consult this policy: its
production export path (`src/cloud-hypervisor/exports.ts`) only resolves the
workspace (`rw`), the runner tool cache (`ro`, only under the non-default
`workspace-and-tool-cache` policy, using `RUNNER_TOOL_CACHE` or its fallback
`AGENT_TOOLSDIRECTORY`), `$RUNNER_TEMP/gh-aw` (`ro`, when `RUNNER_TEMP` is set
and the directory exists), and `/tmp/gh-aw` (`rw`, when the directory exists) — it does not export `$HOME` at all, so the home allow/deny lists have no
production call site for this runtime. `MicrovmWorkspaceImage`
(`src/microvm/workspace.ts`) does read `home.toolSubdirs` and
`credentials.entries`, but it has no production call site today; it is
exercised only by its own tests.

Mount visibility does not grant engine file scope. A mounted input directory
still requires host read/traverse permissions and any engine-specific grant,
such as Copilot's `--add-dir`. See
[`--mount` does not grant engine file scope](environment.md#--mount-does-not-grant-engine-file-scope)
for an example and fail-closed input verification guidance.

## What the policy contains

| Section | Kind | Applies to | Consumed by |
| --- | --- | --- | --- |
| `system.directories.default` / `.sysroot` | allow (dirs) | compose (Docker + gVisor) | `system-mounts.ts` |
| `system.etc` | allow (files) | compose (Docker + gVisor) | `etc-mounts.ts` |
| `home.toolSubdirs` | allow (dirs) | compose + sbx + NVX; microVM workspace tests | `home-strategy.ts`, `sbx-manager.ts`, `nvx/guest-config-layer.ts`, `microvm/workspace.ts` |
| `home.narrowPaths` | narrow allow override | compose + sbx + NVX; microVM workspace tests | `home-strategy.ts`, `sbx-manager.ts`, `nvx/guest-config-layer.ts`, `microvm/workspace.ts` |
| `home.forbiddenSubdirs` | deny guard | compose + sbx + NVX | invariant tests, `nvx/guest-config-layer.ts`, `nvx/filesystem-builder.ts`, `nvx/live-mount-policy.ts` |
| `credentials.entries` | deny (files/dirs) | compose + sbx + NVX; microVM workspace tests | `credential-hiding.ts`, `sbx-manager.ts`, `nvx/guest-config-layer.ts`, `nvx/filesystem-builder.ts`, `nvx/live-mount-policy.ts`, `microvm/workspace.ts` |

In compose, `~/.gemini` is mounted only when a Gemini or Google API key is
configured; the other `toolSubdirs` are always bound (with `.local` replaced by
its `narrowPaths` descendants), and `~/.copilot` is bound from the host only
when it exists and is readable and writable. Compose also binds the runner tool
cache read-only at its host path under `/host` when it resolves to a directory
(`config.runnerToolCachePath`, `RUNNER_TOOL_CACHE`, or `~/work/_tool`;
[`runner-tool-cache.ts`](../src/runner-tool-cache.ts)). Independently,
compose always binds the supplied session-state and agent-log paths beneath
`~/.copilot/session-state` and `~/.copilot/logs`, even when the host directory
is absent or inaccessible
([`home-strategy.ts`](../src/services/agent-volumes/home-strategy.ts),
[`workspace-mounts.ts`](../src/services/agent-volumes/workspace-mounts.ts)).

The `system.*` section is compose-only: sbx and NVX get their system libraries
from a guest image, not from host mounts. Cloud Hypervisor also boots from a guest
image and is not driven by this config at all.

## Host work-directory permissions

The host work directory (`--work-dir`) holds generated configuration, including
`docker-compose.yml`, which can contain credentials. When the initial
runner/daemon filesystem probe creates a missing work directory, it requests
mode `0700` for that directory and any missing parents. Under `umask 022` or
`000`, these new directories remain `0700`, including when Docker is
unreachable.

The probe does not chmod existing directories. Subsequent configuration
validation still rejects work directories with group or other access,
untrusted ownership, or a symlink at the work-directory path. Reused work
directories must already satisfy those checks.

These host permissions do not change the sandbox mount allow/deny lists or
establish isolation from a same-UID agent. Protected command-output capture
separately checks its storage against effective agent-visible mounts.

## How each runtime applies the credential deny list

The runtime families that read the policy hide credentials with different
mechanisms, but from the **same list**:

- **Compose (Docker / gVisor)** mounts an empty `$HOME` plus the `toolSubdirs`,
  then blanks each credential **file** with a `/dev/null` bind overlay
  (`credential-hiding.ts`). For a `dir` entry it masks the enumerated `files`;
  for a `file` entry it masks the path itself. A `dir` entry with no `files`
  list (currently `.config/heroku`, `.config/hub`, `.config/op`, and
  `.local/state/sandboxes`) is **not** masked in compose, because compose cannot
  overlay a whole directory
  ([`credentialFilesToHide()`](../src/config/mount-policy.ts)). Such files stay
  readable when their parent (for example `~/.config`) is mounted. Sbx moves
  those `.config` directories aside when their parent is mounted;
  `.local/state/sandboxes` is instead protected because `.local/state` is never
  mounted.
- **Compose (Docker / gVisor)** and the **sbx microVM** replace parents listed in
  `narrowPaths` with their explicit descendants. In particular, they mount
  rootless tool directories under `~/.local` but never `~/.local` or
  `~/.local/state` wholesale, keeping sandboxd's private CA and backing store
  outside the guest. Sbx positional mounts are directory-granular and can't overlay
  `/dev/null` onto a nested path. Before `sbx create` it **moves** each credential
  `path` aside on the host (to a backup dir at the home root, never itself
  mounted) and **restores** it after teardown. It only touches entries whose
  top-level parent is actually mounted — paths under never-mounted dirs like
  `.ssh` or `.aws` are skipped because they never enter the VM.

- **NVX microVM** copies the `HOME_TOOL_PATHS` directories that exist under the
  host `$HOME` into the guest home seed, skipping every `credentials.entries`
  and `home.forbiddenSubdirs` path
  ([`guest-config-layer.ts`](../src/nvx/guest-config-layer.ts)); its builder and
  live-share policy apply the same exclusions
  ([`filesystem-builder.ts`](../src/nvx/filesystem-builder.ts),
  [`live-mount-policy.ts`](../src/nvx/live-mount-policy.ts)). Credentials are
  excluded from the copy rather than overlaid.

**Cloud Hypervisor microVM** does not go through this list today. Its
production export path (`src/cloud-hypervisor/exports.ts`) never exports
`$HOME` — only the workspace, the runner tool cache (non-default
`workspace-and-tool-cache` policy only), `$RUNNER_TEMP/gh-aw`, and `/tmp/gh-aw`
are exposed to the guest — so host credential dotfiles are simply
never part of the guest export, independent of `credentials.entries`.
`MicrovmWorkspaceImage` (`src/microvm/workspace.ts`) does read
`home.toolSubdirs` and exclude `credentials.entries` when staging a workspace
image, but it has no production call site; it exists only for its own test
coverage. If it is wired up for Cloud Hypervisor in the future, this doc
should be updated accordingly.

In all cases the agent receives the credentials it legitimately needs through the
API proxy or environment, never from these on-disk stores.

GitLab CLI's `~/.config/glab-cli/config.yml` is included in the credential deny
list. AWF also hides GitLab config files at host `GLAB_CONFIG_DIR`,
`XDG_CONFIG_HOME` and `XDG_CONFIG_DIRS` locations, and macOS configuration
locations, **when an existing mount exposes them**. Compose maps these files
through bind sources, including custom target aliases; sbx moves exposed files
aside and restores them after teardown. This does not add mounts for otherwise
inaccessible credential directories. Other GitLab config files, such as
`aliases.yml`, remain available in Compose.

## Adding an entry

1. Edit `sandbox-mount-policy.json`.
2. For a credential store, add a `credentials.entries[]` object:
   - `path` — `$HOME`-relative path (no leading `/`, `~`, or `..`).
   - `type` — `"file"` or `"dir"`.
   - `files` — (dir only) specific secret filenames so compose can mask them.
   - `reason` — short justification.
3. Run `npm run build && npm test`. The loader validates the JSON at startup and
   the policy tests assert the invariants (relative paths, unique paths, no
   forbidden dir in the allow list).
