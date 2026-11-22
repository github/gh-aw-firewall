import { constants } from 'fs';
import * as path from 'path';
import type {
  CloudHypervisorIdentity,
  CloudHypervisorManagerDependencies,
} from './manager-types';

export type AuditDependencies = Pick<
  CloudHypervisorManagerDependencies,
  'mkdir' | 'lstat' | 'realpath' | 'open' | 'resolveIdentity'
>;

export class DiagnosticPersistenceCleanupError extends Error {
  readonly cause: unknown;
  readonly cleanupError: unknown;

  constructor(cause: unknown, cleanupError: unknown) {
    super('Diagnostic persistence failed and closing its file failed');
    this.cause = cause;
    this.cleanupError = cleanupError;
  }
}

export async function secureFileHandoff(
  dependencies: AuditDependencies,
  filePath: string,
  identity: CloudHypervisorIdentity,
): Promise<void> {
  const handle = await dependencies.open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Refusing to hand off non-regular or multiply-linked file: ${filePath}`);
    }
    await handle.chmod(0o600);
    await handle.chown(identity.uid, identity.gid);
  } finally {
    await handle.close();
  }
}

async function assertExistingDiagnosticComponents(
  dependencies: AuditDependencies,
  directory: string,
): Promise<void> {
  const absolutePath = path.resolve(directory);
  const root = path.parse(absolutePath).root;
  const segments = absolutePath.slice(root.length).split(path.sep).filter(Boolean);
  const cloudHypervisorIndex = segments.lastIndexOf('cloud-hypervisor');
  if (cloudHypervisorIndex < 0) return;
  const diagnosticsIndex = segments.lastIndexOf('diagnostics');
  const protectedIndex = diagnosticsIndex >= 0 && diagnosticsIndex < cloudHypervisorIndex
    ? diagnosticsIndex
    : cloudHypervisorIndex;
  const anchor = path.join(root, ...segments.slice(0, protectedIndex));
  let existingAncestor = anchor;
  const missingSegments: string[] = [];
  while (true) {
    try {
      await dependencies.realpath(existingAncestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missingSegments.unshift(path.basename(existingAncestor));
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
  let current = await dependencies.realpath(existingAncestor);
  const descendants = [
    ...missingSegments,
    ...segments.slice(protectedIndex),
  ];
  for (const segment of descendants) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await dependencies.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing to use non-directory path component: ${current}`);
    }
    if ((await dependencies.realpath(current)) !== current) {
      throw new Error(`Refusing to use non-canonical directory path: ${current}`);
    }
  }
}

async function realDirectoryPath(
  dependencies: AuditDependencies,
  directory: string,
): Promise<string> {
  const canonicalDirectory = await dependencies.realpath(directory);
  const root = path.parse(canonicalDirectory).root;
  let current = root;
  for (const segment of canonicalDirectory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await dependencies.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing to use non-directory path component: ${current}`);
    }
    if ((await dependencies.realpath(current)) !== current) {
      throw new Error(`Refusing to use non-canonical directory path: ${current}`);
    }
  }
  const requestedStat = await dependencies.lstat(directory);
  if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
    throw new Error(`Refusing to use non-directory path: ${directory}`);
  }
  return canonicalDirectory;
}

export async function prepareAuditDirectory(
  directory: string,
  dependencies: AuditDependencies,
  identity = dependencies.resolveIdentity(),
): Promise<{ identity: CloudHypervisorIdentity; directory: string }> {
  const parent = path.dirname(directory);
  if (path.basename(parent) === 'cloud-hypervisor') {
    await prepareAuditDirectory(parent, dependencies, identity);
  }
  await assertExistingDiagnosticComponents(dependencies, directory);
  await dependencies.mkdir(directory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await realDirectoryPath(dependencies, directory);
  const handle = await dependencies.open(
    canonicalDirectory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new Error(`Refusing to use non-directory path: ${canonicalDirectory}`);
    }
    await handle.chmod(0o700);
    await handle.chown(identity.uid, identity.gid);
  } finally {
    await handle.close();
  }
  return { identity, directory: canonicalDirectory };
}

export async function prepareRootOwnedDebugDirectory(
  directory: string,
  protectedRoot: string,
  dependencies: AuditDependencies,
  identity: CloudHypervisorIdentity = { uid: 0, gid: 0 },
): Promise<{ identity: CloudHypervisorIdentity; directory: string }> {
  const canonicalRoot = path.resolve(protectedRoot);
  const canonicalDirectory = path.resolve(directory);
  const relative = path.relative(canonicalRoot, canonicalDirectory);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Public enclave debug artifacts must be stored below their protected root');
  }
  let ancestor = path.parse(canonicalDirectory).root;
  for (const component of canonicalDirectory.slice(ancestor.length).split(path.sep)) {
    ancestor = path.join(ancestor, component);
    try {
      const stat = await dependencies.lstat(ancestor);
      if (stat.isSymbolicLink() || !stat.isDirectory()
        || (stat.uid !== 0 && stat.uid !== identity.uid) || (stat.mode & 0o022) !== 0) {
        throw new Error('Unsafe protected public diagnostic path ancestor');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  await assertExistingDiagnosticComponents(dependencies, canonicalDirectory);
  const components = relative.split(path.sep);
  let current = canonicalRoot;
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    await dependencies.mkdir(current, { recursive: true, mode: 0o700 });
    const canonicalCurrent = await realDirectoryPath(dependencies, current);
    if (canonicalCurrent !== current) throw new Error('Public diagnostic path has symlink ancestors');
    const handle = await dependencies.open(
      canonicalCurrent,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isDirectory() || stat.uid !== identity.uid || (stat.mode & 0o022) !== 0) {
        throw new Error(`Refusing to use non-directory path: ${canonicalCurrent}`);
      }
      await handle.chmod(0o700);
      await handle.chown(identity.uid, identity.gid);
      await handle.sync?.();
    } finally {
      await handle.close();
    }
  }
  return { identity, directory: await realDirectoryPath(dependencies, canonicalDirectory) };
}

export async function writeAuditFile(
  dependencies: AuditDependencies,
  destination: string,
  contents: string | Buffer,
  identity: CloudHypervisorIdentity,
): Promise<void> {
  const handle = await dependencies.open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let failure: { error: unknown } | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Refusing to write non-regular or multiply-linked file: ${destination}`);
    }
    await handle.chmod(0o600);
    await handle.chown(identity.uid, identity.gid);
    await handle.truncate(0);
    await handle.writeFile(contents);
    await handle.chmod(0o600);
    await handle.sync?.();
  } catch (error) {
    failure = { error };
  }
  try {
    await handle.close();
  } catch (cleanupError) {
    if (failure) throw new DiagnosticPersistenceCleanupError(failure.error, cleanupError);
    throw cleanupError;
  }
  if (failure) throw failure.error;
}
