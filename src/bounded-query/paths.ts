import * as crypto from 'crypto';
import * as path from 'path';

/**
 * Filesystem layout and fixed container paths for the bounded-query subsystem.
 *
 * Broker-private state and the only agent-visible artifacts live in disjoint,
 * run-specific host roots outside `/tmp`. Only the ingress roots are mounted
 * into the primary agent.
 *
 * Layout (host side):
 *
 * ```text
 * /var/tmp/awf-bounded-query-private-<uid>-<workDir digest>/
 *   seeds/<seedId>/     immutable, read-only repository seed (one per repo)
 *   work/               broker-owned per-invocation writable copies
 *   control/            broker readiness and other private control state
 *   audit/              protected broker diagnostics (never agent-visible)
 *   seed-map.json       normalized repo -> opaque seed id map (broker input)
 *   control/sbx-ingress.json  ephemeral sbx ingress capabilities
 *
 * /var/tmp/awf-bounded-query-ingress-<uid>-<workDir digest>/
 *   run/                broker Unix socket, shared read-write with the agent
 *   skill/              generated SKILL.md and wrapper, shared read-only
 * ```
 */
export interface BoundedQueryPaths {
  /** Dedicated broker-private host root. Never mounted into the primary agent. */
  root: string;
  /** Immutable per-repository seeds. Mounted read-only into the broker. */
  seedsDir: string;
  /** Broker-owned scratch space for per-invocation writable repo copies. */
  workDir: string;
  /** Broker-private readiness and control state. */
  controlDir: string;
  /** Parent of the only bounded-query artifacts visible to the primary agent. */
  ingressRoot: string;
  /** Directory holding the broker's Unix socket, shared with the agent. */
  runDir: string;
  /** Directory holding agent-visible artifacts (the generated SKILL.md). */
  agentDir: string;
  /** Protected broker diagnostics. Never mounted into the agent or a query. */
  auditDir: string;
  /** Repo → seed map consumed by the broker. */
  seedMapPath: string;
  /** Host path of the broker's Unix socket. */
  socketPath: string;
  /** Host path of the generated skill document. */
  skillPath: string;
  /** Host path of the agent-facing bounded-query executable. */
  wrapperPath: string;
  /** Broker-private path containing ephemeral sbx ingress capabilities. */
  capabilityPath: string;
}

/** Broker-private state is deliberately outside the agent's broad `/tmp` mount. */
export const BOUNDED_QUERY_PRIVATE_BASE_DIR = '/var/tmp';

/** Name of the broker's Unix domain socket inside {@link BoundedQueryPaths.runDir}. */
export const BOUNDED_QUERY_SOCKET_FILENAME = 'broker.sock';

/** Name of the generated skill document inside {@link BoundedQueryPaths.agentDir}. */
export const BOUNDED_QUERY_SKILL_FILENAME = 'SKILL.md';

/** Name of the generated agent-facing executable. */
export const BOUNDED_QUERY_WRAPPER_FILENAME = 'bounded-query';

/** Name of the broker-private sbx ingress capability file. */
export const BOUNDED_QUERY_CAPABILITY_FILENAME = 'sbx-ingress.json';

// ── Fixed container paths ────────────────────────────────────────────────────
//
// These are part of the agent-visible contract (the wrapper and the generated
// skill reference them verbatim) and of the broker contract, so they are
// centralized here rather than duplicated across shell/JS/TS.

/** Directory the broker socket is mounted at inside the agent container. */
export const AGENT_SOCKET_DIR = '/run/awf-bounded-query';

/** Full socket path as seen from inside the agent container. */
export const AGENT_SOCKET_PATH = `${AGENT_SOCKET_DIR}/${BOUNDED_QUERY_SOCKET_FILENAME}`;

/** Directory the generated skill is mounted at inside the agent container. */
export const AGENT_SKILL_DIR = '/run/awf-bounded-query-skill';

/** Full skill path as seen from inside the agent container. */
export const AGENT_SKILL_PATH = `${AGENT_SKILL_DIR}/${BOUNDED_QUERY_SKILL_FILENAME}`;

/** Seeds mount point inside the broker container (read-only). */
export const BROKER_SEEDS_DIR = '/srv/awf/seeds';

/** Per-invocation scratch mount point inside the broker container. */
export const BROKER_WORK_DIR = '/srv/awf/work';

/** Seed-map mount point inside the broker container (read-only). */
export const BROKER_SEED_MAP_PATH = '/srv/awf/seed-map.json';

/** Socket directory inside the broker container. */
export const BROKER_SOCKET_DIR = '/run/awf-bounded-query';

/** Protected diagnostics directory inside the broker container. */
export const BROKER_AUDIT_DIR = '/var/log/awf-bounded-query';

/** Broker-private control directory inside the broker container. */
export const BROKER_CONTROL_DIR = '/run/awf-bounded-query-control';

/** Docker socket mount point inside the broker container. */
export const BROKER_DOCKER_SOCKET_PATH = '/var/run/docker.sock';

/** Writable working directory mounted into each query container. */
export const QUERY_MOUNT_DIR = '/query';

/** Fixed read-only path the submitted query script is mounted at. */
export const QUERY_SCRIPT_PATH = '/awf/query-script.py';

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

/** Derives every bounded-query path from the AWF work directory. */
export function resolveBoundedQueryPaths(
  awfWorkDir: string,
  privateBaseDir = BOUNDED_QUERY_PRIVATE_BASE_DIR,
): BoundedQueryPaths {
  const rootIdentity = deriveRootIdentity(awfWorkDir);
  const root = path.join(privateBaseDir, `awf-bounded-query-private-${rootIdentity}`);
  const ingressRoot = path.join(privateBaseDir, `awf-bounded-query-ingress-${rootIdentity}`);
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
    seedMapPath: path.join(root, 'seed-map.json'),
    socketPath: path.join(runDir, BOUNDED_QUERY_SOCKET_FILENAME),
    skillPath: path.join(agentDir, BOUNDED_QUERY_SKILL_FILENAME),
    wrapperPath: path.join(agentDir, BOUNDED_QUERY_WRAPPER_FILENAME),
    capabilityPath: path.join(root, 'control', BOUNDED_QUERY_CAPABILITY_FILENAME),
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
export function generateBoundedQueryRunId(): string {
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
