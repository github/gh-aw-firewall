import './main-action-mocks.test-utils';
import * as fs from 'fs';
import * as dockerManager from '../docker-manager';
import * as hostIptables from '../host-iptables';
import { logger } from '../logger';
import { mainActionFsMocks } from './main-action-fs-mock.test-utils';
import {
  MAIN_ACTION_STUB_CONFIG,
  getMainActionMocks,
  setupMainActionPlatformHarness,
  setupMainActionTestHarness,
  type MainActionTestHarness,
} from './main-action.test-utils';

describe('getMainActionMocks', () => {
  it('returns the registered module mocks without replacing their identities', () => {
    const mocks = getMainActionMocks();
    expect(mocks.mockedDockerManager).toBe(dockerManager);
    expect(mocks.mockedHostIptables).toBe(hostIptables);
    expect(mocks.mockedLogger).toBe(logger);
    expect(jest.isMockFunction(mocks.mockedDockerManager.runAgentCommand)).toBe(true);
    expect(jest.isMockFunction(mocks.mockedPreflight.applyConfigFilePrecedence)).toBe(true);
    expect(jest.isMockFunction(mocks.mockedLogger.error)).toBe(true);
    expect(getMainActionMocks().mockedDockerManager).toBe(mocks.mockedDockerManager);
  });

  it('shares filesystem calls with the existing factory mocks', () => {
    fs.writeFileSync('/synthetic/mock-output', 'contents');
    expect(mainActionFsMocks.writeFileSync).toHaveBeenCalledWith(
      '/synthetic/mock-output', 'contents'
    );
    expect(fs.constants.O_WRONLY).toBe(jest.requireActual<typeof fs>('fs').constants.O_WRONLY);
  });
});

describe('setupMainActionTestHarness', () => {
  let harness: MainActionTestHarness;

  beforeEach(() => {
    harness = setupMainActionTestHarness();
  });

  afterEach(() => {
    harness.processExitSpy.mockRestore();
    harness.consoleErrorSpy.mockRestore();
  });

  it('provides default implementations without explicit dependency wiring', async () => {
    const mocks = getMainActionMocks();
    const config = mocks.mockedValidateOptions.validateOptions({}, 'echo hi');
    expect(config).toEqual(MAIN_ACTION_STUB_CONFIG);
    expect(config).not.toBe(MAIN_ACTION_STUB_CONFIG);
    expect(mocks.mockedOptionParsers.joinShellArgs(['echo', 'hi'])).toBe('echo hi');
    await expect(mocks.mockedDindProbe.probeSplitFilesystem('/synthetic/probe')).resolves.toEqual({
      prefix: undefined,
      splitDetected: false,
      inconclusive: false,
    });
    await expect(mocks.mockedSbxManager.isSbxAvailable()).resolves.toBe(true);
    expect(harness.getOptionValueSource('allowDomains')).toBeUndefined();
  });

  it('preserves the process.exit behavior expected by main-action tests', () => {
    expect(() => process.exit(1)).toThrow('process.exit: 1');
    expect(() => process.exit(0)).not.toThrow();
    expect(() => process.exit(42)).not.toThrow();
    expect(harness.processExitSpy.mock.calls).toEqual([[1], [0], [42]]);
  });
});

describe('setupMainActionPlatformHarness', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalGeteuid = process.geteuid;
  const originalExit = process.exit;
  const originalConsoleError = console.error;
  const harness = setupMainActionPlatformHarness();
  let previousExitSpy: jest.SpyInstance;

  it.each([1, 2])('sets up fresh Linux root state and spies (case %i)', () => {
    expect(process.platform).toBe('linux');
    expect(process.geteuid?.()).toBe(0);
    expect(process.exit).toBe(harness.processExitSpy);
    expect(console.error).toBe(harness.consoleErrorSpy);
    expect(harness.processExitSpy).not.toBe(previousExitSpy);
    expect(harness.processExitSpy).not.toHaveBeenCalled();
    expect(harness.getOptionValueSource()).toBeUndefined();
    previousExitSpy = harness.processExitSpy;
    harness.getOptionValueSource.mockReturnValue('cli');
    process.exit(0);
  });

  afterEach(() => {
    expect(process.geteuid).toBe(originalGeteuid);
    expect(process.exit).toBe(originalExit);
    expect(console.error).toBe(originalConsoleError);
  });

  afterAll(() => {
    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(originalPlatform);
  });
});
