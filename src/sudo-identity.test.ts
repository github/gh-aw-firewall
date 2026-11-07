import { parseOperatorId, resolveOperatorIdentity } from './sudo-identity';

describe('operator identity', () => {
  const environment = process.env;
  const getuid = process.getuid;
  const getgid = process.getgid;

  beforeEach(() => {
    jest.spyOn(process, 'getuid').mockReturnValue(1001);
    jest.spyOn(process, 'getgid').mockReturnValue(1002);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = environment;
    Object.defineProperty(process, 'getuid', { value: getuid, configurable: true, writable: true });
    Object.defineProperty(process, 'getgid', { value: getgid, configurable: true, writable: true });
  });

  it('resolves sudo identities without replacing system-range operator IDs', () => {
    expect(resolveOperatorIdentity({ SUDO_UID: '500', SUDO_GID: '20' })).toEqual({ uid: 500, gid: 20 });
  });

  it('uses the current environment by default', () => {
    process.env = { ...environment, SUDO_UID: '2001', SUDO_GID: '2002' };
    expect(resolveOperatorIdentity()).toEqual({ uid: 2001, gid: 2002 });
  });

  it('falls back to the process identity independently for each missing value', () => {
    expect(resolveOperatorIdentity({})).toEqual({ uid: 1001, gid: 1002 });
    expect(resolveOperatorIdentity({ SUDO_UID: '2001' })).toEqual({ uid: 2001, gid: 1002 });
    expect(resolveOperatorIdentity({ SUDO_GID: '2002' })).toEqual({ uid: 1001, gid: 2002 });
  });

  it.each([
    '', '0', '-1', '+1', '1.5', 'NaN', 'Infinity', '0x10', '1e3',
    ' 500', '500 ', '500\n', '01', '4294967295', '4294967296',
    '9007199254740992', '9'.repeat(400),
  ])('rejects invalid ID %j and falls back to the process identity', (value) => {
    expect(parseOperatorId(value)).toBeUndefined();
    expect(resolveOperatorIdentity({ SUDO_UID: value, SUDO_GID: '2002' }))
      .toEqual({ uid: 1001, gid: 2002 });
    expect(resolveOperatorIdentity({ SUDO_UID: '2001', SUDO_GID: value }))
      .toEqual({ uid: 2001, gid: 1002 });
    if (value !== '0') expect(parseOperatorId(value, true)).toBeUndefined();
  });

  it('accepts the largest usable UID/GID and only explicitly allows root parsing', () => {
    expect(resolveOperatorIdentity({ SUDO_UID: '4294967294', SUDO_GID: '4294967294' }))
      .toEqual({ uid: 4294967294, gid: 4294967294 });
    expect(parseOperatorId('0')).toBeUndefined();
    expect(parseOperatorId('0', true)).toBe(0);
    expect(parseOperatorId(undefined)).toBeUndefined();
  });

  it.each(['getuid', 'getgid'] as const)('returns undefined when %s is unavailable', (method) => {
    Object.defineProperty(process, method, { value: undefined, configurable: true });
    expect(resolveOperatorIdentity({})).toBeUndefined();
    expect(resolveOperatorIdentity({ SUDO_UID: '2001', SUDO_GID: '2002' }))
      .toEqual({ uid: 2001, gid: 2002 });
  });

  it.each([0, -1, 1.5, NaN, Infinity, 0xffffffff, Number.MAX_SAFE_INTEGER + 1])(
    'does not use invalid process identity %j as a fallback', (id) => {
      jest.spyOn(process, 'getuid').mockReturnValue(id);
      expect(resolveOperatorIdentity({})).toBeUndefined();
      jest.spyOn(process, 'getuid').mockReturnValue(1001);
      jest.spyOn(process, 'getgid').mockReturnValue(id);
      expect(resolveOperatorIdentity({})).toBeUndefined();
    },
  );
});
