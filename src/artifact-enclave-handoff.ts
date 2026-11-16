import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { logger } from './logger';
import { getLocalDockerEnv } from './host-env';
import { ENCLAVE_MCP_SERVER_CONTAINER_NAME } from './constants';
import { openArtifactDirectory, resolveArtifactOwner } from './resolved-config-artifact';

const ENCLAVE_SESSION_DIR = 'sessions';
const ENCLAVE_AUDIT_FILES = [
  { source: 'enclave.jsonl', destination: 'enclave.jsonl' },
  { source: 'runtime-telemetry.jsonl', destination: 'enclave-runtime.jsonl' },
  { source: 'enclave-host-executor.jsonl', destination: 'enclave-host-executor.jsonl' },
] as const;
export const PRIVATE_ENCLAVE_AUDIT_FILE = 'enclave-host-executor.jsonl';
type EnclaveArtifactCopyResult = { exitCode: number | null; stderr: string };

function isSafeAuditDestination(
  directoryFd: number,
  directoryPath: string,
  name: string,
  directory = false,
): boolean {
  try {
    const stat = fs.lstatSync(`/proc/self/fd/${directoryFd}/${name}`);
    if (!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())) {
      return true;
    }
    logger.warn(`Refusing to preserve audit artifact at unsafe destination: ${path.join(directoryPath, name)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    logger.warn(`Could not validate audit artifact destination: ${path.join(directoryPath, name)}`, error);
  }
  return false;
}

function handoffPrivateEnclaveAuditInDirectory(
  directoryFd: number,
  fileName: (typeof ENCLAVE_AUDIT_FILES)[number]['destination'],
): void {
  const owner = resolveArtifactOwner();
  const fd = fs.openSync(`/proc/self/fd/${directoryFd}/${fileName}`,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    const mode = stat.mode & 0o777;
    if (!stat.isFile() || stat.nlink !== 1 ||
        (mode !== 0o600 && !(mode === 0o644 && fileName !== PRIVATE_ENCLAVE_AUDIT_FILE)) ||
        (stat.uid !== process.getuid?.() && stat.uid !== owner.uid) ||
        stat.size > 32 * 1024 * 1024) {
      throw new Error('Unsafe private enclave audit handoff');
    }
    fs.fchmodSync(fd, 0o600);
    fs.fchownSync(fd, owner.uid, owner.gid);
  } finally {
    fs.closeSync(fd);
  }
}

function copyEnclaveArtifact(
  directoryFd: number,
  directoryPath: string,
  source: string,
  name: string,
  directory: boolean,
): EnclaveArtifactCopyResult {
  if (!isSafeAuditDestination(directoryFd, directoryPath, name, directory)) {
    throw new Error(`Unsafe enclave artifact destination: ${name}`);
  }
  const stagingPath = fs.mkdtempSync(`/proc/self/fd/${directoryFd}/.awf-enclave-audit-`);
  fs.chmodSync(stagingPath, 0o700);
  let stagingFd: number | undefined;
  try {
    stagingFd = fs.openSync(
      stagingPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const stagedPath = `/proc/self/fd/${stagingFd}/${name}`;
    const result = execa.sync(
      'docker',
      ['cp', source, `/proc/${process.pid}/fd/${stagingFd}/${name}`],
      { env: getLocalDockerEnv(), reject: false },
    );
    if (result.exitCode !== 0) return result;

    const stagedStat = fs.lstatSync(stagedPath);
    if (stagedStat.isSymbolicLink() || (directory ? !stagedStat.isDirectory() : !stagedStat.isFile())) {
      throw new Error(`Unsafe staged enclave artifact: ${name}`);
    }
    if (!isSafeAuditDestination(directoryFd, directoryPath, name, directory)) {
      throw new Error(`Unsafe enclave artifact destination: ${name}`);
    }
    fs.renameSync(stagedPath, `/proc/self/fd/${directoryFd}/${name}`);
    return result;
  } finally {
    if (stagingFd !== undefined) fs.closeSync(stagingFd);
    fs.rmSync(stagingPath, { recursive: true, force: true });
  }
}

/** @internal Final broker copy only: never widen access to its payload-bearing records. */
// ts-prune-ignore-next
export function handoffPrivateEnclaveAudit(
  directory: string,
  fileName: (typeof ENCLAVE_AUDIT_FILES)[number]['destination'] = PRIVATE_ENCLAVE_AUDIT_FILE,
): void {
  if (!ENCLAVE_AUDIT_FILES.some(file => file.destination === fileName)) {
    throw new Error('Invalid enclave audit role');
  }
  const directoryFd = openArtifactDirectory(directory);
  try {
    handoffPrivateEnclaveAuditInDirectory(directoryFd, fileName);
  } finally {
    fs.closeSync(directoryFd);
  }
}

export function preserveEnclaveAudit(auditDirectoryFd: number, targetAuditDir: string): boolean {
  let complete = true;
  for (const auditFile of ENCLAVE_AUDIT_FILES) {
    try {
      const source = `${ENCLAVE_MCP_SERVER_CONTAINER_NAME}:/var/log/awf-enclave/${auditFile.source}`;
      const result = copyEnclaveArtifact(
        auditDirectoryFd,
        targetAuditDir,
        source,
        auditFile.destination,
        false,
      );
      if (result.exitCode === 0) {
        if (auditFile.destination === PRIVATE_ENCLAVE_AUDIT_FILE) {
          handoffPrivateEnclaveAuditInDirectory(auditDirectoryFd, auditFile.destination);
        }
        logger.debug(`Copied enclave MCP server ${auditFile.source} to audit directory`);
      } else {
        complete = false;
        logger.debug(`Could not copy enclave ${auditFile.source}:`, result.stderr);
      }
    } catch {
      complete = false;
      logger.error('Protected enclave audit handoff failed (role=broker-audit, reason=unsafe-or-inaccessible).');
    }
  }
  try {
    const source = `${ENCLAVE_MCP_SERVER_CONTAINER_NAME}:/var/log/awf-enclave/${ENCLAVE_SESSION_DIR}`;
    const result = copyEnclaveArtifact(
      auditDirectoryFd,
      targetAuditDir,
      source,
      'enclave-agent-sessions',
      true,
    );
    if (result.exitCode === 0) {
      logger.debug('Copied enclave agent sessions to audit directory');
    } else {
      logger.debug('Could not copy enclave agent sessions:', result.stderr);
    }
  } catch {
    logger.debug('Could not copy enclave agent sessions: unsafe destination or staging');
  }
  return complete;
}
