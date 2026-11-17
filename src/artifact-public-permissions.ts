import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { PRIVATE_ENCLAVE_AUDIT_FILE } from './artifact-enclave-handoff';

export function chmodRuntimeArtifacts(targetDir: string, mode: 'recursive' | 'direct-files'): void {
  if (mode === 'recursive') {
    execa.sync('chmod', ['-R', 'a+rX', targetDir]);
    return;
  }

  execa.sync('chmod', ['a+rX', targetDir]);
  const directFiles = fs
    .readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(targetDir, entry.name));
  if (directFiles.length > 0) {
    execa.sync('chmod', ['a+rX', ...directFiles]);
  }
}

export function publicArtifactPaths(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.name === PRIVATE_ENCLAVE_AUDIT_FILE) return [];
    if (entry.isDirectory() && entry.name === 'cloud-hypervisor') return [];
    if (entry.isDirectory() && entry.name === 'diagnostics') {
      return publicArtifactPaths(entryPath);
    }
    return [entryPath];
  });
}

function isRealDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function hasPrivateDiagnostics(directory: string): boolean {
  return fs.existsSync(path.join(directory, PRIVATE_ENCLAVE_AUDIT_FILE)) ||
    isRealDirectory(path.join(directory, 'cloud-hypervisor')) ||
    (isRealDirectory(path.join(directory, 'diagnostics')) &&
      isRealDirectory(path.join(directory, 'diagnostics', 'cloud-hypervisor')));
}

export function chmodPublicArtifacts(directory: string): void {
  if (!isRealDirectory(directory)) {
    throw new Error(`Refusing to change permissions for non-directory path: ${directory}`);
  }
  // Host and broker control diagnostics are private, runner-owned artifacts.
  // Preserve their modes rather than applying the legacy public-log repair.
  if (hasPrivateDiagnostics(directory)) {
    execa.sync('chmod', ['a+rX', directory]);
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    if (isRealDirectory(diagnosticsDirectory) &&
      isRealDirectory(path.join(diagnosticsDirectory, 'cloud-hypervisor'))) {
      execa.sync('chmod', ['a+rX', diagnosticsDirectory]);
    }
    const publicPaths = publicArtifactPaths(directory);
    if (publicPaths.length > 0) execa.sync('chmod', ['-R', 'a+rX', ...publicPaths]);
  } else {
    execa.sync('chmod', ['-R', 'a+rX', directory]);
  }
}
