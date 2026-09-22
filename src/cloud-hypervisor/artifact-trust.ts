import { createHash } from 'crypto';
import { createReadStream, constants, promises as fs } from 'fs';
import * as path from 'path';
import type { CloudHypervisorArtifactDigests } from '../types/runtime-options';

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
    throw new Error(`host tool "${label}" path must be absolute: ${filePath}`);
  }
  const { root } = path.parse(filePath);
  const segments = filePath.slice(root.length).split('/').filter(Boolean);
  let ancestor = root;
  for (const segment of segments.slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    const stat = await fs.lstat(ancestor);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || stat.uid !== 0) {
      throw new Error(`host tool "${label}" has an untrusted parent directory: ${ancestor}`);
    }
  }
  const stat = await fs.lstat(filePath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o022) !== 0 ||
    stat.uid !== 0
  ) {
    throw new Error(`host tool "${label}" must be a root-owned non-writable regular file: ${filePath}`);
  }
  await fs.access(filePath, constants.X_OK);
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
    throw new Error(`${label} path must be absolute: ${filePath}`);
  }
  await assertTrustedAncestorChain(label, filePath, dependencies);
  let stat;
  try {
    stat = await dependencies.lstat(filePath);
  } catch (error) {
    throw new Error(
      `${label} is unavailable: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file and not a symbolic link: ${filePath}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group- or world-writable: ${filePath}`);
  }
  if (stat.uid !== 0 && stat.uid !== dependencies.uid) {
    throw new Error(
      `${label} must be owned by root or uid ${dependencies.uid}; found uid ${stat.uid}: ${filePath}`,
    );
  }
  try {
    await dependencies.access(filePath, accessMode);
  } catch (error) {
    throw new Error(
      `${label} does not have the required host access: ${filePath}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
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
      throw new Error(
        `${label} parent directory must not be a symbolic link: ${ancestor}`,
      );
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(
        `${label} parent directory must not be group- or world-writable: ${ancestor}`,
      );
    }
    if (stat.uid !== 0 && stat.uid !== dependencies.uid) {
      throw new Error(
        `${label} parent directory must be owned by root or uid ${dependencies.uid}; ` +
        `found uid ${stat.uid}: ${ancestor}`,
      );
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
    throw new Error(`${label} SHA-256 must contain exactly 64 hexadecimal characters`);
  }

  const stat = await dependencies.lstat(filePath);
  if (stat.size <= 0) {
    throw new Error(
      `${label} trusted artifact is empty or incomplete before execution: ${filePath}`,
    );
  }
  const actual = await dependencies.sha256(filePath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected.toLowerCase()}, got ${actual.toLowerCase()}`,
    );
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
