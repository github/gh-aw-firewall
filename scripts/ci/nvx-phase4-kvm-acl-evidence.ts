import { createHash } from 'crypto';
import { readFileSync, statSync, writeFileSync } from 'fs';

interface AclEntryShape {
  readonly order: number;
  readonly type: 'user' | 'group' | 'mask' | 'other';
  readonly qualifier: 'owner' | 'named' | 'none';
  readonly permissions: string;
}

function aclShape(contents: string): AclEntryShape[] {
  return contents.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line, order) => {
      const match = /^(user|group):([^:]*):([rwx-]{3})$|^(mask|other)::([rwx-]{3})$/.exec(line);
      if (!match) throw new Error('KVM ACL evidence contains a malformed entry');
      if (match[1]) {
        return {
          order,
          type: match[1] as 'user' | 'group',
          qualifier: match[2] === '' ? 'owner' : 'named',
          permissions: match[3],
        };
      }
      return {
        order,
        type: match[4] as 'mask' | 'other',
        qualifier: 'none',
        permissions: match[5],
      };
    });
}

function sourceIdentity(sourcePath: string): Record<string, string> {
  const stats = statSync(sourcePath, { bigint: true });
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    mode: (stats.mode & 0o7777n).toString(8),
    rdev: stats.rdev.toString(),
  };
}

function aclEvidence(snapshotPath: string, sourcePath: string) {
  const contents = readFileSync(snapshotPath);
  return {
    sourcePath,
    sourceIdentity: sourceIdentity(sourcePath),
    sha256: createHash('sha256').update(contents).digest('hex'),
    entries: aclShape(contents.toString('utf8')),
  };
}

export function writeKvmAclEvidence(
  expectedSnapshotPath: string,
  expectedSourcePath: string,
  actualSnapshotPath: string,
  actualSourcePath: string,
  outputPath: string,
): void {
  const expected = aclEvidence(expectedSnapshotPath, expectedSourcePath);
  const actual = aclEvidence(actualSnapshotPath, actualSourcePath);
  writeFileSync(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    expected,
    actual,
    exactMatch: expected.sha256 === actual.sha256,
  }, null, 2)}\n`, { mode: 0o600 });
}

function main(): void {
  const [expectedSnapshotPath, expectedSourcePath, actualSnapshotPath, actualSourcePath, outputPath] =
    process.argv.slice(2);
  if (
    !expectedSnapshotPath ||
    !expectedSourcePath ||
    !actualSnapshotPath ||
    !actualSourcePath ||
    !outputPath
  ) {
    throw new Error(
      'usage: nvx-phase4-kvm-acl-evidence.ts ' +
      '<expected-snapshot> <expected-source> <actual-snapshot> <actual-source> <output>',
    );
  }
  writeKvmAclEvidence(
    expectedSnapshotPath,
    expectedSourcePath,
    actualSnapshotPath,
    actualSourcePath,
    outputPath,
  );
}

if (require.main === module) main();
