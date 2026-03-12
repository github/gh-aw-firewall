/**
 * Isolated test for chownRecursive that mocks fs to test the traversal logic.
 * This is in a separate file because the main ssl-bump.test.ts uses real fs operations,
 * and Node.js fs.chownSync is non-configurable (can't be spied on or redefined).
 */

import * as path from 'path';

// Mock fs before importing the module under test
const mockChownSync = jest.fn();
const mockReaddirSync = jest.fn();
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    chownSync: (...args: unknown[]) => mockChownSync(...args),
    readdirSync: (...args: unknown[]) => {
      // Only intercept calls with { withFileTypes: true } (from chownRecursive)
      if (args[1] && typeof args[1] === 'object' && 'withFileTypes' in args[1]) {
        return mockReaddirSync(...args);
      }
      return actual.readdirSync(...args);
    },
  };
});

// Mock execa (required by ssl-bump module)
jest.mock('execa');

import { chownRecursive } from './ssl-bump';

describe('chownRecursive', () => {
  beforeEach(() => {
    mockChownSync.mockReset();
    mockReaddirSync.mockReset();
  });

  it('should chown the directory itself', () => {
    mockReaddirSync.mockReturnValue([]);

    chownRecursive('/some/dir', 13, 13);

    expect(mockChownSync).toHaveBeenCalledWith('/some/dir', 13, 13);
  });

  it('should chown files in the directory', () => {
    mockReaddirSync.mockReturnValue([
      { name: 'file1.txt', isDirectory: () => false },
      { name: 'file2.txt', isDirectory: () => false },
    ]);

    chownRecursive('/some/dir', 13, 13);

    expect(mockChownSync).toHaveBeenCalledTimes(3); // dir + 2 files
    expect(mockChownSync).toHaveBeenCalledWith('/some/dir', 13, 13);
    expect(mockChownSync).toHaveBeenCalledWith(path.join('/some/dir', 'file1.txt'), 13, 13);
    expect(mockChownSync).toHaveBeenCalledWith(path.join('/some/dir', 'file2.txt'), 13, 13);
  });

  it('should recursively chown subdirectories', () => {
    // Root dir has a subdir and a file
    mockReaddirSync
      .mockReturnValueOnce([
        { name: 'subdir', isDirectory: () => true },
        { name: 'root-file.txt', isDirectory: () => false },
      ])
      // Subdir has one file
      .mockReturnValueOnce([
        { name: 'sub-file.txt', isDirectory: () => false },
      ]);

    chownRecursive('/root', 13, 13);

    expect(mockChownSync).toHaveBeenCalledTimes(4); // root + subdir + root-file + sub-file
    expect(mockChownSync).toHaveBeenCalledWith('/root', 13, 13);
    expect(mockChownSync).toHaveBeenCalledWith(path.join('/root', 'subdir'), 13, 13);
    expect(mockChownSync).toHaveBeenCalledWith(path.join('/root', 'root-file.txt'), 13, 13);
    expect(mockChownSync).toHaveBeenCalledWith(path.join('/root', 'subdir', 'sub-file.txt'), 13, 13);
  });

  it('should handle empty directory', () => {
    mockReaddirSync.mockReturnValue([]);

    chownRecursive('/empty', 1000, 1000);

    expect(mockChownSync).toHaveBeenCalledTimes(1); // just the dir itself
    expect(mockChownSync).toHaveBeenCalledWith('/empty', 1000, 1000);
  });
});
