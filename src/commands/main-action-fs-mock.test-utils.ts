export const mainActionFsMocks = {
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  chmodSync: jest.fn(),
  openSync: jest.fn().mockReturnValue(42),
  closeSync: jest.fn(),
  lstatSync: jest.fn(() => ({ isSymbolicLink: () => false })),
  statSync: jest.fn(() => ({ isDirectory: () => true })),
  fstatSync: jest.fn(() => ({ isFile: () => true })),
  fchmodSync: jest.fn(),
  fsyncSync: jest.fn(),
};

export function mainActionFsMockFactory() {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => mainActionFsMocks.mkdirSync(...args),
    writeFileSync: (...args: unknown[]) => mainActionFsMocks.writeFileSync(...args),
    chmodSync: (...args: unknown[]) => mainActionFsMocks.chmodSync(...args),
    openSync: (...args: unknown[]) => mainActionFsMocks.openSync(...args),
    closeSync: (...args: unknown[]) => mainActionFsMocks.closeSync(...args),
    lstatSync: (...args: unknown[]) => (mainActionFsMocks.lstatSync as jest.Mock)(...args),
    statSync: (...args: unknown[]) => (mainActionFsMocks.statSync as jest.Mock)(...args),
    fstatSync: (...args: unknown[]) => (mainActionFsMocks.fstatSync as jest.Mock)(...args),
    fchmodSync: (...args: unknown[]) => mainActionFsMocks.fchmodSync(...args),
    fsyncSync: (...args: unknown[]) => mainActionFsMocks.fsyncSync(...args),
  };
}
