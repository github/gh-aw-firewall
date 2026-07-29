import * as crypto from 'crypto';
import * as path from 'path';

/**
 * Filesystem layout and fixed container paths for the bounded-query subsystem.
 *
 * Everything bounded queries need lives under a single run-unique subtree of
 * `config.workDir` so that the existing work-directory hardening (0700,
 * symlink rejection, end-of-run removal) applies to it unchanged.
 *
 * Layout (host side):
 *
 * ```text
 * <workDir>/bounded-queries/
 *   seeds/<seedId>/     immutable, read-only repository seed (one per repo)
 *   work/               broker-owned per-invocation writable copies
 *   run/                broker Unix socket, shared read-write with the agent
 *   agent/              generated SKILL.md, shared read-only with the agent
 *   audit/              protected broker diagnostics (never agent-visible)
 *   seed-map.json       normalized repo -> opaque seed id map (broker input)
 * ```
 */
export interface BoundedQueryPaths {
  /** `<workDir>/bounded-queries` — parent of every bounded-query artifact. */
  root: string;
  /** Immutable per-repository seeds. Mounted read-only into the broker. */
  seedsDir: string;
  /** Broker-owned scratch space for per-invocation writable repo copies. */
  workDir: string;
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
  /**
   * Empty directory used to mask the entire bounded-query root from the agent's
   * broad `/tmp` bind mount.
   *
   * The agent receives `run/` (socket) and `agent/` (skill) as separate,
   * more-specific bind mounts at different container paths. The parent
   * `<workDir>/bounded-queries/` is masked with this empty directory so the
   * agent cannot enumerate seeds, work, audit, or the seed-map through `/tmp`.
   * Located OUTSIDE the bounded-query root to avoid self-referential masking.
   */
  maskDir: string;
}

/** Name of the broker's Unix domain socket inside {@link BoundedQueryPaths.runDir}. */
export const BOUNDED_QUERY_SOCKET_FILENAME = 'broker.sock';

/** Name of the generated skill document inside {@link BoundedQueryPaths.agentDir}. */
export const BOUNDED_QUERY_SKILL_FILENAME = 'SKILL.md';

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

/** Docker socket mount point inside the broker container. */
export const BROKER_DOCKER_SOCKET_PATH = '/var/run/docker.sock';

/** Writable working directory mounted into each query container. */
export const QUERY_MOUNT_DIR = '/query';

/** Fixed read-only path the submitted query script is mounted at. */
export const QUERY_SCRIPT_PATH = '/awf/query-script.py';

/** Derives every bounded-query path from the AWF work directory. */
export function resolveBoundedQueryPaths(awfWorkDir: string): BoundedQueryPaths {
  const root = path.join(awfWorkDir, 'bounded-queries');
  const runDir = path.join(root, 'run');
  const agentDir = path.join(root, 'agent');
  return {
    root,
    seedsDir: path.join(root, 'seeds'),
    workDir: path.join(root, 'work'),
    runDir,
    agentDir,
    auditDir: path.join(root, 'audit'),
    seedMapPath: path.join(root, 'seed-map.json'),
    socketPath: path.join(runDir, BOUNDED_QUERY_SOCKET_FILENAME),
    skillPath: path.join(agentDir, BOUNDED_QUERY_SKILL_FILENAME),
    // Sibling of the bounded-query root — never inside it — so the mask mount
    // does not accidentally mask itself.
    maskDir: path.join(awfWorkDir, 'bounded-queries-mask'),
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
