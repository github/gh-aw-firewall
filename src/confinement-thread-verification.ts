/**
 * Shared post-start confinement verification logic used by both the Cloud Hypervisor and
 * NVX confinement verifiers. Both verifiers walk the final thread set to confirm each thread
 * is still legitimate (reusing a cached start time when it has not changed, otherwise
 * re-verifying the thread from scratch) and then recheck the top-level process start time to
 * detect a PID-reuse identity race between the initial and final `/proc/<pid>/stat` reads.
 */

interface StableThreadSetVerificationOptions {
  /** The thread IDs observed in the final `/proc/<pid>/task` listing. */
  readonly finalTaskIds: readonly number[];
  /** Start times recorded for each thread the first time it was observed and verified. */
  readonly taskStartTimes: ReadonlyMap<number, string>;
  /** Reads a thread's current start time, or `undefined` if the thread has since exited. */
  readTaskStartTime(taskId: number): Promise<string | undefined>;
  /**
   * Fully re-verifies a thread (identity, capabilities, etc.) and returns its start time, or
   * `undefined` if the thread has since exited.
   */
  verifyTask(taskId: number): Promise<string | undefined>;
}

/**
 * Walks the final thread set, treating a thread whose start time is unchanged since it was
 * first verified as still trustworthy, and fully re-verifying any thread that is new or whose
 * start time has changed (a recycled TID). Returns the number of threads confirmed stable.
 */
export async function verifyStableThreadSet(
  options: StableThreadSetVerificationOptions,
): Promise<number> {
  let verifiedThreadCount = 0;
  for (const taskId of options.finalTaskIds) {
    const priorStartTime = options.taskStartTimes.get(taskId);
    if (priorStartTime !== undefined) {
      const startTime = await options.readTaskStartTime(taskId);
      if (startTime === undefined) continue;
      if (startTime === priorStartTime) {
        verifiedThreadCount += 1;
        continue;
      }
    }
    if ((await options.verifyTask(taskId)) !== undefined) verifiedThreadCount += 1;
  }
  return verifiedThreadCount;
}

/**
 * Compares a process's current start time against the start time recorded before verification
 * began, throwing the provided error if they differ (indicating the original PID exited and was
 * reused by an unrelated process while verification was in progress).
 */
export function assertStableProcessStartTime(
  initialStartTime: string,
  finalStartTime: string,
  buildError: (finalStartTime: string) => Error,
): void {
  if (finalStartTime !== initialStartTime) {
    throw buildError(finalStartTime);
  }
}
