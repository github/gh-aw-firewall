import * as crypto from 'crypto';
import * as path from 'path';

/**
 * Filesystem layout and fixed container paths for the bounded-agent subsystem.
 *
 * The layout mirrors bounded queries deliberately: broker-private state and
 * the only agent-visible artifacts live in disjoint, run-specific host roots
 * outside `/tmp`, and only the ingress root is mounted into the primary agent.
 * The roots are *separate* from the bounded-query roots so the two subsystems
 * never share seeds, workspaces, audit state, or a ledger.
 *
 * Layout (host side):
 *
 * ```text
 * /var/tmp/awf-bounded-agent-private-<uid>-<workDir digest>/
 *   seeds/<seedId>/     immutable, read-only repository seed (one per repo)
 *   work/               broker-owned per-invocation state (task, schema, result)
 *   control/            broker readiness and other private control state
 *   audit/              protected broker diagnostics (never agent-visible)
 *   seed-map.json       normalized repo -> opaque seed id map (broker input)
 *
 * /var/tmp/awf-bounded-agent-ingress-<uid>-<workDir digest>/
 *   run/                broker Unix socket, shared read-write with the agent
 *   skill/              generated SKILL.md and wrapper, shared read-only
 * ```
 */
export interface BoundedAgentPaths {
  /** Dedicated broker-private host root. Never mounted into the primary agent. */
  root: string;
  /** Immutable per-repository seeds. Mounted read-only into the broker. */
  seedsDir: string;
  /** Broker-owned scratch space for per-invocation enclave state. */
  workDir: string;
  /** Broker-private readiness and control state. */
  controlDir: string;
  /** Parent of the only bounded-agent artifacts visible to the primary agent. */
  ingressRoot: string;
  /** Directory holding the broker's Unix socket, shared with the agent. */
  runDir: string;
  /** Directory holding agent-visible artifacts (the generated SKILL.md). */
  agentDir: string;
  /** Protected broker diagnostics. Never mounted into the agent or an enclave. */
  auditDir: string;
  /** Dedicated API-proxy telemetry. Never mounted into the primary agent. */
  apiProxyLogsDir: string;
  /** Repo → seed map consumed by the broker. */
  seedMapPath: string;
  /** Host path of the broker's Unix socket. */
  socketPath: string;
  /** Host path of the generated skill document. */
  skillPath: string;
  /** Host path of the agent-facing bounded-agent executable. */
  wrapperPath: string;
  /** Broker-private path containing ephemeral sbx ingress capabilities. */
  capabilityPath: string;
}

/** Broker-private state is deliberately outside the agent's broad `/tmp` mount. */
export const BOUNDED_AGENT_PRIVATE_BASE_DIR = '/var/tmp';

/** Name of the broker's Unix domain socket inside {@link BoundedAgentPaths.runDir}. */
export const BOUNDED_AGENT_SOCKET_FILENAME = 'broker.sock';

/** Name of the generated skill document inside {@link BoundedAgentPaths.agentDir}. */
export const BOUNDED_AGENT_SKILL_FILENAME = 'SKILL.md';

/** Name of the generated agent-facing executable. */
export const BOUNDED_AGENT_WRAPPER_FILENAME = 'bounded-agent';

/** Name of the broker-private sbx ingress capability file. */
export const BOUNDED_AGENT_CAPABILITY_FILENAME = 'sbx-ingress.json';

// ── Fixed container paths ────────────────────────────────────────────────────
//
// These are part of the agent-visible contract (the wrapper and the generated
// skill reference them verbatim) and of the broker contract, so they are
// centralized here rather than duplicated across shell/JS/TS.

/** Directory the broker socket is mounted at inside the agent container. */
export const AGENT_SOCKET_DIR = '/run/awf-bounded-agent';

/** Full socket path as seen from inside the agent container. */
export const AGENT_SOCKET_PATH = `${AGENT_SOCKET_DIR}/${BOUNDED_AGENT_SOCKET_FILENAME}`;

/** Directory the generated skill is mounted at inside the agent container. */
export const AGENT_SKILL_DIR = '/run/awf-bounded-agent-skill';

/** Full skill path as seen from inside the agent container. */
export const AGENT_SKILL_PATH = `${AGENT_SKILL_DIR}/${BOUNDED_AGENT_SKILL_FILENAME}`;

