# Sandbox Mount Policy

AWF exposes a curated slice of the host filesystem to the agent. The **allow
lists** (what gets mounted in) and **deny lists** (what must stay out) used to be
hand-maintained in several TypeScript modules, one per runtime, which let them
drift. They are now centralized in a single declarative config:

- **Config:** [`src/config/sandbox-mount-policy.json`](../src/config/sandbox-mount-policy.json)
- **Loader / typed accessors:** [`src/config/mount-policy.ts`](../src/config/mount-policy.ts)

The Docker/runc compose agent, the gVisor/runsc compose agent, and the sbx
microVM all read from this one source of truth, so they can no longer diverge.
The Cloud Hypervisor microVM does not currently consult this policy: its
production export path (`src/cloud-hypervisor/exports.ts`) only resolves the
workspace, runner tool cache, and `RUNNER_TEMP`/`tmp/gh-aw` directories — it
does not export `$HOME` at all, so the home allow/deny lists have no
production call site for this runtime. `MicrovmWorkspaceImage`
(`src/microvm/workspace.ts`) does read `home.toolSubdirs` and
`credentials.entries`, but it has no production call site today; it is
exercised only by its own tests.

## What the policy contains

| Section | Kind | Applies to | Consumed by |
| --- | --- | --- | --- |
| `system.directories.default` / `.sysroot` | allow (dirs) | compose (Docker + gVisor) | `system-mounts.ts` |
| `system.etc` | allow (files) | compose (Docker + gVisor) | `etc-mounts.ts` |
| `home.toolSubdirs` | allow (dirs) | compose + sbx + microVM workspace tests | `home-strategy.ts`, `sbx-manager.ts`, `microvm/workspace.ts` |
| `home.narrowPaths` | narrow allow override | compose + sbx + microVM workspace tests | `home-strategy.ts`, `sbx-manager.ts`, `microvm/workspace.ts` |
| `home.forbiddenSubdirs` | deny guard | compose + sbx | invariant tests |
| `credentials.entries` | deny (files/dirs) | compose + sbx + microVM workspace tests | `credential-hiding.ts`, `sbx-manager.ts`, `microvm/workspace.ts` |

The `system.*` section is compose-only: sbx gets its system libraries from a
guest image, not from host mounts. Cloud Hypervisor also boots from a guest
image and is not driven by this config at all.

## How each runtime applies the credential deny list

The runtime families that read the policy hide credentials with different
mechanisms, but from the **same list**:

- **Compose (Docker / gVisor)** mounts an empty `$HOME` plus the `toolSubdirs`,
  then blanks each credential **file** with a `/dev/null` bind overlay
  (`credential-hiding.ts`). For a `dir` entry it masks the enumerated `files`;
  for a `file` entry it masks the path itself.
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

**Cloud Hypervisor microVM** does not go through this list today. Its
production export path (`src/cloud-hypervisor/exports.ts`) never exports
`$HOME` — only the workspace, runner tool cache, and `RUNNER_TEMP`/`tmp/gh-aw`
directories are exposed to the guest — so host credential dotfiles are simply
never part of the guest export, independent of `credentials.entries`.
`MicrovmWorkspaceImage` (`src/microvm/workspace.ts`) does read
`home.toolSubdirs` and exclude `credentials.entries` when staging a workspace
image, but it has no production call site; it exists only for its own test
coverage. If it is wired up for Cloud Hypervisor in the future, this doc
should be updated accordingly.

In all cases the agent receives the credentials it legitimately needs through the
API proxy or environment, never from these on-disk stores.

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
