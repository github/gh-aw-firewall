import * as crypto from 'crypto';
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
}

export const ENCLAVE_PRIVATE_BASE_DIR = '/var/tmp';
export const ENCLAVE_CAPABILITY_FILENAME = 'auth-token';

export const ENCLAVE_SERVER_SEEDS_DIR = '/srv/awf/seeds';
export const ENCLAVE_SERVER_WORK_DIR = '/srv/awf/work';
export const ENCLAVE_SERVER_SEED_MAP_PATH = '/srv/awf/seed-map.json';
export const ENCLAVE_SERVER_CAPABILITY_DIR = '/run/awf-enclave-mcp';
export const ENCLAVE_SERVER_CAPABILITY_PATH = `${ENCLAVE_SERVER_CAPABILITY_DIR}/${ENCLAVE_CAPABILITY_FILENAME}`;
export const ENCLAVE_SERVER_CONTROL_DIR = '/run/awf-enclave-mcp-control';
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
  };
}

export function generateEnclaveRunId(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function deriveEnclaveSeedId(runId: string, repo: string): string {
  return crypto.createHash('sha256').update(`${runId}\0${repo.toLowerCase()}`, 'utf8').digest('hex').slice(0, 32);
}
