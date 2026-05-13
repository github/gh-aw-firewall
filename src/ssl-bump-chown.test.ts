/**
 * Tests for the chown traversal inside initSslDb.
 *
 * fs.chownSync is a non-configurable property and cannot be replaced with
 * jest.spyOn. This file uses a module-level jest.mock('fs', ...) to intercept
 * chownSync calls so the successful (non-EPERM) recursion path can be verified.
 * It is separate from ssl-bump.test.ts which relies on real fs operations.
 */

import * as path from 'path';
import * as os from 'os';

// Mock chownSync and conditionally intercept readdirSync (withFileTypes calls only).
const mockChownSync = jest.fn();
const mockReaddirSync = jest.fn();

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    chownSync: (...args: unknown[]) => mockChownSync(...args),
    readdirSync: (...args: unknown[]) => {
      // Only intercept calls that pass { withFileTypes: true } — those come from
      // chownRecursive. All other readdirSync calls (e.g. from mkdirSync internals)
      // use the real implementation.
      if (args[1] && typeof args[1] === 'object' && 'withFileTypes' in (args[1] as object)) {
        return mockReaddirSync(...args);
      }
      return actual.readdirSync(...args as Parameters<typeof actual.readdirSync>);
    },
  };
});

// Mock execa (imported transitively by ssl-bump.ts).
jest.mock('execa');

import * as fs from 'fs';
import { initSslDb } from './ssl-bump';

describe('initSslDb chown traversal', () => {
  let tempDir: string;

  beforeEach(() => {
    mockChownSync.mockReset();
    mockReaddirSync.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-db-chown-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should chown ssl_db root, certs subdir, and all created files', async () => {
    // Let chownSync succeed (no EPERM).
    mockChownSync.mockImplementation(() => {});

    // Return the real ssl_db structure that initSslDb creates:
    // first readdirSync call is on ssl_db root → index.txt, size, certs (dir)
    // second readdirSync call is on certs → empty
    mockReaddirSync
      .mockReturnValueOnce([
        { name: 'index.txt', isDirectory: () => false },
        { name: 'size', isDirectory: () => false },
        { name: 'certs', isDirectory: () => true },
      ])
      .mockReturnValueOnce([]);

    const sslDbPath = await initSslDb(tempDir);

    // Root ssl_db directory
    expect(mockChownSync).toHaveBeenCalledWith(sslDbPath, 13, 13);
    // Files in ssl_db root
    expect(mockChownSync).toHaveBeenCalledWith(path.join(sslDbPath, 'index.txt'), 13, 13);
    expect(mockChownSync).toHaveBeenCalledWith(path.join(sslDbPath, 'size'), 13, 13);
    // Subdirectory (recursed into)
    expect(mockChownSync).toHaveBeenCalledWith(path.join(sslDbPath, 'certs'), 13, 13);
    expect(mockChownSync).toHaveBeenCalledTimes(4);
  });

  it('should recurse into nested subdirectories', async () => {
    mockChownSync.mockImplementation(() => {});

    // ssl_db root contains one subdirectory with a file inside it.
    mockReaddirSync
      .mockReturnValueOnce([
        { name: 'certs', isDirectory: () => true },
      ])
      .mockReturnValueOnce([
        { name: '1234ABCD.pem', isDirectory: () => false },
      ]);

    const sslDbPath = await initSslDb(tempDir);

    expect(mockChownSync).toHaveBeenCalledWith(sslDbPath, 13, 13);
    expect(mockChownSync).toHaveBeenCalledWith(path.join(sslDbPath, 'certs'), 13, 13);
    expect(mockChownSync).toHaveBeenCalledWith(
      path.join(sslDbPath, 'certs', '1234ABCD.pem'),
      13,
      13
    );
    expect(mockChownSync).toHaveBeenCalledTimes(3);
  });
});
