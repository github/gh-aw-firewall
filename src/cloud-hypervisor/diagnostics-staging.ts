import { constants } from 'fs';
import * as path from 'path';
import type {
  CloudHypervisorIdentity,
  CloudHypervisorManagerDependencies,
  CloudHypervisorRunPaths,
} from './manager-types';
import type { VirtiofsdDevice } from './virtiofsd';
import { redactSensitiveValues } from '../redact-secrets';
import { redactPublicEnclaveText } from '../enclave/public-debug-redaction';
import type { BoundedOutputCapture } from './diagnostics-capture';
import {
  prepareAuditDirectory,
  prepareRootOwnedDebugDirectory,
  secureFileHandoff,
  writeAuditFile,
  type AuditDependencies,
} from './diagnostics-paths';

/**
 * Creates the private run-directory chain with real traversal
 * permissions for the non-root target identity: the two ancestor
 * levels (`CLOUD_HYPERVISOR_RUN_ROOT` and the per-binary directory
 * beneath it) are `0711` root-owned (executable/traversable by any uid,
 * but not listable), and only the per-run leaf directory is chowned to
 * the target identity with `0700` (so only that identity, or root, can
 * actually read its contents). See the `CLOUD_HYPERVISOR_RUN_ROOT`
 * comment in `./manager-types.ts` for why this can't simply live under
 * `workDir`.
 */
export async function prepareRunDirectory(
  dependencies: CloudHypervisorManagerDependencies,
  paths: CloudHypervisorRunPaths,
  identity: CloudHypervisorIdentity,
): Promise<void> {
  const binaryDir = path.dirname(paths.runDirectory);
  await dependencies.mkdir(paths.runBaseDir, { recursive: true, mode: 0o711 });
  await dependencies.chmod(paths.runBaseDir, 0o711);
  await dependencies.mkdir(binaryDir, { recursive: true, mode: 0o711 });
  await dependencies.chmod(binaryDir, 0o711);
  await dependencies.mkdir(paths.runDirectory, { recursive: true, mode: 0o700 });
  await dependencies.chown(paths.runDirectory, identity.uid, identity.gid);
}

export async function stageArtifact(
  dependencies: CloudHypervisorManagerDependencies,
  source: string,
  destination: string,
  mode: number,
  identity: CloudHypervisorIdentity,
  copy?: () => Promise<void>,
): Promise<void> {
  if (copy) await copy();
  else await dependencies.copyFile(source, destination, constants.COPYFILE_EXCL);
  await dependencies.chown(destination, identity.uid, identity.gid);
  await dependencies.chmod(destination, mode);
}

export async function stageDiagnosticFile(
  dependencies: CloudHypervisorManagerDependencies,
  destination: string,
  identity: CloudHypervisorIdentity,
): Promise<void> {
  const handle = await dependencies.open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Refusing to create non-regular diagnostic file: ${destination}`);
    }
    await handle.chmod(0o600);
    await handle.chown(identity.uid, identity.gid);
  } finally {
    await handle.close();
  }
}

export async function preserveVirtiofsdStartupEvidence(
  dependencies: CloudHypervisorManagerDependencies,
  devices: readonly VirtiofsdDevice[],
  directory: string,
): Promise<void> {
  if (devices.length === 0) return;
  const { identity, directory: auditDirectory } = await prepareAuditDirectory(directory, dependencies);
  for (const device of devices) {
    try {
      const destination = path.join(auditDirectory, path.basename(device.evidencePath));
      await dependencies.copyFile(device.evidencePath, destination, constants.COPYFILE_EXCL);
      await secureFileHandoff(dependencies, destination, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Host-owned finite evidence; independent of VM stop/diagnostic collection. */
export async function preserveHostExecutorInvocationEvidence(
  directory: string,
  evidence: readonly { name: string; contents: string }[],
  dependencies: AuditDependencies,
): Promise<void> {
  if (!evidence.length) return;
  const prepared = await prepareAuditDirectory(directory, dependencies);
  for (const item of evidence) {
    if (!/^[a-f0-9]{32}-[a-f0-9]{32}\.json$/.test(item.name)) {
      throw new Error('Invalid host executor diagnostic filename');
    }
    await writeAuditFile(dependencies, path.join(prepared.directory, item.name), item.contents, prepared.identity);
  }
}

/** Retain public-only engine evidence without widening ordinary audit disclosure. */
export async function preservePublicEnclaveSession(
  directory: string,
  protectedRoot: string,
  contents: string,
  secrets: string[],
  dependencies: AuditDependencies,
): Promise<void> {
  const prepared = await prepareRootOwnedDebugDirectory(directory, protectedRoot, dependencies);
  const forms = secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]);
  const redacted = redactPublicEnclaveText(Buffer.from(redactSensitiveValues(contents, forms)), secrets).toString()
    .replace(/\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n"\\]+/gi, '$1[REDACTED]')
    .replace(/\bbearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED]');
  await writeAuditFile(
    dependencies,
    path.join(prepared.directory, 'enclave-session.log'),
    Buffer.from(redacted).subarray(0, 1024 * 1024),
    prepared.identity,
  );
}

export async function writeGuestOutputAudit(
  directory: string,
  dependencies: AuditDependencies,
  stdoutCapture: BoundedOutputCapture,
  stderrCapture: BoundedOutputCapture,
  secrets?: readonly string[],
  protectedRoot?: string,
): Promise<void> {
  const { identity, directory: auditDirectory } = protectedRoot
    ? await prepareRootOwnedDebugDirectory(directory, protectedRoot, dependencies)
    : await prepareAuditDirectory(directory, dependencies);
  await writeAuditFile(
    dependencies,
    path.join(auditDirectory, 'guest-stdout.raw.log'),
    protectedRoot ? redactPublicEnclaveText(stdoutCapture.publicContents(), secrets ?? []) : stdoutCapture.contents(),
    identity,
  );
  await writeAuditFile(
    dependencies,
    path.join(auditDirectory, 'guest-stderr.raw.log'),
    protectedRoot ? redactPublicEnclaveText(stderrCapture.publicContents(), secrets ?? []) : stderrCapture.contents(),
    identity,
  );
}