/** Seeds mount point inside the broker container (read-only). */
export const BROKER_SEEDS_DIR = '/srv/awf/seeds';

/** Per-invocation scratch mount point inside the broker container. */
export const BROKER_WORK_DIR = '/srv/awf/work';

/** Seed-map mount point inside the broker container (read-only). */
export const BROKER_SEED_MAP_PATH = '/srv/awf/seed-map.json';

/** Socket directory inside the broker container. */
export const BROKER_SOCKET_DIR = '/run/awf-bounded-agent';

/** Protected diagnostics directory inside the broker container. */
export const BROKER_AUDIT_DIR = '/var/log/awf-bounded-agent';

/** Broker-private control directory inside the broker container. */
export const BROKER_CONTROL_DIR = '/run/awf-bounded-agent-control';

/** Docker socket mount point inside the broker container. */
export const BROKER_DOCKER_SOCKET_PATH = '/var/run/docker.sock';

/** Writable working directory mounted into each enclave container. */
export const ENCLAVE_MOUNT_DIR = '/agent';

/** Fixed read-only path the immutable repository seed is mounted at. */
export const ENCLAVE_SEED_PATH = '/awf/seed';

/** Fixed read-only path the caller's bounded task text is mounted at. */
export const ENCLAVE_TASK_PATH = '/awf/task.txt';

/** Fixed read-only path the caller's finite response schema is mounted at. */
export const ENCLAVE_SCHEMA_PATH = '/awf/schema.json';

/** Derives the private root identity without revealing the work-directory path. */
function deriveRootIdentity(awfWorkDir: string): string {
  const uid = process.getuid?.() ?? 0;
  const digest = crypto
    .createHash('sha256')
    .update(path.resolve(awfWorkDir), 'utf8')
    .digest('hex')
    .slice(0, 20);
  return `${uid}-${digest}`;
}

/** Derives every bounded-agent path from the AWF work directory. */
export function resolveBoundedAgentPaths(
  awfWorkDir: string,
  privateBaseDir = BOUNDED_AGENT_PRIVATE_BASE_DIR,
): BoundedAgentPaths {
  const rootIdentity = deriveRootIdentity(awfWorkDir);
  const root = path.join(privateBaseDir, `awf-bounded-agent-private-${rootIdentity}`);
  const ingressRoot = path.join(privateBaseDir, `awf-bounded-agent-ingress-${rootIdentity}`);
  const runDir = path.join(ingressRoot, 'run');
  const agentDir = path.join(ingressRoot, 'skill');
  return {
    root,
    seedsDir: path.join(root, 'seeds'),
    workDir: path.join(root, 'work'),
    controlDir: path.join(root, 'control'),
    ingressRoot,
    runDir,
    agentDir,
    auditDir: path.join(root, 'audit'),
    apiProxyLogsDir: path.join(root, 'api-proxy-logs'),
    seedMapPath: path.join(root, 'seed-map.json'),
    socketPath: path.join(runDir, BOUNDED_AGENT_SOCKET_FILENAME),
    skillPath: path.join(agentDir, BOUNDED_AGENT_SKILL_FILENAME),
    wrapperPath: path.join(agentDir, BOUNDED_AGENT_WRAPPER_FILENAME),
    capabilityPath: path.join(root, 'control', BOUNDED_AGENT_CAPABILITY_FILENAME),
  };
}

/**
 * Normalizes an `owner/repo` slug for allowlist lookups.
 *
 * GitHub treats owner and repository names case-insensitively, so the lookup
 * key is lowercased. The *original* spelling is retained separately by the
 * staging phase for clone-URL construction.
 */
export function normalizeRepoKey(repo: string): string {
  return repo.trim().toLowerCase();
}

/** Generates the random, run-unique identifier used to derive opaque seed ids. */
export function generateBoundedAgentRunId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Derives the opaque on-disk seed directory name for a repository.
 *
 * The identifier is a keyed digest of the run id and the normalized repo, so
 * it is stable within a run, unpredictable across runs, and reveals nothing
 * about the repository name to anything that can observe only the path.
 */
export function deriveSeedId(runId: string, repo: string): string {
  return crypto
    .createHmac('sha256', Buffer.from(runId, 'utf8'))
    .update(normalizeRepoKey(repo), 'utf8')
    .digest('hex')
    .slice(0, 32);
}
