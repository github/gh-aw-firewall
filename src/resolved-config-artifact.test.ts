import { resolveArtifactOwner } from './resolved-config-artifact';

describe('host publication identity (not sandbox identity)', () => {
  const originalUid = process.env.SUDO_UID;
  const originalGid = process.env.SUDO_GID;
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUid === undefined) delete process.env.SUDO_UID; else process.env.SUDO_UID = originalUid;
    if (originalGid === undefined) delete process.env.SUDO_GID; else process.env.SUDO_GID = originalGid;
  });

  it.each([[0, 0], [500, 20], [1001, 1002]])('preserves actual sudo identity %i:%i', (uid, gid) => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    process.env.SUDO_UID = String(uid);
    process.env.SUDO_GID = String(gid);
    expect(resolveArtifactOwner()).toEqual({ uid, gid });
  });

  it.each(['', '-1', '1.5', 'NaN', '0x10', ' 500', '500\n', '01', '4294967295', '9007199254740992'])(
    'rejects malformed/reserved UID or GID %j before publication', (id) => {
      jest.spyOn(process, 'getuid').mockReturnValue(0);
      process.env.SUDO_UID = id;
      process.env.SUDO_GID = '20';
      expect(resolveArtifactOwner).toThrow('Invalid sudo artifact identity');
      process.env.SUDO_UID = '500';
      process.env.SUDO_GID = id;
      expect(resolveArtifactOwner).toThrow('Invalid sudo artifact identity');
    },
  );

  it('rejects incomplete sudo identity and preserves native root', () => {
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    jest.spyOn(process, 'getgid').mockReturnValue(0);
    process.env.SUDO_UID = '500';
    delete process.env.SUDO_GID;
    expect(resolveArtifactOwner).toThrow('Invalid sudo artifact identity');
    delete process.env.SUDO_UID;
    expect(resolveArtifactOwner()).toEqual({ uid: 0, gid: 0 });
  });

  it('ignores sudo environment when unprivileged', () => {
    jest.spyOn(process, 'getuid').mockReturnValue(500);
    jest.spyOn(process, 'getgid').mockReturnValue(20);
    process.env.SUDO_UID = '0';
    process.env.SUDO_GID = '0';
    expect(resolveArtifactOwner()).toEqual({ uid: 500, gid: 20 });
  });
});
