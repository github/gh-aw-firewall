const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getPendingTimeoutSteeringWarning,
  claimTimeoutSteeringWarning,
  acknowledgeTimeoutSteeringWarning,
  getTimeoutSteeringReflectState,
  resetTimeoutSteeringForTests,
} = require('./timeout-steering');

const DIRECTIVE = "If you are responsible for this workflow's final output, stop the remaining work and " +
  'submit it now with what you have. Otherwise, finish your current step and return what you have to ' +
  'the agent that started you.';
const MINUTE = 60 * 1000;
const START = 1_700_000_000_000;

describe('timeout steering notices', () => {
  let runtimeDir;
  let nowSpy;

  const at = (minutes) => nowSpy.mockReturnValue(START + Math.round(minutes * MINUTE));

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-timeout-steering-unit-'));
    process.env.AWF_AGENT_RUNTIME_START_FILE = path.join(runtimeDir, 'started-at-ms');
    fs.writeFileSync(process.env.AWF_AGENT_RUNTIME_START_FILE, String(START));
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(START);
    resetTimeoutSteeringForTests();
  });

  afterEach(() => {
    delete process.env.AWF_AGENT_TIMEOUT_MINUTES;
    delete process.env.AWF_AGENT_RUNTIME_START_FILE;
    resetTimeoutSteeringForTests();
    jest.restoreAllMocks();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('states the minutes passed and remaining, then the fixed directive', () => {
    process.env.AWF_AGENT_TIMEOUT_MINUTES = '20';
    at(14);
    expect(getPendingTimeoutSteeringWarning()).toBeNull();

    // About five minutes left: the "little left" notice fires before 80%.
    at(15);
    expect(getPendingTimeoutSteeringWarning()).toEqual({
      rank: 0.5, threshold: null, trigger: 'little_left',
      message: `[AWF TIME WARNING] 15 of 20 minutes have passed; about 5 minutes remain. ${DIRECTIVE}`,
    });
    acknowledgeTimeoutSteeringWarning(0.5);

    at(16);
    expect(getPendingTimeoutSteeringWarning()).toEqual({
      rank: 80, threshold: 80, trigger: 'threshold',
      message: `[AWF TIME WARNING] 16 of 20 minutes have passed; about 4 minutes remain. ${DIRECTIVE}`,
    });
    acknowledgeTimeoutSteeringWarning(80);

    at(19.5);
    expect(getPendingTimeoutSteeringWarning().message).toBe(
      `[AWF TIME WARNING] 19 of 20 minutes have passed; less than a minute remains. ${DIRECTIVE}`);
    expect(getTimeoutSteeringReflectState()).toMatchObject({
      thresholds_crossed: [80, 90, 95],
      thresholds_pending: [90, 95],
      little_left_triggered: true,
    });
  });

  it('fires the "little left" notice only once half the deadline has passed, and once per run', () => {
    process.env.AWF_AGENT_TIMEOUT_MINUTES = '6';
    at(2);
    expect(getPendingTimeoutSteeringWarning()).toBeNull();
    expect(getTimeoutSteeringReflectState().little_left_triggered).toBe(false);

    at(3);
    expect(getPendingTimeoutSteeringWarning()).toMatchObject({
      rank: 0.5, trigger: 'little_left',
      message: expect.stringContaining('3 of 6 minutes have passed; about 3 minutes remain.'),
    });
    claimTimeoutSteeringWarning(0.5, 'conversation-a').acknowledge();
    expect(getPendingTimeoutSteeringWarning('conversation-a')).toBeNull();

    at(4);
    expect(getPendingTimeoutSteeringWarning('conversation-a')).toBeNull();
    at(4.8);
    expect(getPendingTimeoutSteeringWarning('conversation-a')).toMatchObject({ rank: 80, trigger: 'threshold' });
  });

  it('ranks a "little left" notice crossed with a threshold just above it', () => {
    process.env.AWF_AGENT_TIMEOUT_MINUTES = '60';
    // The first check happens late: 90% and "little left" are crossed together.
    at(55);
    expect(getPendingTimeoutSteeringWarning('conversation-a')).toMatchObject({
      rank: 90.5, threshold: null, trigger: 'little_left',
    });
    claimTimeoutSteeringWarning(90.5, 'conversation-a').acknowledge();
    // The superseded 80% and 90% notices are never offered afterwards.
    expect(getPendingTimeoutSteeringWarning('conversation-a')).toBeNull();
    expect(getPendingTimeoutSteeringWarning()).toBeNull();

    at(57);
    expect(getPendingTimeoutSteeringWarning('conversation-a')).toMatchObject({ rank: 95, threshold: 95 });
  });
});
