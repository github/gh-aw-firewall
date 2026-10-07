import * as path from 'path';

export type SensitivePathRuntime = 'docker' | 'cloud-hypervisor' | 'nvx';

export interface SensitivePath {
  readonly id: string;
  readonly path: string;
  readonly reason: string;
  readonly exposure: 'read';
  readonly appliesTo: readonly SensitivePathRuntime[];
}

export const SENSITIVE_PATHS: readonly SensitivePath[] = [
  {
    id: 'mcp-logs',
    path: '/tmp/gh-aw/mcp-logs',
    reason: 'mcpg logs contain pre-filter tool-call payloads (github/gh-aw-firewall#9204)',
    exposure: 'read',
    appliesTo: ['docker', 'cloud-hypervisor', 'nvx'],
  },
  {
    id: 'work-directory',
    path: '$workDir',
    reason: 'docker-compose.yml in workDir contains plaintext tokens and API keys',
    exposure: 'read',
    appliesTo: ['docker'],
  },
  {
    id: 'firewall-logs',
    path: '/tmp/gh-aw/sandbox/firewall/logs',
    reason: 'Squid access logs reveal the configured egress policy',
    exposure: 'read',
    appliesTo: ['docker', 'cloud-hypervisor', 'nvx'],
  },
  {
    id: 'firewall-audit',
    path: '/tmp/gh-aw/sandbox/firewall/audit',
    reason: 'Firewall audit output may reveal policy and request details',
    exposure: 'read',
    appliesTo: ['docker', 'cloud-hypervisor', 'nvx'],
  },
];

export const SENSITIVE_PATH_EXEMPTIONS = [
  {
    path: '/tmp/gh-aw/mcp-payloads',
    reason:
      'mcpg spills payloads after jq filtering, segments them by session, and instructs the agent to read them at payloadPath',
  },
] as const;

/**
 * Existing export roots with intentional guest visibility. `sandbox` can
 * contain other children, but registered firewall logs and audit directories
 * below it are still masked independently.
 */
export const EXPLICITLY_SAFE_GH_AW_CHILDREN = [
  '.cache',
  '.config',
  '.local',
  'agent',
  'cache',
  'home',
  'sandbox',
] as const;

export interface ResolvedSensitivePath extends Omit<SensitivePath, 'path'> {
  readonly path: string;
}

export interface SensitivePathAuditEntry {
  readonly id: string;
  readonly path: string;
  readonly reason: string;
  readonly targets?: readonly string[];
}

export function createSensitivePathAudit(
  runtime: SensitivePathRuntime,
  maskedPaths: readonly SensitivePathAuditEntry[],
  unclassifiedPaths: readonly string[] = [],
): {
  readonly runtime: SensitivePathRuntime;
  readonly maskedPaths: readonly SensitivePathAuditEntry[];
  readonly exemptions: typeof SENSITIVE_PATH_EXEMPTIONS;
  readonly unclassifiedPaths: readonly string[];
} {
  return {
    runtime,
    maskedPaths,
    exemptions: SENSITIVE_PATH_EXEMPTIONS,
    unclassifiedPaths,
  };
}

export function resolveSensitivePaths(
  runtime: SensitivePathRuntime,
  options: { readonly workDir?: string } = {},
): ResolvedSensitivePath[] {
  return SENSITIVE_PATHS
    .filter((entry) => entry.appliesTo.includes(runtime))
    .map((entry) => {
      if (entry.path !== '$workDir') return { ...entry };
      if (
        !options.workDir ||
        !path.posix.isAbsolute(options.workDir) ||
        path.posix.normalize(options.workDir) !== options.workDir ||
        options.workDir === '/'
      ) {
        throw new Error(`Sensitive path "${entry.id}" requires a clean, absolute, non-root workDir`);
      }
      return { ...entry, path: options.workDir };
    });
}

export function dockerSensitiveTmpfs(workDir: string): string[] {
  const entries = resolveSensitivePaths('docker', { workDir });
  const targets = new Set<string>();
  for (const entry of entries) {
    for (const target of dockerSensitivePathTargets(entry.path)) targets.add(target);
  }
  return [...targets].map((target) => `${target}:rw,noexec,nosuid,size=1m`);
}

export function dockerSensitivePathTargets(sensitivePath: string): string[] {
  return [sensitivePath, path.posix.join('/host', sensitivePath)];
}
