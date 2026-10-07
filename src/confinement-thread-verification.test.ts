import {
  assertStableProcessStartTime,
  verifyStableThreadSet,
} from './confinement-thread-verification';

describe('verifyStableThreadSet', () => {
  it('counts a thread as verified without re-verification when its start time is unchanged', async () => {
    const readTaskStartTime = jest.fn(async (taskId: number) => (taskId === 1 ? '100' : undefined));
    const verifyTask = jest.fn(async () => '999');
    const count = await verifyStableThreadSet({
      finalTaskIds: [1],
      taskStartTimes: new Map([[1, '100']]),
      readTaskStartTime,
      verifyTask,
    });
    expect(count).toBe(1);
    expect(readTaskStartTime).toHaveBeenCalledWith(1);
    expect(verifyTask).not.toHaveBeenCalled();
  });

  it('re-verifies a thread whose start time changed (recycled TID)', async () => {
    const readTaskStartTime = jest.fn(async () => '200');
    const verifyTask = jest.fn(async () => '200');
    const count = await verifyStableThreadSet({
      finalTaskIds: [2],
      taskStartTimes: new Map([[2, '100']]),
      readTaskStartTime,
      verifyTask,
    });
    expect(count).toBe(1);
    expect(verifyTask).toHaveBeenCalledWith(2);
  });

  it('fully verifies a new thread with no prior start time', async () => {
    const readTaskStartTime = jest.fn();
    const verifyTask = jest.fn(async () => '300');
    const count = await verifyStableThreadSet({
      finalTaskIds: [3],
      taskStartTimes: new Map(),
      readTaskStartTime,
      verifyTask,
    });
    expect(count).toBe(1);
    expect(readTaskStartTime).not.toHaveBeenCalled();
    expect(verifyTask).toHaveBeenCalledWith(3);
  });

  it('does not count a thread that exited before re-verification', async () => {
    const readTaskStartTime = jest.fn(async () => undefined);
    const verifyTask = jest.fn(async () => undefined);
    const count = await verifyStableThreadSet({
      finalTaskIds: [4],
      taskStartTimes: new Map([[4, '100']]),
      readTaskStartTime,
      verifyTask,
    });
    expect(count).toBe(0);
  });
});

describe('assertStableProcessStartTime', () => {
  it('does not throw when the start time is unchanged', () => {
    expect(() =>
      assertStableProcessStartTime('100', '100', (finalStartTime) => new Error(finalStartTime)),
    ).not.toThrow();
  });

  it('throws the provided error when the start time changed', () => {
    expect(() =>
      assertStableProcessStartTime('100', '200', (finalStartTime) => new Error(`raced to ${finalStartTime}`)),
    ).toThrow('raced to 200');
  });
});
