import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'self-hosted-runner-doctor.md');
const sharedPath = path.join(workflowsDir, 'shared/self-hosted-failure-modes.md');
const lockPath = path.join(workflowsDir, 'self-hosted-runner-doctor.lock.yml');
const portableAgentPath = path.resolve(__dirname, '../../.github/agents/self-hosted-runner-doctor.md');

describe('self-hosted runner doctor workflow config', () => {
  it('defines a community-facing slash command workflow with the shared failure-mode import', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const shared = fs.readFileSync(sharedPath, 'utf-8');

    expect(source).toContain('name: Self-Hosted Runner Doctor');
    expect(source).toContain('roles: all');
    expect(source).toContain('slash_command:');
    expect(source).toContain('name: runner-doctor');
    expect(source).toContain('shared/self-hosted-failure-modes.md');
    expect(source).toContain('title-prefix: "🩺 Runner Doctor"');
    expect(shared).toContain('## Category A — ARC / DinD');
    expect(shared).toContain('| A10 | `Docker socket not found` plus `Invalid container ID format: arc-...` |');
  });

  it('compiles the trigger, safe outputs, and knowledge-base references into the lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('runner-doctor');
    expect(lock).toContain('issues: read');
    expect(lock).toContain('pull-requests: read');
    expect(lock).toContain('🩺 Runner Doctor');
    expect(lock).toContain('shared/self-hosted-failure-modes.md');
    expect(lock).toMatch(/github\/gh-aw(?:-actions\/|\/actions\/)setup@(?:[a-f0-9]{40}|v\d+\.\d+\.\d+)/);
  });

  it('keeps the shared catalog, workflow playbook, and portable agent aligned for new failure modes', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const shared = fs.readFileSync(sharedPath, 'utf-8');
    const portableAgent = fs.readFileSync(portableAgentPath, 'utf-8');

    for (const content of [shared, portableAgent]) {
      expect(content).toContain('github/gh-aw-firewall#5753');
      expect(content).toContain('| A14 | `unknown shorthand flag: \'d\' in -d` / `Command failed with exit code 125: docker compose up -d --pull never` |');
      expect(content).toContain('| A15 | `[WARN] Rootless artifact permission repair failed for .../sandbox/firewall/logs (exit 1)`; squid log files unreadable after ARC/DinD run; `awf logs summary` returns `Failed to load logs: EACCES` |');
      expect(content).toContain('**Fixed in PR github/gh-aw-firewall#5963**');
      expect(content).toContain('`fixArtifactPermissionsForRootless()`');
      expect(content).toContain('`applyHostPathPrefixToVolumes()`');
      expect(content).toContain('Workaround (older AWF): run `chmod -R a+rX` inside the squid container before `docker compose down`.');
      expect(content).toContain('github/gh-aw-firewall#5816, github/gh-aw-firewall#5817, github/gh-aw-firewall#5963');
      expect(content).toContain('| `unknown shorthand flag: \'d\' in -d` from `docker compose up -d` on ARC/DinD | A14 |');
      expect(content).toContain('| `Rootless artifact permission repair failed for .../sandbox/firewall/logs` on ARC/DinD | A15 |');
      expect(content).not.toMatch(/^- A15 \/ /m);
      // D1 gVisor support phrasing
      expect(content).toContain('**gVisor support landed** in PR github/gh-aw-firewall#6093');
      expect(content).toContain('use `--container-runtime gvisor` (maps to Docker runtime `runsc`), or raw `--container-runtime runsc` which now aliases to the same gVisor capability profile');
      expect(content).not.toContain('Raw `runsc` remains an unknown passthrough runtime');
      expect(content).toContain('**Kata Containers** remain an unresolved research area.');
      expect(content).toContain('github/gh-aw-firewall#3264, github/gh-aw-firewall#6093, github/gh-aw-firewall#6401');
      expect(content).toContain('- D1 / #3264 — Kata Containers compatibility research (gVisor resolved in github/gh-aw-firewall#6093; raw `runsc` aliases to the same profile in github/gh-aw-firewall#6401)');
      expect(content).not.toContain('- D1 / #3264 — gVisor and Kata compatibility research');
      // B11 new failure mode
      expect(content).toContain('| B11 |');
      expect(content).toContain('github/gh-aw-firewall#6070, github/gh-aw-firewall#6072');
      expect(content).toContain('**Improved in AWF (PR github/gh-aw-firewall#6072, merged 2026-07-10)**');
      expect(content).toContain('The non-zero exit code comes from `runAgentCommand()` before cleanup; cleanup warnings do not override it.');
      expect(content).toContain('| `[WARN] Rootless artifact permission repair failed ... (exit 1)` with little/no stderr detail, plus cleanup warnings around chroot-home removal and `Command completed with exit code: 1` | B11 |');
      expect(content).toContain('| B12 | `getaddrinfo EAI_AGAIN <awmg-cli-proxy>` or `ENOTFOUND <awmg-cli-proxy>`');
      expect(content).toContain('`detectDnsResolutionFailure()`');
      expect(content).toContain('docker run --rm alpine nslookup awmg-cli-proxy');
      expect(content).toContain('github/gh-aw-firewall#6326, github/gh-aw-firewall#6328');
      expect(content).toContain('**Further fixed in AWF (PR github/gh-aw-firewall#6460, merged 2026-07-21):** `/etc/pki/ca-trust` and `/etc/pki/tls` are now included in the chroot mount policy');
      expect(content).toContain('github/gh-aw-firewall#5733, github/gh-aw-firewall#5783, github/gh-aw-firewall#6460');
      expect(content).toContain('**Fixed in AWF (PR github/gh-aw-firewall#6473, merged 2026-07-21):** Topology peer hostnames and `difcProxyHost` are also auto-added to the Squid ACL allowlist');
      expect(content).toContain('confirm topology hostname appears in generated `squid.conf` as `acl allowed_domains dstdomain .<topology-host>` after github/gh-aw-firewall#6473');
      expect(content).toContain('github/gh-aw-firewall#6189, github/gh-aw-firewall#6438, github/gh-aw-firewall#6473');
      expect(content).toContain('expected on restricted runners');
      expect(content).toContain('Post-#6328: a `[WARN] Rootless artifact permission repair failed` message indicates a genuine failure');
      expect(content).toContain('| D8 | MCP tool calls (`safeoutputs`, `github`) return `403 ERR_ACCESS_DENIED` under `--container-runtime gvisor` or raw `runsc`; agent completes but never writes safe outputs; smoke tests fail at "Validate safe outputs were invoked"; direct `/dev/tcp` connections fail with `No route to host` |');
      expect(content).toContain('`runtimeUsesIptables()` returns `false` for `gvisor` and its raw `runsc` alias (plus `sbx`)');
      expect(content).toContain('AWF_SKIP_IPTABLES_INIT=1');
      expect(content).toContain('| D9 | On `--container-runtime sbx`, credential files (`~/.aws/credentials`, `~/.ssh/id_rsa`, `~/.docker/config.json`, `~/.kube/config`, `~/.azure/`, `~/.gnupg/`, `~/.netrc`, `~/.config/gh/hosts.yml`, `~/.config/gcloud/`, `~/.cargo/credentials.toml`, `~/.claude/.credentials.json`, `~/.gemini/oauth_creds.json`) are visible to the agent inside the sbx microVM |');
      expect(content).toContain('`scrubHomeCredentials()` moves them aside to `.awf-sbx-cred-backup-<pid>`');
      expect(content).toContain('| `403 ERR_ACCESS_DENIED` for MCP tool calls (`safeoutputs`, `github`) to `172.30.0.1/redacted` under `--container-runtime gvisor` or raw `runsc`; agent finishes but safe-output validation fails | D8');
      expect(content).toContain('| Credential files (`~/.aws`, `~/.ssh`, `~/.docker/config.json`, `~/.kube`, `~/.config/gh`, `~/.cargo/credentials.toml`, etc.) visible inside sbx microVM under `--container-runtime sbx` | D9');
      expect(content).toContain('| D11 | Copilot CLI agent starts under `--container-runtime gvisor` but exits immediately with **exit code 139** (`SIGSEGV`) or `SIGABRT` (exit 1);');
      expect(content).toContain('often before any model or tool call is issued');
      expect(content).toContain('`MAX_GVISOR_AGENT_RETRIES = 1`');
      expect(content).toContain('github/gh-aw-firewall#6513, github/gh-aw-firewall#6514, github/gh-aw-firewall#6558');
      expect(content).toContain('| `SIGABRT` / `signal=SIGABRT duration=0s stdout=0B` for Copilot CLI all retries under `--container-runtime gvisor`; or exit code 139 with `Segmentation fault` on bash wrapper | D11');
      expect(content).toContain('- D11 / github/gh-aw-firewall#6558 — gVisor + Node.js v22 V8 ESM startup crash root cause (SIGABRT `StringBytes::Encode`); one-shot retry mitigates (~8% failure rate) but does not prevent the crash');
      expect(content).toContain('| D12 | Copilot workflow with `model: auto` (or no explicit top-level `model`, where gh-aw v0.84.1+ emits `auto`) fails before the agent starts under `--container-runtime gvisor` or `sbx`;');
      expect(content).toContain('`checkUnknownModelRejection` now allows `provider === \'copilot\' && model.toLowerCase() === \'auto\'` to pass pre-flight');
      expect(content).toContain('github/gh-aw-firewall#6810, github/gh-aw-firewall#6811');
      expect(content).toContain('| `Model "auto" has no AI credits pricing and no default pricing is configured` together with `awf-reflect: request failed: fetch failed` under `--container-runtime gvisor` or `sbx` | D12');
      // A20 new failure mode (writable /host$HOME under arc-dind sysroot staging)
      expect(content).toContain('| A20 | Under `runner.topology: arc-dind`, `awf-agent` fails to start');
      expect(content).toContain('`filterAgentVolumesForSysroot()` (`src/services/optional-services.ts`) dropped every mount targeting `/host$HOME`');
      expect(content).toContain('**Fixed in AWF (PR github/gh-aw-firewall#7244, merged 2026-08-11):**');
      expect(content).toContain('github/gh-aw-firewall#7239, github/gh-aw-firewall#7244');
      expect(content).toContain('| `runc` mountpoint creation failure for `/dev/null` credential overlays under `/host$HOME` on `runner.topology: arc-dind` | A20 |');
      expect(content).toContain('| `mkdir -p .../.m2` failing under `set -e` in agent entrypoint on `arc-dind` | A20 |');
      // A21 new failure mode (filesystem.allowWrite nested mountpoint EROFS on ARC/DinD)
      expect(content).toContain('| A21 | `awf-agent` fails to start with `runc create failed: ... mkdirat /var/lib/docker/overlay2/<layer-id>/merged/tmp/awf-init: read-only file system`');
      expect(content).toContain('`planNestedMountpoints()`/`ensureNestedMountpoints()`');
      expect(content).toContain('github/gh-aw-firewall#7678, github/gh-aw-firewall#7679, github/gh-aw-firewall#7681');
      expect(content).toContain('`/tmp/awf-lib` helper staging');
      expect(content).toContain('Startup now fails closed');
      expect(content).toContain('| `mkdirat ... : read-only file system` at agent container startup while a `filesystem.allowWrite` policy is active (not the `chroot.binariesSourcePath`-specific A12 case) | A21 |');
      // B23 update: PR #7245 fixes the AWF-side gap
      expect(content).toContain('**Fixed on the AWF side (PR github/gh-aw-firewall#7245, merged 2026-08-11):**');
      expect(content).toContain('`ensure_usr_local_bin_shims()`');
      expect(content).toContain('`prepare_usr_local_bin_overlay()`');
      expect(content).toContain('AWF_ENSURE_USR_LOCAL_BIN=copilot');
      expect(content).toContain('The upstream installer/harness mismatch remains open in github/gh-aw-firewall#7130.');
      expect(content).toContain('**Older AWF only:**');
      expect(content).not.toContain('Not an AWF defect.');
      // B17 update: PR #7499 replaces DNS filtering with DNS preservation
      expect(content).toContain('**Behavior changed again in AWF (PR github/gh-aw-firewall#7499, merged 2026-08-19):**');
      expect(content).toContain('`filterForNetworkIsolation()` now preserves all detected/explicit DNS servers unchanged in network-isolation mode');
      expect(content).toContain('Fallback to `DEFAULT_DNS_SERVERS` now only occurs when host DNS auto-detection finds no usable non-loopback resolver, not based on resolver classification.');
      expect(content).toContain('github/gh-aw-firewall#7495, github/gh-aw-firewall#7499');
      expect(content).not.toContain('**Further refined in AWF (PR github/gh-aw-firewall#7188, merged 2026-08-10):** resolver filtering is now reachability-probed');
      // B24 new failure mode (native-root without SUDO_UID leaves gh-aw config unreadable)
      expect(content).toContain('| B24 | Repeated `EACCES` retries from the harness reading `${RUNNER_TEMP}/gh-aw/mcp-config/mcp-servers.json`');
      expect(content).toContain('**Fixed in AWF (PR github/gh-aw-firewall#7565, merged 2026-08-20):**');
      expect(content).toContain('`isNativeRootWithoutSudo()`');
      expect(content).toContain('`repairRunnerTempGhAwOwnership()`');
      expect(content).toContain('github/gh-aw-firewall#7564, github/gh-aw-firewall#7565');
      expect(content).toContain('| `EACCES` retries reading `${RUNNER_TEMP}/gh-aw/mcp-config/mcp-servers.json` (or similar `${RUNNER_TEMP}/gh-aw` paths) when AWF was invoked as native root (no `sudo`) | B24');
      // B25 new failure mode (native-root checkout ownership blocks agent writes)
      expect(content).toContain('| B25 | On native-root runners');
      expect(content).toContain('**Fixed in AWF (PR github/gh-aw-firewall#7599, merged 2026-08-21):**');
      expect(content).toContain('`repairContainerWorkDirOwnership(config)`');
      expect(content).toContain('`isDirectoryWritableByIdentity()`');
      expect(content).toContain('github/gh-aw-firewall#7593, github/gh-aw-firewall#7599');
      expect(content).toContain('| `Host workspace is not writable by the sandbox identity (<uid>:<gid>): <path>` | B25 |');
    }

    // B26 new failure mode (network-isolation artifact ZIP download via blob storage egress)
    for (const content of [shared, portableAgent]) {
      expect(content).toContain('| B26 | In `--network-isolation` mode');
      expect(content).toContain('`error connecting to productionresultssa*.blob.core.windows.net`');
      expect(content).toContain('`http_access allow from_cli_proxy cli_proxy_artifact_storage`');
      expect(content).toContain('github/gh-aw-mcpg#10350');
      expect(content).toContain('github/gh-aw#54371, github/gh-aw-firewall#7615, github/gh-aw-firewall#7635');
      expect(content).toContain('| `error connecting to productionresultssa*.blob.core.windows.net` from `gh run download`/artifact ZIP fetch in `--network-isolation` mode | B26');
    }

    expect(source).toContain('- `unknown shorthand flag: \'d\' in -d` from `docker compose up -d` → A14 (DinD sidecar missing `docker-compose-plugin`)');
    expect(source).toContain('- `Rootless artifact permission repair failed` on ARC/DinD squid logs → A15 (`dockerHostPathPrefix` not applied to repair bind mount)');
    expect(source).toContain('- `EAI_AGAIN` / `ENOTFOUND` resolving a topology-attached DIFC proxy (for example `awmg-cli-proxy`) in network-isolation + topology-attach: if DinD `nslookup` fails, match B12; otherwise B5');
    expect(source).toContain('- `403 ERR_ACCESS_DENIED` for MCP tool calls (`safeoutputs`, `github`) to `172.30.0.1/redacted` under `--container-runtime gvisor` or raw `runsc`; safe-output validation fails even though the agent completed → D8');
    expect(source).toContain('- credential files such as `~/.aws/credentials`, `~/.ssh/id_rsa`, or `~/.docker/config.json` are visible inside an `--container-runtime sbx` microVM → D9');
    expect(source).toContain('- `SIGABRT` / `signal=SIGABRT duration=0s stdout=0B` for Copilot CLI all retries under `--container-runtime gvisor`; or exit 139 / `Segmentation fault` on bash wrapper, often before any model or tool call → D11');
    expect(source).toContain('- `Model "auto" has no AI credits pricing and no default pricing is configured` together with `awf-reflect: request failed: fetch failed` under `--container-runtime gvisor` or `sbx` → D12');
    expect(source).toContain('- `awf-agent` fails to start under `runner.topology: arc-dind` (runc cannot create the `/dev/null` credential-hiding overlay mountpoints under `/host$HOME`), or the entrypoint aborts with `mkdir -p /host$HOME/.m2` failing under `set -e` → A20 (sysroot filter dropped every mount targeting `/host$HOME`, including a caller-supplied writable home; fixed in github/gh-aw-firewall#7244)');
    expect(source).toContain('- `mkdirat ... : read-only file system` at agent container startup while a `filesystem.allowWrite` policy is active (not the `chroot.binariesSourcePath`-specific A12 case) → A21; `[entrypoint][WARN] Could not copy one-shot-token library to /tmp/awf-lib` followed by `Token protection will be disabled` → A21');
    expect(source).toContain('B12 / github/gh-aw-firewall#6326, github/gh-aw-firewall#6328 — On ARC/DinD, a topology-attached DIFC proxy addressed by Kubernetes Service name can remain unresolvable from DinD containers even after the ordering fix.');
    expect(source).toContain('D8 / github/gh-aw-firewall#6401, github/gh-aw-firewall#6326 — Under `--container-runtime gvisor` or raw `runsc`, MCP calls to the gateway at `172.30.0.1:8080` could be misrouted through Squid and fail with `403 ERR_ACCESS_DENIED`');
    expect(source).toContain('D9 / github/gh-aw-firewall#6336 — sbx microVMs previously mounted the entire host `$HOME`, exposing credentials such as `~/.aws/credentials`, `~/.ssh/id_rsa`, and `~/.docker/config.json`.');
    expect(source).toContain('D11 / github/gh-aw-firewall#6558 — gVisor + Node.js v22 V8 ESM startup crash root cause remains unresolved (`SIGABRT` `StringBytes::Encode` assertion and occasional exit 139).');
    expect(source).toContain('D12 / github/gh-aw-firewall#6810, github/gh-aw-firewall#6811 — Copilot runs using `model: auto` under isolated runtimes (`--container-runtime gvisor` or `sbx`) could fail before agent start with `awf-reflect: request failed: fetch failed` plus `Model "auto" has no AI credits pricing and no default pricing is configured` when `apiProxy.maxAiCredits` was enabled.');
    expect(source).toContain('A20 / github/gh-aw-firewall#7239, github/gh-aw-firewall#7244 — Under `runner.topology: arc-dind`, `filterAgentVolumesForSysroot()` (`src/services/optional-services.ts`) dropped every mount targeting `/host$HOME`');
    expect(source).toContain('A21 / github/gh-aw-firewall#7678, github/gh-aw-firewall#7679, github/gh-aw-firewall#7681 — When a `filesystem.allowWrite` policy narrows `/tmp` to read-only, `awf-agent` startup can fail with `runc create failed: ... mkdirat ... read-only file system`');
    expect(portableAgent).toContain('- `unknown shorthand flag: \'d\' in -d` from `docker compose up -d` → A14 (DinD sidecar missing `docker-compose-plugin`)');
    expect(portableAgent).toContain('- `Rootless artifact permission repair failed` on ARC/DinD squid logs → A15 (`dockerHostPathPrefix` not applied to repair bind mount)');
    expect(portableAgent).toContain('- `EAI_AGAIN` / `ENOTFOUND` resolving a topology-attached DIFC proxy (for example `awmg-cli-proxy`) in network-isolation + topology-attach: if DinD `nslookup` fails, match B12; otherwise B5');
    expect(portableAgent).toContain('- `403 ERR_ACCESS_DENIED` for MCP tool calls (`safeoutputs`, `github`) to `172.30.0.1/redacted` under `--container-runtime gvisor` or raw `runsc`; safe-output validation fails even though the agent completed → D8');
    expect(portableAgent).toContain('- credential files such as `~/.aws/credentials`, `~/.ssh/id_rsa`, or `~/.docker/config.json` are visible inside an `--container-runtime sbx` microVM → D9');
    expect(portableAgent).toContain('- `SIGABRT` / `signal=SIGABRT duration=0s stdout=0B` for Copilot CLI all retries under `--container-runtime gvisor`; or exit 139 / `Segmentation fault` on bash wrapper, often before any model or tool call → D11');
    expect(portableAgent).toContain('- `Model "auto" has no AI credits pricing and no default pricing is configured` together with `awf-reflect: request failed: fetch failed` under `--container-runtime gvisor` or `sbx` → D12');
    expect(portableAgent).toContain('D11 / github/gh-aw-firewall#6558 — gVisor + Node.js v22 V8 ESM startup crash root cause remains unresolved (`SIGABRT` `StringBytes::Encode` assertion and occasional exit 139).');
    expect(portableAgent).toContain('D12 / github/gh-aw-firewall#6810, github/gh-aw-firewall#6811 — Copilot runs using `model: auto` under isolated runtimes (`--container-runtime gvisor` or `sbx`) could fail before agent start with `awf-reflect: request failed: fetch failed` plus `Model "auto" has no AI credits pricing and no default pricing is configured` when `apiProxy.maxAiCredits` was enabled.');
    expect(portableAgent).toContain('- `awf-agent` fails to start under `runner.topology: arc-dind` (runc cannot create the `/dev/null` credential-hiding overlay mountpoints under `/host$HOME`), or the entrypoint aborts with `mkdir -p /host$HOME/.m2` failing under `set -e` → A20 (sysroot filter dropped every mount targeting `/host$HOME`, including a caller-supplied writable home; fixed in github/gh-aw-firewall#7244)');
    expect(portableAgent).toContain('A20 / github/gh-aw-firewall#7239, github/gh-aw-firewall#7244 — Under `runner.topology: arc-dind`, `filterAgentVolumesForSysroot()` (`src/services/optional-services.ts`) dropped every mount targeting `/host$HOME`');
    expect(portableAgent).toContain('- `mkdirat ... : read-only file system` at agent container startup while a `filesystem.allowWrite` policy is active (not the `chroot.binariesSourcePath`-specific A12 case) → A21; `[entrypoint][WARN] Could not copy one-shot-token library to /tmp/awf-lib` followed by `Token protection will be disabled` → A21');
    expect(portableAgent).toContain('A21 / github/gh-aw-firewall#7678, github/gh-aw-firewall#7679, github/gh-aw-firewall#7681 — When a `filesystem.allowWrite` policy narrows `/tmp` to read-only, `awf-agent` startup can fail with `runc create failed: ... mkdirat ... read-only file system`');
    expect(source).toContain('B23 / github/gh-aw-firewall#7130 (still open), github/gh-aw-firewall#7147, github/gh-aw-firewall#7151, github/gh-aw-firewall#7245');
    expect(source).toContain('**Fixed on the AWF side (PR github/gh-aw-firewall#7245, merged 2026-08-11):**');
    expect(portableAgent).toContain('**Fixed on the AWF side (PR github/gh-aw-firewall#7245, merged 2026-08-11):**');
    for (const playbook of [source, portableAgent]) {
      expect(playbook).toContain('- Repeated `EACCES` retries reading `${RUNNER_TEMP}/gh-aw/mcp-config/mcp-servers.json` (or similar `${RUNNER_TEMP}/gh-aw` paths) when AWF was invoked as native root (no `sudo`) → B24 (root fallback to sandbox uid 1000 leaves root-owned config unreadable; fixed in github/gh-aw-firewall#7565 with `repairRunnerTempGhAwOwnership()`)');
      expect(playbook).toContain('B24 / github/gh-aw-firewall#7564, github/gh-aw-firewall#7565 — On native-root runners');
      expect(playbook).toContain('- Job exits 0 with no agent output/writes on a native-root runner (no `sudo`), even after `${RUNNER_TEMP}/gh-aw` ownership is fixed, or `Host workspace is not writable by the sandbox identity (<uid>:<gid>): <path>` → B25');
      expect(playbook).toContain('B25 / github/gh-aw-firewall#7593, github/gh-aw-firewall#7599 — On native-root runners');
    }
    expect(source).toContain('- `error connecting to productionresultssa*.blob.core.windows.net` from `gh run download`/artifact ZIP fetch in `--network-isolation` mode → B26');
    for (const playbook of [source, portableAgent]) {
      expect(playbook).toContain('- `error connecting to productionresultssa*.blob.core.windows.net` from `gh run download`/artifact ZIP fetch in `--network-isolation` mode → B26');
      expect(playbook).toContain('B26 / github/gh-aw#54371, github/gh-aw-firewall#7615, github/gh-aw-firewall#7635 — In `--network-isolation` mode');
      expect(playbook).toContain('github/gh-aw-mcpg#10350');
    }
  });
});
