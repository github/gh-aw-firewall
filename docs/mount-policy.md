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
The Cloud Hypervisor microVM does not use this policy to build its guest exports.
Its production export path (`src/cloud-hypervisor/exports.ts`) only resolves the
workspace (`rw`), the runner tool cache (`ro`, only under the non-default
`workspace-and-tool-cache` policy, using `RUNNER_TOOL_CACHE` or its fallback
`AGENT_TOOLSDIRECTORY`), `$RUNNER_TEMP/gh-aw` (`ro`, when `RUNNER_TEMP` is set
and the directory exists), and `/tmp/gh-aw` (`rw`, when the directory exists).
It does not export `$HOME`, so the home allow/deny lists are never used to
build a guest export for this runtime. The enclave private-root preflight does
read the policy's home and system paths, but only to check that AWF-private
state does not overlap any agent-visible path.
`MicrovmWorkspaceImage` (`src/microvm/workspace.ts`) does read `home.toolSubdirs`
and `credentials.entries`, but it has no production call site today; it is
exercised only by its own tests.

Mount visibility does not grant engine file scope. A mounted input directory
still requires host read/traverse permissions and any engine-specific grant,
such as Copilot's `--add-dir`. See
[`--mount` does not grant engine file scope](environment.md#--mount-does-not-grant-engine-file-scope)
for an example and fail-closed input verification guidance.

Compose `/tmp` and `/host/tmp` are private tmpfs mounts, not host directory
binds. Only the `/tmp/gh-aw` handoff and explicit subpath mounts are shared.
If `filesystem.allowWrite` makes the handoff read-only, AWF prepares directory
mountpoints for the sensitive log and audit masks before starting the agent.
The handoff remains read-only and both guest views still see private tmpfs at
the masked paths, including on the first run after cleanup. For a read-only
custom handoff source, pre-create the mask directories yourself; AWF will not
create directories in that source on behalf of the container.
The sbx default similarly shares `/tmp/gh-aw` rather than `/tmp`, plus the narrow
`/usr/local/bin` toolchain directory and the policy's home tool paths
([`sandbox-create.ts`](../src/sbx/sandbox-create.ts)). Do not place
host service IPC in live handoff, home, workspace, or custom shares; read-only
mounts do not prevent socket/FIFO communication. See the
[host runtime IPC boundary](security.md#host-runtime-ipc-boundary) for the
in-container CoreCLR check and the limits of this guarantee.

## Trusted host socket directories

A trusted orchestrator can declare existing private host socket directories with
repeatable `--private-host-socket-dir /absolute/path` flags or with
`filesystem.privateHostSocketDirs` in the JSON/YAML configuration:

```json
{
  "filesystem": {
    "privateHostSocketDirs": ["/run/trusted-connector/job-123"]
  }
}
```

AWF rejects declarations overlapping any final agent-visible host mount, including
workspace, home, tool-cache, handoff, log/state and custom mounts. Read-only binds
and nested masks do not rescue an overlapping source. Symlink resolution and
Linux mount-table filesystem coordinates detect path and bind aliases, including
recursive submounts. Directory/ancestor identities are retained across startup;
replacement or retargeting fails closed. The directories must already exist.
Traversal components, dangling symlinks, symlinks inside private directories and
hard-linked sockets are rejected.

With this option, AWF holds **all entrypoint, shell hook, harness and command
execution** behind a root-owned, container-private startup gate. After Compose
bring-up, AWF inspects the actual container and its kernel mount namespace,
rejects overlapping or unsupported mounts, proves the runner and selected Docker
daemon share the inspected filesystem, and lets the trusted entrypoint set up.
A second gate holds the command after mount setup and privilege drop; AWF
rechecks that final namespace and the directory identities before release.
Agent access to the Docker control socket, Docker backing storage used
as a private directory, opaque volume drivers, shared mount propagation, and
host PID/IPC/network namespaces and ambiguous stacked host mounts are rejected.
Host procfs binds are also rejected: PID-root magic links would bypass a
directory-only mount comparison. Container-scoped procfs created during setup
remains supported.
Overlay backing paths must be inspectable inside verified Docker storage; only
the container-root overlay and its same-superblock bind aliases are accepted.
Loader, shell and Node startup hooks are rejected when supplied and cleared
for bootstrap image defaults. Exported Bash functions are stripped before
the privileged entrypoint. In chroot mode the final gate runs before the
host PATH or toolchain setup, and requires an agent image supporting that gate.
Verification failure leaves the gate closed; the normal startup cleanup removes
the container. A retry or recreated container must pass verification again.

**Supported:** local Linux Docker/runc, with root privileges for host `/proc`
inspection (normally `sudo awf`), and private directories on ext4, XFS or tmpfs.
Default runtime selection is explicitly pinned to runc for this contract.
Ordinary disjoint read-only/read-write binds and local named volumes are supported
when the complete actual topology is inspectable.

**Fail closed:** unprivileged host inspection, remote/context-selected Docker,
ARC/DinD, nontrivial `--docker-host-path-prefix` translation, `--enable-dind`,
`--enable-host-access` (which could expose alternate Docker control endpoints),
legacy security, gVisor/runsc, sbx, Cloud Hypervisor, NVX, unknown OCI runtimes,
custom binary sysroots or mounts replacing trusted bootstrap/interpreter/loader
paths, symlinks in nested mount targets, declared directories containing
submounts, and uninspectable filesystems such as NFS/FUSE or private overlay/btrfs roots.
AWF pins the Docker CLI to the selected Unix endpoint, overriding any saved
default context; an explicit `DOCKER_CONTEXT` is unsupported.
These runtimes need an equivalent final-export verifier and pre-execution gate
before they can support this option. An empty declaration list changes no behavior.

The trusted caller must keep service sockets inside the declared directories,
without external socket aliases, and keep their placement and mount topology
stable for the run. Sockets created later inside those directories remain
outside the agent's private mount namespace. AWF does not chmod, relocate, unlink
or export the sockets: their intended **host-side trusted adapter** retains access.
This protects the **AWF agent boundary**, not unrelated same-UID host processes,
malicious host administrators, or an untrusted container image. It does not
authorize connectors, issue tokens, set workflow permissions, or separate reader
and writer jobs; those remain the orchestrator's responsibility.

The live regression runs against local Docker with privileged host inspection:

```bash
sudo env AWF_REQUIRE_PRIVATE_SOCKET_LIVE=1 "$(command -v node)" "$PWD/node_modules/jest/bin/jest.js" \
  --config "$PWD/tests/setup/jest.integration.config.js" \
  --runInBand private-host-sockets.test.ts
```

## What the policy contains

| Section | Kind | Applies to | Consumed by |
| --- | --- | --- | --- |
| `system.directories.default` / `.sysroot` | allow (dirs) | compose (Docker + gVisor) | `system-mounts.ts` |
| `system.etc` | allow (files) | compose (Docker + gVisor) | `etc-mounts.ts` |
| `home.toolSubdirs` | allow (dirs) | compose + sbx + NVX; microVM workspace tests | `home-strategy.ts`, `sbx/sandbox-create.ts`, `nvx/guest-config-layer.ts`, `microvm/workspace.ts` |
| `home.narrowPaths` | narrow allow override | compose + sbx + NVX; microVM workspace tests | `home-strategy.ts`, `sbx/sandbox-create.ts`, `nvx/guest-config-layer.ts`, `microvm/workspace.ts` |
| `home.forbiddenSubdirs` | deny guard | compose + NVX (sbx never mounts these because they are not in `toolSubdirs`) | invariant tests, `agent-home.ts`, `services/agent-path-policy.ts`, `services/agent-volumes/exposed-home-secrets.ts`, `nfs-home-exclusions.ts`, `nvx/guest-config-layer.ts`, `nvx/filesystem-builder.ts`, `nvx/live-mount-policy.ts` |
| `credentials.entries` | deny (files/dirs) | compose + sbx + NVX; microVM workspace tests | `credential-hiding.ts`, `exposed-home-secrets.ts`, `agent-home.ts`, `services/agent-path-policy.ts`, `nfs-home-exclusions.ts`, `sbx/credential-scrub.ts`, `nvx/guest-config-layer.ts`, `nvx/filesystem-builder.ts`, `nvx/live-mount-policy.ts`, `microvm/workspace.ts` |

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
`docker-compose.yml`, which can contain credentials. When AWF creates a missing
work directory, it requests mode `0700` for that directory and any missing
parents. This happens in the runner/daemon filesystem probe (run when no
`--docker-host-path-prefix` is set, before configuration setup) and again
in configuration setup ([`validateAndPrepareWorkDir`](../src/config-writer-ownership.ts)).
Under `umask 022` or `000`, these new directories remain `0700`, including when
Docker is unreachable.

The probe does not chmod existing directories. Subsequent configuration
validation still rejects work directories with group or other access,
untrusted ownership, or a symlink at the work-directory path. Reused work
directories must already satisfy those checks.

These host permissions do not change the sandbox mount allow/deny lists or
establish isolation from a same-UID agent. Protected command-output capture
separately checks its storage against effective agent-visible mounts.

## How each runtime applies the credential deny list

On Linux compose runners with an NFS home (except ARC/DinD), AWF instead copies
the allowlisted tool paths into its local chroot home. It excludes entire
`credentials.entries` paths, forbidden home directories, exposed GitLab
credential locations, and API-proxy env files before copying, and does not
follow symlinks or copy sockets/devices/FIFOs. Credential stores are therefore
absent rather than masked on NFS. The local-storage requirements and snapshot
semantics are described in [environment.md](environment.md#self-hosted-runner-home-directory-support).
A runner tool cache under the home is staged too and remains mounted read-only.

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
  When a workspace, working-directory or explicit bind exposes either the
  effective home or the sudo-aware runner home, compose also maps these file
  masks through the exposed bind paths, including aliases. Existing global
  `.copilot/session-state` directories exposed by such binds are overlaid with
  the run's session-state directory. The runner's home is not inspected merely
  because an alternate `--home` was selected. With an alternate `--home`,
  compose rejects binds exposing forbidden runner-home paths or opaque
  credential directories, because individual file masks cannot secure them.
  Compose also rejects binds into a subdirectory of Copilot session history.
  For example, use a workspace below the runner home rather than the home itself.
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
  live-share policy applies the same exclusions
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
