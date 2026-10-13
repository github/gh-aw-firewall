import {
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
    ['missing base entry', 'user::rw-\ngroup::rw-'],
    ['named entry without mask', 'user::rw-\nuser:1000:rw-\ngroup::rw-\nother::---'],
    ['duplicate entry', 'user::rw-\ngroup::rw-\nother::---\nother::---'],
    ['unsupported entry', 'user::rw-\ngroup::rw-\nother::---\ndefault:user::rw-'],
  ])('rejects malformed ACL evidence: %s', (_name, acl) => {
    expect(() => parseDeviceAcl(acl)).toThrow(/device ACL/);
  });
});
