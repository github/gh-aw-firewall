# Public Cloud Hypervisor environment probe

`probe.py` observes bounded guest metadata without reading repository content,
request files, environment variables, credentials, other processes, or network
addresses. It uses Python's standard library, runs no subprocesses, and makes
no network requests. The only write is the required JSON result at `/awf/out`;
stdout and stderr are not result channels.

**Public means repository sensitivity**, expressed as `sensitivity: public` in
`awf.yaml`. There is no new `secrecy` setting. Public permits an unmetered
**finite** response schema; it does not bypass guest isolation or artifact
verification. The script enclave remains single-use, noNIC, with AWF's pinned
role UID/GID, capabilities and resource limits. The public repository catalog
entry limits enclave staging to this repository; the network allowlist separately
permits GitHub-domain egress for the run.
The primary agent and script enclave both select Cloud Hypervisor. Omitting
the primary runtime would select Docker and is rejected: one workload backend
is required per run. Squid, the MCP gateway, and the API proxy remain Docker
infrastructure, not workload backends. The primary VM requires the API proxy
for credential isolation even though this probe makes no model requests.

## Supported invocation

Use the narrowly admitted, release-tagged native conformance workflow on an
eligible GitHub-hosted Ubuntu x86_64 KVM runner. General primary-with-enclave
execution remains gated pending real end-to-end acceptance; this example is
not a standalone CLI invocation, host diagnostic, or Docker workload. See
[the configuration contract](../../docs/awf-config-spec.md#14-unified-enclaves)
and [artifact setup](../../docs/cloud-hypervisor-foundation.md#host-eligibility-and-artifact-trust).

The workflow requires an exact published, package-matched release tag containing
the reviewed `acceptance_commit` and this fix. The harness verifies tag ancestry,
manifest source commits and signed artifacts, adds the release-matched image tag
and gateway handoff, and exports its isolated workspace via `GITHUB_WORKSPACE`.
It does not add unsupported host mounts or require an agent executor, model key,
or Copilot secret. Missing identity, assets, attestations or host support fail
closed; no backend fallback is allowed.

Generate `tools/call` parameters locally (this does not dispatch anything):

   ```bash
   python3 -B examples/enclave-environment-probe/build-request.py
   ```

Submit that object's `name` and `arguments` through the primary agent's
   supported `enclave_run_script` MCP tool. The arguments are exactly
   `privateRepo: "github/gh-aw-firewall"`, `schema: probe.schema()`, and the
   full UTF-8 `probe.py` source as `script`. Do not pass the script's filename
   as its source, run it directly in the primary agent, or expose the broker's
   socket, endpoint or capability. The result is the unchanged canonical
   `{"status":"ok","result":...}` or non-disclosing `{"status":"error"}`.

### Repository workflow dispatch

The Cloud Hypervisor enclave conformance workflow runs this probe in a distinct
`run_environment_probe` job without an agent executor or Copilot secret.
Its mandatory primary API proxy has no model credential or model traffic.
It requires a future published release tag containing this single-backend fix;
see
[the dispatch guide](../../docs/cloud-hypervisor-foundation.md#public-enclave-environment-probe-dispatch).

The guest probe **cannot run until host startup and broker readiness succeed**.
It cannot diagnose the earlier `v0.28.37` pre-broker failure with schema 1 and
an unknown category. It does not modify host diagnostics, recovery, or networking.
Nothing here authorizes a release, merge, workflow dispatch, or secret-backed run.

## Output version 1

All fields are required. Platform and architecture are finite enums; unfamiliar
values become `other`. Kernel and Python versions contain only their numeric
major/minor/patch, not release suffixes, build strings or hostnames.

Each observation has `status` and exactly eight integer `values`. Unused slots
are `-1`. Values are bounded to `[-1, 2^53-1]`; out-of-range observations discard
all values. Status is one of `ok`, `absent`, `permission_denied`, `unsupported`,
`truncated`, `malformed`, `out_of_range`, or `unlimited`. Unexpected OS errors
fail execution with a sanitized message, yielding the broker's canonical error,
not fabricated success data.

| Field | Meaning of populated value slots, in order |
| --- | --- |
| `kernelVersion`, `pythonVersion` | major, minor, patch |
| `identity` | real UID, real GID, effective UID, effective GID |
| `processSecurity` | inheritable, permitted, effective, bounding, ambient capability masks; `NoNewPrivs` |
| `limits` | NPROC, FSIZE, NOFILE observations; each has soft, hard limit (`-1` means infinity) |
| `cgroupRootLimits` | cgroup v2 root `memory.max`, `pids.max`, `cpu.max`; CPU has quota and period in microseconds (`-1` means `max`) |
| `paths[].metadata` | owner UID/GID, permission mode, directory bit, real-ID read/write/execute access bits |
| `paths[].mount` | covering mount read-only, nosuid, nodev, noexec bits; exact mountpoint bit (aliases are resolved internally) |
| `paths[].capacity` | fragment size, total blocks, available blocks, total inodes, available inodes, statvfs read-only bit |

Path observations always use this fixed order: `/input-seed`, `/input-request`,
`/output`, `/runtime`, `/awf`, `/awf/seed`, `/awf/out`, `/awf/query-script.py`.
The last three are compatibility aliases. Paths absent for this role are reported
as absent, not inferred. Only metadata is observed: no directory listing,
recursion, symlink target strings, file content, or mount sources are returned.

`/proc/self/status` reads are limited to 16 KiB; `/proc/self/mountinfo` to 64 KiB;
each fixed cgroup file to 128 bytes. Mount data is filtered to flags for the fixed
paths; raw mountinfo is never emitted. The UTF-8 result is limited to 8192 bytes,
the source to 16384 bytes, and the generated finite schema to AWF's 4096-byte,
64-node and depth-6 limits.

**Interpretation limits:** `os.access` and ownership do not prove effective
writeability or read-only enforcement. No writes test those properties.
Statvfs capacity is a filesystem view, **not proof of AWF's enforced aggregate
storage cap**. Cgroup observations describe the mounted cgroup root, not
necessarily the process's effective hierarchical limit; no membership paths are
returned. RLIMIT and self capability observations likewise do not prove every
host enforcement boundary. NoNIC is an AWF launch invariant, not inferred from
a network connection test.

## Local validation, not live acceptance

```bash
python3 -B -m unittest discover -s examples/enclave-environment-probe -q
npm test -- --runInBand --runTestsByPath \
  scripts/ci/cloud-hypervisor-environment-probe.test.ts
```

These exercise Linux proc/cgroup/mount fixtures, bounded error statuses,
sanitized unexpected failures, source execution with only `/awf/out` redirected
to memory, schema/value validation, and config validation. Local execution on
macOS observes macOS; it does **not** establish Cloud Hypervisor guest behavior.
Live release-attested KVM acceptance is a separate, unperformed validation step.
