---
name: sandbox-filesystem-access
description: Configure or diagnose file and directory access, mounts, and host ACLs for AWF sandboxes.
---

# Sandbox Filesystem Access

Use this skill when changing or troubleshooting which host files and directories
an agent can read, write, or traverse inside an AWF sandbox. Treat host
permissions, sandbox mount policy, and the sandbox's effective view as separate
checks: a writable mount does not override host ownership or ACLs, and host
permissions do not make an unmounted path visible.

## Find the runtime-specific source of truth

First identify the selected runtime and the access path being changed. Do not
assume all runtimes implement mounts the same way.

- **Docker / gVisor compose:** Review
  [`docs/mount-policy.md`](../../../docs/mount-policy.md),
  [`docs/environment.md`](../../../docs/environment.md), and
  `src/services/agent-volumes/`. The agent runs chrooted under `/host`; account
  for that path mapping when comparing host paths with paths used by the agent.
- **Docker Sandboxes (`sbx`):** Review the volume-mount section of
  [`docs/sbx-integration.md`](../../../docs/sbx-integration.md) and
  `src/sbx-manager.ts`. Workspace and positional mounts appear at the same
  absolute path in the guest; additional mounts do not support an independent
  guest destination.
- **Cloud Hypervisor:** Review the export and write-policy sections of
  [`docs/cloud-hypervisor-foundation.md`](../../../docs/cloud-hypervisor-foundation.md)
  and `src/cloud-hypervisor/exports.ts`. Do not infer its exports or write
  permissions from the compose mount list.

For compose and sbx home-directory policy changes, use
[`src/config/sandbox-mount-policy.json`](../../../src/config/sandbox-mount-policy.json)
as the shared policy and follow [`docs/mount-policy.md`](../../../docs/mount-policy.md)
for its runtime scope and tests. Cloud Hypervisor does not currently consume
that home policy.

## Configure access narrowly

1. Name the exact host source, guest-visible path, required operations
   (read/write/execute/traverse), and runtime. Confirm the source exists and
   determine whether the configuration accepts a file, directory, or only a
   directory mount.
2. Grant only the required access. Prefer a specific read-only mount; if output
   is needed, make only the necessary output path writable. Avoid mounting `/`,
   the full host home, or broad credential-bearing directories.
3. Check existing parent and nested mounts before adding one. Mount ordering or
   a narrower child mount can change the effective access of a path. On
   ARC/DinD, verify the Docker daemon can see the source and account for
   `--docker-host-path-prefix`.
4. Preserve credential exclusions and the backend's isolation guarantees. A
   host ACL or mode change is not a substitute for a narrowly scoped sandbox
   mount.
5. Add or update a focused test for the policy or mount-generation behavior in
   the module being changed. Cover both the requested access and a nearby
   denied or read-only case.

## Verify effective access

Check each layer independently, using the actual host source and guest path:

1. **Host DAC/ACL:** Inspect owner, group, mode, and ACL entries. For example:
   `stat -c '%A %a %u:%g %n' <path>` and, when available, `getfacl -p <path>`.
   Check execute/traverse permission on every parent directory as well as the
   file or directory itself. Do not change host permissions merely to make a
   sandbox test pass.
2. **Generated mount/export:** For compose, inspect the generated volume and
   the running container's actual mounts (for example,
   `docker inspect <container> --format '{{json .Mounts}}' | jq`). For sbx or
   Cloud Hypervisor, inspect the corresponding generated command/export plan
   and runtime-specific diagnostics. Confirm the source, destination, and
   read-only/read-write mode.
3. **Guest identity and effective access:** Run checks inside the command AWF
   wraps, with the agent's actual user, groups, privileges, and guest path.
   In compose, a plain `docker exec awf-agent ...` runs as container root
   outside the `/host` chroot and can bypass mode/ACL restrictions; it is not
   equivalent to the agent command. Check `id`, inspect the target with `stat`,
   and use `test -r`, `test -w`, or `test -x` as preliminary permission probes.
   When write access is expected, confirm it by creating and removing a
   disposable file in the intended output directory. Use `findmnt -T <path>`
   when available to identify the supplying mount, not to prove write access:
   Cloud Hypervisor exports narrowed by `filesystem.allowWrite` can remain
   `rw` in the guest while the host mount tree denies writes outside allowed
   paths. A mount declaration or permission probe alone does not prove the
   intended operation works.

Keep verification non-destructive. Never read, print, or copy credential
contents while checking access; verify sensitive paths by checking existence,
metadata, or expected denial only.

## Report the result

State the runtime, host source, guest path, expected access, and observed
effective access. Distinguish a missing mount from a host permission/ACL denial
and from a read-only mount. Include the focused test or runtime check used, and
call out any backend that was not verified.
