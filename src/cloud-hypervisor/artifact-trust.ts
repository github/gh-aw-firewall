import { createHash } from 'crypto';
import { createReadStream, constants, promises as fs } from 'fs';
import * as path from 'path';
import type { CloudHypervisorArtifactDigests } from '../types/runtime-options';
import { hostPreflightReason, markHostPreflightError } from './host-preflight-progress';

export interface CloudHypervisorArtifactTrustDependencies {
  uid: number;
  access(filePath: string, mode: number): Promise<void>;
  lstat(filePath: string): Promise<{
    isFile(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
    size: number;
    uid: number;
  }>;
  sha256(filePath: string): Promise<string>;
}

export async function assertTrustedHostTool(label: string, filePath: string): Promise<void> {
  if (!path.isAbsolute(filePath)) {
    throw markHostPreflightError(new Error(`host tool "${label}" path must be absolute: ${filePath}`), 'path-not-absolute');
  }
  const { root } = path.parse(filePath);
  const segments = filePath.slice(root.length).split('/').filter(Boolean);
  let ancestor = root;
  for (const segment of segments.slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    const stat = await fs.lstat(ancestor);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || stat.uid !== 0) {
      throw markHostPreflightError(new Error(`host tool "${label}" has an untrusted parent directory: ${ancestor}`),
        stat.isSymbolicLink() ? 'ancestor-symlink' : (stat.mode & 0o022) !== 0 ? 'ancestor-writable' : 'ancestor-owner');
    }
  }
  const stat = await fs.lstat(filePath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o022) !== 0 ||
    stat.uid !== 0
  ) {
    throw markHostPreflightError(new Error(`host tool "${label}" must be a root-owned non-writable regular file: ${filePath}`),
      stat.isSymbolicLink() ? 'file-symlink' : !stat.isFile() ? 'file-type' :
        (stat.mode & 0o022) !== 0 ? 'file-writable' : 'file-owner');
  }
  await fs.access(filePath, constants.X_OK);
}

export async function resolveTrustedHostTool(
  tool: string,
  environment: NodeJS.ProcessEnv,
  verify: typeof assertTrustedHostTool = assertTrustedHostTool,
): Promise<string> {
  let failure: unknown;
  for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    try {
      const candidate = path.join(directory, tool);
      await verify(tool, candidate);
      return candidate;
    } catch (error) {
      // Missing entries must not erase a rejected candidate's trust failure.
      if (failure === undefined || hostPreflightReason(failure) === 'ENOENT') failure = error;
    }
  }
  const error = new Error(`required trusted host tool "${tool}" was not found on PATH`);
  if (failure !== undefined) Object.defineProperty(error, 'cause', { value: failure });
  throw markHostPreflightError(error, failure === undefined || hostPreflightReason(failure) === 'ENOENT'
    ? 'tool-not-found' : hostPreflightReason(failure));
}

export async function calculateSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export async function assertTrustedRegularFile(
  label: string,
  filePath: string,
  accessMode: number,
  dependencies: CloudHypervisorArtifactTrustDependencies,
): Promise<void> {
  if (!path.isAbsolute(filePath)) {
    throw markHostPreflightError(new Error(`${label} path must be absolute: ${filePath}`), 'path-not-absolute');
  }
  await assertTrustedAncestorChain(label, filePath, dependencies);
  let stat;
  try {
    stat = await dependencies.lstat(filePath);
  } catch (error) {
    throw markHostPreflightError(new Error(
      `${label} is unavailable: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    ), hostPreflightReason(error));
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw markHostPreflightError(new Error(`${label} must be a regular file and not a symbolic link: ${filePath}`),
      stat.isSymbolicLink() ? 'file-symlink' : 'file-type');
  }
  if ((stat.mode & 0o022) !== 0) {
    throw markHostPreflightError(new Error(`${label} must not be group- or world-writable: ${filePath}`), 'file-writable');
  }
  if (stat.uid !== 0 && stat.uid !== dependencies.uid) {
    throw markHostPreflightError(new Error(
      `${label} must be owned by root or uid ${dependencies.uid}; found uid ${stat.uid}: ${filePath}`,
    ), 'file-owner');
  }
  try {
    await dependencies.access(filePath, accessMode);
  } catch (error) {
    throw markHostPreflightError(new Error(
      `${label} does not have the required host access: ${filePath}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    ), hostPreflightReason(error));
  }
}

export function parsePositiveUid(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}

export function resolveTrustedOperatorUid(): number {
  return parsePositiveUid(process.env.SUDO_UID) ?? (process.getuid?.() ?? -1);
}

export async function assertTrustedAncestorChain(
  label: string,
  filePath: string,
  dependencies: CloudHypervisorArtifactTrustDependencies,
): Promise<void> {
  const { root } = path.parse(filePath);
  const segments = filePath.slice(root.length).split('/').filter((segment) => segment.length > 0);
  let ancestor = root;
  for (const segment of segments.slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    const stat = await dependencies.lstat(ancestor);
    if (stat.isSymbolicLink()) {
      throw markHostPreflightError(new Error(
        `${label} parent directory must not be a symbolic link: ${ancestor}`,
      ), 'ancestor-symlink');
    }
    if ((stat.mode & 0o022) !== 0) {
      throw markHostPreflightError(new Error(
        `${label} parent directory must not be group- or world-writable: ${ancestor}`,
      ), 'ancestor-writable');
    }
    if (stat.uid !== 0 && stat.uid !== dependencies.uid) {
      throw markHostPreflightError(new Error(
        `${label} parent directory must be owned by root or uid ${dependencies.uid}; ` +
        `found uid ${stat.uid}: ${ancestor}`,
      ), 'ancestor-owner');
    }
  }
}

export async function assertDigest(
  label: string,
  filePath: string,
  expected: string | undefined,
  dependencies: CloudHypervisorArtifactTrustDependencies,
): Promise<void> {
  if (!expected) return;
  if (!/^[a-fA-F0-9]{64}$/.test(expected)) {
    throw markHostPreflightError(new Error(`${label} SHA-256 must contain exactly 64 hexadecimal characters`), 'digest-format');
  }

  const stat = await dependencies.lstat(filePath);
  if (stat.size <= 0) {
    throw markHostPreflightError(new Error(
      `${label} trusted artifact is empty or incomplete before execution: ${filePath}`,
    ), 'digest-empty');
  }
  const actual = await dependencies.sha256(filePath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw markHostPreflightError(new Error(
      `${label} SHA-256 mismatch: expected ${expected.toLowerCase()}, got ${actual.toLowerCase()}`,
    ), 'digest-mismatch');
  }
}

export function hasCompleteArtifactDigests(
  digests: CloudHypervisorArtifactDigests | undefined,
): digests is Required<CloudHypervisorArtifactDigests> {
  return Boolean(
    digests?.cloudHypervisor &&
    digests.virtiofsd &&
    digests.kernel &&
    digests.rootfs &&
    digests.supervisor,
  );
}
