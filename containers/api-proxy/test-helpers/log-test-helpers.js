'use strict';

/**
 * Spy on process.stdout.write and collect any structured JSON log lines emitted
 * during a test.  Call spy.mockRestore() (or jest.restoreAllMocks()) in afterEach
 * to clean up.
 *
 * @returns {{ lines: object[], spy: jest.SpyInstance }}
 */
function collectLogOutput() {
  const lines = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((data) => {
    try {
      lines.push(JSON.parse(data.toString()));
    } catch {
      // ignore non-JSON writes
    }
    return true;
  });
  return { lines, spy };
}

module.exports = { collectLogOutput };
