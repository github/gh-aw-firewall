import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { writeKvmAclEvidence } from './nvx-phase4-kvm-acl-evidence';

describe('Phase 4 KVM ACL evidence', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'awf-kvm-acl-'));

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('records exact hashes and UID-redacted ordered ACL structure with source identity', () => {
    // UID-like digits in source metadata must not be mistaken for unredacted ACL entries.
    const expected = path.join(directory, 'expected-1001.acl');
    const actual = path.join(directory, 'actual-2002.acl');
    const output = path.join(directory, 'evidence.json');
    writeFileSync(expected, [
      '# file: /dev/kvm',
      '# owner: 0',
      '# group: 993',
      'user::rw-',
      'user:1001:rw-',
      'group::rw-',
      'mask::rw-',
      'other::---',
      '',
    ].join('\n'));
    writeFileSync(actual, [
      '# file: /dev/kvm',
      '# owner: 0',
      '# group: 993',
      'user::rw-',
      'user:2002:rw- #effective:r--',
      'group::rw-',
      'mask::rw-',
      'other::---',
      '',
    ].join('\n'));

    writeKvmAclEvidence(expected, expected, actual, actual, output);

    const evidence = JSON.parse(readFileSync(output, 'utf8'));
    const identityShape = {
      device: expect.stringMatching(/^\d+$/),
      inode: expect.stringMatching(/^\d+$/),
      mode: expect.stringMatching(/^[0-7]+$/),
      rdev: expect.stringMatching(/^\d+$/),
    };
    expect(evidence).toEqual({
      schemaVersion: 1,
      exactMatch: false,
      expected: {
        sourcePath: expected,
        sourceIdentity: identityShape,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        entries: [
          { order: 0, type: 'user', qualifier: 'owner', permissions: 'rw-' },
          { order: 1, type: 'user', qualifier: 'named', permissions: 'rw-' },
          { order: 2, type: 'group', qualifier: 'owner', permissions: 'rw-' },
          { order: 3, type: 'mask', qualifier: 'none', permissions: 'rw-' },
          { order: 4, type: 'other', qualifier: 'none', permissions: '---' },
        ],
      },
      actual: {
        sourcePath: actual,
        sourceIdentity: identityShape,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        entries: [
          { order: 0, type: 'user', qualifier: 'owner', permissions: 'rw-' },
          { order: 1, type: 'user', qualifier: 'named', permissions: 'rw-' },
          { order: 2, type: 'group', qualifier: 'owner', permissions: 'rw-' },
          { order: 3, type: 'mask', qualifier: 'none', permissions: 'rw-' },
          { order: 4, type: 'other', qualifier: 'none', permissions: '---' },
        ],
      },
    });
  });
});
