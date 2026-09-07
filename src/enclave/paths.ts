import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface EnclavePaths {
  root: string;
  seedsDir: string;
  workDir: string;
  controlDir: string;
  auditDir: string;
  /** Dedicated agent-enclave API-proxy telemetry. Never agent-visible. */
  apiProxyLogsDir: string;
  seedMapPath: string;
  ingressRoot: string;
  runDir: string;
  capabilityPath: string;
  githubAgentIdPath: string;
  /**
   * AWF-private, never-mounted custody file for the mcpg delegation-control
   * endpoint. Only the AWF host process can reach that endpoint, so this path
   * is deliberately outside every container bind mount.
   */
  delegationEndpointPath: string;
  /** AWF-private, never-mounted custody file for the control capability. */
  delegationCapabilityPath: string;
  /**
   * Host-only structured audit stream for delegation admission, identity
   * lifecycle, usage settlement, revocation, and reconciliation. It lives
   * outside every bind mount so a compromised broker cannot read it.
   */
  delegationAuditPath: string;
  /**
   * Private request/response directory shared with the enclave MCP broker so
   * it can route a dynamic `enclave_run_agent` through host-side admission.
   * It carries admission requests, canonical outcomes, and settlement
   * receipts — never the control endpoint, the control capability, an identity
   * handle, the envelope, or repository content.
   */
  delegationChannelDir: string;
  /**
   * AWF-private record of this run's enclave run id, so teardown can reconcile
   * orphaned containers without a seed catalog. Dynamic-only runs stage no
   * seed map at all.
   */
  runIdPath: string;
}

export const ENCLAVE_PRIVATE_BASE_DIR = '/var/tmp';
export const ENCLAVE_CAPABILITY_FILENAME = 'auth-token';
export const ENCLAVE_GITHUB_AGENT_ID_FILENAME = 'github-agent-id';

export const ENCLAVE_SERVER_SEEDS_DIR = '/srv/awf/seeds';
export const ENCLAVE_SERVER_WORK_DIR = '/srv/awf/work';
export const ENCLAVE_SERVER_SEED_MAP_PATH = '/srv/awf/seed-map.json';
export const ENCLAVE_SERVER_CAPABILITY_DIR = '/run/awf-enclave-mcp';
export const ENCLAVE_SERVER_CAPABILITY_PATH = `${ENCLAVE_SERVER_CAPABILITY_DIR}/${ENCLAVE_CAPABILITY_FILENAME}`;
export const ENCLAVE_SERVER_GITHUB_AGENT_ID_PATH =
  `${ENCLAVE_SERVER_CAPABILITY_DIR}/${ENCLAVE_GITHUB_AGENT_ID_FILENAME}`;
export const ENCLAVE_SERVER_CONTROL_DIR = '/run/awf-enclave-mcp-control';
/**
 * Broker-side mount point of {@link EnclavePaths.delegationChannelDir}.
 *
 * The broker writes admission requests and settlement receipts here and reads
 * AWF's canonical outcomes back. It is intentionally *not* the control
 * endpoint: mcpg's control listener is published on the runner's own
 * `127.0.0.1` only, so no container can reach it.
 */
export const ENCLAVE_SERVER_DELEGATION_CHANNEL_DIR = '/run/awf-enclave-delegation';
export const ENCLAVE_SERVER_AUDIT_DIR = '/var/log/awf-enclave';
export const ENCLAVE_SERVER_DOCKER_SOCKET_PATH = '/var/run/docker.sock';

function deriveRootIdentity(awfWorkDir: string): string {
  const uid = process.getuid?.() ?? 0;
  const digest = crypto.createHash('sha256').update(path.resolve(awfWorkDir), 'utf8').digest('hex').slice(0, 20);
  return `${uid}-${digest}`;
}

export function resolveEnclavePaths(
  awfWorkDir: string,
  privateBaseDir = ENCLAVE_PRIVATE_BASE_DIR,
): EnclavePaths {
  const identity = deriveRootIdentity(awfWorkDir);
  const root = path.join(privateBaseDir, `awf-enclave-private-${identity}`);
  const ingressRoot = path.join(privateBaseDir, `awf-enclave-control-${identity}`);
  const runDir = path.join(ingressRoot, 'run');
  return {
    root,
    seedsDir: path.join(root, 'seeds'),
    workDir: path.join(root, 'work'),
    controlDir: path.join(root, 'control'),
    auditDir: path.join(root, 'audit'),
    apiProxyLogsDir: path.join(root, 'api-proxy-logs'),
    seedMapPath: path.join(root, 'seed-map.json'),
    ingressRoot,
    runDir,
    capabilityPath: path.join(runDir, ENCLAVE_CAPABILITY_FILENAME),
    githubAgentIdPath: path.join(runDir, ENCLAVE_GITHUB_AGENT_ID_FILENAME),
    delegationEndpointPath: path.join(root, 'delegation-endpoint'),
    delegationCapabilityPath: path.join(root, 'delegation-capability'),
    delegationAuditPath: path.join(root, 'delegation-audit.jsonl'),
    runIdPath: path.join(root, 'run-id'),
    delegationChannelDir: path.join(root, 'delegation-channel'),
  };
}

export function generateEnclaveRunId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Reads the AWF-private enclave run id staged by `prepareEnclaves`.
 *
 * A dynamic-only run has no seed catalog to carry the id, so it is written to
 * its own `0600` file inside the private root.
 */
export function readEnclaveRunId(paths: EnclavePaths): string | undefined {
  try {
    const raw = fs.readFileSync(paths.runIdPath, 'ascii').trim();
    return /^[0-9a-f]{16,64}$/.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function deriveEnclaveSeedId(runId: string, repo: string): string {
  return crypto.createHash('sha256').update(`${runId}\0${repo.toLowerCase()}`, 'utf8').digest('hex').slice(0, 32);
}
