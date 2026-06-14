export const mockGetRealUserHome = jest.fn();

export function fsMockFactory() {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
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
