export const mockGetRealUserHome = jest.fn();

export function fsMockFactory() {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: jest.fn((...args: Parameters<typeof actual.mkdirSync>) => actual.mkdirSync(...args)) as typeof actual.mkdirSync,
    accessSync: jest.fn((...args: Parameters<typeof actual.accessSync>) => actual.accessSync(...args)) as typeof actual.accessSync,
    statSync: jest.fn((...args: Parameters<typeof actual.statSync>) => actual.statSync(...args)) as typeof actual.statSync,
    chmodSync: jest.fn((...args: Parameters<typeof actual.chmodSync>) => actual.chmodSync(...args)),
    chownSync: jest.fn(),
    existsSync: jest.fn((...args: Parameters<typeof actual.existsSync>) => actual.existsSync(...args)),
    lstatSync: jest.fn((...args: Parameters<typeof actual.lstatSync>) => actual.lstatSync(...args)) as typeof actual.lstatSync,
  };
}

export function hostEnvMockFactory(overrides: Record<string, unknown> = {}) {
  return {
    getSafeHostUid: jest.fn().mockReturnValue('1000'),
    getSafeHostGid: jest.fn().mockReturnValue('1000'),
    getRealUserHome: mockGetRealUserHome,
    ...overrides,
  };
}

export function hostIdentityMockFactory() {
  return {
    getRealUserHome: mockGetRealUserHome,
  };
}
