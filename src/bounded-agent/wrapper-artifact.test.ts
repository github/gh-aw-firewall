import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeBoundedAgentWrapper } from './wrapper-artifact';
import type { BoundedAgentPaths } from './paths';

jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;
const actualFs = jest.requireActual<typeof import('fs')>('fs');

describe('writeBoundedAgentWrapper source resolution', () => {
  let dir: string;
  let paths: BoundedAgentPaths;

  beforeEach(() => {
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
    dir = actualFs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-wrapper-'));
    paths = { wrapperPath: path.join(dir, 'bounded-agent') } as BoundedAgentPaths;
  });

  afterEach(() => {
    actualFs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the packaged fallback candidate when the source-tree candidate is absent', () => {
    mockExistsSync
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValue('#!/bin/sh\n');

    expect(writeBoundedAgentWrapper(paths)).toBe(paths.wrapperPath);
    expect(actualFs.readFileSync(paths.wrapperPath, 'utf8')).toBe('#!/bin/sh\n');
  });

  it('fails closed when neither fixed wrapper candidate exists', () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => writeBoundedAgentWrapper(paths)).toThrow(/Bounded-agent wrapper not found/);
  });
});
