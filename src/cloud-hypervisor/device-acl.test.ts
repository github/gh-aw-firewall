import {
  composeDeviceAcl,
  deviceAclArgument,
  describeDeviceAclShape,
  parseDeviceAcl,
  sameDeviceAcl,
} from './device-acl';

describe('Cloud Hypervisor device ACLs', () => {
  it('normalizes effective comments and preserves exact access entries', () => {
    const acl = parseDeviceAcl([
      '# file: /dev/kvm',
      'user::rw-',
      'user:1000:rw-\t#effective:r--',
      'group::rw-',
      'mask::r--',
      'other::---',
    ].join('\n'));

    expect(acl).toEqual([
      'user::rw-',
      'user:1000:rw-',
      'group::rw-',
      'mask::r--',
      'other::---',
    ]);
    expect(deviceAclArgument(acl)).toBe(acl.join(','));
    expect(sameDeviceAcl(acl, [...acl])).toBe(true);
    expect(sameDeviceAcl(acl, [
      ...acl.slice(0, -1),
      'other::rw-',
    ])).toBe(false);
    expect(sameDeviceAcl(acl, acl.slice(0, -1))).toBe(false);
    expect(sameDeviceAcl(acl, [
      'user::rw-',
      'user:1000:r--',
      'group::rw-',
      'mask::r--',
      'other::---',
    ])).toBe(false);
    expect(describeDeviceAclShape(acl)).toBe(
      'user::rw-,user:<id>:rw-,group::rw-,mask::r--,other::---',
    );
  });

  it('accepts the mask-only residue observed in run 38474851931', () => {
    expect(parseDeviceAcl(
      'user::rw-\ngroup::rw-\nmask::rw-\nother::rw-\n',
    )).toEqual(['user::rw-', 'group::rw-', 'mask::rw-', 'other::rw-']);
  });

  it.each([
    {
      name: 'earlier identity cleans first',
      baseline: [
        'user::rw-', 'user:1001:rw-', 'group::rw-', 'mask::rw-', 'other::---',
      ],
      current: [
        'user::rw-', 'user:997:rw-', 'user:999:rw-', 'user:1001:rw-',
        'group::rw-', 'mask::rw-', 'other::---',
      ],
      ownerUid: 999,
      capturedTemporaryUids: [],
      liveTemporaryUids: [997, 999],
      expected: [
        'user::rw-', 'user:997:rw-', 'user:1001:rw-',
        'group::rw-', 'mask::rw-', 'other::---',
      ],
    },
    {
      name: 'later identity cleans after its captured peer is gone',
      baseline: [
        'user::rw-', 'user:999:rw-', 'user:1001:rw-',
        'group::rw-', 'mask::rw-', 'other::---',
      ],
      current: [
        'user::rw-', 'user:997:rw-', 'user:1001:rw-',
        'group::rw-', 'mask::rw-', 'other::---',
      ],
      ownerUid: 997,
      capturedTemporaryUids: [999],
      liveTemporaryUids: [997],
      expected: [
        'user::rw-', 'user:1001:rw-',
        'group::rw-', 'mask::rw-', 'other::---',
      ],
    },
  ])('composes overlapping baselines when $name', ({
    baseline,
    current,
    ownerUid,
    capturedTemporaryUids,
    liveTemporaryUids,
    expected,
  }) => {
    expect(composeDeviceAcl(
      baseline,
      current,
      ownerUid,
      capturedTemporaryUids,
      liveTemporaryUids,
    )).toEqual(expected);
  });

  it('adds a live peer mask to a baseline that had no named entries', () => {
    expect(composeDeviceAcl(
      ['user::rw-', 'group::r--', 'other::---'],
      [
        'user::rw-', 'user:997:rw-', 'user:999:rw-',
        'group::r--', 'mask::rw-', 'other::---',
      ],
      999,
      [],
      [997, 999],
    )).toEqual([
      'user::rw-', 'user:997:rw-', 'group::r--', 'mask::rw-', 'other::---',
    ]);
  });

  it('restores a durable runner ACE from accessed history without dropping mask residue', () => {
    expect(composeDeviceAcl(
      ['user::rw-', 'group::rw-', 'mask::rw-', 'other::---'],
      ['user::rw-', 'group::rw-', 'mask::rw-', 'other::---'],
      999,
      [],
      [],
      [
        'user::rw-', 'user:1001:rw-',
        'group::rw-', 'mask::rw-', 'other::---',
      ],
      [],
    )).toEqual([
      'user::rw-', 'user:1001:rw-',
      'group::rw-', 'mask::rw-', 'other::---',
    ]);
  });

  it('restores a durable runner ACE without widening the journaled baseline mask', () => {
    expect(composeDeviceAcl(
      ['user::rw-', 'group::r--', 'mask::r--', 'other::---'],
      [
        'user::rw-', 'user:999:rw-',
        'group::r--', 'mask::rw-', 'other::---',
      ],
      999,
      [],
      [],
      [
        'user::rw-', 'user:1001:rw-',
        'group::r--', 'mask::rw-', 'other::---',
      ],
      [],
    )).toEqual([
      'user::rw-', 'user:1001:rw-',
      'group::r--', 'mask::r--', 'other::---',
    ]);
  });

  it('keeps a runner and mask present only in the journaled deletion baseline', () => {
    expect(composeDeviceAcl(
      [
        'user::rw-', 'user:1001:rw-',
        'group::rw-', 'mask::rw-', 'other::---',
      ],
      ['user::rw-', 'group::rw-', 'other::---'],
      999,
      [],
      [],
      ['user::rw-', 'group::rw-', 'other::---'],
      [],
    )).toEqual([
      'user::rw-', 'user:1001:rw-',
      'group::rw-', 'mask::rw-', 'other::---',
    ]);
  });

  it('rejects a named ACE that is neither durable nor a live VMM peer', () => {
    expect(() => composeDeviceAcl(
      [
        'user::rw-', 'user:1001:rw-',
        'group::rw-', 'mask::rw-', 'other::---',
      ],
      [
        'user::rw-', 'user:1001:rw-', 'user:2001:rw-',
        'group::rw-', 'mask::rw-', 'other::---',
      ],
      999,
      [],
      [],
    )).toThrow(/unowned user ACE: 2001/);
  });

  it.each([
    ['missing base entry', 'user::rw-\ngroup::rw-'],
    ['named entry without mask', 'user::rw-\nuser:1000:rw-\ngroup::rw-\nother::---'],
    ['duplicate entry', 'user::rw-\ngroup::rw-\nother::---\nother::---'],
    ['unsupported entry', 'user::rw-\ngroup::rw-\nother::---\ndefault:user::rw-'],
  ])('rejects malformed ACL evidence: %s', (_name, acl) => {
    expect(() => parseDeviceAcl(acl)).toThrow(/device ACL/);
  });
});
