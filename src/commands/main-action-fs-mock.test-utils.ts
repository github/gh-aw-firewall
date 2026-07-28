export const mainActionFsMocks = {
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  chmodSync: jest.fn(),
  openSync: jest.fn().mockReturnValue(42),
  closeSync: jest.fn(),
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
  };
}
