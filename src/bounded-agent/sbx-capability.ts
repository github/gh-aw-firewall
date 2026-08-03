import execa from 'execa';

/**
 * Host-side capability probe for the bounded-agent `sbx` enclave runtime.
 *
 * This is deliberately its own module (not a re-export of the bounded-query
 * probe) because bounded agents have a strictly harder requirement: a bounded
 * *query* sandbox needs `--network=none` (no egress at all), while a bounded
 * *agent* enclave must reach exactly one peer — the dedicated, API-proxy-only
 * enclave network — and nothing else. sbx has no primitive that can attach a
 * sandbox to a named Docker network while also enforcing that no other peer
 * on that network (or the internet) is reachable, so that requirement is
 * always reported missing below rather than inferred from a flag that would
 * only prove the weaker no-network case.
 */

const SBX_AUDITED_VERSION = '0.37.1';

/** Flags proven by `sbx create --help` inspection. */
const SBX_REQUIRED_CREATE_FLAGS = [
  '--cpus',
  '--memory',
  '--name',
  '--template',
  '--pids-limit',
  '--disk-limit',
  '--ulimit-fsize',
  '--mount-target',
] as const;

/** Flags proven by `sbx exec --help` inspection. */
const SBX_REQUIRED_EXEC_FLAGS = ['--user', '--workdir'] as const;

export interface BoundedAgentSbxCapabilityReport {
  supported: boolean;
  version?: string;
  auditedVersion: string;
  missing: string[];
}

/** Executes the minimum host-side capability proof for the sbx enclave backend. */
export type BoundedAgentSbxCapabilityQuery = () => Promise<BoundedAgentSbxCapabilityReport>;

function helpIncludesFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${escaped}(?=([=\\s,]|$))`, 'm').test(help);
}

/**
 * Probes the installed `sbx` CLI for every capability the bounded-agent
 * enclave requires: lifecycle (create/exec/stop/rm), read-only targeted
 * mounts, unprivileged exec identity/workdir, resource and storage limits,
 * and — the category current sbx cannot satisfy — a hard, API-proxy-only
 * network-isolation primitive with mandatory lateral-peer denial.
 *
 * Help/version output alone never marks the runtime supported: every
 * unconditional architectural gap below is always reported so a future sbx
 * release cannot be silently treated as capable of this feature by CLI-flag
 * drift alone.
 */
export const defaultBoundedAgentSbxCapabilityQuery: BoundedAgentSbxCapabilityQuery = async () => {
  const managementEnv = { ...process.env };
  delete managementEnv.DOCKER_SANDBOXES_PROXY;
  delete managementEnv.XDG_CONFIG_HOME;

  const run = async (args: string[]): Promise<{ exitCode: number; stdout: string }> => {
    const result = await execa('sbx', args, {
      reject: false,
      timeout: 10_000,
      env: managementEnv,
    });
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
  };

  let versionResult: { exitCode: number; stdout: string };
  let daemonResult: { exitCode: number; stdout: string };
  let createHelp: { exitCode: number; stdout: string };
  let execHelp: { exitCode: number; stdout: string };
  try {
    [versionResult, daemonResult, createHelp, execHelp] = await Promise.all([
      run(['version']),
      // sbx has no auth-status command; listing is authenticated and non-mutating.
      run(['ls']),
      run(['create', '--help']),
      run(['exec', '--help']),
    ]);
  } catch {
    return {
      supported: false,
      auditedVersion: SBX_AUDITED_VERSION,
      missing: ['authenticated sbx CLI/daemon'],
    };
  }

  const version = /\bv?(\d+\.\d+\.\d+)\b/.exec(versionResult.stdout)?.[1];
  const missing: string[] = [
    // AWF has not published the immutable, AWF-authored enclave template and
    // bootstrap for sbx because current sbx cannot yet enforce the network
    // primitive below — publishing one would imply a false capability claim.
    'pinned AWF bounded-agent sbx template and bootstrap',
    // sbx v0.37.1 has no primitive that attaches a sandbox to a named network
    // while denying every peer except one configured endpoint. Local
    // HTTP_PROXY / org-level network policy is advisory, not a hard control,
    // and organization governance can replace it — so it never counts here.
    'sbx named-network attach with mandatory lateral-peer denial to enforce ' +
      'API-proxy-only egress (hard network-policy / capability-token ingress primitive)',
  ];
  if (versionResult.exitCode !== 0 || !version || daemonResult.exitCode !== 0) {
    missing.push('authenticated sbx CLI/daemon');
  }
  if (version && version !== SBX_AUDITED_VERSION) {
    missing.push(`audited sbx version ${SBX_AUDITED_VERSION} (found ${version})`);
  }
  for (const flag of SBX_REQUIRED_CREATE_FLAGS) {
    if (createHelp.exitCode !== 0 || !helpIncludesFlag(createHelp.stdout, flag)) {
      missing.push(`sbx create ${flag}`);
    }
  }
  for (const flag of SBX_REQUIRED_EXEC_FLAGS) {
    if (execHelp.exitCode !== 0 || !helpIncludesFlag(execHelp.stdout, flag)) {
      missing.push(`sbx exec ${flag}`);
    }
  }
  return { supported: missing.length === 0, version, auditedVersion: SBX_AUDITED_VERSION, missing };
};

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const boundedAgentSbxCapabilityTestHelpers = {
  SBX_AUDITED_VERSION,
  SBX_REQUIRED_CREATE_FLAGS,
  SBX_REQUIRED_EXEC_FLAGS,
  helpIncludesFlag,
};
