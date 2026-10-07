/**
 * Returns true when `error` is a Node.js `ENOENT` filesystem error, indicating that a
 * `/proc/<pid>/task/<tid>` entry disappeared because the thread exited. Confinement
 * verifiers treat this as a benign thread departure rather than a verification failure.
 */
export function isMissingProcEntryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
