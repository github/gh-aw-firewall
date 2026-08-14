# Sandbox Mount Policy

AWF exposes a curated slice of the host filesystem to the agent. The **allow
lists** (what gets mounted in) and **deny lists** (what must stay out) used to be
hand-maintained in several TypeScript modules, one per runtime, which let them
drift. They are now centralized in a single declarative config:

- **Config:** [`src/config/sandbox-mount-policy.json`](../src/config/sandbox-mount-policy.json)
- **Loader / typed accessors:** [`src/config/mount-policy.ts`](../src/config/mount-policy.ts)

Every runtime reads from this one source of truth, so the Docker/runc compose
agent, the gVisor/runsc compose agent, the sbx microVM, and the Cloud Hypervisor
microVM can no longer diverge.

## What the policy contains

| Section | Kind | Applies to | Consumed by |
| --- | --- | --- | --- |
| `system.directories.default` / `.sysroot` | allow (dirs) | compose (Docker + gVisor) | `system-mounts.ts` |
| `system.etc` | allow (files) | compose (Docker + gVisor) | `etc-mounts.ts` |
| `home.toolSubdirs` | allow (dirs) | all runtimes | `home-strategy.ts`, `sbx-manager.ts`, `microvm/workspace.ts` |
| `home.forbiddenSubdirs` | deny guard | all runtimes | invariant tests |
| `credentials.entries` | deny (files/dirs) | all runtimes | `credential-hiding.ts`, `sbx-manager.ts`, `microvm/workspace.ts` |

The `system.*` section is compose-only: sbx and Cloud Hypervisor get their
system libraries from guest images, not from host mounts.

## How each runtime applies the credential deny list

The runtime families hide credentials with different mechanisms, but from the
**same list**:

- **Compose (Docker / gVisor)** mounts an empty `$HOME` plus the `toolSubdirs`,
  then blanks each credential **file** with a `/dev/null` bind overlay
  (`credential-hiding.ts`). For a `dir` entry it masks the enumerated `files`;
  for a `file` entry it masks the path itself. Directory entries with no known
  filenames cannot be masked this way; the microVM paths exclude or scrub the
  directory before exposing allowed home state.
- **sbx microVM** mounts the `toolSubdirs` (plus `.copilot`/`.gemini`) wholesale,
  because sbx positional mounts are directory-granular and can't overlay
  `/dev/null` onto a nested path. Before `sbx create` it **moves** each credential
  `path` aside on the host (to a backup dir at the home root, never itself
  mounted) and **restores** it after teardown. It only touches entries whose
  top-level parent is actually mounted — paths under never-mounted dirs like
  `.ssh` or `.aws` are skipped because they never enter the VM.
- **Cloud Hypervisor microVM** copies allowed home state into its private
  staging area and excludes every matching `credentials.entries` path during
  the copy. The staged state is then exposed through the runtime's sandboxed
  virtio-fs boundary; excluded host credentials never enter the guest export.

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
